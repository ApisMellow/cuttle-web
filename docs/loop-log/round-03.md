# Round 03 — launch 1

**Started:** 2026-09-27 (overnight, autonomous)
**Integration base:** `loop/integration` @ the round-3 prep commit (playbook, role agents, design doc, SPEC §5.3 amendment)
**Rounds remaining this launch:** 8 (this is round 3 of 10)

## Direction (product owner, 2026-09-27)

- Run the rounds back to back with no pauses in between. Stop only for a decision that belongs to the product owner.
- The goal is a playable game in a desktop web browser by morning, so this round and the next favour the playable path over working through the ledger in order.
- Build on the provisional design tokens in `docs/design.md`. The judge-scored visual items (R5.1, R19.4) wait for the design calls to be confirmed.
- The playbook (`AGENTS.md` "Developer playbook") and the role agents (`.claude/agents/cuttle-*.md`) are in use from this round. They were Opus-reviewed before first use. The product owner reviews them in the morning, and any edits apply from the next round.

## Dispatch note

The orchestrator session runs outside this repo, so the repo's `.claude/agents/` types are not registered as subagent types there. Developers and reviewers are dispatched as general-purpose agents on the model in the role file's frontmatter. Their first instruction is to read `AGENTS.md` and their role file.

## Batch

Prep commit `19439dc` added the playbook, role agents, `docs/design.md`, and the SPEC §5.3 amendment. Worktrees branch from it. All four items are Svelte, on the Sonnet developer role; an Opus reviewer checks each one.

| Work item | Branch | Scope | Requirements served (e2e verify after round-4 integration) |
|---|---|---|---|
| W9 board | `loop/r03-board` | Board and its zones, card states on HandCard, geometry 72 → 60 | R5.2, R6.1 (tap), R8.1, R9.x rendering, R10.1 |
| W10 curtain | `loop/r03-curtain` | Curtain, HandoffPanel, RevealGate, RecapPanel | R13.2, R13.3, R13.4, R20.3 |
| W11 staging | `loop/r03-staging` | `staging.svelte.ts`, StagingBar, AmbiguityChooser | R9.2–R9.4, R10.2, R11.1–R11.3, R12.1–R12.2 |
| W12 shell | `loop/r03-shell` | App screen switch, HomeScreen, ResultScreen, GameScreen skeleton, `tokens.css` | R1.3, R2.3, R3.1–R3.2, R4.3, R4.4 notice |

- **Board ↔ staging coupling:** a fixed target-key string format (`hand:i`, `deck`, `scrap`, `zone:*`, `point:o:i`, `perm:o:i`), so neither item needs the other's code. The round-4 integrator adds a shared type.
- **Round-4 plan:**
  - GameScreen integration, plus CounterPrompt (real and synthetic ack identical)
  - DiscardPicker and SevenRevealPanel
  - ScrapBrowser (browse, plus pick for the 3)
  - carry-over cleanup

## Verdicts

- **W12 (shell) — revise, cycle 1** (Opus review).
  - **What passed:** the live flow works; a probe mounted the real App and showed the tally counted once and stalemates not tallied.
  - **Blocking:**
    - **B1:** the App-level tally and Rematch wiring had no test. Four mutants survived: A (no once-guard), B (stalemates tallied), C (no `recordResult`) and K (dead Rematch).
    - **B2 (bug):** restoring into `result` re-records an already-tallied win.
    - **B3:** the R4.3 cancel e2e doesn't prove the game survives; mutant D survived e2e.
  - **Rulings:**
    - `window.__cuttleNewGame` is the SPEC §2.2 bridge surface, shipped since P1b. It's acceptable.
    - Orchestrator ruling: a snapshot resting at `result` offers Resume, which shows the result without re-tallying. "New game" over a finished game needs no abandon confirm.
  - **Folded in:** an error-boundary order test; verbatim result copy; a real no-hand DOM assertion; no raw engine message on the error screen; the error screen's "New game" goes through the abandon confirm.
  - **Routed to** a fresh Opus developer.
  - **Process:** the developer did not run red-first TDD, and the survivors show the cost.

