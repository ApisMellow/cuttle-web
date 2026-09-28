# Implementation assumptions

Choices made during implementation that the SPEC doesn't pin down, logged
per section so a later batch can see the reasoning without re-deriving it.

## Batch 0 (scaffold)

- **go.mod dependency mode (David's call, resolving OQ-3).** Dropped the
  `replace github.com/ApisMellow/cuttle => ../Cuttle` directive and
  `require`d the published module `github.com/ApisMellow/cuttle` v0.2.0
  directly. `go mod tidy` resolves it from the public module proxy; no
  sibling engine checkout is required to build this repo anymore.

- **`web/static/` is now fully gitignored** (was two specific lines: `*.wasm`
  and `web/static/wasm_exec.js`). Everything under `web/static/` is a build
  artifact of `scripts/build-wasm.sh`; a blanket ignore also covers any
  future artifact dropped there without needing a new line each time.

- **Vite `publicDir` is set to `static`** (SPEC §1.3 layout: `web/static/`
  sits next to `web/src/`, not under a conventional `public/`). SPEC §2.3
  fetches `/cuttle.wasm` and imports `/wasm_exec.js` from root-relative
  paths, so `publicDir: 'static'` is what makes `vite build` copy those
  artifacts into `web/dist/` untouched and `vite dev` serve them at `/`.

- **`npm run check` excludes `tests/unit/engine.test.ts` and
  `tests/unit/schema.test.ts` from type-checking** (via `tsconfig.json`
  `exclude`). Both import `../../src/lib/bridge/{engine,schema}`, which is
  Batch 3's deliverable (SPEC §5.4) and doesn't exist yet. Excluding them
  from `tsc`/`svelte-check` keeps `check` green without touching the test
  files themselves; `vitest` still picks them up (via `test:unit`'s
  `tests/unit/**/*.test.ts` include) and they fail at import time, which is
  the expected red documented in the batch report.

- **`test:smoke` script runs `node --test tests/smoke/**/*.mjs`, not
  `node --test tests/smoke`.** Passing the bare directory made Node's CJS
  loader try to `require()` the directory itself and crash before
  discovering any test file, even though `package.json` has
  `"type": "module"`. The explicit glob reliably discovers
  `bridge-smoke.mjs`.

- **Scenario loader + replayer live under `web/tests/scenario/`** (singular;
  the YAML data files are the sibling `web/tests/scenarios/`, plural,
  renamed from `fixtures/`). Files: `types.ts`, `loader.ts`, `replayer.ts`,
  `stub-engine.ts` (vitest-only fake), `wasm-engine.ts` (real-bridge
  adapter, test-only).

- **`wasm-engine.ts` duplicates the ~15-line WASM boot sequence** from
  `tests/smoke/bridge-smoke.mjs` instead of importing a shared bridge
  module, because the only shared module that could exist —
  `src/lib/bridge/engine.ts` — is explicitly Batch 3's to create (SPEC
  §5.4). Once that lands, `wasm-engine.ts` is a reasonable candidate to
  delete in favor of importing the real thing.

- **Replayer's use of the three engine methods:** `newGame()` seeds the
  position and its return value is discarded; `legalMoves()` is called once
  immediately after to fetch the envelope for step 0's assertion; every
  envelope after that comes from `apply()`'s return value, matching how the
  real bridge already behaves (every call returns a full envelope, SPEC
  §2.7). `legalMoves()` is real, used surface — not vestigial.

- **Diagnostic message step numbering is 0-indexed** by position in the
  scenario's `moves` array (`step 0` is the first move), not 1-indexed and
  not tied to the engine's `seq` counter. SPEC §7.3's example (`step 4: ...`)
  doesn't pin this down precisely enough to derive it either way.

- **Checkpoint assertion is generic key/value equality** over every field in
  a `checkpoints[]` entry except `afterStep`, using `===`. SPEC §7.3's
  example checkpoint has `phase`, `active`, `curtain` — the loader/replayer
  don't special-case any of them; whatever fields a scenario's checkpoint
  names, the replayer asserts against the matching keys in the envelope
  returned by `apply()` at that step.

- **YAML parsing uses the `yaml` npm package** (devDependency, test-tooling
  only — not shipped in the app bundle).

