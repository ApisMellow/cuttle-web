# Round 04 — launch 1

**Started:** 2026-09-28
**Integration base:** `loop/integration` @ `a9c9ccb` (round-3 post-integration gate, 9/9 PASS)
**Status:** in progress — this entry captures what's known so far and gets filled in as the round continues.

## Merges

- W13 (GameScreen integration) merged at `7e6f694`. Took 2 revise cycles; B1 was a last-move leak — the idle centre-strip line read raw `lastMove`, which can be a filtered-out kind like `Decline`, telling the acting player whether the opponent held a 2. Fixed by reading the last `isRecapVisible` entry in `history` instead. See `docs/requirements.yaml` R5.2, `AGENTS.md` "Redaction rules", `.claude/agents/cuttle-svelte-dev.md`, `docs/SPEC.md` §4.3, and `docs/design.md` §6, all amended 2026-09-28.
- W14 (board polish) merged at `71bda8a`.
- W15 (pickers — DiscardPicker, SevenRevealPanel, ScrapBrowser) merged. Review verdict: accept, backed by a 240-seed real-engine corpus and no privacy leak.
- W16 (Pages deploy) merged at `4a1cc4c`. GitHub Pages is enabled at https://apismellow.github.io/cuttle-web/.
- W17 (card-face redo) merged at `40efddc` — David, after a build screenshot: the upper-left corner index rule at every size and a shorter card ratio (`--cuttle-card-aspect`, about 1.3, tunable). See `docs/design.md` §4–§7, `docs/PRD.md` A-3, and `docs/SPEC.md` §5.2, all amended 2026-09-28.
- W18 (single-Jack display) — supersedes W17's cascade treatment: only the top Jack is drawn, offset downward, with a deck-thickness edge once 2 or more are stacked; count moves to the aria-label only. See `docs/design.md` §6–§7 and `docs/SPEC.md` §5.2, all amended 2026-09-28.
- **The family beta went live 2026-09-28** at https://apismellow.github.io/cuttle-web/ via PR #5 (merge `1caba19`), with the W18 update following in PR #6 (`46d1024`).

- W19 (cleanup) landed: its tests (`web/tests/unit/staging-corpus.test.ts`, the body-margin check in `app-shell.spec.ts`) are on `loop/integration`.
- W20 (the rename) merged at `786fa9b`.
- W21 (the dimmed-card popover, R9.3) merged at `6dcf7df`. The staging store already recorded the inspect tap; this landed the popover UI. Privacy bound restated: own hand only, never hidden info (SPEC §6.1).
- W22 (the iPhone design pass) merged at `16d2507`. Retunes tokens for David's target devices (PRD §10 A-5, 2026-09-28): iPhone 15 or larger, 393×852 primary, 430×932, safe areas, and the 393×660 toolbar-shortened view where the hand and action bar stay visible and only the board scrolls. The 360×740 compact target is dropped, so the 360×740 cases in `board-fit.spec.ts`, `pickers.spec.ts` and `point-row-stacking.spec.ts` are now off-target and due to be retargeted there. `docs/design.md` §4–§7, §10 and §11 updated to match (2026-09-28).

## Docs sync (2026-09-28)

The day's in-flight decisions were back-ported to the requirements docs:

- **PRD:** new amendment A-5 (target devices); R19's width range and R11's chooser line annotated; A-4 now also records Alice/Blake sample names and the Mythic theme as a separate art thread.
- **design.md:** the compact tier (§4–§6) and the 360×740 fit rules (§10) are replaced by the iPhone targets, safe areas and the short-viewport rule; buried Jacks are never targetable (§6–§7); no board or `ScoreBar` at the ack (§8).
- **SPEC:** §5.9 retargeted; the Ace resolves by zone with no chooser (§2.6, §6.4); only the top Jack is a 2 or 9 target (§5.2, §6.3); the card ratio is the ~1.3 token with a corner index (§5.6); the idle last-move line reads the last recap-visible history entry (§4.6); the popover's privacy bound (§6.1).
- **AGENTS.md and the Svelte dev agent:** tap-target viewports, the corner-index and Jack rules, and the last-move, 7-reveal and popover redaction rules.
- **Ledger:** a targeted post-integration run at `786fa9b` (Playwright e2e 30/30 with no retries, plus the 240-seed staging corpus) backs these changes. R1.3 and R15.1 → `verified`. R6.1, R9.1, R14.1–R14.4, R15.3 and R16.3 → `implemented`. R9.3 → `in-progress`. Evidence appended without a status change to R4.3, R9.2, R11.1, R12.1, R13.2 and R19.1. Acceptance amended on R9.1 (buried Jacks), R19.1 (393/430 widths), R20.1 (last-move source) and R23.1 (aspect token). R19.5 added (safe areas and the short viewport). `docs/traceability.md` statuses resynced.

## Still open

- **Staging N1** — a test that calls `choose()` with a legal index that isn't one of the chooser's options (carried from round-03.md "Round 4 plan" (d)).
- **The R9.3 popover** — post-integration e2e across the fixture corpus, deferred from round 3 to round 4's GameScreen/board integration (W13).
- The rest of round-03.md "Round 4 plan" (g) carry-over cleanup, still outstanding:
  - The shared snapshot-peek helper (App and Home both decode).
  - Confirm the §2.10 stuck-state screen survives GameScreen integration.
  - The store comment on the curtain-before-screen ordering in `restore()`.
  - W9's board carry-overs: tapping your own point card while `zone:points` is lit; Jack moves carry `JackTarget`, not `Target`.
  - The handoff menu button (design §8) is still unbuilt.
