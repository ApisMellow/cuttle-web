# Round 02 — launch 1

**Started:** 2026-09-27
**Integration base:** `loop/integration` @ b1db703
**Rounds remaining this launch:** 9 (this is round 2 of 10)

## Bootstrap (loop-workflow §9)

- Mechanical gate on `loop/integration` @ b1db703 before round 2: **9/9 green**.
- Round-1 worktrees (`~/dev/cuttle-web-wt/r01-*`) removed by the git agent; their branches are kept, all merged.
- `frontend-design` plugin confirmed available for the post-round-2 design pass.

## Batch

Order: store, then bridge contract, then repairs, then presentational components. Each item has its own worktree branched from `loop/integration`. The items own disjoint files.

| Work item | Branch | Requirement IDs | Developer model |
|---|---|---|---|
| W5 game store + snapshot persistence | `loop/r02-store` | R4.4; R7.4 (store leg); R3.3 (unit) | Sonnet |
| W6 `AppliedMove.targetCard` through the bridge | `loop/r02-targetcard` | R20.2 | Sonnet |
| W7 repair + consolidation | `loop/r02-repair` | (gate health) | Sonnet |
| W8 vector theme seam + HandCard/PlayerHand | `loop/r02-theme` | R8.2 (unit); R23.1 (unit bullet) | Sonnet |

Review: an Opus code reviewer on every submission. No playtest judge this round, because nothing in it is judge-scored.

## Decisions mid-round

- **§4.6 amended (2026-09-27; David delegated the call to the orchestrator).** A successful `apply` also stamps `lastSeenSeq[mover]`, so a player's recap never repeats their own previous move. Handed to W5's revise developer.

## Verdicts

- **W7 (repair) — revise, cycle 1** (Opus review).
  - **Blocking:** B1. When the wasm build fails, `ci.sh` exits before printing any summary. `check` and `lint` never run, and the script's own header says it keeps going.
  - **Confirmed:** placement is right, and a fresh-artifact run is 9/9. `enums.ts` matches §2.5, checked value by value. The migration has zero runtime change. The task-4 guard caught a nested-path mutation that nothing else catches.
  - **Folded in:** `CI=1` so parallel worktrees can't share an e2e dev server on port 4173 (found in review; the same risk touched this round's concurrent gates, and the post-integration gate is the authority). Pin drift fails under CI. Comment fixes. A `node_modules` preflight.
- **W8 — accept** after revise cycle 1 (Opus re-review).
  - **All prior surviving mutations killed**, plus 12 new probes.
  - **Rulings:**
    - The `default.ts` placement is compliant; SPEC §5.6 rule 5 was amended to name it.
    - The Face/Back testids are removed. Containers own testids, faces carry none. This settles the §5.9 sweep tension.
    - The residual static-check gaps are acceptable for now: theme `.css` files, `:global`, `zoom`, `!important`, and comment-stripping inside Svelte markup.
  - **Mandatory carry-over before any second theme is registered:**
    - Extend the rule-2 scan to `lib/theme/**/*.{svelte,css}`.
    - Ban `:global`, `zoom` and `!important` in theme files.
    - Strip JS comments only inside `<script>`/`<style>`.
  - **Other carry-overs:**
    - Every card container imports `card-geometry.css` and owns its box.
    - Testid presence must not vary with move legality.
    - Re-lint after integration, because `hand-card.svelte.test.ts` isn't matched by the eslint `*.svelte.ts` block.
- **W7 — accept** after revise cycle 1 (Opus re-review; every fix reproduced by the reviewer).
  - **Confirmed:** a no-`go` run reports all 9 rows. Concurrent e2e runs on distinct ports both pass. A held port fails loudly and never tests a foreign server. Pin drift throws under CI.
  - **Carry-over:** under CI, `retries: 2` lets a flaky e2e test pass the gate. Add `failOnFlakyTests: !!process.env.CI`, or set retries to 0, before the R11 invariant e2e test lands. Also note the F4 preflight exit in the `ci.sh` header.
- **W7 revise, cycle 1 back:** B1 and F1–F4 done, with evidence.
  - **B1:** a build failure keeps all 9 rows and clears the stale wasm.
  - **F1:** `CI=1` turns a port clash into a loud failure.
  - **F2:** pin drift throws under CI.
  - **F3:** comment fixes.
  - **F4:** a `node_modules` preflight.
  - **Orchestrator addition (F5):** `CI=1` alone would make parallel developer gates fail each other on port 4173, so the e2e port is now chosen per run (`ci.sh` exports a free port; `playwright.config.ts` reads it, defaulting to 4173).
  - Then re-review.
