#!/bin/bash
# Mechanical gate, SPEC §7.6. Runs the 9 gate commands in order, keeps
# going after a failure so every step gets a result, prints a PASS/FAIL
# summary table, and exits non-zero if any step failed.
set -u

cd "$(dirname "$0")/.."

# Round 2 W7 F1/F2: several loop worktrees can run this gate at once. Without
# CI set, `reuseExistingServer: !process.env.CI` (web/playwright.config.ts)
# would let `npm run test:e2e` silently reuse ANOTHER worktree's dev server
# and test the wrong code. With CI=1: reuseExistingServer is false, so a
# port clash instead fails the webServer startup loudly; forbidOnly/retries
# (already CI-conditional in that config) also turn on. The pinned
# engine-walk test in web/tests/unit/affordances.test.ts also reads this to
# fail loudly on pin drift instead of falling back (F2). Side effect:
# Vitest's own `allowOnly` default (`!process.env.CI`) also turns off, so a
# stray `.only()` left in a unit test fails the gate instead of silently
# narrowing the run.
export CI=1

# Round 2 W7 F4: a single, clear preflight instead of every npm step
# failing obscurely (missing binaries, module-not-found) if setup was
# never run. Does not install anything.
if [ ! -d web/node_modules ]; then
  echo "web/node_modules is missing — run: npm --prefix web ci" >&2
  exit 1
fi

# Round 2 W7 F5: now that a port clash fails loudly (F1) instead of
# silently reusing a foreign server, several worktrees racing on
# playwright.config.ts's fixed port 4173 would turn that into spurious
# failures instead. Pick a free port for THIS run and export it as
# CUTTLE_E2E_PORT; the config reads it for both webServer and baseURL,
# falling back to 4173 when it's unset (so a plain `npm run test:e2e`,
# outside this script, is unaffected). Binding port 0 and reading back the
# OS-assigned port is portable — no lsof/netstat parsing, no fixed range to
# collide on — and node is already required for every npm step below.
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

# web/dist is untracked, but main.go's `//go:embed all:web/dist` needs it to
# exist before the Go steps compile. Writes a placeholder only when
# web/dist/index.html is missing; never touches a real build.
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

# -short only thins the W9 privacy sweep to every 7th seed (its sole
# testing.Short use). Full sweep by hand: go test ./internal/server/ -run TestW9_WirePrivacySweep
run_step "go test ./..." \
  go test -short ./...

# Prerequisite for the npm steps below (not one of the SPEC §7.6 nine gate
# commands, so it gets no PASS/FAIL row of its own): two unit tests need
# the compiled wasm — `test:unit`'s `scenario-replay.opening.test.ts` and
# the seed-2/ply-23 engine-walk test in `tests/unit/affordances.test.ts` —
# but only `test:smoke` (further down) rebuilds it, so on a fresh checkout
# the gate used to fail on `test:unit`. Building it once now, ahead of
# both, fixes that.
#
# Round 2 W7 B1: a build failure here must NOT abort the script — every one
# of the 9 rows below still has to run and get a result (`check`/`lint`
# don't even need the wasm) — and must NOT let a stale, previously-built
# web/static/cuttle.wasm let test:unit/test:e2e pass against old code. So
# on failure we delete any existing artifact before continuing: every
# wasm-dependent step then fails for real, on the missing file, instead of
# silently passing against a stale one or being silently skipped.
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

run_step "npm --prefix web run test:unit" \
  npm --prefix web run test:unit

run_step "npm --prefix web run test:smoke" \
  npm --prefix web run test:smoke

run_step "npm --prefix web run test:e2e" \
  npm --prefix web run test:e2e

echo "=== SPEC §7.6 mechanical gate summary ==="
failed=0
for i in "${!step_names[@]}"; do
  printf '%-55s %s\n' "${step_names[$i]}" "${step_statuses[$i]}"
  if [ "${step_statuses[$i]}" = "FAIL" ]; then
    failed=1
  fi
done

exit "${failed}"
