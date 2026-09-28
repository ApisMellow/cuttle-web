# AGENTS.md

Guidance for agent sessions working in this repo. The binding documents are
`docs/PRD.md` (requirements R1–R23, locked decisions A1–A7) and
`docs/SPEC.md` (technical contract). `docs/requirements.yaml` is the single
source of truth for "done" — do not mark anything `verified` without
attached evidence.

## Environment

- The Go engine is a **published module**: `github.com/ApisMellow/cuttle`,
  pinned at `v0.2.0`, no `replace` directive committed. A temporary local
  `replace` for engine development is fine — never commit it.
- The engine is canon. The UI implements zero game rules; every rule
  question is answered by `engine.LegalMoves` / `engine.Apply` output.

## Commands

- `go test ./...` — the Go gate. The repo is **test-first**: test files
  exist before implementations; golden scenarios (e.g. seed-42 deal in
  `internal/wasm/deal_test.go`) are authoritative, not judgment calls.
- `./scripts/build-wasm.sh` — builds the WASM bridge and reports raw/gzip
  size. Budget: ≤ 1.5 MB gzipped, enforced by `test:smoke` (R18).
- `verify:` enums in `requirements.yaml` map to test layers (SPEC §7);
  `unit-test` → vitest, `bridge-smoke` → `web/tests/smoke/`, `e2e-test` →
  Playwright, `screenshot-judge` → judged playtest.

## WASM bridge landmines (SPEC §2.8 — re-read before touching the bridge)

- `[]PlayerID` is `[]byte` to `encoding/json` → base64 string on the wire.
  `JackOwners` must be re-typed as a real array bridge-side.
- Nil slices marshal as `null`; normalize every array field to `[]` —
  except `opponent.hand`, where `null` ("hidden") vs `[]` ("visible, empty")
  is a deliberate, load-bearing distinction (SPEC §3.2).
- `FrozenIDs` is `map[int]bool` with explicit `false` entries; normalize to
  a sorted `[]int` dropping falses.
- `Move.Card` with `Rank: 0` is "no card" → emit `null` (Rank 0 panics
  `Rank.String()`).
- `pending.ScrapIndex` must be omitted from the view entirely — it leaks
  the acting player's intent (SPEC §3.2).
- `dealStream = 0x9E3779B97F4A7C15` in `internal/wasm/deal.go` must NEVER
  vary; scenario reproducibility depends on the exact PCG stream.

## Build artifacts and gitignore gotchas

- `wasm_exec.js` must NEVER be committed. It is copied from
  `$(go env GOROOT)/lib/wasm/wasm_exec.js` (Go 1.24+ path) at build time
  and must match the Go version that compiled the `.wasm`.
- `go:embed all:web/dist` requires `web/dist` to exist at compile time —
  that is why `web/dist/index.html` is a committed placeholder. The
  `.gitignore` needs `!web/dist/` BEFORE content negations, because `dist/`
  excludes the directory itself and git will not descend into it.
- Workbox's default `maximumFileSizeToCacheInBytes` is 2 MiB — the raw
  `.wasm` is silently skipped by precache at that default. Raise it (§5.8).

## Git conventions

- All writes happen on a feature branch, never directly on docs branches.
- OQ-3 (module publish vs replace) and OQ-9 (snapshot redaction) are both
  resolved — see SPEC §8.

## Developer playbook

The stable HOW for every loop developer and reviewer. A dispatch brief
carries the WHAT: requirement IDs, acceptance criteria, owned files,
out-of-scope lines, and the absolute worktree path. The brief wins on scope,
this section wins on method, and `docs/SPEC.md` binds both. A conflict with
SPEC is reported, never resolved by the developer (loop-workflow §10). Role
agents live in `.claude/agents/`.

**Testing policy for the family beta** (`docs/loop-workflow.md` §4.5):
strict-tier work (game rules, move wiring, hidden-information privacy,
save/resume) is test-first with red evidence and Opus on both sides;
light-tier work (pure look and layout) gets a render/smoke test plus a
fit check, Sonnet developers, and a review that blocks only on real
defects. The brief says which tier an item is.

### Roles and boundaries

| Role | Writes | Git |
|---|---|---|
| Developer | Only the files the brief assigns, in its own worktree | None. Commits belong to the git agent. |
| Reviewer | Nothing in the worktree. Scratch copies under the system temp dir only. | Read-only: `status`, `diff`, `log`, `show`, `ls-files` |
| Orchestrator | `docs/`, the ledger, round logs | Through the git agent |

