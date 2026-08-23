# Cuttle Web — Loop-Based Implementation Workflow

**Status:** Draft for David's review
**Date:** 2026-08-23
**Companion to:** `docs/PRD.md`

This document specifies the autonomous, loop-based multi-agent workflow that implements Cuttle Web. It is written so that a fresh orchestrator session — any capable model, no prior conversation context — can open this repo, read this file, and run the loop correctly.

---

## 1. Operating principles

1. **All loop state lives on disk in this repo.** No decision, verdict, or progress fact exists only in a model's context. Any session can crash or be reloaded and the loop resumes from files.
2. **The requirements ledger is the single source of truth for "done."** Nothing is complete by assertion — only by verification evidence recorded in the ledger.
3. **Specialists own their specialty.** Developers develop, reviewers review, judges judge. When work fails a gate, it goes back to a developer with the failure evidence — the orchestrator never absorbs implementation work.
4. **Fully autonomous within a launch.** No human gates during a run. The run ends by finishing, by stalling out, or by hitting the round cap — each ends with a written report for David.
5. **The engine is canon.** Rules questions are answered by the engine's behavior and the engine repo's `RULES.md`, never by a model's memory of Cuttle.

## 2. Phases (across sessions)

| Phase | Session | Output |
|---|---|---|
| P0 — PRD | done (this one) | `docs/PRD.md`, this file |
| P1 — Spec | fresh session, reads PRD | `docs/SPEC.md` (technical spec: JSON envelope schema, component breakdown, redacted-view rules, curtain state machine, test strategy) + `docs/requirements.yaml` (the ledger, seeded from PRD R1–R20 broken into machine-checkable items) + repo scaffold |
| P2 — Loop | fresh orchestrator session(s) | working software; loop runs until ledger is green |
| P3 — Ship | after David plays it | Fly.io deploy, PR ceremony |

P1 also builds the **walking skeleton** before the loop starts: repo scaffold (Vite + Svelte 5 + Go WASM build + Playwright + CI script) and the WASM bridge smoke test (headless full random game through the compiled engine). The loop needs a running skeleton to iterate on; scaffolding inside round 1 wastes a round.

## 3. State on disk

```
docs/PRD.md               # product requirements (stable IDs R1–R20)
docs/SPEC.md              # technical spec (P1 output)
docs/requirements.yaml    # THE LEDGER — see schema below
docs/loop-log/round-NN.md # one log per round
docs/loop-log/blockers.md # stalled requirements + why (created on first stall)
```

### 3.1 `requirements.yaml` schema

```yaml
meta:
  round: 4                 # last completed round
  launch: 2                # increments each time the loop is relaunched
requirements:
  - id: R9.2               # PRD requirement, decomposed; stable, never reused
    prd: R9
    title: "Scuttle targets highlight on tap"
    acceptance:            # machine-checkable, written in P1
      - "e2e: tapping a hand card with legal scuttles highlights exactly the engine-legal targets (scripted fixture game, 3 positions)"
      - "e2e: tapping a non-highlighted card does not stage a move"
    verify: [e2e-test]     # unit-test | e2e-test | screenshot-judge | bridge-smoke
    status: verified       # todo | in-progress | implemented | verified | stalled
    evidence: "round-03: playwright run 47/47 green; judge verdict accept (round-03.md §R9.2)"
    fails: 0               # consecutive rounds this item failed a gate
```

Status meanings: `implemented` = a dev submitted it and mechanical gates passed; `verified` = its listed verification methods all passed **post-integration** and (for `screenshot-judge` items) the judge accepted. Only `verified` counts toward done.

## 4. Roles and models

| Role | Does | Model |
|---|---|---|
| **Orchestrator** | Runs rounds: reads ledger, batches work, writes briefs, dispatches, routes verdicts, integrates, updates ledger, writes logs. Never writes application code. | Sonnet/Opus-class |
| **Developer** (N per round) | Implements assigned requirement IDs in an isolated git worktree, TDD, returns a branch + test evidence. | Sonnet/Opus-class |
| **Code reviewer** | Reviews a submission's diff against SPEC + acceptance criteria; flags correctness, contract violations (envelope/move-index/redaction), and drift. | Sonnet/Opus-class |
| **Playtest judge** | Runs the built app in a browser at phone viewport (Playwright, 390×844), plays real moves, screenshots, and rules each `screenshot-judge` acceptance criterion accept/revise with written reasons. Also scores UX regressions (tap targets, overflow, curtain leaks). | **Strongest available** — taste and rules-correctness verdicts are where model quality pays |

Dispatch briefs are curated: they name exact requirement IDs with acceptance criteria verbatim, the SPEC sections that bind them, the files in scope, and explicit out-of-scope lines. Developers never "scan the repo for what to do."

