#!/bin/bash
# Builds a static linux/amd64 cuttle-server for the droplet.
# Usage: scripts/build-server.sh [output-path]   (default: $TMPDIR/cuttle-server, outside the repo)
set -eu

cd "$(dirname "$0")/.."

out="${1:-${TMPDIR:-/tmp}/cuttle-server}"
version="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
commit="${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

mkdir -p "$(dirname "$out")"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.version=${version} -X main.commit=${commit}" \
  -o "$out" ./cmd/cuttle-server
echo "built ${out} (version ${version}, commit ${commit})"