- **W11 (staging):** submitted, 9/9 with 539 tests; in Opus review.
  - **Criteria drift for the product owner (R11.3).** The acceptance text says tapping A♥ (golden seed 42) opens AmbiguityChooser with 2 candidates. SPEC §6.4 says the Ace's two moves are "two different zones", resolved by the zone tap, and the verified `affordances.ts` suite classes them as non-ambiguous. The implementation follows SPEC.
  - Per loop-workflow §10 the orchestrator doesn't reinterpret criteria. R11.3 is noted as stalled-on-decision, to be raised in the morning report. It doesn't block playability.
- **W10 (curtain) — revise, cycle 1** (Opus review).
  - **What held:** redaction survived every leak mutation (class, data, testid, wrapper, style, seven-return label).
  - **Blocking:**
    - **B1:** no once-only latch.
    - **B2:** reason invariance is untested at the Curtain root (M7 survived).
    - **B3:** the reduced-motion ring test is vacuous (M16 and M18 survived).
    - **B4:** mini faces come only from `targetCard`, but `AppliedMove.card` is public for every played kind (engine apply.go citations), and the fixtures wrongly nulled it.
    - **B5:** the last-6 rule is untested.
  - **Orchestrator rulings (following `docs/design.md` §8 and SPEC §4.5):**
    - **A1:** "same screen, armed". One persistent screen spans `handoff` and `reveal`; the first explicit action arms it, and a continuing press becomes the hold. One `onadvance` per machine transition. The separate Continue screen is dropped.
    - **C2:** "+N earlier" sits in the lower two-thirds.
    - **B4:** a formatter-owned `recapCards(entry)` is added to `lib/recap.ts`.
  - Routed to a fresh Opus developer.
- **W9 (board) — revise, cycle 1** (Opus review).
  - **Confirmed:** key semantics match engine `Target.Owner`/`Index` (state.go:3-22, moves.go:51, apply.go:254/289/310), and redaction is clean.
  - **Blocking:**
    - **B1:** the JackStack is invisible, clipped by the row's `overflow`. Browser-measured.
    - **B2:** stolen-point keys are untested.
    - **B3:** staged/highlighted precedence is untested in three components.
    - **B4:** Board wiring mutants survive.
    - **B5:** `last-move-text` is under 44px and reflows the centre strip, which causes a vertical scroll at 360×740.
  - **Orchestrator rulings:**
    - The last-move line moves to the centre middle slot per design §6: one clamped line, fixed height, no testid.
    - A `deckEnabled` prop drives the deck's disabled style.
    - The owner marker uses a token with ≥3:1 contrast on paper.
    - DropZones becomes a well plus a sibling hit button (a11y).
  - **Carry-over to the integrator:** tapping your own point card while `zone:points` is lit; Jack moves carry `JackTarget`, not `Target`.
  - Routed to a fresh Opus developer.

### Status at 2026-09-28 morning (session handoff)

- **W12 — accept** after revise cycle 1 (Opus re-review). All 8 prior survivors killed; the new survivors are equivalent. Gate 9/9 (516 unit, 8 e2e). Carry-overs: a shared snapshot-peek helper (App and Home both decode); the §2.10 stuck-state screen replaces the generic error boundary; a store comment on the curtain-before-screen ordering in `restore()`.
- **W11 — revise, cycle 1.** One blocking gap: no test drives a rejected `apply`, so the `confirm()` `finally` is unguarded (M3 survived). The reviewer's probe found zero violations over 5,113 real-engine positions and 77,244 random stagings. Folded in: a `choose()` bounds check; widen the `probeCrossTalk` key space. **Not yet sent to the developer** (tool outage). Send it to the same Sonnet developer.
- **W9 revise cycle 1 back** (Opus developer, 9/9, 592 unit, 19 mutants killed, browser-measured). **Awaiting re-review** (not yet sent).
  - Open design question: the Jack fan covers the point card's rank. Needs a ruling: Jacks behind with a 12px peek, a taller row, or a corner index.
- **W10 revise cycle 1 back** (Opus developer, 9/9, 594 unit, about 25 mutants killed). **Awaiting re-review** (not yet sent).
  - Ruling A1 implemented: one persistent handoff/reveal screen, and the press carries over into the hold.
  - Testids `handoff`, `handoff-continue`, `reveal-gate` removed; `curtain-gate` added.
  - SPEC §4.5 wording and design.md §8's "+N earlier" position need doc amendments to match rulings A1 and C2.
  - The handoff menu button (design §8) isn't built yet.

## Merges

## Ledger delta

## Next-round intent