- **W5 — accept** after revise cycle 2 (Opus final re-review).
  - **Mutations:** all 3 required mutations are caught, and the object-graph probe with the new stamp is clean.
  - **R14 A/B probe:** the acting player sees identical screens and an identical recap on the real-Decline path and the synthetic-ack path. The stamp is symmetric.
  - **Persisted `lastSeenSeq`:** it differs only because the real path has an extra Decline entry. That difference already exists in `history`/`seq`, and it's out of the threat model (OQ-9).
  - **Integration plan:** The git agent commits W5 on its branch, then brings `loop/integration` into it. The same developer adds `targetCard: null` to the `appliedMove()` factory (W6 made the field required) and fixes the stale `advanceCurtain` doc comment. Gate, then merge.
- **W5 — revise, cycle 2** (Opus re-review).
  - **Code correct on every probe:** the object-graph walk over Draw, the 7 round trip, the odd-chain cancel and restores into all 7 curtain kinds is clean. `refresh()` can't expose a non-holder. `recapFor(other)` ruled acceptable. `curtain.to === viewer` never rejects a store-written snapshot.
  - **Blocking (test only):** the index strip in `#enterWithheldCurtain` has no test; it's reachable only on the synthetic-ack handback. Also required: a failed-fetch-then-retry test (the pending-context mutation survived).
  - **§4.6 amended again (delegated):** recap dismissal also stamps `lastSeenSeq`. Otherwise an acknowledger who hands back never reaches `'none'` and sees the same entries again.
  - **Loop rule reading (loop-workflow §5):** "two revise cycles → park" is read as allowing a second cycle; a failed cycle-2 re-review parks the item with `fails +1`.
- **W5 revise cycle 1 back** (Opus developer). B1–B5, N1–N5 and the §4.6 mover stamp are all done, each B-item red-first. Gate 9/9, 327 tests.
  - A single `#enterWithheldCurtain()` null-out; a `withoutIndex()` strip.
  - `refresh()` (no argument) replaces `setViewer(p)`.
  - Restore behaves correctly for each curtain kind.
  - The snapshot shape is tightened, plus a `curtain.to === viewer` check.
  - Now in Opus re-review.