- Developers never edit `docs/` (SPEC, PRD, `assumptions.md`,
  `requirements.yaml`, loop logs). Assumptions and SPEC tensions go in the
  hand-back; the orchestrator records them.
- Only one kind of out-of-scope edit is allowed: mechanical fallout in
  existing test fixtures from a required field your own change introduced
  (for example, adding `targetCard: null` to another suite's fixture). Make
  it minimal and report it. Any config, tooling, script or production file
  outside your brief means stop and report, even for a one-line fix.
- Not owned unless the brief grants them: `web/vite.config.ts`,
  `web/playwright.config.ts`, `web/eslint.config.js`, `scripts/*`, `go.mod`.

### Paths and Bash hygiene

- **Your brief names an absolute worktree path. Every Read/Edit/Write path
  and every command targets it. Your shell's working directory is not your
  worktree, so a relative path lands in the main checkout.**
- No `cd`, and no `&&` or `;` chains. One command per call.
- Command forms (`<worktree>` is the absolute path from the brief):

| Task | Command |
|---|---|
| Full gate | `<worktree>/scripts/ci.sh` |
| One vitest file | `npm --prefix <worktree>/web run test:unit -- tests/unit/<file>` (path relative to `web/`) |
| One Go test | `go -C <worktree> test ./internal/wasm/ -run <Name>` |
| Rebuild the wasm | `<worktree>/scripts/build-wasm.sh` |
| Locate the engine | `go -C <worktree> list -m -f '{{.Dir}}' github.com/ApisMellow/cuttle` |
| Install deps | `npm --prefix <worktree>/web ci` |

- Leave no scratch files in the worktree. No machine-local paths in code,
  tests or comments.

### Running the gate

`<worktree>/scripts/ci.sh` runs the nine SPEC §7.6 rows in order and prints
a PASS/FAIL table. Done means 9/9 in your own worktree. The script `cd`s to
its own repo root, so calling it by absolute path tests that tree.

| Behavior | Why it matters |
|---|---|
| Builds `web/static/cuttle.wasm` before any npm step | Three unit files boot the real wasm: `scenario-replay.opening.test.ts`, `game-restore.test.ts`, and the seed-2/ply-23 walk in `affordances.test.ts`. A stale wasm fails them, or passes them against old code. A failed build deletes the artifact so the dependent rows fail loudly. |
| Exports `CI=1` | Playwright won't reuse another worktree's dev server; `.only` fails; engine-walk pin drift throws. |
| Picks a free port, exports `CUTTLE_E2E_PORT` | Parallel worktrees each get their own e2e server. |
| Exits early if `web/node_modules` is missing | Run `npm --prefix <worktree>/web ci`. The script installs nothing. |

- After a Go change, run `<worktree>/scripts/build-wasm.sh` before any
  targeted run of the three wasm-backed files or the smoke test.
- Never run `test:e2e` outside `ci.sh`. If you must, set `CI=1` and your own
  `CUTTLE_E2E_PORT`.
- Under CI, Playwright `retries: 2` can hide a flaky test. `flaky` or
  "retry #N" in the Playwright summary is a finding, not a pass.
- `web/dist/index.html` is a committed placeholder that any `vite build`
  overwrites. The overwritten file is never committed. If a build touched
  it, say so in the report; the git agent restores it.
- `*.svelte.test.ts` files are not matched by eslint's `**/*.svelte.ts`
  block. Check the `lint` row after adding one.

### SPEC text superseded by rulings

| SPEC says | Reality |
|---|---|
| §7.1: unit tests use no WASM | Three unit files boot the real wasm (above). |
| §1.3: `web/src/routes/` | Doesn't exist. The shell is `web/src/App.svelte` and `web/src/main.ts`. |
| §5.4, §3.3 rule 1: `lib/bridge/types.ts`, `raw.ts` | Don't exist. The wire types live in `lib/bridge/schema.ts`. |
| §2.10, §7.2 item 6: smoke exclusion list | Gone. The smoke corpus is seeds 1–240, unfiltered. |
| `engine/*.go:NNN` line numbers throughout | Predate v0.2.0. Find code by symbol; cite v0.2.0 lines. |

### Engine canon

- The engine is `github.com/ApisMellow/cuttle@v0.2.0` in the Go module
  cache (locate it with the command above). Key files: `engine/apply.go`,
  `engine/moves.go`, `engine/state.go`, `engine/win.go`, `card/card.go`,
  `RULES.md`. Read-only.
- Every claim about engine behavior carries a v0.2.0 `file:line` citation
  or a test through the real wasm. A model's memory of Cuttle is not
  evidence.
- Never edit the engine, never commit a `replace`, never compensate for an
  engine defect in web code. Report it with a minimal repro; the
  orchestrator files it in `docs/loop-log/engine-issues.md`.

**Engine shapes that bit us.** Don't trust SPEC pseudocode non-null
assertions. Handle every shape the engine can emit, and cite the switch
that makes your list complete.

- Dead-end SevenPick: `SubMove: null` (the reveal is scrapped).
- A one-off revealed by a 7 arrives wrapped in `SevenPick`. Per-kind logic
  must recurse into `SubMove`.
- One-card discard: `DiscardB: -1`.

### WASM bridge: beyond the landmines above

- **`AppliedMove.targetCard`** (SPEC §2.7) comes from the PRE-state, and
  the key is always present (`null` when untargeted). A rank-2 one-off
  aimed at a Jack-stacked point names the **top Jack**, the card the engine
  scraps. Scuttle, Jack steal and 9 name the point card, stacked or not. A
  SevenPick uses its `SubMove`'s target.
- **`AppliedMove.UnmarshalJSON`** (`internal/wasm/envelope.go`) rejects a
  missing `targetCard` key and unknown fields. An outer
  `DisallowUnknownFields` doesn't reach into a custom `UnmarshalJSON`, so
  every custom decoder needs its own.
- `AppliedMove.index` is present only for `viewer === entry.by`: the key is
  omitted, not `null` (SPEC §3.2).
- The bridge never panics across the boundary. Every error is a §2.9
  `EngineError` and leaves held state unchanged.

### Svelte 5 conventions

- Runes only: `$state`, `$derived`, `$props`, `$effect`. No `export let`,
  no `$:`, no `svelte/store`. Read `docs/vendor/svelte-5-llms.txt` before
  writing a component. It is the pinned reference; memory is not.
- Component tests: `mount`/`unmount`/`flushSync` from `svelte`, with
  `// @vitest-environment jsdom` as the first line. `web/vite.config.ts`
  adds the `browser` resolve condition only under `VITEST`; without it
  `mount` resolves to the SSR build.
- **Prop-change tests use ONE mounted instance** driven through a `$state`
  props object, in a `*.svelte.test.ts` file. Two mounts hide latch bugs
  (OQ-13). Model: `web/tests/unit/hand-card.svelte.test.ts`.
- Prefer clsx-style `class={[…]}` arrays. No `await` on an animation in any
  state path (§5.9).

### Theme seam (SPEC §5.6)

- **Containers own card geometry.** A card container imports
  `lib/styles/card-geometry.css` and sizes its box: token width,
  `aspect-ratio: var(--cuttle-card-aspect)`, `overflow: hidden`,
  `flex: none`. Face and Back fill 100% of it and never size themselves.
- **No rank or suit rendering outside `lib/theme/`.** Outside the theme,
  import only `lib/theme` (index), `lib/theme/types` and `lib/theme/default`.
  `theme-glyph-boundary.test.ts` enforces the suit-glyph ban (every
  encoding) and the import boundary. Rank rendering is checked in review.
- Theme files use no `:global`, `zoom` or `!important`. The boundary test
  doesn't yet scan `lib/theme/**/*.{svelte,css}` or comments inside markup,
  so review greps for these by hand.
- **Recap and staging text (provisional ruling, 2026-09-27, `docs/design.md`):**
  cards named in a recap line render as theme `mini` faces. The sentence
  beside a card is runtime text, either from `lib/recap.ts` or from the engine's
  `descriptions[i]`, and it may contain suit glyphs. §5.6 rule 1 governs glyphs
  written into component source, not runtime strings. A component never builds
  card text from `Card` fields itself, and never creates a theme label
  component to work around this rule. A brief that contradicts this means stop
  and report.

### Testids and tap targets (SPEC §5.1, §5.9)

- Containers own testids; faces carry none. Every `[data-testid]` is
  ≥ 44 × 44 px at 390×844, so a 32 px `mini` container gets no testid
  unless it is interactive and padded to 44 px.
- A card container or board zone (hand card, point or permanent row, deck,
  scrap) keeps its element and testid whatever the legality; dim or disable
  it instead. Controls whose existence SPEC ties to the move list (the §4.3
  counter buttons and "Let it resolve", the §6 chooser, Confirm) are exempt.
- A child testid must not match a sibling family's prefix selector. A badge
  inside `hand-card-3` named `hand-card-frozen` is counted as a card by
  `[data-testid^="hand-card-"]`.
- Testids are contract. Removing or renaming one is a breaking change;
  report it.

### Redaction rules

Hard rejects. Each came up in rounds 1–2.

- **SPEC §3.3:** no `GameState` type in TS; no recomputing engine-derived
  values; submit moves only by engine-produced index; no view cached across
  a curtain; no card identities from `history` beyond the recap formatter.
- **Nothing of the previous holder survives a curtain:** not the envelope,
  not the view, not mover-only `index` in history or recap entries, not a
  closure or component-local copy.
- **The board renders only at curtain `none`, never at `ack`** (real or
  synthetic), and never merely because `view` is non-null. Behind the
  curtain it is unmounted, not hidden. *(Amended 2026-09-28, W13 GameScreen
  review: at a synthetic ack the one-off has already resolved and at a real
  window it hasn't, so a board or `ScoreBar` at either would leak which case
  it was, under R14.)*
- **Handoff DOM:** only `handoffLabel(reason)` ("Your turn" / "Your
  response"), and zero game state: no counts, scores or scrap. The raw
  `HandoffReason` never reaches text, class, attribute, `data-*`, testid or
  layout before the reveal gate. Assert it in a DOM test.
- **No auto-advance anywhere in the curtain.** The ack can't be skipped,
  fast-forwarded or auto-dismissed.
- **Real and synthetic ack are identical** to the acting player: screen
  count, DOM, testids, control position, dwell (§4.3).
- **Recap:** never name the 7's unchosen card; never show a Decline (filter
  with `isRecapVisible` before the "skip when empty" check); `DiscardPair`
  names no indices and no identities.
- `ResultScreen` renders neither hand. The seed appears only on the
  stuck-state screen.

### Stores

- `lib/stores/game.svelte.ts` is the only holder of engine state.
  Components read `$derived` values and call store methods; nothing else
  calls the bridge.
- No viewer switch: `refresh()` takes no argument, re-fetches only the
  current viewer, and runs only at `none` or a real counter window.
  `apply()` refuses behind a curtain.
- Anything carried across a curtain is typed to the minimum
  (`CurtainView = Pick<PlayerView,'active'|'phase'>`).
- The snapshot is written synchronously **before** state updates, on every
  `apply` and curtain transition, including `lastSeenSeq` stamps. A test
  must fail if the order flips.
- A failed fetch clears pending context. Test a failure followed by a retry.
- Restore by curtain kind: withhold the view at `handoff`, `reveal`,
  `recap`; expose the persisted viewer's envelope at `none`, either ack,
  and `result`. Test every kind.
- `Snapshot.engineState` is opaque to TS. Never read inside it.
- Any change to the `Snapshot` or persisted `AppliedMove` shape needs the
  brief to say "bump `v`" or "no bump". If it says neither, stop and report.

### Fixtures and scenarios

- **Sample player names are Alice and Blake.** Use them in every fixture,
  test, scenario and doc example. Don't use real people's names or agent names.
  The repo is public.
- **Wire-true fixtures.** Ints hold what the engine emits: normally `0`
  when unused, but engine sentinels stay (a one-card discard is
  `DiscardB: -1`). `targetCard` is always present; `index` only on the
  viewer's own entries; `JackOwners` in an order the engine can produce.
  Capture from the wasm when unsure.
- Build every `AppliedMove` through `appliedMove()` in
  `web/tests/unit/game-test-support.ts`, so a new required field lands once.
- A new SPEC §7.3 scenario (`web/tests/scenarios/*.yaml`) ships with the
  requirement it exercises, with an `expect` on every step. No placeholders.
- Go property tests walk a fixed seed range with `playRandom`
  (`internal/wasm/bridge_test.go`) and fail if the property was never
  exercised. One fresh bridge per `t.Run`.

### Done means

1. **TDD with red evidence.** Write the failing test, run it, keep the
   output. Then implement.
2. Every acceptance criterion maps to a named test.
3. Every redaction strip or guard has a test that reaches its own code
   path. Reviewers mutate each guarantee; a surviving mutant is a revise.
4. Full `<worktree>/scripts/ci.sh` 9/9, with test counts.
5. **Stop on ambiguity.** A criterion that is unclear or conflicts with
   SPEC is reported, not reinterpreted. Finish the unaffected parts, then
   hand back with the question.
6. Hand-back: files changed, red→green evidence, gate table, assumptions
   (each with its SPEC section), SPEC tensions, engine issues, any fixture
   fallout edited outside scope.
