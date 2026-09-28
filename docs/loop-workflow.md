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
| P0 — PRD | done | `docs/PRD.md`, this file |
| P1a — Spec docs | done (2026-08-23) | `docs/SPEC.md` (technical spec: JSON envelope schema, component breakdown, redacted-view rules, curtain state machine, test strategy) + `docs/requirements.yaml` (the ledger, seeded from PRD R1–R23 broken into machine-checkable items) + PRD/workflow amendments. **No code is written in P1a.** |
| P1b — Walking skeleton | done (2026-09-27) | Repo scaffold (Vite + Svelte 5 + Go WASM build + Playwright + CI script), the WASM bridge, the TS bridge boundary and the bridge smoke test (headless full random games through the compiled engine). Built test-first by Claude developer agents under a manager session, on its own feature branch; git ceremony via the DevOps agent. |
| P2 — Loop | fresh orchestrator session(s) | working software; loop runs until ledger is green |
| P-ART — Card art pipeline | own launches, §11; unblocked by R21's human gate | Style-locked reference set, then the massively parallel full-deck generation + consistency QA (PRD §10 A-1, R21–R23) |
| P3 — Ship | after David plays it | Fly.io deploy, PR ceremony |

The walking skeleton (P1b) is built before the loop starts because the loop needs a running skeleton to iterate on; scaffolding inside round 1 wastes a round. P-ART may run concurrently with P2 once R21 is verified — its assets integrate through the theme seam (SPEC) and never block R1–R20 work.

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
      - "e2e: tapping a hand card with legal scuttles highlights exactly the engine-legal targets (scripted scenario game, 3 positions)"
      - "e2e: tapping a non-highlighted card does not stage a move"
    verify: [e2e-test]     # unit-test | e2e-test | screenshot-judge | bridge-smoke | image-judge | human-approval
    status: verified       # todo | in-progress | implemented | verified | stalled
    evidence: "round-03: playwright run 47/47 green; judge verdict accept (round-03.md §R9.2)"
    fails: 0               # consecutive rounds this item failed a gate
