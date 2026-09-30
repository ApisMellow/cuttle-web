#!/bin/bash
# Updates the Cuttle droplet. Safe to run any time; stops at the first error
# and, once the new version is in place, rolls back if /healthz does not
# answer 200.
#
#   sudo /opt/cuttle/update.sh                 pull main, build web + server, deploy both
#   sudo /opt/cuttle/update.sh --binary /ABS/PATH   deploy only a prebuilt server binary
#                                              (what the deploy Action uses)
#
# Run as root. Git and the builds run as the owner of the source checkout,
# never as root. See docs/ops.md.
set -euo pipefail

ROOT=/opt/cuttle
SRC="${CUTTLE_SRC:-$ROOT/src}"
BIN="$ROOT/bin/cuttle-server"
WEB=/var/www/cuttle
ENV_FILE=/etc/cuttle/cuttle.env
HEALTH_URL="http://127.0.0.1:8080/healthz"
GO_PATH=/usr/local/go/bin

log() { printf '==> %s\n' "$*"; }
die() { printf 'update.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"

# One update at a time.
exec 9>/var/lock/cuttle-update.lock
flock -n 9 || die "another update is running"

binary_only=""
uploader=""
case "${1:-}" in
  "") ;;
  --binary)
    [ -n "${2:-}" ] || die "--binary needs an absolute path"
    binary_only="$2"
    case "$binary_only" in /*) ;; *) die "--binary needs an absolute path" ;; esac
    # The file belongs to the user who ran sudo. Root never opens it: it is
    # read, and later deleted, with that user's own permissions.
    uploader="${SUDO_USER:-}"
    { [ -n "$uploader" ] && [ "$uploader" != "root" ]; } || die "--binary must be run through sudo by the deploy user"
    ;;
  *) die "usage: $0 [--binary /absolute/path]" ;;
esac

new_web=""
staged=""
cleanup() { [ -z "$new_web" ] || rm -rf "$new_web"; [ -z "$staged" ] || rm -f "$staged"; }
trap cleanup EXIT

# Copies a binary into a root-owned file inside $ROOT/bin, read as $1 (the
# user who owns the source), then checks it runs as the service user, never
# as root. Leaves the path in $staged.
stage_binary() {
  local reader="$1" file="$2"
  staged="$(mktemp "$ROOT/bin/.stage.XXXXXX")"
  runuser -u "$reader" -- cat -- "$file" > "$staged" || die "cannot read $file"
  chown root:root "$staged"
  chmod 0755 "$staged"
  # Does it run here at all? -h prints the flags and exits 0.
  runuser -u cuttle -- timeout 10 "$staged" -h >/dev/null 2>&1 || die "the new binary does not run on this machine"
}

wait_healthy() {
  local tries=15
  while [ "$tries" -gt 0 ]; do
    tries=$((tries - 1))
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || true)" = "200" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [ -z "$binary_only" ]; then
  [ -d "$SRC/.git" ] || die "no checkout at $SRC"
  builder="$(stat -c %U "$SRC")"
  [ "$builder" != "root" ] || die "the checkout must be owned by an unprivileged build user"
  builder_home="$(getent passwd "$builder" | cut -d: -f6)"
  as_builder() {
    runuser -u "$builder" -- env HOME="$builder_home" PATH="$GO_PATH:$PATH" CI=1 "$@"
  }

  public_origin=""
  if [ -r "$ENV_FILE" ]; then
    public_origin="$(sed -n 's/^CUTTLE_PUBLIC_ORIGIN=//p' "$ENV_FILE" | tail -n 1)"
  fi

  log "pulling"
  as_builder git -C "$SRC" pull --ff-only

  log "building the web app"
  as_builder npm --prefix "$SRC/web" ci
  as_builder "$SRC/scripts/build-wasm.sh"
  as_builder env CUTTLE_BASE=/ VITE_CUTTLE_SERVER="$public_origin" npm --prefix "$SRC/web" run build
  as_builder rm -rf "$SRC/web/dist/gallery"
  as_builder cp -R "$SRC/gallery/site" "$SRC/web/dist/gallery"
  # Fails if the offline cache list is missing a file.
  as_builder node "$SRC/web/scripts/precache-manifest.mjs" "$SRC/web/dist"

  log "building the server"
  as_builder rm -rf "$SRC/.build"
  as_builder "$SRC/scripts/build-server.sh" "$SRC/.build/cuttle-server"

  new_web="$WEB.new"
  rm -rf "$new_web"
  mkdir -p "$new_web"
  # The builder packs the site; root only unpacks it, never following paths
  # the builder controls.
  as_builder tar -C "$SRC/web/dist" -cf - . | tar -C "$new_web" -xf - --no-same-owner --no-same-permissions
  chmod -R u+rwX,go+rX-w "$new_web"
  stage_binary "$builder" "$SRC/.build/cuttle-server"
else
  stage_binary "$uploader" "$binary_only"
  # Delete the upload as its owner, not as root.
  runuser -u "$uploader" -- rm -f -- "$binary_only" || true
fi

log "switching over"
had_web=""
if [ -n "$new_web" ]; then
  rm -rf "$WEB.old"
  if [ -d "$WEB" ]; then mv "$WEB" "$WEB.old"; had_web=1; fi
  mv "$new_web" "$WEB"
  new_web=""
fi
had_bin=""
if [ -f "$BIN" ]; then cp -p "$BIN" "$BIN.prev"; had_bin=1; fi
mv -f "$staged" "$BIN"
staged=""

systemctl restart cuttle

if wait_healthy; then
  rm -rf "$WEB.old"
  log "healthy: $(curl -s --max-time 3 "$HEALTH_URL")"
  exit 0
fi

printf 'update.sh: /healthz did not return 200; rolling back\n' >&2
if [ -n "$had_bin" ]; then mv -f "$BIN.prev" "$BIN"; fi
if [ -n "$had_web" ]; then rm -rf "$WEB"; mv "$WEB.old" "$WEB"; fi
systemctl restart cuttle || true
if wait_healthy; then
  die "new version failed its health check; the previous version is running again (journalctl -u cuttle)"
fi
die "new version failed its health check and the rollback is not healthy either (journalctl -u cuttle)"
