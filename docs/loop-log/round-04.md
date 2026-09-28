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

## In progress

- W19 cleanup — in progress.

## Still open

- **Staging N1** — a test that calls `choose()` with a legal index that isn't one of the chooser's options (carried from round-03.md "Round 4 plan" (d)).
- **The R9.3 popover** — post-integration e2e across the fixture corpus, deferred from round 3 to round 4's GameScreen/board integration (W13).
- The rest of round-03.md "Round 4 plan" (g) carry-over cleanup, still outstanding:
  - The shared snapshot-peek helper (App and Home both decode).
  - Confirm the §2.10 stuck-state screen survives GameScreen integration.
  - The store comment on the curtain-before-screen ordering in `restore()`.
  - W9's board carry-overs: tapping your own point card while `zone:points` is lit; Jack moves carry `JackTarget`, not `Target`.
  - The handoff menu button (design §8) is still unbuilt.
