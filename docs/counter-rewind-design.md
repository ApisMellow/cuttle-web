# Counter rewind: design for issue #93 (v4, final)

**Status:** ruled by ApisMellow on 2026-10-24. No open decisions. The PRD, SPEC and requirements amendments are applied (§10). There is no production code yet.
**Tier:** strict, covering rules, hidden-information privacy and save/resume.
**Engine:** needs a release, `github.com/ApisMellow/cuttle` v0.3.0.
**Priority:** online play.

> Issue #93, verbatim: *There is no reason that resolving whether or not a
> counter is used should disrupt the pattern of the game, and we don't want
> to leak the fact that the other player has a counter. We can rewind state
> if a counter is used. Get rid of the pattern where a player is consulted
> ahead of time about countering and just rewind the game if one is used.*

The examples use Alice (A) and Blake (B). Engine citations refer to v0.2.1
(`engine/…`), and cuttle-web citations to origin/main `29d4afb`.

---

## 1. What leaks today

Today, a one-off opens `PhaseAwaitingCounter` only when the opponent holds
an unfrozen 2 (`engine/apply.go:327-341`, with the check in `hasLegalCounter`
at `:489-497`). If they don't, the one-off resolves in the same call. That
asks the opponent *between* the one-off and their turn, and every leak below
comes from that question.

| Mode | How the mover learns "the opponent holds a 2" |
|---|---|
| pass-and-play | The phone goes to the opponent for a prompt only if they hold a 2 (SPEC §4.3, the old "accepted leak"). A 7's round trip and the timing of a 5's draw reveal show the same thing. |
| table mode | The handoff sub-label depends on whether a window opened (SPEC §5.10). |
| online | The hold stretches while a 2-holder thinks (`internal/server/play.go:453-469`). The window shows directly after a server restart. Raw history carries Decline entries and seq jumps. Every one-off also costs 1.5 s. |
| all | The mover's post-apply envelope reads `phase 1, active opp` (`internal/game/bridge.go:172-175`). |

---

## 2. The rule

