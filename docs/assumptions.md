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

- **Which viewer the non-`view` calls return (§2.4, §2.7).** `newGame`,
  `legalMoves`, `apply`, `describe` and `restore` return the envelope for
  `state.Active`, the actor (§4.1). The SPEC doesn't name the viewer for
  these calls. The smoke test and the scenario replayer drive whole games
  from `apply`'s return value, which only works if that envelope carries the
  new actor's legal moves. `__cuttleView(p)` is the only call that picks
  another viewer.

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
