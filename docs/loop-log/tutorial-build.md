# Learn to play — build log

**Built:** 2026-10-24 (UTC dates on the PRs run into 2026-10-25)
**Scope:** R25, `docs/tutorial-design.md`, executed per `docs/tutorial-plan.md` (T1–T15, five rounds)
**Integration branch:** `feat/tutorial`, cut from `main` @ `29d4afb` (the plan, #80)
**Status:** T1–T13 and T12b merged into `feat/tutorial`, and `main` synced in (#101). T14 (judge) accepted on re-check after T14fix; T14fix is merging; T15 (this docs sync) is in progress. The final merge to `main` is open.

One log covers the whole tutorial build instead of one per round, because the five rounds ran back to back in one day.

## How the build was integrated

- **Item PRs merge into `feat/tutorial`; one final PR takes it to `main`.** Pages deploys only from `main`, so no intermediate state reached players. An item could leave a half-wired state (for example a Home control before its route existed) on the integration branch. Accepted items were merged directly by the orchestrator (product-owner authorization, 2026-10-24).
- **CI on `feat/**` (#83).** `ci.yml` ran the gate only for PRs into and pushes to `main`, so the first item PR (#81) had no checks. It merged on the developer's 9/9 `scripts/ci.sh` run and the reviewer's evidence. #83 added `'feat/**'` to both the `pull_request` and `push` filters; Pages and the server deploy workflows are unchanged (`main` or manual only). #82 (T4) was opened before #83 landed, so its only gate is the push run on `feat/tutorial`. T3's PR gate was the first run over T1–T4 together: the round-1 integration check. The `ci.yml` header comment still said "main" until T15.
- **Post-merge gate.** Every merge into `feat/tutorial` triggers the gate on the push. All were green except T11's (#98 @ `31caf60`), which failed only on `TestW9_WirePrivacySweep` seed001. That is the known privacy-sweep stall (#72/#74), unrelated to the tutorial. The next push (T13 @ `4141ce4`) was green on every row, and that run is the post-integration evidence for the R25 ledger rows. T12b's push run (#100 @ `a0a38b3`) also failed only on the known `TestW9_WirePrivacySweep` stall (#72/#74).

## Items

Tier and models are listed as developer / reviewer (loop-workflow §4.5). Strict tier means test-first with red evidence and a reviewer running mutation probes. Light tier means a review that blocks only on real defects.

| Item | Tier · models | Review | PR · merge |
|---|---|---|---|
| T1 game-over spike (B6) | light · Sonnet / Sonnet | **ACCEPT.** A mutant (the pre-win envelope) proves the inert assertions can fail. **B6 PASS:** the post-win board renders cleanly and inert at curtain `none`, so the B6 fallback was never needed. | #81 · `414411f` |
| CI on `feat/**` | — | gate ran and passed | #83 · `23f5fd4` |
| T4 coach visual kit | light · Sonnet / Sonnet | **ACCEPT.** CSS keyframes instead of Svelte transitions was ruled sound (enter motion only). Other rulings: `CoachTone` is the plan's `LineTone`; components honour the setting OR the media query; `--cu-ease-land` falls back to `--cu-ease-out` under reduced motion. | #82 · `6ba1f01` |
| T2 GameScreen seam | strict · Opus / Opus | **ACCEPT**, with one required doc-comment fix: the `TableSource` comment claimed `OnlineGameStore` leaves `names` absent, but it has `names` (its room names), read through `online.names`. 10 mutants; the one survivor, dropping `!== false`, is equivalent (`GameMenu`'s `newGame` defaults to true). | #84 · `c5d78f9` |
| T3 lessons as data | strict · Opus / Opus | **ACCEPT.** Every engine checkpoint passed against v0.2.1 on the first data run, and every position, predicate, Blake-script and data-rule mutant was killed. Five copy mutants survived, so the orchestrator required a golden copy and nudge table before merge. The 4.1 copy was shortened (131 to 112 characters). | #85 · `acc49ce` |
| T8 motion base, ghost demo | light · Sonnet / Sonnet | **ACCEPT.** Carry-overs to T9: bump `playKey` for each intended play; stack the ghost above the board and below the bubble; the idle-replay timer belongs to the controller; `confirmBox` places only the static "3". | #86 · `bea07a3` |
| T6 staged-setup classifier | strict · Opus / Opus | **ACCEPT** (21 mutants), with two test-comment fixes. Review notes to T9: enter a staged state only when Confirm (or a staged counter) is present; read the GameScreen root, never `document`; clones carry no staging markers; hold the last verdict while pending; a refused Decline remounts as `fresh`. | #87 · `a4271df` |
| T7 progress, Home, lessons screen | strict · Opus / Opus | **REVISE**, test-only. **B1:** cover a blocked-storage `localStorage` getter. **B2:** a spy proving the lessons screen writes no "seen" flag. Also pins for the quiet button (no accent fill, no autofocus). Then merged. | #88 · `5a1c62c` |
| T5 `TutorialTable` | strict · Opus / Opus | **REVISE**, test-only. **B1:** a skip or a commit during a non-last narration beat. **B2:** the gate's refusal in the error phase. **B3:** `restart()` resets `wrongTries` and `lastNudge`. **N1:** the hidden-card walk. **N2:** the `pending` check. Then merged. The review also proposed public-only hooks for Blake's flights, which the orchestrator adopted for T11. | #89 · `430378b` |
| T10 `FlightLayer` | light · Sonnet / Sonnet, then Opus re-review | **REVISE**, real defects. **B1:** spreading a `DOMRect` gave NaN keyframes, so Jack and scuttle movers never moved in real browsers. **B2 (privacy):** the opponent's flights needed his private `Move`, hand index included. Fixed with a new public-only API (`FlightMove`, `snapshot`, `captureReply`). Opus re-review **ACCEPT**, plus three hardening additions, one of them that `capture` throws unless the learner is active. | #90 · `3f7095a` |
| T9 coach, overlay, routing | strict · Opus / Opus | **REVISE**, a real defect: the beat-skip `pointerdown` swallowed taps on Leave and Show me (reproduced in a real browser), which broke "Leave always works". The fix exempts the coach's own controls and `menu-button`. Also required: tests for teardown, observing the root only, Enter/Space, the error blocker and the unknown verdict; and join links ignored while the tutorial is active. Focused Opus re-review **REVISE**, test-only: a tap or Enter on the copy must still skip, and Tab must not. Then merged; the tutorial was playable end to end from this merge. | #92 · `15e9f57` |
| T12 placement, geometry e2e | light · Sonnet / Sonnet | **ACCEPT** (`promptDock` and `dockAt` checked by mutation). New `PLACEMENT.promptDock` (108); the last-resort dock slides past holes and staged cards; geometry e2e at all three viewports. | #97 · `6090190` |
| T11 lesson motion | light, with the table hooks strict · Opus / Opus | **REVISE**, test-only: `attachMotion`/detach guarantees, no win beats on a non-winning move, no testids on clones, and an audit of rest-argument hooks. All 15 hook-privacy mutants killed. Then merged. Adds `beforeReply`/`afterReply` to the table, flights for both players, the lesson-1 deal and the win beats. | #98 · `31caf60` |
| T13 walkthroughs | light · Sonnet / Sonnet | **ACCEPT** (a stale-game-save mutant was caught). Ruling: no Confirm "3" marker at 4.2's `staged-right` under reduced motion. Helper nits were deferred to T12b, which also edits `helpers/tutorial.ts`. | #99 · `4141ce4` |
| T12b coach polish *(added)* | light · Opus / Opus | **ACCEPT**: real-game Board layout byte-identical; 8 mutants killed. Post-merge push run: failed only on the known `TestW9_WirePrivacySweep` stall (#72/#74). A follow-up commit applied the deferred helper edits (real clicks in the wrong-setup helper) and added `deck-pile` to the avoid set during Blake's beats. Covers the T11 and T12 review findings: rings keyed by target, a delayed pulse, an opacity-only pulse on wide rings; board scroll padding from the score bar, every target scrolled into view; lit targets, `opp-hand`, `opponent-zone` and `deck-pile` in the avoid set; "You win!" as the headline only, in one live region; the glasses face on the 8's clone; one `OWN_CONTROLS`. | #100 · `a0a38b3` |
| T14 screenshot judge | Opus judge | **REVISE**, first pass at 393×852 on the L6 moments (the lesson 1 deal, a lesson 3 scuttle flight, the lesson 5 glasses flip, the lesson 5 win). Legibility ACCEPT, liveliness ACCEPT; pacing, whether the bubble hides what the copy talks about, and first-impression clarity REVISE. Must-fixes:<br>• **M1** the bubble covered the staged card after a real drag;<br>• **M2** the bubble hid the opponent's points row during success beats (the 3.1 scuttle);<br>• **M3** the beats were too fast at 1.2 s;<br>• **M4** Show me rendered with no demo.<br>These were routed to T14fix. **Re-check:** M1–M4 fixed in a real browser at 393×852; taste verdict **ACCEPT** on all five criteria. R25.11 is verified. | — |
| T14fix judge must-fixes *(added)* | light · Opus / Opus, then the judge's re-check | **REVISE**, test-only: Show me must release the 4.2 demo hold, plus N1–N4. Then the judge's re-check: **ACCEPT**. Changes:<br>• success and narration beats are 2200 ms;<br>• a `soft` list in `placeBubble`, fed with the move's flight boxes during beats and the step target at `staged-wrong`;<br>• re-measure on `transitionend`/`transitioncancel`;<br>• `coach-show-me` only when a demo exists;<br>• the footer reads "Lesson N/5";<br>• 1.5 spotlights the 9 and `zone-points`, and its line is "You reached 21.";<br>• lesson 4's done line names "The Rules page";<br>• the reduced-motion "3" sits above Confirm;<br>• the 4.2 demo is held until Blake's 4 lands in the prompt (`intoPrompt`), and the hold is spent when read (`takeDemoHold()`), so a restart can't carry it into another step;<br>• on a wide labelled button (the 4.2 counter option) the tap dot, ripple and reduced-motion "1" land 28 px in from its right end, clear of the label;<br>• the finale's pips fill in turn;<br>• an iris ring shows on `opp-hand` during the glasses flip. | merging |
| GEOFIX geometry regression *(added)* | light (CI fix after T14fix) | **Root cause:** lit drop targets at `selected` were hard avoid boxes. In CI a 22 px focus scroll at 393×660 in step 3.1 left no spot that cleared them, so the bubble fell back to the top dock and covered spotlit holes. **Fix:** lit targets are soft, added last so they are dropped first. Before: 7 of 20 runs failed; after: 40 of 40 pass. Regression test in `coach-controller.svelte.test.ts`. | merging |
| T15 docs sync | Opus | this item | — |

**Accepted reduced-motion exception (T13).** At step 4.2's `staged-right` no Confirm "3" marker shows. Staging the counter option removes the demo's only spot, and the Confirm ring and the bubble still lead. The R25.9 ledger row and design §8.3 record it.

**Merge order.** The plan had T11 merge before T12; T12 (#97) landed first and T11 (#98) after it. T13 merged before T12b because both touch `web/tests/e2e/helpers/tutorial.ts`.

## Rulings made during the build

Recorded in `docs/tutorial-plan.md` §4.1, reflected in the design as as-built amendments, and made contract in SPEC §5.11 where they are contract. In short: integration branch with one final PR; no three.js in v1; step 4.2 remounts the counter prompt via `{#key refusals}`; the coach nudges before Confirm; the 4.1 copy shortened; `refused` shows the bare nudge on the board while the counter's "fresh again" row shows the tap route at `wrongTries ≥ 2`; `heldLessonTable` per lesson `{#key}`; the error phase blocks the board below the score bar with the menu live; the snag line is `role="alert"`; reduced-motion markers stay visible; beat skips exclude the coach's own controls and `menu-button` (taps on the copy still skip); join links ignored while the tutorial is active; Blake's flights from public history only.

## Parallel work on `main`

Another work stream ran on `main` the same day, from branches cut from `main`.

- **QR code invites** (issue #91): PR #96, merged to `main`. `main`'s CI went red after it (run 40145932629), but only on the known `TestW9_WirePrivacySweep` stall (#72/#74); Pages deployed normally.
- **The counter fix** (issue #93, an information leak when one player holds a counter): branch `fix/93-counter-rewind`, merging to `main`. Not yet on `main` at the sync below.

**Main sync (#101).** A merge commit took `main` into `feat/tutorial` (`fa9eaea`, 2026-10-25). It brought in #96 (QR invite) with no conflicts, and the seam suites stayed green. #96 also edited `docs/requirements.yaml`, so this docs branch may conflict there when it is rebased.

**Before the final `feat/tutorial` → `main` merge:**

1. Merge `origin/main` into `feat/tutorial` again if it has moved since #101 (the #93 fix), and re-run the full gate.
2. Check the #93 change against the tutorial's counter-window seam: GameScreen's `{#key source.refusals ?? 0}` around `CounterPrompt` (SPEC §4.3). Run the T2 seam tests (`game-screen-tutorial-seam.svelte.test.ts`) and S3c (`tutorial-table.test.ts` 'S3c step 4.2 at the store', `coach-overlay.svelte.test.ts` 'S3c: step 4.2 in the DOM').
3. Open the PR `feat/tutorial` → `main`; Pages deploys from `main`.

## Ledger delta

R25.1–R25.10 and R25.12 → `verified`. The evidence is the post-integration push run on `feat/tutorial` @ `4141ce4` with the named tests (see `docs/requirements.yaml`). R25.9 carries the accepted 4.2 marker exception. R25.11 → `verified` on the T14 judge's re-check (ACCEPT on all five criteria after T14fix). `docs/traceability.md` now has R25 rows.

## Watch list

- `staging-corpus` and `game-draw-reveal-wasm` hit their 60 s timeouts twice under parallel-worktree load. Both pass alone. If it recurs, file an issue.
- Judge note for T14: with a `game.notice` showing, the notice now renders below the Learn to play control on Home.

## Known follow-ups (after T14)

- **Grey card faces on a cold cache.** On a slow network the card faces in lesson 2 can show grey until their art loads. Preload the faces when the tutorial opens.
- **The score bar's turn header wraps at 393.** "You, your turn" wraps onto a second line.
- **The 5.1 success bubble** overlaps the top of the opponent's points row.