> **RULE (ApisMellow, issue #93).** At the start of your turn, if your
> opponent's last turn was *counterable*, you may play an unfrozen 2 from
> your hand as your first action. The game is restored to the position at
> the start of their last turn, which is the end of your own last turn.
> Your 2 and the *countered cards* go to the scrap. Then you take a normal
> turn. Any other first action lets their turn stand for good.

**A turn is counterable** if the player played a one-off from their hand
during it (A, a 2 as scrap, 3, 4, 5, 6, 7 or 9), or began it with a counter.

**The countered cards** are the one-off and the counter 2 that the opponent
played from their hand in that turn. Each one goes to the scrap if it is in
that player's hand in the restored position; otherwise it stays where the
restored position has it (example in §2.2). Every other card played in the
erased turn simply goes back where it was.

**Chains.** Counters chain without any pause:
1. Alice plays a one-off.
2. Blake counters. Alice's turn is erased, her one-off and his 2 go to the
   scrap, and Blake plays a normal turn.
3. On her next turn Alice may counter back. That erases Blake's whole turn,
   both his counter and his action. The game returns to the position just
   after her one-off, both 2s go to the scrap, and Alice plays a normal turn.
4. Blake may do the same on his next turn, and so on.

Nobody acts out of turn. The one exception is the pending win (§4), which
the owner accepts.

### 2.1 What "their last turn" covers

| Rank | What a counter erases | Countered card |
|---|---|---|
| A, 2 (scrap), 6 | the one-off and its board effect | the one-off |
| 3 | the one-off; the card it took goes back to its old scrap position | the 3 |
| 4 | the one-off and the discard it left owed (§5) | the 4 |
| 5 | the one-off and both draws; those cards go back on top of the deck, in order | the 5 |
| 7 | **the whole turn**: the 7, the reveal, the pick, and everything the pick did. The counter doesn't target parts of the turn. The revealed cards go back on top of the deck, in their original order | only the 7. A one-off it picked came from the deck, so it goes back there |
| 9 | the one-off; the returned card goes back to the board and loses its freeze | the 9 |
| a counter turn | the counter and then the normal action | the counter 2, plus the action's card if that was a one-off |

### 2.2 The snapshot model

The engine keeps the position at the end of each player's last turn, as
`TurnEnd[A]` and `TurnEnd[B]`. That is the minimum chained counters need.

- **When it's taken:** once per turn, as the turn ends. That is after
  `endTurn` hands over and applies the freeze rule (§3), and before the
  incoming player's turn-start steps.
- **A restore never overwrites a snapshot.** After Blake counters,
  `TurnEnd[A]` still holds the position just after Alice's one-off, which is
  exactly what her counter-back needs.
- **Depth is one.** A saved position doesn't contain the snapshot fields.
- **Each snapshot also records** that turn's counterable flag and its
  countered cards (at most two).

| Field | After a counter |
|---|---|
| Hands (and their order), points, Jack stacks, permanents, scrap order, deck order, owed discards (§5) | **taken from the snapshot.** Cards drawn in the erased turn go back on top of the deck, in their original order |
| Scrap additions | the countered cards in play order, then the counterer's 2 on top. Each is removed from its hand by identity |
| Frozen marks | **all cleared** (§3) |
| `PassesInARow` | **0.** A counter is a card play |
| `Active`, `Phase` | the counterer. `PhaseNormal` |
| `Pending`, `Winner` | nil |
| `TurnEnd[*]` | untouched |
| History | append-only. The erased turn's entries stay, and a `Counter` entry records the rewind. Seq goes up by 1 per entry |
| `lastSeenSeq`, seed, dealer, tally | untouched |

**Example: a countered card that isn't in its player's hand.**
1. Alice plays 5♥ and draws 3♦.
2. Blake counters, so 3♦ goes back on top of the deck, and then he draws it.
3. Alice counters back, so 3♦ is in her hand again. She plays it as a
   one-off.
4. Blake counters that turn. In the restored position 3♦ is in **Blake's**
   hand, so it stays there.

The counterer's own 2 is always in their hand at the snapshot. The only 2s
that reach a hand during the opponent's turn arrive through a 9, and those
are frozen.

### 2.3 What the engine adds

- **New state fields:**
  - `TurnEnd [2]*GameState`, one level deep.
  - `LastTurn {Counterable bool; Countered []card.Card}`.
  - `Owed [2]int`, an owed-discard count per player. It is a board field, so
    snapshots save and restore it.
- **`PhasePendingWin` (5).** Its decider is `Active`, the 2-holder. Its legal
  moves are one `MoveCounter` per unfrozen 2, plus `MoveDecline`, which is
  "Let it happen" (§4).
- **`PhaseAwaitingDiscard` (3), new use.** This is the turn-start step for an
  owed discard. Its legal moves are the discard pairs (two cards at a time,
  or one card from a one-card hand), plus the Counters if the last turn was
  counterable. Each `DiscardPair` lowers `Owed`. When the debt is paid, the
  phase becomes `PhaseNormal` for the **same** player, and the turn doesn't
  end. A phase-3 state that has a `Pending` is the v0.2.x shape and keeps the
  old behaviour.
- **`LegalMoves` in `PhaseNormal`:** adds one `MoveCounter{Card, HandIndex}`
  per unfrozen 2, but only as the first move after a counterable turn.
- **`Apply(MoveCounter)`:** restore, scrap, clear the marks, set
  `PassesInARow` to 0, then run the §4 check. Any other first move removes
  the counter option.
- **`endTurn`:** applies the freeze rule (§3), takes the snapshot, sets
  `LastTurn`, then runs the turn-start order (§4).
- **Kept frozen:** `PhaseAwaitingCounter`, `CounterChain`,
  `legalCounterMoves` and `resolvePending`. They are reachable only from a
  v0.2.x save made mid-window.
- **RULES.md** changes:
  - Rewrite the one-off timing note as this §2.
  - Add §3, §4 and §5.
  - Make the 4's entry read "discards at the start of their turn".
  - Change "2 vs. 2" to describe the chain.
- **The REPL** shows `PhasePendingWin` and the owed discards.

---

## 3. Freeze rule (also fixes the v0.2.1 stale-freeze defect)

> **A card returned by a 9 is frozen for the turn that starts right after the
> 9, and for no other. A counter clears every mark.**

To get there:
- `endTurn` clears **both** players' marks; today it clears only the
  incoming player's (`engine/apply.go:837-841`).
- The 9 then sets its new mark after that clear, as it does today
  (`:762-773`).
- A restore clears all marks.

The reviewer's repro is `TestStaleFreezeBlocksCounter`. In it, Alice's 9
bounces Blake's 2-point, Blake draws, and on Alice's next turn his 2 still
carries the mark. That repro becomes a v0.3.0 regression test: the bounced 2
is frozen during Blake's next turn, so he can't counter the 9 with it, and
it's free again on the turn after. With nothing played out of turn, RULES.md's
note that returning your own stolen card "has no effect" also becomes true.

---

## 4. Win timing: "Not So Fast!" (ruled by ApisMellow, 2026-10-24)

**Wins on a turn that can't be countered** happen at once, as today
(`checkWin`, `engine/apply.go:817-826`).

**Wins on a counterable turn.** Suppose Alice reaches her threshold on a
counterable turn, whether through the one-off itself, a 7's pick, a
counter's restore, or her normal action after a counter. Her turn ends at
once. Then:

- **If Blake holds no unfrozen 2,** the game ends at once and Alice wins.
  There's no "Not So Fast!" and no button.
- **If Blake holds an unfrozen 2,** the engine enters `PhasePendingWin` with
  Blake active. "Unfrozen" uses his marks for the turn now starting, so a 2
  a 9 just returned to him doesn't count. Blake's turn has in effect started
  early with exactly two options:
  - **Counter:** drag a 2 onto the winning play, like any card play. The
    normal rewind runs and Blake takes a normal turn. Alice may counter back
    at her next turn start. That restores her winning position, and this
    rule applies again.
  - **"Let it happen"** (`MoveDecline`): the game ends and Alice wins.
- **Accepted leak:** "Not So Fast!" tells Alice that Blake holds a 2.

**Turn-start order:**
1. A pending win from the previous turn, as above.
2. The incoming player's start-of-turn win check, for points that reached
   them during the opponent's turn. If they've won, nothing is offered,
   since they'd never erase their own win.
3. The counter option, together with the owed discard (§5).
4. The normal turn.

If both players reach their thresholds in one counterable turn, the mover's
claim comes first and step 1 runs. A counter erases the opponent's points as
well. Points from a turn that can still be erased therefore never award a
win unless the player who could erase it chooses "Let it happen".

**Alice's screen (every mode).** Her win starts to play out as a victory: the
winning card lands and the win headline begins. It is then cut off by a
**"Not So Fast!"** beat, a banner over the board. It isn't a dialog and has
no buttons. Alice then waits:
- **Online:** the board stays up with the action-bar line "Blake is
  deciding…". The next `state` brings either the result screen or Blake's
  counter turn.
- **Pass-and-play and table mode:** a tap, or 3 s, raises the usual handoff
  to Blake (reason `turn`). The beat lives only in memory, like the 5's draw
  reveal; the save already holds the handoff, so a reload comes back to that
  handoff.

"Not So Fast!" appears only on Alice's screen.

**Blake's screen (every mode).** There's no dialog and no pop-up:
- He sees his normal card view and board. In pass-and-play and table mode
  that comes after the usual reveal, and after the recap of Alice's turn.
- The action bar holds one added button, **"Let it happen"**
  (`let-it-happen`, at least 44 px, one tap). The owner's example of why
  someone would press it is a win streak.
- His 2s are playable; every other card is dimmed, because it has no legal
  move.
- To counter, he drags a 2 onto the centre last-turn marker, or taps the 2
  and then the marker, then stages and confirms it like any card play.
- Nothing is selected for him, and no "which 2" chooser appears, because
  each 2 is its own card.

**Recap and lines:**
- Blake's recap of Alice's turn uses the normal lines, for example "Alice
  played 10♥ for points."
- After a counter, Alice's line is "Blake countered with 2♣ and undid your
  last turn."
- "Let it happen" is a `Decline`. The recap still hides it, and the result
  line reads the last visible entry: "Alice won by reaching 21 with the
  10♥."

---

## 5. The 4: owed discard (ruled by ApisMellow, 2026-10-24)

> *"Alice plays a 4. Nothing is discarded yet. At the start of Blake's turn,
> he either counters or discards two, then takes his turn as usual."*

**Basic.** The 4 adds 2 to `Owed[B]`, and Alice's turn ends.
- If Blake holds cards, his turn opens in phase 3. The handoff reason is
  `discard`, as today.
- If he counters, the restore brings back `Owed[B] = 0` from the end of his
  last turn, so the debt disappears with no extra code.
- Otherwise he pays the debt with `min(Owed, hand)` cards, two at a time,
  and plays on without a curtain.

**Counter-back.** Blake counters and plays. Alice counters back, which
restores the end of her 4 turn, where `Owed[B] = 2`. She plays, and the
debt waits for Blake's next turn start. There he can counter her
counter-back turn (back to `Owed[B] = 0`) or pay.

**Two 4s.** A plain sequence of 4, pay, 4, pay never stacks. A stack only
happens when Alice counters back and then plays a second 4: `Owed[B]`
becomes 4, paid two at a time. A counter there clears both, because both 4s
are erased.

**Paying again.** Blake pays with 7♦ and K♣, then plays a one-off. Alice
counters that turn. That restores `Owed[B] = 2` and puts 7♦ and K♣ back in
his hand, so he pays again at his next start, possibly with different cards.
The same applies to Alice's own payments.

**Small hands.**
- A debt bigger than the hand means discarding the whole hand.
- An empty hand pays nothing and the debt clears.
- If Blake holds 2♣ and 7♦, he can counter and keep the 7♦.

**Leaks.** None about who holds a 2. Countering or paying is the first
action of Blake's own turn, and paying without countering is no evidence
either way.

**Rejected alternative (option A, discard inside the 4-player's turn).** It
needed no new state, but it had two problems: the 4-player saw the discards
before any counter, and a hand of two cards or fewer that held a 2 had to
discard the 2.

---

## 6. Accepted consequences

- **(a) The counterer decides after seeing the effect.** The one-off has
  already happened when the opponent chooses whether to counter.
- **(b) A counter-back erases the opponent's whole turn,** including their
  action, and the counter-backer then takes a normal turn.
- **Can't unsee.** A rewind restores the position, not memory. The following
  are accepted, and none of them leaks who holds a 2:
  - A redrawn top card, including one Blake drew in a turn that was erased
    and that Alice may now draw.
  - A 7's reveal, the unchosen card included.
  - A 3's scrap pick.
  - Discards paid in a turn that was later countered (§5).
  - Glasses played through a 7's pick. These show Blake's whole hand until a
    counter removes them.
- **"Not So Fast!"** reveals that Blake holds a 2 (§4).

---

## 7. Modes and versions

**Online (the priority).**
- **Remove the hold:** delete `hold`, `checkHoldsLocked`, `answerIn`,
  `isCounterable`, `refuseHeldLocked` and the welcome's held-mover rule
  (`internal/server/play.go:31-160`, `:371-469`;
  `internal/server/frames.go:127-150`).
- **Stop sending `responding`.** Keep `-respond-min-ms` and
  `CUTTLE_RESPOND_MIN_MS` as accepted no-ops for one release.
- **Fan out at once:** every move goes to both seats immediately.
- **The pending win needs no server code.** It's an ordinary engine state
  whose `Active` is Blake.

**Protocol `v: 2`.** The changes:
- Phase 5 is new.
- Counter is now legal in phases 0 and 3.
- Phase 3 now opens a turn.
- The view gains `counterable` (public, and not derived from any hand) and
  `owedDiscards {you, opponent}` (public counts).

Those change existing meanings, so SPEC §2.12.7 requires a bump. Deploy the
server first, with the app in the same release.

**Snapshot v3** (Go `snapshotVersion` and TS `Snapshot.v`):
- A v2 save loads with no `TurnEnd` and no debt, so no counter is offered at
  that turn start.
- A v2 save made mid-window, or in an old-style discard, finishes through
  the frozen legacy paths.
- `validateState` recurses into `TurnEnd`.
- The golden transcript is regenerated.

**cuttle-ios** ports engine v0.2.1 and speaks protocol v1. Online, it gets
`UPGRADE_REQUIRED` until it ports v0.3.0 and v2; its other modes are
unaffected. Coordinate before the server deploy.

**Pass-and-play and table mode** inherit the fix, because no one is asked
anything out of turn.
- **Counters** are played from the board at curtain `none`, so they raise no
  curtain.
- **The counter affordance:** selecting a 2 lights the last-turn marker.
- **The pending win** uses the usual handoff to Blake, then Blake's board
  with "Let it happen". `CounterPrompt` and the `ack` curtain are kept only
  for legacy saves.
- **Handoffs after a one-off** are `turn`, or `discard` after a 4, whatever
  anyone holds.
- **Unchanged:** the 5's reveal before the pass and the resume gate.

**Tutorial (flag only, not edited here).** `docs/tutorial-design.md` §5.5.1
(lesson 4.2) assumes the counter prompt opens on Blake's 4. Under this rule,
Alice counters from her board at the start of her turn: she drags the 2 onto
the 4 instead of discarding. The tutorial branch needs to rework that step.

---

## 8. Test plan (strict tier, red first)

**Twin states:** two positions that differ only in whether Blake holds a 2
(with the same card count). Everything Alice can observe must be
byte-identical between them, except after her winning counterable turn,
where the difference is the accepted leak.

**Engine**
- **E1** For every one-off rank, a 7 with each kind of pick, and a counter
  turn, a non-winning `Apply` gives the same phase and `Active` in both
  twins.
- **E2** Counter is offered only as the first move after a counterable turn,
  only for an unfrozen 2, and never on the first turn. Any other first move
  removes it.
- **E3** Exact restore for each rank: the result equals `TurnEnd` plus the
  scrapped cards. The deck order, the 3's scrap index and the 9's card on the
  board all come back.
- **E4** Chains of 2, 3 and 4 counters, including the 3♦ example in §2.2.
- **E5** Freeze: the reviewer's repro, rewritten for the new rule; both sides
  cleared at `endTurn`; a counter clears all marks.
- **E6** Pending win:
  - It's entered from every win source in §4, but only when Blake holds an
    unfrozen 2. A frozen 2 doesn't count, and with no 2 the game is over.
  - Its legal moves are exactly the Counters plus Decline.
  - Decline makes Alice the winner. Counter rewinds and starts Blake's turn.
  - A counter-back brings the pending win back.
  - With both players at threshold, the mover's claim comes first.
  - The start-of-turn win is checked before the counter option.
- **E7** Owed discard: every sequence in §5 (basic, counter, counter-back,
  stacking, paying again, a 0-, 1- or 2-card hand, a debt bigger than the
  hand). The turn doesn't end after paying.
- **E8** `PassesInARow` is 0 after a counter. A random playout never panics.
  JSON round-trips. Depth stays at one.
- **E9** The legacy phase-1 and phase-3 paths still work.

**Bridge**
- **B1** Over seeds 1 to 240, the mover's post-apply envelope and `View` are
  byte-identical in both twins after every non-winning move.
- **B2** No `Decline` appears in new play except "Let it happen". Seq goes up
  by exactly 1 per move. `counterable` and `owedDiscards` are correct.
- **B3** Snapshot v3 round-trips. A v2 save and a legacy mid-window save both
  load. A malformed `TurnEnd` is rejected without a panic.

**Server**
- **S1** No `responding` frame is ever sent. Both seats get `state` at once,
  and Alice's frames are byte-identical in both twins.
- **S2** The W9 sweep exercises counters, counter-backs, a countered 7 and a
  countered 5, an owed discard and a pending win. The no-op flag is
  accepted.

**Client**
- **C1** Store twins through the real wasm: identical curtain sequences and
  saved curtains.
- **C2** The board counter affordance. The markup with nothing selected is
  identical in both twins.
- **C3** Recap and result lines, including after "Let it happen".
- **C4** Resume at a board where a counter is available, at a pending win,
  and at an owed discard. The v2 to v3 migration.
- **C5** Alice's beat: the victory start, then "Not So Fast!" with no
  dialog, then the waiting line online or the handoff in pass-and-play. It
  never appears on Blake's screen, and never when Blake has no 2.
- **C6** Blake at a pending win: the normal board, one "Let it happen"
  button and draggable 2s. Nothing is auto-selected and there's no chooser.
- **C7** The owed-discard step: the picker and the 2 drag together, then the
  turn continues with no curtain.
- **e2e** The golden deal in both twins; a counter and counter-back chain;
  a pending win settled both ways; a 4 countered at Blake's turn start.

---

## 9. Work breakdown

All work goes on one integration branch, `fix/93-counter-rewind`, with one
full gate at the end (reviewer N8). The engine is developed in
`ApisMellow/cuttle` against a local `replace` that is never committed.
Before the final gate, tag v0.3.0 and bump `go.mod`.

| Batch | Layer | Scope | Agent |
|---|---|---|---|
| 1 | engine | §2.3, §3, §4, §5, RULES.md, REPL, E1–E9 | `cuttle-bridge-dev`, briefed for the engine repo (no engine role exists) |
| 2 | bridge | `counterable`, `owedDiscards`, phase 5 and the new phase-3 uses in the view and `validateState`, snapshot v3, golden transcript, `schema.ts`, B1–B3 | `cuttle-bridge-dev` |
| 3a | server | remove the hold, protocol v2, S1–S2 | `cuttle-bridge-dev` |
| 3b | client | board counter, "Let it happen", the "Not So Fast!" beat and waiting state, owed-discard step, recap, curtain `REACHABLE`, snapshot v3, online store, C1–C7, e2e | `cuttle-svelte-dev` |
| 4 | all | tag v0.3.0, bump `go.mod`, full `scripts/ci.sh`, review, ledger; deploy the server, then the app | `cuttle-reviewer`, orchestrator |

Batches 3a and 3b run in parallel after batch 2. The tutorial rework (§7)
follows 3b on the tutorial branch.

---

## 10. Amendments applied (2026-10-24, ApisMellow)

- **`docs/PRD.md`:**
  - R14 rewritten.
  - R15 note added.
  - A-7's R14 online bullet replaced.
  - New amendment **A-9**.
- **`docs/SPEC.md`:**
  - §2.5: phase 5; phases 1 and 3 annotated.
  - §2.7: `counterable` and `owedDiscards`.
  - §2.12.4 and §2.12.5: the hold superseded.
  - §2.12.7: protocol v2.
  - §2.12.8: Q6 closed.
  - §2.12.9: the responding panel superseded; the pending-win waiting line
    added.
  - §4.1: identity.
  - §4.3: rewritten.
  - §4.4: superseding note and new rows.
  - §4.6: Counter and "Let it happen" rows.
  - §4.7: note.
  - §5.7: v3.
  - §5.10: note.
- **`docs/requirements.yaml`:**
  - R14.1–R14.4 superseded and replaced by R14.1–R14.7.
  - R24.11 replaced.
  - R15 note.
