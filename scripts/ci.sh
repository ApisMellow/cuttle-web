#!/bin/bash
# Mechanical gate, SPEC §7.6. Runs the 9 gate commands in order, keeps
# going after a failure so every step gets a result, prints a PASS/FAIL
# summary table, and exits non-zero if any step failed.
set -u

cd "$(dirname "$0")/.."

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

run_step "go test ./..." \
  go test ./...

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
