#!/bin/bash
# `main.go` has `//go:embed all:web/dist`, so the Go build needs web/dist to
# exist. web/dist is untracked (a vite build fills it), so on a fresh clone
# this writes a minimal placeholder. Idempotent: a real build, or an existing
# placeholder, is never overwritten.
set -eu

cd "$(dirname "$0")/.."

if [ ! -f web/dist/index.html ]; then
  mkdir -p web/dist
  cat > web/dist/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Cuttle</title></head>
  <body><main>Cuttle</main></body>
</html>
EOF
  echo "created placeholder web/dist/index.html (go:embed needs web/dist)"
fi
