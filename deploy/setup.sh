#!/bin/bash
# First-time setup of the directories, service user, systemd unit, env file
# and Caddyfile on a fresh Ubuntu 24.04 droplet. Idempotent: rerunning it
# keeps an existing env file and Caddyfile.
#
#   sudo deploy/setup.sh HOST [BUILD_USER [DEPLOY_USER]]
#
# HOST is the public hostname (your domain, or an sslip.io name). BUILD_USER
# owns the source checkout at /opt/cuttle/src and runs the builds (default:
# the user who invoked sudo). DEPLOY_USER, if given, is the unprivileged
# account the deploy Action logs in as; it gets a sudoers entry for the one
# upload command. It does NOT install Go, Node or Caddy, or clone
# the repo; docs/ops.md lists those steps. Run it from a checkout of this repo.
set -euo pipefail

die() { printf 'setup.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 HOST)"
host="${1:-}"
[ -n "$host" ] || die "usage: $0 HOST [BUILD_USER]"
printf '%s' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || die "HOST looks wrong: $host"
[ "$host" != "cuttle.example.com" ] || die "give your real hostname, not the placeholder"
build_user="${2:-${SUDO_USER:-}}"
[ -n "$build_user" ] && [ "$build_user" != "root" ] || die "give an unprivileged BUILD_USER"
id "$build_user" >/dev/null 2>&1 || die "no such user: $build_user"
deploy_user="${3:-}"

here="$(cd "$(dirname "$0")" && pwd)"

# Automatic security updates (already present on stock Ubuntu images).
DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades

if ! id cuttle >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin cuttle
fi

# /opt/cuttle is root's: update.sh runs as root from there. Only the source
# checkout belongs to the build user.
install -d -m 0755 -o root -g root /opt/cuttle /opt/cuttle/bin /var/www/cuttle
install -d -m 0755 -o "$build_user" -g "$build_user" /opt/cuttle/src
# The database and the backups hold every hidden card: service user only.
# The server refuses a looser existing backup directory at startup.
install -d -m 0700 -o cuttle -g cuttle /var/lib/cuttle /var/backups/cuttle
install -d -m 0750 -o root -g cuttle /etc/cuttle

if [ ! -f /etc/cuttle/cuttle.env ]; then
  sed "s/cuttle\.example\.com/$host/g" "$here/cuttle.env.example" > /etc/cuttle/cuttle.env
  chown root:cuttle /etc/cuttle/cuttle.env
  chmod 0640 /etc/cuttle/cuttle.env
fi

# Optional third argument: the user the deploy Action logs in as. It may run
# exactly one command as root, on exactly one file in its own home.
if [ -n "$deploy_user" ]; then
  id "$deploy_user" >/dev/null 2>&1 || die "no such user: $deploy_user"
  [ "$deploy_user" != "root" ] || die "the deploy user must not be root"
  deploy_home="$(getent passwd "$deploy_user" | cut -d: -f6)"
  sudoers_tmp="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: /opt/cuttle/update.sh --binary %s/cuttle-server.upload\n' \
    "$deploy_user" "$deploy_home" > "$sudoers_tmp"
  visudo -cf "$sudoers_tmp" >/dev/null || die "generated sudoers line is invalid"
  install -m 0440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/cuttle-deploy
  rm -f "$sudoers_tmp"
fi

install -m 0755 -o root -g root "$here/update.sh" /opt/cuttle/update.sh
install -m 0644 -o root -g root "$here/cuttle.service" /etc/systemd/system/cuttle.service
systemctl daemon-reload
systemctl enable cuttle

if [ -d /etc/caddy ] && [ ! -f /etc/caddy/Caddyfile.cuttle-installed ]; then
  sed "s/cuttle\.example\.com/$host/g" "$here/Caddyfile" > /etc/caddy/Caddyfile
  : > /etc/caddy/Caddyfile.cuttle-installed
  systemctl reload caddy || systemctl restart caddy
fi

cat <<EOF
Done. Next: clone the repo into /opt/cuttle/src (as $build_user), then run
  sudo /opt/cuttle/update.sh
which builds, starts the service and checks /healthz.
EOF