## Batch 1 (Go WASM bridge)

- **Host build stub (§1.3).** `internal/wasm/main_host.go` carries
  `//go:build !(js && wasm)` and an empty `main()`. The §1.3 files keep their
  roles: `main.go` stays the `js && wasm` bridge entry, `deal.go`/`view.go`
  stay untagged. Without the stub, `go build ./...` on the host compiled the
  untagged files as a `main` package with no `main()`. The stub is never run;
  it exists so `go build ./...` passes and `go test ./...` keeps covering the
  untagged files on the host.

- **Extra untagged helper files (§1.3).** `internal/wasm/bridge.go` (the
  held-state `Bridge` and all seven calls) and `internal/wasm/envelope.go`
  (wire types, §2.8 normalization, §2.9 errors, panic guard) sit beside the
  three §1.3 files. `main.go` is only the `syscall/js` shim. It converts JS
  arguments (string → string, number → float64, undefined/null/missing → nil,
  anything else → an "unsupported" marker) and returns the Bridge's string.

- **Which viewer each call returns (§2.4, §2.7; David-approved change,
  Batch 1 follow-up).**
  - `apply` returns the **mover's** view (viewer = pre-apply `Active`). The UI
    fetches the incoming actor's envelope with `__cuttleView(newActor)` after
    the curtain reveal (§3.3 rule 4). The goal is that no mutating call loads
    the hand of a player who isn't holding the phone into the JS heap.
  - `legalMoves` and `describe` return `state.Active`'s envelope. They are the
    actor's own queries.
  - **Decided by David, 2026-09-26:** `newGame` returns the first actor's
    view (`state.Active` after the deal). Whoever starts the game is the
    first player, so there is no opening curtain.
  - **Decided by David, 2026-09-26:** the signature is now
    `__cuttleRestore(snapshotJson, viewerId)`, and it returns `viewerId`'s
    envelope. TS passes its persisted `Snapshot.viewer` (§5.7), and the UI
    puts the persisted curtain back up before rendering anything (R4.2).
    A `viewerId` other than exactly 0 or 1 is `BAD_REQUEST`, with the held
    state unchanged.
  - `view(p)` returns `p`'s envelope.
  - `web/tests/smoke/bridge-smoke.mjs` and
    `web/tests/scenario/wasm-engine.ts` now follow `apply` with
    `view(state.active)`, which is what the UI will do. The smoke test also
    asserts that `apply`'s viewer is the mover.

- **`history[].index` / `lastMove.index` are omitted for non-movers (§3.2;
  David-approved).** The bridge holds every index. Each envelope drops
  `index` (the key is absent, not null) from entries whose `by` is not the
  viewer, because the index encodes a pending 3's ScrapIndex and the size of
  the mover's option list. The snapshot keeps the full history, and `restore`
  requires every entry to carry an index.

- **`AppliedMove.subKind` (§2.7, §4.3; David-approved).** It holds the
  SubMove's `MoveKind` as a bare number, or `null` when there is no SubMove
  (§2.8(d) pointer style). It is always present and visible to both viewers.
  The SubMove's kind is public once it is played, and the synthetic-ack side
  needs it.

- **`restore` requires `Pending` to be present if and only if the phase is 1,
  2 or 3 (§2.9 `BAD_REQUEST`).** A mismatch is rejected and the held state is
  unchanged.

- **`describe` is the same envelope as `legalMoves` (§2.4).** A2 names both
  and the SPEC gives `describe` no distinct payload. Descriptions already sit
  parallel to `legalMoves` in every envelope.

- **Where `NO_LEGAL_MOVES` is raised (§2.9, §2.10).** `legalMoves`,
  `describe` and `apply` raise it when the held position is not game-over and
  the engine offers no move. The error carries `detail {phase, active, seq}`.
  A mutating call (`apply`, `restore`) that *lands* in such a position
  commits and returns the truthful envelope with `legalMoves: []`, which the
  §2.7 invariant exception allows. §2.9 requires held state to be unchanged
  on every `ok:false`, and the move that got there really happened, so its
  history must survive for the stuck-state screen. `view` never raises it, so
  that screen can still read `seq` and `history`.

