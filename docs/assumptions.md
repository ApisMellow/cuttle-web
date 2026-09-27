# Implementation assumptions

Choices made during implementation that the SPEC doesn't pin down, logged
per section so a later batch can see the reasoning without re-deriving it.

## Batch 0 (scaffold)

- **go.mod dependency mode (David's call, resolving OQ-3).** Dropped the
  `replace github.com/ApisMellow/cuttle => ../Cuttle` directive and
  `require`d the published module at `v0.2.0` directly. `go mod tidy`
  resolves it from the public module proxy; no sibling `~/dev/Cuttle`
  checkout is required to build this repo anymore.

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
