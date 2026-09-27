# AGENTS.md

Guidance for agent sessions working in this repo. The binding documents are
`docs/PRD.md` (requirements R1–R23, locked decisions A1–A7) and
`docs/SPEC.md` (technical contract). `docs/requirements.yaml` is the single
source of truth for "done" — do not mark anything `verified` without
attached evidence.

## Environment

- The Go engine is a **sibling checkout**, not a published module:
  `go.mod` contains `replace github.com/ApisMellow/cuttle => ../Cuttle`.
  Builds fail if `~/dev/Cuttle` is missing or moved. Engine module path is
  `github.com/ApisMellow/cuttle` (NOT the repo name `Cuttle-card-game`).
- The engine is canon. The UI implements zero game rules; every rule
  question is answered by `engine.LegalMoves` / `engine.Apply` output.

## Commands

- `go test ./...` — the Go gate. The repo is **test-first**: test files
  exist before implementations; golden fixtures (e.g. seed-42 deal in
  `internal/wasm/deal_test.go`) are authoritative, not judgment calls.
- `./scripts/build-wasm.sh` — builds the WASM bridge and reports raw/gzip
  size. Budget: ≤ 1.5 MB compressed (R18). Current: ~590 KB gzipped.
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
  vary; fixture reproducibility depends on the exact PCG stream.

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
- Open questions OQ-3 (module publish vs replace) and OQ-9 (snapshot
  redaction) are David's calls — surface them, do not resolve them.
