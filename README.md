# Cuttle Web

A graphical, mobile-first web version of the two-player card game [Cuttle](https://github.com/ApisMellow/Cuttle-card-game) — pass-and-play on one phone first, two-device rooms later. The Go engine from the parent project is the single source of rules truth, compiled to WASM for the browser.

**Status: pre-implementation.** Start here:

- [`docs/PRD.md`](docs/PRD.md) — product requirements (R1–R23, incl. §10 amendments) and locked architecture decisions
- [`docs/loop-workflow.md`](docs/loop-workflow.md) — the autonomous multi-agent loop that will build this
- [`docs/SPEC.md`](docs/SPEC.md) — technical spec (P1a output, binding for the loop)
- [`docs/requirements.yaml`](docs/requirements.yaml) — the requirements ledger, the single source of truth for "done"

Next phase: P1b — walking skeleton + test scaffolding (Codex dispatch), then the P2 loop, per §2 of the workflow doc. Card art runs as its own phase (P-ART, workflow §11).
