# Round 01 — launch 1

**Started:** 2026-09-27
**Integration base:** `loop/integration` @ 7161871 (cut from `main` after PR #1's squash-merge)
**Rounds remaining this launch:** 10 (this is round 1 of 10)

## Bootstrap (loop-workflow §9)

- Mechanical gate on `loop/integration` before round 1: **9/9 green** (go build, wasm build, go vet, go test, svelte-check, lint, vitest, test:smoke 6/6, test:e2e 1/1).
- Permission check (handoff pending item): local `git` is allow-listed and only `git push` / `gh pr *` prompt. The loop pushes nothing. Git agents use single `git -C` calls to avoid compound-command prompts.
- Gap found: `docs/vendor/svelte-5-llms.txt` (SPEC §5.1, required developer reading) was never committed. W4 vendors it this round.

## Batch

Pure TypeScript logic, no components. Four work items, each in its own worktree branched from `loop/integration`.

| Work item | Branch | Requirement IDs | Developer model |
|---|---|---|---|
| W1 curtain machine | `loop/r01-curtain` | R13.1; R13.3 (unit); R14.2 (unit); R14.3 (unit) | Opus |
| W2 affordance derivation | `loop/r01-affordances` | R15.2; unit side of R9/R11 (SPEC §7.1 "Affordance derivation") | Sonnet |
| W3 recap formatter | `loop/r01-recap` | R20.2; R16.2 | Sonnet |
| W4 session + settings stores, Svelte docs vendoring | `loop/r01-session` | R1.2 (unit) | Sonnet |

**Sequencing change from the kickoff memo:** `game.svelte.ts` and snapshot persistence (R4.4, R7.4 store leg, R3.3) move to round 2. `Snapshot.curtain` is typed `CurtainState`, which W1 defines, and two parallel worktrees shouldn't both create that type.

Review: Opus code reviewer on every submission. No playtest judge this round (no UI-visible items).

## ApisMellow decisions mid-round (2026-09-27)

W1's developer found two R14 leaks in the SPEC itself. Both were escalated rather than reinterpreted (loop-workflow §10), and ApisMellow ruled:

1. **Handoff label (SPEC §4.5 amended).** The handoff screen is visible to the *acting* player, and §4.4's distinct reasons ("You may counter" / "Acknowledge" / "Choose discards") would reveal whether the opponent held a 2. Now: "Your turn" for `turn`/`seven-return`, one neutral "Your response" for `counter`/`acknowledge`/`discard`. The internal `HandoffReason` must not reach the DOM before the reveal gate.
2. **Decline never shown in the recap (SPEC §4.6 amended).** A real decline writes history; a synthetic ack doesn't. Showing "NAME let it resolve." would leak the 2 and change the screen count. W3 was updated mid-flight.

3. **`AppliedMove.targetCard` (SPEC §2.7 + §4.6 amended).** W3 showed two §4.6 rows can't be built: engine `Describe` omits the stolen card for a Jack steal ("play J♣ (steal opponent point)") and the target for one-offs ("play 9♥ as one-off"), and `AppliedMove` had no target. ApisMellow chose the bridge fix: a public `targetCard: Card | null` from the pre-state. Round-2 work item (Go bridge + schema + restore validation + formatter update). R20.2 stays open until it lands.

Other findings routed:
- `scripts/ci.sh` runs `test:unit` (which needs the built wasm for `scenario-replay.opening.test.ts`) before `test:smoke` builds it, so the gate fails on a fresh worktree. Pre-existing. Round-2 repair item.
- W1 and W4 both edited `web/eslint.config.js` to let `*.svelte.ts` parse as TypeScript (first `.svelte.ts` files in the repo). Overlapping edits; reconcile at integration.

## Verdicts

- **W4 (session/settings/vendor) — accept** (Opus review). Gate 9/9 in worktree; vendored `svelte-5-llms.txt` byte-identical to a fresh fetch (svelte 5.57.1). Round-2 carry-overs for the game-store item: derive dealer as `1 - active` after `newGame` (envelope carries no dealer) and call `session.recordDealer`; on restore, push snapshot `dealer`/`names` back into session; assert the `dealer` key is absent in first-game `NewGameOpts` (closes R1.2's wording literally); `settings.reducedMotion=false` means "no override" of the OS media query (§5.9) — reword comment; `DEFAULTS.themeId` should import the §5.6 default-theme constant once `lib/theme/index.ts` exists; add a wrong-type stored-fields test; document that stalemate isn't tallied.
- **W1 (curtain) — revise, cycle 1.** Blocking: `CurtainContext` typed `pre`/`post` as full `PlayerView`, forcing the caller to hold the mover's hand across the curtain (§3.3 rule 4). Fix: narrow to `Pick<PlayerView,'active'|'phase'>`. Also folded in: `handoffLabel()` per the §4.5 amendment, paired real-vs-synthetic R14 walk test, dispose guard. Review otherwise confirmed ~18 §4.4 rows independently and all 8 developer assumptions sound.

- **W1 (curtain) — accept** after revise cycle 1 (Opus re-review; reviewer mutation-tested the new label/paired/dispose tests on a scratch copy — each mutation caught). Carry-over for the Curtain UI item: HandoffPanel renders only `handoffLabel(reason)`, never the raw reason in text/class/`data-*`/`data-testid`, with a DOM assertion.
- **W3 (recap) — revise, cycle 1.** Blocking: one-card discard (`hand[-1]`, engine apply.go:508-511) throws in the DiscardPair regex. Folded in: "discarded 1 card." wording (assumption; §4.6 has no one-card row), SevenPick subKind whitelist, parsing-edge coverage, and ApisMellow's §4.6 SevenPick amendment ("revealed the top of the deck").

- **W3 (recap) — accept** after revise cycle 1 (Opus re-review; B1 verified against both engine discard shapes, SevenPick whitelist verified exhaustive against apply.go:549-574, untargeted scuttle confirmed unreachable at apply.go:117-120). Carry-over to the round-2 `targetCard` item: delete stale comment `recap.ts:161-164` ("can be inaccurate when the deck holds only 1 card"), fix test comment `recap.test.ts:208-209`.
- **W2 (affordances) — revise, cycle 1.** Blocking: B1 `slotKey` crashes on a dead-end SevenPick (`SubMove: null`, engine apply.go:535-541) — SPEC §6.2 pseudocode had the same `!`; amended to a `seven:<card>|scrap` slot. B2 the ScrapIndex collapse missed a 3 revealed by a 7 (routed to the chooser instead of scrap pick). Also: fixtures default unused ints to 0 (wire truth), 2-card discard pre-select pinned as a conscious choice, engine-walk test pinned to seed 2 / ply 23 with stronger assertions.

**ApisMellow, 2026-09-27:** `frontend-design` (Anthropic, `claude-plugins-official`) installed; it replaces the planned `design:design-system` pass. Front-end design pass deferred — round 2 components use functional styling on the SPEC's fixed geometry; a `design:design-system` token/layout brief lands before R5.1/R19.4 (judge-scored visuals) are scheduled.

**Integration note (eslint):** keep one block, W1's form (`files: ['**/*.svelte', '**/*.svelte.ts']` on the existing `tseslint.parser` block), carrying W4's explanatory comment; drop W4's separate block.

## Merges

All local, nothing pushed. Integration branch `loop/integration`:

- `b9f9c36` docs: SPEC amendments (§4.5 handoff label, §4.6 Decline/SevenPick wording + targetCard source, §2.7 `targetCard`, §6.2 dead-end SevenPick slot)
- `940e6d2` merge loop/r01-curtain (`d961203`)
- `f31d94f` merge loop/r01-session (`e3ab204`); the eslint overlap auto-merged into two redundant blocks and was hand-reduced to one
- `e8cd2b1` merge loop/r01-affordances (`0821b5e`)
- `08bc32f` merge loop/r01-recap (`393d623`)

**Post-integration gate @ 08bc32f: 9/9 green**: go build, wasm build, go vet, go test, svelte-check, lint, vitest (11 files, 217 tests), test:smoke 6/6, test:e2e 1/1. No post-merge failures, so nothing is reopened.

## Ledger delta

- `meta.round` 0 → 1, `meta.launch` 0 → 1.
- **→ verified (new this round):** R13.1, R15.2, R16.2.
- **→ verified (P1b `implemented` items confirmed by this launch's post-integration gate):** R1.1, R7.1, R7.3, R16.1, R18.1.
- **PARTIAL evidence added (unit half done, e2e open):** R1.2, R13.3, R14.2, R14.3. **R20.2**: every row except the Jack-steal and one-off target clauses, which wait for `targetCard`.
- Totals: 8 verified, 65 todo. `fails` counters: all 0 (each revise was resolved within the round).
- `docs/traceability.md` synced; round assumptions appended to `docs/assumptions.md`.

## Next-round intent (round 2)

Order: store, then bridge contract, then repairs, then presentational components.

1. **Game store + snapshot persistence** (`game.svelte.ts`): R4.4, R7.4 store leg, R3.3 unit. Uses `CurtainView`, `isRecapVisible`, `session.nextDealer`. Carries W4's review notes (dealer = `1 - active` after `newGame`; restore pushes dealer/names into session; first-game `NewGameOpts` has no `dealer` key).
2. **`AppliedMove.targetCard`** (Go bridge + `schema.ts` + restore validation + recap formatter): closes R20.2. Also deletes the stale `recap.ts:161-164` comment and fixes `recap.test.ts:208-209`.
3. **Repair and consolidation:** `ci.sh` builds the wasm before `test:unit` (it currently fails on a fresh checkout); a shared enums module for curtain and affordances; the dangling eslint comment; W2 notes (a real-shape duplicate-ScrapIndex guard, surfacing pin drift).
4. **Theme seam vector baseline + HandCard/PlayerHand, presentational only:** `lib/theme` `CardFace`/`CardBack` (R23.1 unit part) and HandCard frozen state from `frozenHandIndices` alone (R8.2 unit). No store wiring yet.

**Design pass (ApisMellow, 2026-09-27):** the session reloads so `frontend-design` loads, then it produces the token/layout brief before the judge-scored visual items (R5.1, R19.4). Round 2 uses functional styling on the SPEC's fixed geometry.
