#!/bin/bash
# Mechanical gate, SPEC §7.6. Two modes, both keep going after a failure so
# every step gets a result, print a PASS/FAIL summary table, and exit non-zero
# if any step failed.
#
#   ./scripts/ci.sh          quick (default): go build, wasm build, go vet,
#                            go test -short, svelte-check, lint, and vitest on
#                            files changed against origin/main (or HEAD when
#                            origin/main is absent). No smoke, no e2e.
#   FULL=1 ./scripts/ci.sh   the full nine-row gate: the Go rows, check, lint,
#                            the whole unit suite, smoke and e2e. GitHub runs
#                            this once per PR (.github/workflows/ci.yml).
set -u

cd "$(dirname "$0")/.."

if [ "${FULL:-0}" = "1" ]; then
  mode="full"
else
  mode="quick"
fi

# CI=1 stops Playwright reusing another worktree's dev server, makes
# forbidOnly and Vitest's allowOnly fail on a stray `.only`, and makes the
# pinned engine-walk test in affordances.test.ts throw on pin drift.
export CI=1

# One clear preflight instead of every npm step failing obscurely.
# Installs nothing.
if [ ! -d web/node_modules ]; then
  echo "web/node_modules is missing — run: npm --prefix web ci" >&2
  exit 1
fi

# Full mode only: pick a free port for this run so parallel worktrees don't
# race on playwright.config.ts's fixed 4173 (the config falls back to it when
# CUTTLE_E2E_PORT is unset). Binding port 0 avoids lsof/netstat parsing.
if [ "${mode}" = "full" ]; then
  CUTTLE_E2E_PORT="$(node -e '
const net = require("net");
const srv = net.createServer();
srv.listen(0, "127.0.0.1", () => {
  const p = srv.address().port;
  srv.close(() => { process.stdout.write(String(p)); });
});
' 2>/dev/null)"
  if [ -n "${CUTTLE_E2E_PORT}" ]; then
    export CUTTLE_E2E_PORT
    echo "test:e2e will use port ${CUTTLE_E2E_PORT} (CUTTLE_E2E_PORT)"
  else
    echo "could not pick a free port for test:e2e; falling back to the default (4173)" >&2
  fi
  echo
fi

# web/dist is untracked, but main.go's `//go:embed all:web/dist` needs it to
# exist before the Go steps compile. Writes a placeholder only when missing.
./scripts/ensure-dist.sh

step_names=()
step_statuses=()

run_step() {
  local name="$1"
  shift
  echo "=== ${name} ==="
  if "$@"; then
    step_statuses+=("PASS")
  else
    step_statuses+=("FAIL")
  fi
  step_names+=("${name}")
  echo
}

run_step "go build ./..." \
  go build ./...

run_step "GOOS=js GOARCH=wasm go build -o /dev/null ./internal/wasm" \
  env GOOS=js GOARCH=wasm go build -o /dev/null ./internal/wasm

run_step "go vet ./..." \
  go vet ./...

# The 240-seed W9 privacy sweep is opt-in and skipped here. Run it by hand:
# CUTTLE_SWEEP=1 go test ./internal/server/ -run TestW9_WirePrivacySweep
run_step "go test ./..." \
  go test -short ./...

# Prerequisite, not a table row: some vitest files boot the real wasm, and
# test:smoke no longer rebuilds it. On failure, delete any old artifact so
# wasm-dependent steps fail on the missing file instead of passing against a
# stale build; the script keeps going.
echo "=== build web/static/cuttle.wasm (prerequisite for the npm steps) ==="
if ! ./scripts/build-wasm.sh; then
  echo "wasm build failed; clearing web/static/cuttle.wasm + wasm_exec.js so" >&2
  echo "downstream npm steps fail on the missing artifact, not a stale one" >&2
  rm -f web/static/cuttle.wasm web/static/wasm_exec.js
fi
echo

run_step "npm --prefix web run check" \
  npm --prefix web run check

run_step "npm --prefix web run lint" \
  npm --prefix web run lint

if [ "${mode}" = "full" ]; then
  run_step "npm --prefix web run test:unit" \
    npm --prefix web run test:unit

  run_step "npm --prefix web run test:smoke" \
    npm --prefix web run test:smoke

  run_step "npm --prefix web run test:e2e" \
    npm --prefix web run test:e2e
else
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    base="origin/main"
  else
    base="HEAD"
  fi
  run_step "vitest on files changed vs ${base}" \
    npm --prefix web run test:unit -- --changed "${base}" --passWithNoTests
fi

echo "=== SPEC §7.6 mechanical gate summary (${mode}) ==="
failed=0
for i in "${!step_names[@]}"; do
  printf '%-65s %s\n' "${step_names[$i]}" "${step_statuses[$i]}"
  if [ "${step_statuses[$i]}" = "FAIL" ]; then
    failed=1
  fi
done

exit "${failed}"
