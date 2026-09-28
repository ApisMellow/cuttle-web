#!/bin/sh
# Build the WASM bridge (SPEC §2.2). wasm_exec.js must come from the GOROOT
# of the same Go version that compiled the .wasm — never vendor a copy.
set -eu

cd "$(dirname "$0")/.."

mkdir -p web/static
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/static/cuttle.wasm ./internal/wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/static/wasm_exec.js

echo "cuttle.wasm: $(wc -c < web/static/cuttle.wasm) bytes raw, $(gzip -9 -c web/static/cuttle.wasm | wc -c) bytes gzipped"
