# AGENTS.md

Cuttle Web is a mobile PWA for the card game Cuttle: pass-and-play on one
phone, and two-phone online play. The Go engine
(`github.com/ApisMellow/cuttle`) runs in the browser as WASM; a small Go
server hosts online rooms.

The binding documents are `docs/PRD.md` (requirements and amendments),
`docs/SPEC.md` (the technical contract) and `docs/requirements.yaml` (the
done ledger). This file is for the session that plans work and writes
briefs. Developer agents work from their brief and don't read it.

## How work runs (lean, ApisMellow, 2026-10-24)

- **The brief is the whole context.** It names the task, the files, the
  acceptance checks and the commands, and it quotes the SPEC or design
  excerpts the work needs. Developers don't read this file, the plan docs
  or the design docs.
- **Agents are small and short-lived.** One developer per work item. An
  agent is continued only for a quick fix to its own fresh work.
- **Dev agents run inside the repo folder**, never from another workspace.
- **Small-fix lane** (a bug fix or tweak of about 100 lines or less): one
  Sonnet developer with a short brief writes the fix and a regression test,
  and runs only the touched tests. There's no reviewer, no local full gate,
  no ledger edit and no screenshot judge. One git pass: branch, PR, wait
  for `gate`, merge.
- **Feature work:** developers commit on the feature branch, with no PR per
  work item into it. At the end there's one PR to `main` and one git pass.
  The reviewer (`.claude/agents/cuttle-reviewer.md`) is opt-in, for large or
  risky features, and it reads the PR's `gate` result rather than re-running
  it.
- **Ledger:** `requirements.yaml` is updated once per feature, at merge,
  with the PR number as evidence.

## Testing rules

1. While building, run only the test file for the code you touched, at
   natural stopping points. Don't test after every line.
2. The full suite runs only as the PR `gate` on GitHub. Nobody runs
   `FULL=1` locally: not developers, not the reviewer, not the planning
   session. If the gate fails, rerun just the failing test file with its
   one-file command, fix it, and push; the gate runs again on the PR.
3. Logic changes get unit tests with exact assertions. Don't replay hundreds
   of games to prove a rule.
4. Changes with no visual effect run no Playwright.
5. There's no privacy or strict tier. The players are honest, and the one
   requirement is that the opponent's hand is not shown on screen, except to
   a player with an 8 (glasses) in play. Normal tests and playtests cover
   it.
6. Subtle hints (for example, timing that suggests a held 2) are gameplay
   issues, handled as normal gameplay work.
7. A flaky or brittle test is a bug in the test. Fix or cut it; don't
   retry it.

## Commands

`<repo>` is the absolute repo or worktree path. Use one command per call,
with no `cd`.

| Task | Command |
|---|---|
| Quick check (default) | `<repo>/scripts/ci.sh` |
| One vitest file | `npm --prefix <repo>/web run test:unit -- tests/unit/<file>` |
| One Go test | `go -C <repo> test ./internal/game/ -run <Name>` |
| Rebuild the wasm | `<repo>/scripts/build-wasm.sh` |
| Locate the engine | `go -C <repo> list -m -f '{{.Dir}}' github.com/ApisMellow/cuttle` |
| Install deps | `npm --prefix <repo>/web ci` |

- After a Go change, rebuild the wasm before running a wasm-backed unit
  file. Those files call `createWasmEngine()`
  (`web/tests/scenario/wasm-engine.ts`).
- `FULL=1 scripts/ci.sh` is what the GitHub `gate` job runs. Never run it
  locally (testing rule 2).
- `ci.sh` exits early if `web/node_modules` is missing; it installs nothing.
- Playwright by hand needs `CI=1` and your own `CUTTLE_E2E_PORT`, or it may
  reuse another worktree's dev server. `ci.sh` sets both.
- On a fresh clone, `go build` and `go test` need `web/dist` to exist:
  run `scripts/ensure-dist.sh`, which writes a placeholder.

## Layout