- **`ILLEGAL_MOVE` detail (§2.9).** Carries `{index, description, seq,
  phase}` so the §2.10 stuck-state screen can name the offered move the
  engine rejected. Held state is unchanged.

- **Error precedence (§2.9).** `NO_GAME` is checked before argument
  validation, so a call before `newGame`/`restore` always routes home. For
  `apply`, the order is: `NO_GAME`, then a non-integer argument
  (`BAD_REQUEST`), then a stuck position (`NO_LEGAL_MOVES`), then
  `INDEX_OUT_OF_RANGE`, then `ILLEGAL_MOVE`.

- **Strict `NewGameOpts` (§2.6).** The argument must be a JSON string holding
  one object, with no unknown fields and no trailing data. `seed` must be a
  decimal uint64 *string* (a JSON number is rejected), `dealer` must be 0 or
  1, and `names`, if present, must hold exactly two entries. The bridge
  accepts `names` but doesn't use them. A JSON `null` for `seed`/`dealer`
  counts as omitted. Omitted values come from `crypto/rand`, drawn only after
  validation passes.

- **`SnapshotJson` shape (§2.4, §3.4, §5.7).** `{ok: true, v: 1, state,
  history, seed, dealer}`. `state` is the raw `engine.GameState` exactly as
  `encoding/json` writes it, unnormalized (e.g. `JackOwners` stays base64).
  It is opaque to TypeScript and round-trips byte-for-byte through
  `restore`. `seed` is a decimal string. The bridge includes seed and dealer
  because it is the only party that knows a crypto-random seed.

- **`restore` validation (§2.9 `BAD_REQUEST`).** Restore requires `v === 1`
  and the presence of `state`, `history`, `seed` and `dealer`, and rejects
  unknown fields. It checks structure only, never game rules:
  - every enum is in range
  - every card has Rank 1..13 and Suit 0..3
  - `JackOwners` and `JackStack` have the same length
  - `history[i].seq === i + 1`

  This keeps a hand-edited snapshot from driving the view or engine into an
  index panic.

- **Commit-after-render (§2.9).** Every mutating call builds and encodes the
  new envelope before it replaces the held state, so a failure while
  rendering leaves the previous state in place.

- **`__cuttleReady` is the boolean `true` (§2.3).** The Batch 0 placeholder
  set it to a resolved Promise. The SPEC and the smoke test poll for `true`.

- **`PointEntry` wire keys are PascalCase (§2.7).** The Batch 0 `view.go`
  emitted `card/owner/jackStack/jackOwners/controller`. §2.7's `PointEntry`
  interface and `tests/unit/schema.test.ts` both use
  `Card/Owner/JackStack/JackOwners/Controller`, so the bridge now emits
  those. `JackOwners` is now `[]int`, a real array rather than base64 (§2.8a).
  This corrects the code to match the SPEC; the SPEC itself is unchanged.

- **History `subKind` validation on restore (§2.7, §2.9; re-review minor,
  2026-09-26).** A non-null `subKind` is accepted only on a `SevenPick`
  entry. A `SevenPick` with `subKind: null` is also valid: engine v0.2.0's
  `legalSevenPickMoves` dead-end fallback emits `SevenPick` with no SubMove
  ("7: no legal play — scrap X"). The reviewer's stricter rule (non-null
  exactly when the kind is `SevenPick`) contradicts the engine, so it was
  escalated rather than applied. `snapshotVersion` stays 1 because no
  snapshot shape has been released yet.

- **The actor's envelope must render before commit (§2.9; re-review minor).**
  When a mutating call returns a non-actor viewer (`apply`, or `restore` with
  a non-actor `viewerId`), `commit` also renders the actor's envelope before
  it assigns the state. The builder is the package variable `renderEnvelope`
  so that a test can make it fail and prove nothing commits. Production never
  reassigns it.

## Batch 2 (bridge smoke)