- **W5 (game store) — revise, cycle 1** (Opus review; 9/9 gate; all 3 required mutations caught). Probe tests found redaction and reload holes that the round's tests missed:
  - **B1:** after a synthetic ack hands back to the mover (the 7's round trip, or an odd-chain counter), the acknowledger's full view stays in memory behind the curtain.
  - **B2:** the mover-only `AppliedMove.index` stays in store history and recap entries across the curtain (§3.2).
  - **B3:** public `setViewer(p)` bypasses the curtain and can expose the non-holder's hand.
  - **B4:** restoring into a real counter window or into `result` leaves the store unusable.
  - **B5:** persist-before-update is tested only on `apply`; 2 mutations survived.
  - **Rulings:** client-side seed sound; `v` checked first sound; restore `pre.active = lastMove.by` sound; the `result` screen keeping the mover's envelope sound; public `setViewer` unsound.
  - **Routed:** per the plan's "Opus on revise", to a fresh Opus developer in the same worktree, with the full evidence.
  - **Open for David:** the mover's own `lastSeenSeq` is never stamped after their move, so each recap repeats their previous move. This is literal §4.6.
  - **Carry-overs for the component rounds:** the board renders only when `curtain.kind` is `'none'` or a real ack, never merely because `view` is non-null. ResultScreen renders neither hand. `session.recordResult` is wired by the ResultScreen/rematch item.
- **W8 (theme/hand):** stopped correctly at 8/9. Every component `mount()` in vitest resolved Svelte's server build, because vitest wasn't requesting the `browser` condition; `docs/vendor/svelte-5-llms.txt` has the fix under "Component testing". Orchestrator ruling: W8 owns `web/vite.config.ts` for that one change this round. The developer is applying it, confirming no regressions in the wasm-under-Node tests, and checking that the production build still succeeds.
  - **Revise, cycle 1** (Opus review; mutation-driven). Routed to a fresh Opus developer per the plan.
    - **B1:** the glyph boundary is bypassed by importing `theme/glyphs.ts`, by HTML entities, and by `\u` escapes.
    - **B2:** the OQ-13 test mounts two separate instances, so a remembered-freeze `$state` latch passes. R8.2's "no additional logic" is unproven.
    - **B3:** rule 2 is inverted. The theme components size themselves from tokens living in `lib/theme/`; the container should own the box, with the Face filling it.
    - **B4:** the frozen badge's `data-testid` is on a sub-44px span, which fails the §5.9 sweep and double-counts under the `hand-card-` prefix.
  - **Carry-over (SPEC tension, for the component rounds):** the §5.9/§7.4 "every `[data-testid]` ≥ 44px" sweep conflicts with non-interactive `mini`/`field` faces. Decide whether to scope the sweep to interactive elements or keep testids off non-interactive faces.
  - **Git note:** `web/dist/index.html` was overwritten by a `vite build` during review. Don't stage it.
  - Earlier: 9/9 with 244 tests after the `vite.config.ts` fix. The production build is unchanged, because the override is guarded by `VITEST`. In Opus review.
- **W6 — accept** after revise cycle 1 (Opus re-review).
  - **Mutations killed:** M2 and M3; M6 killed but misattributed.
  - **The S3 kind-consistency check** falsely rejected nothing across seeds 0–599: 21,274 plies, 7,487 snapshot→restore round-trips, all byte-identical.
  - **Carry-overs:**
    - `TestSPEC2_9_BadRequest` shares one bridge across randomized map entries, so failures get misattributed. Fix it with a per-case `newGame42` inside `t.Run`.
    - Fixtures (d)/(e) use a `JackOwners` order the engine can't produce.
    - `recap.ts` S1 wording.
    - Glyph tables → `lib/theme/glyphs.ts`.
- **W6 (targetCard) — revise, cycle 1** (Opus review). Production code is correct for every targeted shape the engine emits, with apply.go citations.
  - **Rank-2 on a Jack-stacked point targets the top Jack:** ruled correct. The Jack is what gets scrapped.
  - **Blocking (tests only):** two mutations in the Jack-stack special case survived, M2 (bottom Jack) and M3 (top Jack for every stacked target). Required: table cases for a Jack re-steal, a 9 or a Scuttle on a stacked point, a 2 on a two-Jack stack, and a SevenPick-wrapped 2.
  - **Folded in:** a header-comment fix, an unknown-field restore case (M6 survived), a kind-consistency check in `validateHistory`, and comment citations.
  - **Rulings:** no `Snapshot.v` bump; this follows the `subKind` precedent, and nothing has shipped yet. Glyph duplication carries over to round 3.
  - Back to the same Sonnet developer.
- **W6 (targetCard), first submission:** 9/9. It touched `curtain.test.ts` out of scope, but only to add `targetCard: null` to the fixture, because `AppliedMove` gained a required field. In Opus review.
  - **Integration hazard:** W5's `appliedMove()` factory in `game-test-support.ts` has no `targetCard`, so `svelte-check` will fail once both merge. Plan: merge W6 before W5, then W5's developer adds the field in its revise or integration pass.
  - **Glyph duplication:** `recap.ts` now carries its own Rank/Suit glyph tables alongside `lib/theme/glyphs.ts`. Asked the reviewer for a ruling.
  - **Round-3 flag, not blocking:** §5.6 rule 1 says nothing outside `lib/theme/` renders a suit glyph. §4.6 recap lines are text such as "played 7♥", and they will render in a non-theme component (RecapPanel). W8's boundary test carves out `lib/recap.ts` as a parser. Decide how RecapPanel shows card identities (a theme `mini` CardFace per §4.6 "pairs with a small card glyph", or allowed text) before the recap UI item. That may be a David decision.

## Merges

All local, nothing pushed. Integration branch `loop/integration`:

- `fec7593` docs: SPEC §4.6 amendment (mover's own moves count as seen)
- `06b6e7c` merge loop/r02-repair (`f8908bc`)
- `0599c49` docs: SPEC §4.6 recap-dismissal stamp; §5.6 rule 5 default-theme module
- `fc1059a` merge loop/r02-theme (`2a795e8`)
- `6b3733f` merge loop/r02-targetcard (`1267242`)

- `64cb289` merge loop/r02-store (`a75ac64` feature, `9780a6e` sync with integration, `b85b3d1` fixup)
  - W5's branch was cut before W6 made `AppliedMove.targetCard` required. It was synced with integration, and its developer added the field to the test factory, before the final merge. Integration never went red.

**Post-integration gate @ 64cb289: 9/9 green.** go build, wasm build, go vet, go test, svelte-check, lint, vitest (21 files, 484 tests), test:smoke 6/6, test:e2e 1/1. An interim gate after W7+W8+W6 was also 9/9 (369 tests). No post-merge failures, so nothing is reopened.

## Ledger delta

- `meta.round`: 1 → 2.
- **Newly verified:** R4.4, R7.4 (store leg closes it), R8.2 (the HandCard half closes it), R20.2 (`targetCard` closes it).
- **PARTIAL:** unit half done, e2e open, for R3.3 and R23.1.
- **Totals:** 12 verified, 61 todo.
- **`fails` counters:** all 0. Every revise resolved within the round: W7, W6 and W8 in one cycle, W5 in two.
- `docs/traceability.md` synced. Round assumptions appended to `docs/assumptions.md`, and the stale `targetCard` line there marked superseded.

## Process notes

- **Revise routing:** W5 and W8 escalated to fresh Opus developers on revise, per the plan. W6 and W7 stayed with their Sonnet developers.
- **Reviews:** the Opus reviewers' mutation testing and object-graph probes found every blocking defect this round. The developers' own suites missed them:
  - two redaction holes in the store;
  - a public curtain bypass;
  - an inverted theme-geometry contract;
  - surviving mutants in the `targetCard` special case.
- **Harness notice:** subagents twice reported the harness's session-attribution reminder as a suspected injection. It is a genuine remote-control reminder. The no-session-links rule wins, so no commit carries it.

## Next-round intent

**Before round 3 (David, 2026-09-27):**
1. **Cuttle developer playbook and role agents, in this repo.**
   - The playbook becomes a section of `AGENTS.md`: running the gate (wasm, `CI=1`, e2e port), Svelte 5 component testing (`mount`, the browser condition), reading the engine from the module cache, wire-true fixtures, and the redaction rules.
   - Role agents live in `.claude/agents/`: a bridge developer, a Svelte developer, and a reviewer carrying the mutation and object-graph probe protocol.
   - No machine-local paths anywhere. Committed through the git agent.
2. **Design pass (`frontend-design`):** a token and layout brief (palette, type, card table at 390×844, curtain screens) as a design brief plus `docs/design.md`. It must come before the judge-scored R5.1 and R19.4.

**Round 3 candidates:**
- Board layout and curtain components (R13.2–R13.4). HandoffPanel renders only `handoffLabel`, with a DOM assertion.
- GameScreen renders the board only at curtain `none` or a real ack.
- Stuck-state screen (R11.4 e2e).
- Staging and the R11 invariant walk.

**Carry-overs into round-3 briefs:**
- **Gate:** add `failOnFlakyTests: !!process.env.CI`, or set retries to 0, before the R11 e2e test lands. Note the F4 preflight exit in the `ci.sh` header.
- **`recap.ts`:** migrate its glyph tables to `lib/theme/glyphs.ts` and its MoveKind constants to `lib/enums.ts`. Fix the S1 wording.
- **Recap panel (may be a David decision):** how it shows cards, as text glyphs or theme `mini` faces.
- **Card containers:** every container imports `lib/styles/card-geometry.css` and owns its box. Containers own testids; faces carry none. Testid presence never varies with legality.
- **Theme scans:** harden them before any second theme is registered. Cover `lib/theme/**/*.css`, ban `:global`/`zoom`/`!important`, and strip JS comments only inside `<script>`/`<style>`.
- **Go tests:** give `TestSPEC2_9_BadRequest` per-case isolation, and make the `JackOwners` in fixtures (d)/(e) something the engine can produce.
- **Result and rematch:** ResultScreen renders neither hand, and the ResultScreen/rematch item wires `session.recordResult`. The seed shows only on the stuck-state screen.
- **App wiring:** pass `settings.themeId` into PlayerHand and HandCard.
- **Open policy:** decide the `Snapshot.v` bump policy for first release.
