# Two-phone online play: implementation plan

**Status:** plan, 2026-09-29. Decisions are recorded in PRD §10 amendment A-7.
**Replaces:** the PRD §7 design sketch wherever the two disagree (in-memory rooms, 1-hour GC, Fly.io).

## 1. Summary and goals

Alice and Blake each play on their own phone. A small Go server on a DigitalOcean droplet runs the same engine and holds the only full copy of the game; each phone receives only its own redacted view. The app stays on GitHub Pages.

- **O1.** A full game between two phones, started from a share link or a 4-character code.
- **O2.** No phone ever receives the opponent's hand (except under glasses), the deck order, or the other player's 7 reveal.
- **O3.** A player who closes the app or loses signal comes back to the same game.
- **O4.** Pass-and-play and table mode (issue #37) keep working, offline included.
- **O5.** An online game with no moves for 1 day is deleted.

Not in v1: accounts, matchmaking, push notifications, spectators, more than one online game per phone.

## 2. Architecture

```
 phone A (Pages app)                          phone B (Pages app)
   OnlineGameStore                               OnlineGameStore
        |  HTTPS POST /api/rooms...                   |
        |  WSS /api/play  (seat token in hello)       |
        +------------------+     +--------------------+
                           v     v
                 Caddy :443 (TLS, reverse proxy)
                           |
                 cuttle-server  127.0.0.1:8080
                   rooms -> game.Session (internal/game)
                           |
                 SQLite file (/var/lib/cuttle/cuttle.db)
```

The engine code that builds views (`viewFor`, `redactHistory`, `buildEnvelope`, `targetCardFor`, `resolvedFiveDraw`, the deal and the snapshot code) lives today in `internal/wasm`, which is `package main` and can't be imported. Step one moves it into an importable package, `internal/game`. The wasm build becomes a thin `syscall/js` shim over `internal/game`, and the server imports the same package. One copy of the redaction code serves both.

**The PRD's "transport swap, no store changes" (G4, SPEC §5.4) doesn't fully hold.** The envelope and index-based moves (A2, A3) carry over unchanged. But `GameEngine` in `game.svelte.ts` is synchronous (`apply(i): BridgeResult`), the server pushes opponent moves the store never asked for, and the store is built around the curtain machine, which means nothing when each player has a phone. So online play gets its own store, `OnlineGameStore`, and `GameScreen` reads a small interface both stores implement (W10). The local store stays as it is.

## 3. Wire protocol (v1)

HTTP, JSON bodies, served from the configured server origin:

| Call | Body | Reply |
|---|---|---|
| `POST /api/rooms` | `{name}` | `{code, seat: 0, token}` |
| `POST /api/rooms/{code}/join` | `{name}` | `{code, seat: 1, token}` |
| `GET /healthz` | | `{ok, rooms, version}` |

WebSocket at `/api/play`. JSON text frames, each with a type field `t`. The token travels in the first frame, never in a URL, so it never lands in access logs.

Client to server:

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v: 1, code, token, lastSeq` | Authenticate. Sent on every (re)connect. |
| `move` | `game, seq, index` | Apply legal move `index` of the envelope with this `seq`. |
| `rematch` | `game` | Ask for a rematch after game over. |
| `ping` | | Keepalive. |

Server to client:

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `seat, names, status` | `status`: `waiting` (no opponent yet), `playing`, `over`. |
| `state` | `game, envelope, opponentOnline, tally` | Full redacted envelope for this seat. Sent after hello, after every move, and after rematch. Never a diff. |
| `responding` | `by` | Neutral hold while the other player may answer a one-off (§6). |
| `presence` | `opponentOnline` | Opponent connected or dropped. |
| `rematch` | `requestedBy` | The other player asked for a rematch. |
| `error` | `code, message, seq?` | See below. |
| `pong` | | |

`envelope` is exactly what `buildEnvelope(state, history, seat)` produces today, so `parseBridgeResult` in `schema.ts` validates it unchanged. `envelope.seq` is the history length. `game` counts games in the room (1, 2, ... across rematches).

**Seq rules.** A `move` must carry the current `game` and `seq`; otherwise the server replies `STALE` and resends `state`. The client never resends a move on its own. After a reconnect the fresh `state` shows whether the move landed, and if it didn't, the player confirms again.

**Error codes.** From the bridge (SPEC §2.9): `ILLEGAL_MOVE`, `INDEX_OUT_OF_RANGE`, `NO_LEGAL_MOVES`, `BAD_REQUEST`, `INTERNAL`. Added by the server:

| Code | Client does |
|---|---|
| `UNAUTHORIZED` | Unknown token. Forget the saved seat, go Home. |
| `ROOM_GONE` | Expired or unknown code. "This game has ended." Forget the seat. |
| `ROOM_FULL` | Join on a full room. "That game already has two players." |
| `NOT_YOUR_TURN` | Resync from the `state` that follows. |
| `STALE` | Resync. |
| `RATE_LIMITED` | "Too many tries, wait a minute." |
| `UPGRADE_REQUIRED` | Protocol `v` mismatch (an old cached app). "Refresh to update." |
| `SERVER_FULL` | Create at the live-room cap (HTTP 503, `Retry-After`). "The server is busy, try again later." Added in W5. |
| `FORBIDDEN` | Disallowed `Origin` (HTTP 403). Added in W5. |

**HTTP status per code (W5).** Create answers 201 and join 200, both `{code, seat, token}` with `Cache-Control: no-store`. Errors are `{code, message}`: `ROOM_GONE` 404, `ROOM_FULL` 409, `RATE_LIMITED` 429 with `Retry-After`, `SERVER_FULL` 503, `FORBIDDEN` 403, `BAD_REQUEST` 400 (including an over-1 KB body, a non-JSON content type and unknown fields), `INTERNAL` 500. The store can't tell an expired code from an unknown one, so both are 404.

## 4. Server design

One binary, `cmd/cuttle-server`, with no embedded frontend (Pages serves the app). Packages:

- `internal/game`: the moved bridge logic plus a typed Go API: `New(seed, dealer, names)`, `Apply(seat, index) (Envelope, error)`, `View(seat) Envelope`, `Snapshot() []byte`, `Restore([]byte)`. `Apply` refuses a seat that isn't `state.Active`. The wasm `Bridge` becomes a wrapper that keeps today's JSON behaviour byte for byte.
- `internal/server/store`: SQLite through `modernc.org/sqlite` (no cgo, so it cross-compiles). WAL mode, one writer connection.
- `internal/server/rooms`: code generation, join, per-room mutex, in-memory cache of live `game.Session`s loaded from the store on demand, the response hold (§6), and rematch.
- `internal/server/httpapi`: HTTP handlers, WebSocket (`github.com/coder/websocket`), origin checks, rate limits, health.

Table `rooms`: `code` (PK), `created_at`, `updated_at`, `status`, `name0`, `name1`, `token0_hash`, `token1_hash` (SHA-256 of the token; the token itself is never stored), `game_no`, `tally0`, `tally1`, `last_dealer`, `seq`, `snapshot` (the `snapshotWire` JSON blob as-is, full and unredacted, never sent anywhere).

A move runs under the room lock: check seat and `seq`, call `game.Apply`, commit snapshot, `seq` and `updated_at` in one transaction, and only then send each seat its own `state`. If the write fails, nothing is sent and the session is reloaded from the store. Seeds and dealers come from `crypto/rand`; no seed or snapshot leaves the server.

Config from the environment: `CUTTLE_ADDR` (default `127.0.0.1:8080`), `CUTTLE_DB`, `CUTTLE_ALLOWED_ORIGINS` (default `https://apismellow.github.io`), `CUTTLE_RESPOND_MIN_MS` (default 1500), `CUTTLE_IDLE_TTL` (default 24h).

## 5. Room lifecycle

1. **Create.** Alice enters her name and gets a code, seat 0 and a token. Codes are 4 random Crockford base32 characters, redrawn on collision with a live room.
2. **Join.** Blake opens the share link or types the code, enters his name, and gets seat 1 (`ROOM_FULL` if taken). The server deals with a random dealer and sends both phones `state`.
3. **Play.** Each move stamps `updated_at`.
4. **Idle expiry.** Every 10 minutes a janitor deletes rooms whose `updated_at` is over 24 hours old, joined or not. A phone holding a dead seat gets `ROOM_GONE`.
5. **Rematch.** When both players tap Rematch, the server deals game `n+1` with the other dealer (R1, R3) and keeps the room tally.

## 6. Counter prompt and the timing tell

The engine opens a counter window only when the responder holds a legal 2 (SPEC §4.3). Online, only the responder's phone shows the counter prompt, exactly as in pass-and-play.

Without care, the mover's phone would reveal the answer by timing: an instant result means "no 2", a pause means "has a 2". To blunt this:

- After any **counterable move** (a `OneOff`, a `SevenPick` whose sub-move is a one-off, or a `Counter`), the server sends the mover `responding` right away and withholds the mover's next `state` until **both** the answer is in **and** `CUTTLE_RESPOND_MIN_MS` has passed since the move. This happens whether or not a window opened.
- The mover sees "Blake is responding…" over the board with the played card, identical in both cases. A reconnect during the hold gets `responding` again.
- The responder gets its own `state` at once: the counter prompt if they hold a 2, the resolved board if not.

**Recommended value: 1.5 s,** about as long as a quick "no" at a real table, and short enough that 5s and 7s don't drag. A long think still tells Alice that Blake has a 2, as at a table; that stays the accepted leak from R14.

Because the server enforces the hold, raw frames show nothing early either. One signal remains in the data: after a decline, both phones' history holds a `Decline` entry. The recap hides it (`isRecapVisible`), but raw frames show it (§14, question 1).

## 7. Client changes

**Store seam (W10).** Extract the interface `GameScreen` reads today (`envelope`, `history`, `seq`, `viewer`, `curtain`, `drawReveal`, `error`, `apply`, `dismissDrawReveal`, `goHome`) into a `TableSource` type. The existing `GameStore` implements it without behaviour changes. `OnlineGameStore` implements it with `curtain` always `none`.

**`OnlineGameStore` (W12):**

- `apply(index)` is async: it sets `sending` (Confirm disabled), sends `move`, and clears `sending` on the next `state` or `error`. Staging survives a failed send.
- An inbound `state` replaces the envelope whole. When `seq` jumps by more than one (reconnect, app reopened), a non-blocking recap panel lists the missed entries.
- `waitingOn` drives "Blake is responding…", "Blake is choosing a discard" (a 4) and "Alice is choosing from the 7".
- Draw reveal (SPEC §4.7) works from the envelope as today, `beforePass: false` form only.
- localStorage holds only `{v, server, code, seat, token, names}` under `cuttle.online.v1`, no game state. That closes SPEC OQ-9 for online play.

**What carries over:** the board, staging, choosers, counter prompt, discard picker, seven panel, draw reveal, recap formatter, result screen, menu and Rules sheet.

**What's off online:** the curtain, handoff panel, reveal gate, resume gate and viewer switching.

**Screens (W13a, W13b):**

- **Home** offers Pass and play, Table mode (once issue #37 lands) and Play online (Create or Join). A saved seat adds "Resume online game with Blake".
- **Create** leads to the waiting screen: the code in large type, Share (`navigator.share` with the link), Copy link, and "Waiting for someone to join…". **Join** takes a code (prefilled from a link) and a name.
- **Join links** need no server routing on Pages: `https://apismellow.github.io/cuttle-web/#/join/K7QX`. `App.svelte` reads the hash on load and `hashchange`, then clears it with `history.replaceState`.
- **Banners:** "Reconnecting…", "You're offline. Online games need a connection.", "Blake is offline." Rematch shows "Waiting for Blake" until both tap.

**Server origin** comes from `VITE_CUTTLE_SERVER` at build time (set by the Pages workflow from a repo variable). When it's unset, Play online is hidden, so the domain choice blocks nothing but the final deploy.

## 8. Presence and reconnect

- The server pings every 20 s; 45 s of silence means a dead connection, and the other seat gets `presence {opponentOnline: false}`.
- The client reconnects with backoff (0.5, 1, 2, 4, then every 8 s) and sends `hello`. The server always answers with a full `state`, which also settles a move that was in flight.
- **iOS in the background:** Safari suspends the page and the socket dies within a minute. On `visibilitychange` to visible, and on `online`, the client reconnects at once. Meanwhile the opponent sees "offline", which is true.

**Turn notifications** are out of v1; a player sees whose turn it is on opening the app. Web Push (installed home-screen apps, iOS 16.4+) is the later option: a VAPID key pair, one subscription per seat, and a notice that says only "Your turn".

## 9. Security

- **Seat tokens:** 32 bytes from `crypto/rand`, base64url, stored hashed, sent only in `hello` and the create/join reply (`Cache-Control: no-store`), never logged.
- **Codes aren't secrets.** The token authorizes play. A code grants one thing, the empty seat 1, once.
- **Rate limits** per IP (`X-Forwarded-For` trusted only from the local Caddy): create 10/hour, join and failed hello 30/hour, 10 frames/second per socket. Frames ≤ 1 KB, names ≤ 20 characters with control characters stripped, at most 500 live rooms.
- **Origins:** CORS on `/api/rooms*` and the WebSocket `Origin` check allow only `CUTTLE_ALLOWED_ORIGINS`. `http://localhost:5173` only by a dev flag.
- **No accounts,** no email, no analytics.
- **The full state never leaves the server.** The only outbound game data is `buildEnvelope(state, history, seat)` for the token's own seat. No endpoint serves a snapshot. Logs carry code, seat and event, never cards or tokens.
- TLS ends at Caddy; the Go server listens on localhost only.

## 10. Offline and the service worker

The one-phone modes stay fully offline. Online play needs the network and says so.

- The API lives on the server's origin, not the Pages origin. A service worker never sees WebSocket traffic, and Workbox's precache and navigation routes match same-origin requests only. The rule to hold: **no `runtimeCaching` route may match the server origin**, and `navigateFallback` denies `/api/`. W14 adds a test for both.
- Offline, Play online stays visible but explains that it needs a connection; a game in progress shows the offline banner and reconnects on its own.

## 11. Ops and hosting

**Layout on the droplet:** Ubuntu 24.04 LTS. Caddy from its apt repo. The binary at `/opt/cuttle/cuttle-server`, run by systemd as user `cuttle`. The database at `/var/lib/cuttle/cuttle.db`.

Caddyfile:

```
cuttle.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Caddy fetches and renews the certificate on its own.

- **Deploys:** manual first. `scripts/deploy-server.sh` builds with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64`, uploads `cuttle-server.new`, swaps it in and restarts the service; phones reconnect by themselves. Later a GitHub Action runs the same script over SSH on a tag (secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`).
- **Backups:** optional, since rooms live a day at most. The janitor runs `VACUUM INTO` nightly and keeps 3 copies.
- **Health and logs:** `GET /healthz` checks the database and reports the build version. Logs are JSON lines in journald (`journalctl -u cuttle -f`).
- **Cost:** the $4/month droplet (512 MB) is enough; $6 (1 GB) gives headroom. DigitalOcean backups add 20%. sslip.io is free.

### Setup checklist for the owner

1. Sign up at digitalocean.com and add a payment method.
2. On your laptop, make an SSH key: `ssh-keygen -t ed25519 -C cuttle-droplet`. Accept the default file, and set a passphrase if you want one.
3. In DigitalOcean, open Settings, then Security, then Add SSH Key, and paste the contents of `~/.ssh/id_ed25519.pub`.
4. Create a Droplet: Ubuntu 24.04 LTS, Basic, Regular CPU, the $4 or $6 size, the region nearest the family (for example San Francisco). Choose your SSH key, not a password. Name it `cuttle`.
5. Write down its public IPv4 address, for example `203.0.113.10`.
6. Under Networking, then Firewalls, create a firewall that allows inbound TCP 22, 80 and 443, and attach it to the droplet.
7. Pick a name:
   - **Your own domain:** add an `A` record, for example `cuttle.yourdomain.com`, pointing at the IP.
   - **No domain yet:** use `cuttle.203-0-113-10.sslip.io` (your IP with dashes). It works with no setup.
8. Check that you can log in: `ssh root@203.0.113.10`.
9. Give the hostname to whoever runs the first deploy. They run the setup script (W16), which creates the `cuttle` user, installs Caddy and the service, and turns on automatic security updates.
10. In the cuttle-web GitHub repo, open Settings, then Variables, and add `CUTTLE_SERVER_ORIGIN` = `https://<your hostname>`. The next Pages build shows Play online.

## 12. Testing strategy

**Strict tier (privacy, rules, save/resume):**

- The existing `internal/wasm` tests move with the code and stay green. The seed-42 deal golden is unchanged.
- **Wire privacy sweep (Go):** two simulated clients play random games over seeds 1–240 through the real HTTP and WebSocket stack (`httptest`). For every frame sent to seat `s`, decode every card-shaped value and assert that none is in the hidden set at that moment. The hidden set is the opponent's hand (unless `s` has glasses), the whole deck, and the 7's revealed cards when `s` isn't the actor. Also assert that no frame contains `seed`, `Deck`, `snapshot` or a token other than the socket's own. The test fails if glasses, a 7 reveal and a counter window were never exercised.
- **Hold test:** with and without a 2 in the responder's hand, the mover gets only `responding` for at least the minimum hold, and the two frame sequences match in type and order.
- **Auth and seq:** wrong token, the other seat's token, stale seq, out-of-turn move, full room and expired room each give the right error and no state change.
- **Persistence:** restart the server mid-game; both clients resync to the same seq.
- **Client:** `OnlineGameStore` against a fake socket: async apply, pushes, `STALE` resync, reconnect, and no game state in localStorage.

**E2E:** Playwright with two browser contexts against a local server: create, join by link, play a scripted seed to a win, rematch, and one reconnect. It needs its own Playwright config and a `ci.sh` row, both orchestrator-owned.

**Light tier:** the new screens and banners get render tests and a fit check at 393×852 and 393×660.

## 13. Work breakdown

Sizes: S is up to half a day, M about a day, L about two days. Strict means Opus developer and reviewer; light means Sonnet.

| # | Item | Depends on | Tier | Size |
|---|---|---|---|---|
| W1 | Move bridge logic from `internal/wasm` to `internal/game` (package `game`); wasm keeps the `syscall/js` shim; all tests move and stay green; wasm output unchanged | — | strict | M |
| W2 | Typed Go API on `internal/game` (`New`, `Apply(seat, i)`, `View`, `Snapshot`, `Restore`); `Bridge` wraps it | W1 | strict | M |
| W3 | `cmd/cuttle-server` skeleton: config, `/healthz`, slog, graceful shutdown | — | light | S |
| W4 | SQLite store: schema, token hashing, transactions, expiry query | W3 | strict | M |
| W5 | Rooms and HTTP API: create, join, codes, name rules, rate limits, CORS | W2, W4 | strict | M |
| W6 | WebSocket protocol: hello, state push, move/seq, errors, presence, heartbeat, rematch, tally | W5 | strict | L |
| W7 | Response hold (§6) | W6 | strict | S |
| W8 | Janitor: 1-day expiry and nightly `VACUUM INTO` | W4 | light | S |
| W9 | Wire privacy sweep and two-client integration tests (§12) | W6, W7 | strict | M |
| W10 | `TableSource` seam; `GameScreen` reads it; local store unchanged | — | strict | M |
| W11 | Client connection module: WebSocket, hello, backoff, heartbeat, visibility and online handling, frame validation | protocol in §3 | strict | M |
| W12 | `OnlineGameStore`: async apply, pushes, `waitingOn`, recap on seq jumps, seat record | W10, W11 | strict | L |
| W13a | Home with three modes, Create, Join, waiting screen, share sheet, `#/join/CODE` | W12 | light | M |
| W13b | In-game banners, "responding" panel, online result and rematch | W12 | light | M |
| W14 | `VITE_CUTTLE_SERVER` config; service worker guard test | offline PR merged | light | S |
| W15 | Two-context e2e (needs orchestrator-owned config and a `ci.sh` row) | W6, W13a, W13b | strict | M |
| W16 | Ops files: Caddyfile, systemd unit, setup script, deploy script | W3 | light | S |
| W17 | GitHub Action deploy over SSH | W16, first manual deploy | light | S |

W1 to W9 (server) and W10 to W12 (client) can run in parallel once §3 is agreed. The critical path is W1, W2, W5, W6, W12, W13, W15: roughly 9 to 11 developer-days.

`go.mod` (new dependencies), `scripts/*` and the Playwright config aren't developer-owned, so the briefs for W3, W5, W6, W15 and W16 must grant them explicitly.

## 14. Risks and open questions

Each question has a default the work proceeds on unless the product owner says otherwise.

1. **Decline entries in history** let a player who reads raw frames see that the opponent held a 2 and declined. **Default:** accept, since the leak is already accepted by R14 and the UI hides it. Redacting it would change `seq` semantics.
2. **Code squatting:** someone who guesses a code could take seat 1 before Blake does. **Default:** accept at family scale. Alice's waiting screen shows the joiner's name before play starts, and she can start a new room.
3. **One online game per phone.** **Default:** yes for v1. Starting a second one asks first and forgets the first seat.
4. **sslip.io certificates** share Let's Encrypt limits with every other sslip.io user. **Default:** Caddy's built-in ZeroSSL fallback covers it. Move to a real subdomain when one is chosen.
5. **Hold length.** **Default:** 1.5 s, configurable. Tune it after the first family games.
6. **SPEC text.** SPEC §2.4, §3.1, §5.4 and OQ-9 still describe the transport swap. **Default:** the orchestrator adds a SPEC section for the protocol when W6 starts, and this plan stays the source until then.