- **WASM gzip budget interpretation (R18.1, SPEC §7.6; revised 2026-09-26).**
  SPEC §7.6/§2.2 say "1.5 MB" with no qualifier, so it is taken literally as
  the stricter decimal reading: 1,500,000 bytes, not 1.5 MiB (1,572,864
  bytes). The looser binary reading was tried first and reverted — it
  quietly relaxes the acceptance criterion by ~72 KB, and where SPEC means a
  binary unit it says so explicitly (§2.2's "806 KiB baseline"). Measured
  gzipped size at engine v0.2.0 is ~988,532 bytes (Node's `zlib.gzipSync` at
  level 9), comfortably under the stricter 1,500,000-byte budget too. The
  check was proven red/green before landing: a deliberately low 100 KiB
  threshold failed the assertion against the real artifact, then the real
  budget passed — both verified by hand before writing the committed test.

- **Gzip measured in-process, not shelled out.** `R18.1`'s test uses Node's
  `node:zlib` `gzipSync(buf, { level: 9 })` rather than spawning the `gzip`
  binary, so the check has no external-tool dependency and matches
  `build-wasm.sh`'s own `-9` compression level. Node's gzip framing differs
  slightly from GNU `gzip -9` (996,691 vs. 988,491 bytes on the same
  artifact) — header/OS-byte differences, not compression quality — so the
  budget has enough headroom that the ~1% delta doesn't matter.

- **`test:smoke` builds the WASM bridge first (R11.4/R18.1 "fresh build"
  requirement).** Changed `web/package.json`'s `test:smoke` script to
  `npm run build:wasm && node --test tests/smoke/**/*.mjs` rather than
  adding a separate build step to `scripts/ci.sh`. Before this change,
  `ci.sh` ran `npm --prefix web run test:smoke` directly, so the gate could
  pass against a stale `.wasm` left over from an earlier manual build.
  Putting the build inside the npm script means every caller of
  `npm run test:smoke` — `ci.sh`, a direct developer invocation, or a future
  CI job — always tests fresh output, with one point of truth instead of
  two that could drift out of sync.

- **Exclusion re-enablement (R11.4, SPEC §2.10/§7.2(6)).** Confirmed by
  running the full unfiltered 240-seed corpus twice (see
  `docs/loop-log/engine-issues.md`, 2026-09-26 entry) before touching
  anything: 0 defects, both endings occurred. Per §7.2(6)'s policy,
  `web/tests/smoke/exclusions.json` is deleted outright (not emptied) and
  the filtering code in `bridge-smoke.mjs` that read it is removed, rather
  than leaving a permanently-empty exclusions file as a vestigial seam. If a
  defect ever reappears, the file and the two lines of filtering code are a
  small, obvious thing to re-add — SPEC §7.2(6) and this file both describe
  the exact shape.

- **Redaction sampling scope (§7.2(5)).** "Several corpus games" is read as
  a fixed sample of 6 seeds spread across the 240-seed range (5, 45, 90,
  135, 180, 225) rather than the full corpus, to keep the smoke suite's
  runtime cost proportionate (SPEC §7.2: "Cost: seconds"). Within each
  sampled game, every 5th step's position is checked for both viewers
  against a same-position `__cuttleSnapshot()` ground truth: opponent hand
  leak (respecting the glasses exception), deck-content leak, and
  `history[].index` leak on the other player's entries. The test asserts at
  least 20 positions were actually checked, as a guard against a future
  refactor silently shrinking the sample to nothing.

- **`assertNoLeak`'s glasses branch doesn't re-check hand-card absence.**
  When `opponent.hand !== null` for a sampled position, the test asserts the
  viewer has a glasses-8 in `you.permanents` (SPEC §3.2's `viewerHasGlasses`)
  and does not additionally scan for the (now legitimately visible) hand
  cards — that would be asserting the opposite of what glasses are for. Deck
  and history-index checks still run unconditionally in every branch.

- **Stray Go package under `web/node_modules` (item 6).** `go version`
  reported `go1.25.2`, which supports the go.mod `ignore` directive
  (`go help mod edit`'s `-ignore=path` flag). Ran
  `go mod edit -ignore=web/node_modules`, which adds a single `ignore
  web/node_modules` line to `go.mod`. Verified `go test ./...`,
  `go build ./...`, and `go vet ./...` no longer see
  `web/node_modules/flatted/golang/pkg/flatted` at all (previously
  `go test ./...` printed `? ... [no test files]` for it). Chosen over
  `.gitignore`-only exclusion (doesn't affect `go` tool package discovery,
  only `git`) and over a build-tag/exclude-file approach (there's nothing to
  tag — it's third-party vendored-by-npm source, not ours to edit).

## Batch 3 (TS bridge boundary)

- **Three files, not five.** SPEC §5.4 lists five bridge files
  (`wasm.ts`, `raw.ts`, `engine.ts`, `types.ts`, `schema.ts`). Per this
  batch's scope, only `wasm.ts`, `engine.ts`, and `schema.ts` were created.
  `types.ts`'s content (the §2.7 wire types) lives in `schema.ts`, since
  schema validation needs the types anyway and the task scope explicitly
  named `schema.ts` as owning "types and runtime validation." `raw.ts`'s
  thin per-global wrappers are folded directly into `engine.ts` — there was
  no daylight between "a thin typed wrapper over a `__cuttle*` global" and
  "the public API function for that call," so a separate pass-through layer
  would have added a file without adding a seam. If a real v2 transport
  swap (SPEC §5.4) later needs `engine.ts`'s public functions decoupled
  from the raw global-calling mechanics, splitting `raw.ts` back out is a
  small, obvious refactor with no behavior change.

- **`wasm_exec.js` is loaded via a `<script src>` tag, not `import()`, in
  `lib/bridge/wasm.ts` — a deviation from SPEC §2.3's illustrative code**
  (logged here per the task's "record SPEC gaps" instruction; not a
  `SPEC.md` edit). `await import('/wasm_exec.js')` — the SPEC's exact
  snippet — fails under the pinned toolchain (`vite@8.3.1`) with: *"Cannot
  import non-asset file /wasm_exec.js which is inside /public. JS/CSS files
  inside /public are copied as-is on build and can only be referenced via
  `<script src>` or `<link href>` in html."* Verified by running the
  walking-skeleton e2e test against the literal SPEC snippet before
  changing it — the dev server logs the error above and the page never
  reaches `Engine ready`. A `document.createElement('script')` load
  produces the identical side effect (`globalThis.Go` defined) without
  going through Vite's module graph, and works unchanged in dev, build, and
  preview. `resetEngineForTests()` is exported alongside `ensureEngine()`
  as a test-only escape hatch (unused by any test in this batch, but the
  memoization means nothing else can force a second boot without it).

- **`web/tests/scenario/wasm-engine.ts` reuses `lib/bridge/engine.ts` for
  every bridge *call* (item 7), but keeps its own Node-native boot
  sequence rather than calling `lib/bridge/wasm.ts`'s `ensureEngine()`.**
  Not clean to unify fully: `ensureEngine()`'s `<script src="/wasm_exec.js">`
  load requires a real browser DOM actually executing injected script tags,
  and its `fetch('/cuttle.wasm')` is relative to a page origin — neither
  holds under `vitest`'s `jsdom` environment (jsdom does not execute
  externally-loaded `<script src>` elements by default, and there is no
  dev server backing a relative `fetch()` in a bare Node test run). The
  existing `readFile`-based boot (already proven working, matching
  `tests/smoke/bridge-smoke.mjs`) was kept unchanged for that reason. Once
  booted, though, the *calls* (`newGame`, `legalMoves`, `apply`, via
  `view`) now delegate to the real `engine.ts` wrappers instead of a
  duplicated `call()` helper, which is the reuse the task asked for where
  it's actually clean — the boot dance and the call surface are separable,
  and only the former is inherently browser/server-shaped.

- **`docs/requirements.yaml`/`docs/traceability.md` edited are the ones in
  the feature branch, not the stale, all-`todo` copy on the
  `docs/p1b-decisions` branch.** The
  latter is `SPEC.md`'s home and was read-only per this batch's
  instructions; its `requirements.yaml`/`traceability.md` predate Batch 1/2
  and don't reflect any of the `implemented`/`PARTIAL` work already landed
  here. This repo's copies are the ones `loop-workflow.md` and every prior
  batch's assumptions entries treat as the live ledger.

- **R2.1/R2.2 TS halves scoped to `schema.ts`, not a store.** Both
  ledger entries' `unit-test` acceptance bullets ("scoreboard fields …
  never recomputed in TS", "`state.stalemate` … never independently
  computed") describe a no-recomputation property that `schema.ts`'s
  validate-only design already proves structurally: `parseBridgeResult`
  never derives these fields, only checks their shape and passes the
  parsed value through unchanged. Added vitest cases assert exactly that,
  including a deliberately-inconsistent `stalemate` value to prove the
  schema doesn't second-guess it. Both ledger entries stay `todo (PARTIAL)`
  — their `e2e-test` bullets (`ResultScreen`, scenario fixtures
  `win-with-kings`/`stalemate`) are UI-screen work out of scope for this
  batch.

- **R7.4's "store updates" clause is explicitly NOT closed by this batch.**
  The acceptance text asks the null-vs-`[]` distinction to survive
  "snapshot round-trip and store updates." This batch proves the
  round-trip through `lib/bridge/{schema,engine}.ts` (parse, and a full
  `restore()` call), but `lib/stores/game.svelte.ts` (SPEC §5.3) doesn't
  exist yet — stores are explicitly out of scope here ("no … stores beyond
  what the bridge needs"). `requirements.yaml`'s evidence field says so
  directly so a later batch doesn't mistake this for closed.

## P2 round 01 (launch 1)

Logged by the orchestrator from developer reports and review rulings. Full verdicts in `docs/loop-log/round-01.md`.

- **Curtain machine (W1, `lib/stores/curtain.svelte.ts`).** The real counter window is `{kind:'ack', synthetic:false}`; it rests until a bridge `apply` and a fresh `next()`, and `advance()` on it throws. After a synthetic ack, control hands back to `post.active` when that isn't the acknowledger, with reason `seven-return` for SevenChoosing and `turn` otherwise; this covers the 7's round trip and a Counter-with-no-2 that cancels on an odd chain (§4.3, §4.4). Game over beats the synthetic ack (no curtain on a winning move). A dead-end SevenPick (`subKind` null) is a plain `turn` curtain. `advance()` on `none`/`result` throws `INTERNAL`.
- **The machine sees only `{active, phase}` (W1 review).** Every `pre`/`post` it takes is `CurtainView = Pick<PlayerView,'active'|'phase'>`, so the store never has to keep the mover's hand in memory across a curtain (§3.3 rule 4).
- **Handoff label (SPEC §4.5 amended).** `handoffLabel()` maps `turn`/`seven-return` to "Your turn" and `counter`/`acknowledge`/`discard` to "Your response". The internal reason never reaches the DOM before the reveal gate.
- **Hold gate (`lib/curtain.ts`).** Timer-injectable; `pointerdown` after `dispose()` is a no-op.
- **Recap (W3, `lib/recap.ts`).** Own moves use second person ("You drew a card."); §4.6 only specifies the opponent's view. A one-card discard (`hand[-1]`) reads "discarded 1 card."; §4.6 has no one-card row. `formatRecapLine` throws on a Decline because callers must filter with `isRecapVisible` first (SPEC §4.6 amended). Until `AppliedMove.targetCard` lands (round 2), a Jack steal reads "stole your point card with J♣" and one-offs carry no target clause.
- **Affordances (W2, `lib/affordances.ts`).** The ScrapIndex collapse is detected structurally (targetless OneOff candidates on the same card with distinct ScrapIndex), never by rank, and it recurses into a SevenPick's sub-moves so a 3 revealed by a 7 routes to scrap pick. A dead-end SevenPick keys as `seven:<card>|scrap` (SPEC §6.2 amended). `deriveDiscardPicker` pre-selects whenever exactly one legal move exists, which covers 1- and 2-card hands; Confirm is still required (R12). A Scuttle with no Target throws `SlotKeyError`.
- **Stores (W4).** Settings persist under `cuttle-web:settings`, separate from the game snapshot. Defaults: `themeId 'vector'`, `revealPreference 'hold'`, `reducedMotion false`, which means "no in-app override" of the OS `prefers-reduced-motion` query, never "force motion on". Settings have no schema version; bad fields fall back one by one. The session store exposes `nextDealer` (undefined on the first game, `1 - lastDealer` after) and `recordDealer`; the game store composes `NewGameOpts`. Stalemates are not tallied.
- **Enum constants** are private copies in each round-1 module, pinned to §2.5; round 2 consolidates them.
- **eslint.** `**/*.svelte.ts` rune modules go through the same `tseslint.parser` block as `**/*.svelte`.