## 5. One round

```
1. RECHECK    Read ledger + last round log. Select a batch of todo/revise
              items (max ~4 work items; prefer unblocking + same-subsystem
              grouping). If zero eligible items → go to TERMINATE.
2. DISPATCH   One developer per work item, parallel, isolated worktrees.
              TDD required: failing test first, then implementation.
3. GATE       Per submission, in order:
              a. MECHANICAL (hard fail): go build (incl. WASM target),
                 go test ./..., go vet, svelte-check, vitest, playwright
                 suite, lint. Any red → verdict: revise.
              b. CODE REVIEW: reviewer agent verdict accept/revise.
              c. PLAYTEST: judge runs only for UI-visible items.
              Verdicts: accept | revise (back to a developer with the
              evidence — same or fresh, orchestrator's call) | reject
              (work discarded, item stays todo with notes).
4. INTEGRATE  Merge accepted branches into the integration branch
              (`loop/integration`). Re-run the full mechanical gate
              post-merge. A post-merge failure reopens the offending
              item as revise for next round.
5. LEDGER     Flip statuses with evidence strings. Increment fails
              counters on items that failed any gate this round; reset
              on success. Item with fails ≥ 3 → status: stalled, entry
              in blockers.md.
6. LOG        Write docs/loop-log/round-NN.md: batch, verdicts (with
              judge reasoning), merges, ledger delta, next-round intent.
              Commit everything on loop/integration.
```

### Revise routing rule

A `revise` verdict returns to a **developer** with the complete failure evidence (gate output, review notes, judge screenshots + reasoning). The orchestrator never fixes code itself. Two revise cycles on the same submission in one round → park it (`fails +1`), move on.

## 6. Termination and reporting

The loop ends a launch when **any** of:

- **DONE:** every requirement is `verified` → run the **final gate**: a full agent-driven playtest of a complete game (new game → curtained turns → at least one counter chain, one Jack steal, one seven-reveal → win screen → rematch) at phone viewport, plus the full mechanical gate, on `loop/integration`. Green → write `docs/loop-log/final-report.md`, open a PR from `loop/integration` per §7. Red → reopen offending items and continue (rounds permitting).
- **ROUND CAP:** 10 rounds per launch, hard. Write a progress report (`docs/loop-log/launch-N-report.md`): verified/remaining counts, stalled items, recommended next batch. David relaunches at will; `meta.launch` increments and `fails` counters carry over.
- **ALL STALLED:** every remaining item is `stalled` → same report, plus `blockers.md` gets a per-item diagnosis and what would unblock it (a David decision, an engine change, a spec fix).

## 7. Git discipline

- All loop work happens on `loop/integration` and short-lived `loop/rNN-<item>` worktree branches. **Nothing is committed to `main`.**
- **No pushes to any remote during the loop.** Local commits only. The finished (or capped) state ends as an **open PR** to `main` — David merges; the PR click is his gate.
- Every round ends with a commit on `loop/integration` (code + ledger + log move together, so any checkout is a coherent loop state).
- Engine bugs discovered by the loop are **not** fixed in this repo: the orchestrator writes a repro + report to `docs/loop-log/engine-issues.md` and the affected requirement is marked stalled-on-engine. Engine fixes belong to the engine repo, by David's dispatch.

## 8. Budget

- **10 rounds per launch** (hard cap, §6). Stall detection (3 fails) keeps a stuck requirement from eating rounds.
- Batch size ≤ 4 work items/round keeps a round's cost bounded and verdicts reviewable.
- The playtest judge runs only on UI-visible items and the final gate — not on every submission.

## 9. Orchestrator bootstrap (start of any loop session)

1. Read `docs/PRD.md`, `docs/SPEC.md`, `docs/requirements.yaml`, and the highest-numbered `docs/loop-log/round-NN.md` (plus `blockers.md` if present).
2. Verify the mechanical gate passes on `loop/integration` as-is. If red, round 1 of this launch is a repair round (dispatch a developer; the orchestrator still doesn't fix code).
3. Announce (in the round log) the launch number, rounds remaining, and the intended first batch.
4. Run rounds per §5 until a §6 terminator fires.

## 10. What the orchestrator may never do

- Write or edit application code, tests, or styles (docs/ledger/logs are its only writes).
- Mark a requirement `verified` without recorded evidence from this launch or a prior one.
- Push to a remote, merge to `main`, or open a PR before a §6 terminator fires.
- Reinterpret a requirement's acceptance criteria. Ambiguity discovered mid-loop → the item is stalled with a note; criteria changes are a David decision at relaunch.