```

Status meanings: `implemented` = a dev submitted it and mechanical gates passed; `verified` = its listed verification methods all passed **post-integration** and (for `screenshot-judge` items) the judge accepted. Only `verified` counts toward done.

## 4. Roles and models

| Role | Does | Model |
|---|---|---|
| **Orchestrator** | Runs rounds: reads ledger, batches work, writes briefs, dispatches, routes verdicts, integrates, updates ledger, writes logs. Never writes application code. | Claude Opus 5.5 |
| **Developer** (N per round) | Implements assigned requirement IDs in an isolated git worktree, TDD, returns a branch + test evidence. | Claude, sized per work item by the orchestrator |
| **Code reviewer** | Reviews a submission's diff against SPEC + acceptance criteria; flags correctness, contract violations (envelope/move-index/redaction), and drift. | Claude, sized by the orchestrator (Opus for high-risk diffs) |
| **Playtest judge** | Runs the built app in a browser at phone viewport (Playwright, 390×844), plays real moves, screenshots, and rules each `screenshot-judge` acceptance criterion accept/revise with written reasons. Also scores UX regressions (tap targets, overflow, curtain leaks). | Claude Opus — taste and rules-correctness verdicts are where model quality pays |
| **Art generators (P-ART)** | Generate reference candidates, then the full-deck fan-out conditioned on the locked references. Parallel batches; each worker gets the style lock + its asset list, nothing else. | Image-generation tooling (photographer-agent pipeline); orchestration by Claude, sized by the orchestrator |
| **Art consistency judge (P-ART)** | Scores every generated asset against the style lock (accept/regenerate, written reasons); samples cross-asset pairs for drift. | Claude Opus (vision) — consistency verdicts are the phase's quality gate |

**Model rule (2026-09-27):** Claude Opus 5.5 is the orchestrator, the chief of staff. All work is done by Claude models the orchestrator dispatches: it right-sizes both the work items (neither too large nor too small) and the model for each one, spending Opus where the reasoning is hard or a verdict carries risk and using a smaller Claude model where the work is mechanical. No non-Claude coding agents.

Dispatch briefs are curated: they name exact requirement IDs with acceptance criteria verbatim, the SPEC sections that bind them, the files in scope, and explicit out-of-scope lines. Developers never "scan the repo for what to do."

## 4.5 Testing policy for the family beta

Set by David, 2026-09-28 (PRD §10 amendment A-4). Splits developer and
reviewer rigor by risk, so the loop can spend Opus-grade scrutiny where a
bug is a real defect and a lighter pass where it's taste.

**Strict tier** — game rules, move wiring, hidden-information privacy
(curtain, counter prompts, redaction), save/resume:

- Test-first is mandatory. The developer's report must show red evidence
  (the failing run) before the code. A test that's green on its first run
  needs a hand-applied mutant to prove it bites.
- Opus developers.
- Opus reviewers with mutation probes, per §5 GATE(b) and the reviewer's
  mutation-testing protocol.

**Light tier** — pure look and layout:

- One render/smoke test per component, plus a screenshot or browser fit
  check.
- Sonnet developers.
- The review blocks only on real defects: broken layout, overflow,
  unreadable cards, tap targets under 44px. No mutation hunting.

**Both tiers:** reviewers keep the bar proportionate to a family beta —
block only on real defects, and list nice-to-haves as non-blocking rather
than folding them into a revise.

**Deferred to after the beta (roadmap, not scheduled into a round):**

- full per-item e2e evidence for `verified` across the ledger
- mutation testing on light-tier items
- the `failOnFlakyTests` gate
- an accessibility audit
- PWA/offline polish
- judge-scored visual reviews (R5.1/R19.4) after David's placement feedback

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

## 11. P-ART — card art pipeline

Added 2026-08-23 per PRD §10 Amendment A-1 (R21–R23). P-ART is its own loop phase because its shape is unlike code rounds: one small serial stage, one **human gate**, then a massively parallel fan-out. It runs as separate launches so principle 1.4 (no human gates *within* a launch) is preserved — the human gate sits **between** launches.

### Stages

1. **ART-1 — References (one launch).** Generate the art-direction brief and reference candidate set: card-face template (rank/suit legibility at in-game size is the binding constraint), one court-card sample, card back, table background, mascot candidate. A handful of style directions, a few candidates each. Output: candidates + a draft style-lock document (palette, line weight, framing, texture, negative rules).
2. **ART-GATE — Style lock (human gate, ends the launch).** The agent coordinator culls to a recommended set, then **David approves or redirects**. `human-approval` evidence = David's recorded pick. R21 flips to `verified` only on his approval. Rejection → ART-1 relaunches with his notes.
3. **ART-2 — Fan-out (one or more launches, fully autonomous).** All 52 faces + card back + approved auxiliaries, generated in parallel batches, every generation conditioned on the locked references. Batch size and concurrency are the art orchestrator's call; each worker receives the style lock and its asset list only.
4. **ART-3 — QA + integration.** Consistency judge scores every asset against the style lock (`image-judge`); failures regenerate (fails-counter and stall rules from §5 apply per asset group). Accepted assets are normalized (naming, dimensions, compression, ≤ 4 MB total budget per R22) and land behind the theme seam (R23) via a normal developer work item in the P2 loop.

### Ledger and git

- R21–R23 live in `docs/requirements.yaml` like everything else; ART round logs go to `docs/loop-log/art-round-NN.md`.
- Art work happens on `art/` branches, merged to `loop/integration` by the DevOps agent. Local only, no pushes, nothing to `main` — same §7 discipline. Generated assets are committed (they are deliverables, not build artifacts); keep per-asset sizes honest so the repo stays clonable.
- P-ART may run concurrently with P2 code rounds after R21 is verified. The only coupling point is the R23 integration item, which is an ordinary P2 work item.
