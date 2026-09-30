# Running the game server

How the online-play server is set up and kept current on a small Ubuntu 24.04
droplet. Design background is `docs/two-phone-plan.md` section 11; the wire
contract is SPEC section 2.12. The files live in `deploy/`.

| File | Goes to |
|---|---|
| `deploy/cuttle.service` | `/etc/systemd/system/cuttle.service` |
| `deploy/cuttle.env.example` | `/etc/cuttle/cuttle.env` (copied once, then yours) |
| `deploy/Caddyfile` | `/etc/caddy/Caddyfile` |
| `deploy/update.sh` | `/opt/cuttle/update.sh` |
| `deploy/setup.sh` | run once from the checkout |

Layout: source in `/opt/cuttle/src`, server binary `/opt/cuttle/bin/cuttle-server`,
web app in `/var/www/cuttle`, database in `/var/lib/cuttle` (`cuttle.db`),
backups in `/var/backups/cuttle`. The service runs as system user `cuttle` and
listens on `127.0.0.1:8080` only. Caddy is the one public entry point: it
terminates HTTPS, serves the app, and proxies `/healthz` and `/api/*`
(WebSocket included) to the server. Never pass `-dev` in production.

## First setup

1. Create the droplet and firewall (22, 80, 443) and point a hostname at it
   (plan section 11 has the owner's checklist). Call it `HOST` below.
2. Install, as root:
   - `git`, `curl`, `ca-certificates`
   - Go, exactly the version in `go.mod`, from go.dev/dl into `/usr/local/go`
     (not Ubuntu's package: `wasm_exec.js` must match the compiler)
   - Node 22
   - Caddy, from its official apt repo
   - a 2 GB swap file on a 1 GB droplet, or `npm ci` can run out of memory
3. As an unprivileged build user, clone the repo somewhere temporary (for
   example the home directory) so `setup.sh` can be run from it.
4. From that checkout, run `sudo deploy/setup.sh HOST BUILD_USER`. It
   creates the `cuttle` user and directories (the backup directory `0700`,
   owned by `cuttle`: the server refuses a looser existing one at startup),
   writes `/etc/cuttle/cuttle.env` and the Caddyfile with your hostname,
   installs the unit and `update.sh`, and enables automatic security updates.
5. As the build user, clone the repo into the empty `/opt/cuttle/src`, then run
   `sudo /opt/cuttle/update.sh`. It builds and starts everything.
6. Check: `curl https://HOST/healthz` returns 200 with `"status":"ok"` and the
   version, `systemctl status cuttle` is active, and `ss -tlnp` shows the
   server on `127.0.0.1:8080` only. `/healthz` is public and exposes the live
   room count and the build version and commit; that is accepted, so don't
   put anything more sensitive in it.

`/opt/cuttle` and `update.sh` are owned by root; only `/opt/cuttle/src`
belongs to the build user. Caddy adds HSTS, `nosniff`, a no-referrer policy
and a Content-Security-Policy (with `frame-ancestors 'none'`) to every
response; if the app gains an external dependency, update the CSP in the
Caddyfile.

Settings live in `/etc/cuttle/cuttle.env` (allowed origins, backup directory,
the public origin baked into the droplet's copy of the app, optional limits).
`-trusted-proxy 127.0.0.1` is in the unit: Caddy sets `X-Forwarded-For`, and
without the flag every player would share one rate limit. After editing the
env file or the unit, run `sudo systemctl daemon-reload` and
`sudo systemctl restart cuttle`.

## Updating

`sudo /opt/cuttle/update.sh` pulls whichever branch is checked out in
`/opt/cuttle/src` (fast-forward only; keep it on `main` unless you mean
otherwise), takes a lock so two updates never overlap, builds the web
app and the server as the checkout's owner, swaps both in by rename, restarts
the service, and requires `/healthz` to return 200. If it does not, the script
restores the previous binary and site and says so; check
`journalctl -u cuttle -n 50`. A build or pull failure stops the run before
anything changes.

Restarting drops open sockets; phones reconnect on their own. A counter-hold
timer in progress is lost (SPEC section 2.12.8, item 5).

### Deploy from GitHub

The `Deploy server` workflow (Actions tab, Run workflow; manual only) builds
the server on the runner and ships just the binary with
`update.sh --binary`. The web app on the droplet is updated only by a full
`update.sh` run on the droplet. One-time setup:

1. Make a key pair used for nothing else, and an unprivileged (non-root)
   deploy user on the droplet with that public key in its `authorized_keys`.
2. Allow that user exactly one command. The easy way is
   `sudo deploy/setup.sh HOST BUILD_USER DEPLOY_USER`, which writes
   `/etc/sudoers.d/cuttle-deploy` with this line (by hand: replace
   `DEPLOY_USER`, and use its real home directory):
   `DEPLOY_USER ALL=(root) NOPASSWD: /opt/cuttle/update.sh --binary /home/DEPLOY_USER/cuttle-server.upload`
   `update.sh` reads that file as the deploy user, never as root, runs the
   check on it as the service user, and deletes it afterwards.
3. In the repo, create a GitHub Environment named `production` (Settings,
   Environments) and restrict it to deployment from the `main` branch. Add
   the secrets to that environment, not to the repo:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the droplet's hostname or IP |
| `DEPLOY_USER` | the deploy user |
| `DEPLOY_SSH_KEY` | the private key |
| `DEPLOY_KNOWN_HOSTS` | required; output of `ssh-keyscan HOST` (the host key is pinned, never fetched on the run) |

With none of the secrets set, the workflow ends green with a notice and
deploys nothing. With some set and others missing, it fails.

## Backups

`CUTTLE_BACKUP_DIR` (default in the env example: `/var/backups/cuttle`) is
where the server writes its nightly copy of the database (`VACUUM INTO`),
keeping the newest three. Rooms live a day at most (SPEC section 2.12.6), so
backups guard against a bad disk or a bad deploy, not against long-term loss.
The directory holds every hidden card, so it stays `0700` and owned by
`cuttle`. Until the server's nightly backup ships, the variable is read by
nothing and the directory stays empty.

To restore a copy:

1. `sudo systemctl stop cuttle`
2. Move the current database aside: in `/var/lib/cuttle`, rename `cuttle.db`
   it and `cuttle.db-wal` and `cuttle.db-shm` (if present) into a dated
   folder outside `/var/lib/cuttle`, together, so the set stays consistent.
   Do not leave a stale `-wal` or `-shm` beside the restored file.
3. Copy the chosen backup to `/var/lib/cuttle/cuttle.db`, then
   `sudo chown cuttle:cuttle /var/lib/cuttle/cuttle.db` and
   `sudo chmod 600 /var/lib/cuttle/cuttle.db`. (A backup is a complete
   SQLite file, so nothing else is needed.)
4. `sudo systemctl start cuttle`, then check `/healthz`.

Rooms older than a day are expired on load, so a restore of an old copy mostly
brings back nothing.

## Two-phone hand test

Run after each deploy, on two real phones: Alice's (A) and Blake's (B). Tick
each line as it passes.

- [ ] Open the Pages site on both phones: the online section appears (the `CUTTLE_SERVER_ORIGIN` variable is set).
- [ ] Alice creates a game on A and shares the link; Blake joins on B from the link.
- [ ] Start a second game and join it on B by typing the 4-character code.
- [ ] Play one full game to the end on both phones.
- [ ] Mid-game, lock B for about a minute, reopen it: it resumes at the current position.
- [ ] Mid-game, put A in airplane mode, move on B, bring A back: A catches up and shows the recap of the moves it missed (once W13b lands).
- [ ] After a game ends, ask for a rematch from Alice's side, then again from Blake's side: a new game starts each time.
- [ ] On every screen, neither phone ever shows the other's hand cards, the other player's 7 reveal or 3 scrap pick, or the deck order.
- [ ] Open a bad or expired code (change one character, or use a room a day old): a clear "room gone" message, not a blank screen or a spinner.

## Pointing the Pages build at the server

The GitHub Pages build reads the repo variable `CUTTLE_SERVER_ORIGIN`
(Settings, Secrets and variables, Actions, Variables tab; a variable, not a
secret, since the origin is public):

1. Add `CUTTLE_SERVER_ORIGIN` = `https://HOST` (https, no path, no trailing
   slash).
2. Re-run the `Deploy Pages` workflow (or push to `main`). The build passes it
   to the app as `VITE_CUTTLE_SERVER`, and Play online appears.
3. Make sure `https://apismellow.github.io` is in `CUTTLE_ALLOWED_ORIGINS` in
   the env file (it is in the example), or the server answers 403.

Unset, the variable is empty and the app hides Play online. The droplet's own
copy of the app gets the same origin from `CUTTLE_PUBLIC_ORIGIN` in the env
file at each full update.