| Path | What |
|---|---|
| `internal/game` | The bridge: envelope, view redaction, dealing, `Session`, snapshot validation, golden transcript |
| `internal/wasm` | The `syscall/js` shim only; no contract logic |
| `internal/server`, `cmd/cuttle-server` | Online rooms: HTTP API, WebSocket play, rate limits, janitor, backups |
| `internal/store` | The only SQLite code (rooms and saved games) |
| `web/src/lib/bridge` | The TS wire types (`schema.ts`) and engine loader |
| `web/src/lib/stores` | `game.svelte.ts`, the only holder of engine state |
| `web/src/lib/components`, `lib/theme` | Svelte 5 UI; all card rendering lives in the theme |
| `web/src/lib/online`, `lib/tutorial` | The online client connection; Learn to play |
| `web/tests/{unit,smoke,scenario,scenarios,e2e}` | vitest, bridge smoke, scenario harness, YAML scenarios, Playwright |

The shell is `web/src/App.svelte` and `web/src/main.ts`; there is no
`routes/` folder.

## Where the detail lives

| Topic | Read |
|---|---|
| WASM bridge, envelope, normalization landmines | SPEC §2, especially §2.7 and §2.8 |
| Online protocol, server obligations, limits | SPEC §2.11, §2.12 |
| Redaction, what the UI may not do | SPEC §3 |
| Curtains, counters, recap, the 5's reveal | SPEC §4; counters also `docs/counter-rewind-design.md` |
| Components, theme seam, persistence, PWA | SPEC §5.2–§5.9 |
| Tutorial | SPEC §5.11, `docs/tutorial-design.md` |
| Move interaction and affordances | SPEC §6 |
| Visual design and card layout | `docs/design.md` |
| Deploy and server ops | `docs/ops.md` |

The old AGENTS.md (662 lines) had a list of coding warnings for each part
of the code. It isn't loaded any more, but you can still read it with
`git show 2514079:AGENTS.md` when a brief touches that code. Its notes on
the counter hold are out of date; SPEC §4.3 wins.

## Counters (issue #93): ruled, not yet built

SPEC §4.3 and `docs/counter-rewind-design.md` hold the rule that
ApisMellow decided on 2026-10-24. A one-off takes effect at once. The
opponent may open their next turn with a 2, which rewinds to the end of
their own last turn. There's no hold online and no prompt out of turn.
The code still implements the old counter window until engine v0.3.0 and
the `go.mod` bump land. Treat `docs/counter-rewind-design.md` §8 as the
list of cases to cover under the testing rules above, not as a red-first
mandate.

## Hard rules

- **The engine is canon.** The UI implements no game rules: every rule
  comes from `engine.LegalMoves` / `engine.Apply`, and moves are submitted
  only by engine-produced index. Never edit the engine, never commit a
  `replace` in `go.mod` (a local one for engine work is fine), and never
  work around an engine defect in web code. Report it with a minimal repro
  in `docs/loop-log/engine-issues.md`.
- **The opponent's hand is not shown**, except to a player with an 8
  (glasses) in play (SPEC §3.2). Redaction happens Go-side
  (`internal/game/view.go`, `redactHistory` in `envelope.go`). The board
  renders only at curtain `none` and is unmounted behind a curtain. No
  view, envelope or mover-only history `index` survives a curtain.
- **Build artifacts:** never commit `wasm_exec.js` (it's copied from the Go
  toolchain at build time). `web/dist/` stays untracked.
  `dealStream = 0x9E3779B97F4A7C15` in `internal/game/deal.go` never
  changes.
- **Svelte 5 runes only** (`$state`, `$derived`, `$props`, `$effect`). Read
  `docs/vendor/svelte-5-llms.txt` before writing a component.
- **Theme seam:** no rank or suit rendering outside `lib/theme/`. Card
  containers size the box; faces fill it (SPEC §5.6).
- **Testids are contract:** each is ≥ 44 × 44 px at every target viewport,
  and renaming or removing one is a breaking change.
- **Persisted shapes:** a change to `Snapshot` or a persisted
  `AppliedMove` needs the brief to say "bump `v`" or "no bump". Store
  migrations in `internal/store/migrate.go` are append-only.
- **Public repo:** sample players are Alice and Blake. No real people's or
  agents' names, and no machine-local paths in code, tests or docs.
  Rulings in docs are attributed to ApisMellow.
