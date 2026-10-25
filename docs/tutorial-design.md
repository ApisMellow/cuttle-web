# Learn to play: interactive tutorial design

**Status:** built on the `feat/tutorial` integration branch (2026-10-24), pending the merge to `main`. Decisions by ApisMellow; PRD §10 amendment A-8; ledger group R25. Build plan, progress and build-time rulings: `docs/tutorial-plan.md`. Contract: `docs/SPEC.md` §5.11.
**As-built amendments** are marked *(as built, 2026-10-24)* where the shipped tutorial differs from the original design text. Items marked T12b came with the T12b polish item (PR #100).
**Reads with:** `docs/PRD.md` (A-8), `docs/SPEC.md` (§2.4 restore, §3.3, §5.2–§5.9, §6.1), `docs/design.md` (tokens, §6–§9), `docs/requirements.yaml` (R25.x), `docs/loop-workflow.md` §4.5.
**Engine:** `github.com/ApisMellow/cuttle@v0.2.1`. Every rule claim below cites it.

---

## 1. Intent

Cuttle is easy to play and hard to learn from a rules sheet. A new player doesn't need the whole rules text. They need to see the board, make a few real moves, and watch something happen. This tutorial teaches the game in five lessons of about a minute each. Every lesson runs on the real game board and the real engine, with a coach pointing at what matters.

Why the real board and engine:

- **Nothing to unlearn.** The lesson board is the game board: same cards, same drop zones, same Confirm. A player who finishes the tutorial already knows the controls.
- **No second rules implementation.** The engine is canon (PRD §2). The tutorial authors positions and scripts. Every move it shows or accepts comes from `engine.LegalMoves`, so a lesson can't teach a rule the game doesn't enforce.
- **Cheap to keep correct.** A lesson is data: a position, a list of steps, and the opponent's scripted replies. A strict-tier test replays every lesson through the real wasm (§11).

## 2. Decisions (locked, ApisMellow)

| # | Decision |
|---|---|
| D1 | **Opt-in, never forced, never suggested.** The only way in is a "Learn to play" choice on the Home screen. The app never prompts, nudges, badges or suggests the tutorial on its own: no first-visit nudge, no pop-up, no "new here?" banner. Exit is possible at any step. Lesson progress is remembered locally, and every storage access is wrapped in try/catch, so the app works without storage. *(The first-visit nudge in the original brief was withdrawn by ApisMellow on 2026-10-24.)* |
| D2 | **Real board, real engine.** Lessons play on `GameScreen` and the real WASM engine, from authored positions loaded with the bridge's existing `restore`, against a scripted opponent. There is no AI opponent. |
| D3 | **Coach overlay.** An ink dim with a spotlight on the zone that matters, a short speech bubble, and a ghost demo of a drag or tap before the player tries it. Every lesson ends with the player making the move. A wrong move gets a gentle nudge and never a dead end. |
| D4 | **Five short lessons:** the goal; your turn (points and drawing); scuttling; one-offs and the 2; royals and glasses. |
| D5 | **Motion without three.js in v1.** CSS 3D transforms, the Web Animations API (WAAPI) and Svelte's built-in transitions. No motion library (§8.7). `prefers-reduced-motion` gets a calm, fully usable version of every effect. |
| D6 | **Lively, inside the existing design system.** Only existing tokens, themes, card art and UI primitives. Art hold: no new card art, no new themes, no generated imagery. |
| D7 | **Devices:** iPhone 15 (393×852) up to 430×932, plus the 393×660 Safari-toolbar view (PRD A-5). 360-wide is out of scope. Touch first, keyboard complete. |

## 3. Goals, non-goals, anti-goals

**Goals**

- G-T1. A player who has never seen Cuttle can, in about five minutes, say how to win, play points, draw, scuttle, play a one-off, counter with a 2, and use a Jack, Queen, King and glasses 8.
- G-T2. They learn the real controls along the way: drag or tap a card, drop it on a lit target, then Confirm.
- G-T3. The tutorial feels alive: cards deal, fly, flip and land, and wins get a moment.
- G-T4. Every rule statement in the coach copy matches engine v0.2.1 and the Rules sheet.

**Non-goals (decided)**

- The app never prompts, nudges or suggests the tutorial (D1). It is reachable only from Home.
- No AI opponent. Blake's moves are scripted and fixed.
- No tutorial for online play, table mode, the curtain or the 7, 3, 6, 9 one-offs. The Rules sheet covers the rest; lesson 4 points to it.
- No in-game "Learn to play" entry and no hints during real games. ROADMAP "Learn-as-you-play help" stays a separate item.
- No three.js, canvas or WebGL in v1 (§8.8 leaves the slot).
- No new art (D6).
- No change to real-game behaviour. The card flights (§8.4) are tutorial-only in v1.

**Anti-goals (what failure looks like)**

- A tutorial that blocks the menu, traps the player, or can't be left from any step.
- A lesson that can stall: a wrong tap that leaves no way forward, or a step that waits for something that never happens.
- A tutorial that touches the player's saved game, the session tally or their settings.
- Copy that states a rule the engine doesn't implement, or a house ruling taught wrong.
- A spotlight or bubble that covers the card or target it's talking about, the Confirm button or the menu button.
- Motion that the player has to wait for, motion that blocks input, or a reduced-motion mode that hides information.
- A lesson longer than about a minute, or a coach that talks more than it shows.

## 4. Entry and exit flows

### 4.1 Home

Home gets one new control, directly under the "Cuttle" title and above the Pass and play section: a full-width secondary pill **Learn to play** (`learn-to-play`, ≥ 44 px, `--cu-ink-raised`, 1 px `--cu-ink-line`, pearl text). A muted line under it reads "Five short lessons", or "All 5 lessons done" once every lesson is complete, or "3 of 5 done" in between. It never animates, never pulses and never carries a badge. It is a choice, not a prompt (D1).

### 4.2 The lessons screen

**Learn to play** opens the lessons screen (`tutorial-lessons`), an ordinary full screen like Home:

```
┌───────────────────────────────┐
│ ‹ Home                         │  tutorial-lessons-back (44×44 hit)
│ Learn to play                  │  --cu-text-xl
│ Five lessons, about a minute   │  muted --cu-text-sm
│ each. Leave any time.          │
│ ┌───────────────────────────┐ │
│ │ 1  The goal            ✓  │ │  tutorial-lesson-1  (≥ 56 px)
│ │    Race to 21             │ │
│ ├───────────────────────────┤ │
│ │ 2  Your turn              │ │
│ │    Points and drawing     │ │
│ │ …                         │ │
│ └───────────────────────────┘ │
│ [   Continue: lesson 3      ] │  tutorial-continue (ochre pill)
└───────────────────────────────┘
```

- The numbers are a real sequence, so they're shown. A done lesson shows a ✓ in ochre (the design system's "chosen" accent) plus "done" for screen readers.
- Any row starts that lesson; finished lessons can be replayed.
- The primary pill reads "Start" (nothing done), "Continue: lesson N" (the first unfinished lesson), or "Play again from lesson 1" (all done).
- Back (and Escape) returns Home.

### 4.3 In a lesson

The lesson renders `GameScreen` with the tutorial's table source (§6) and the coach overlay on top. Three exits are always available, and none of them asks "are you sure?" because nothing is lost:

1. **Leave** in the coach bubble footer (`coach-leave`) goes to the lessons screen.
2. **Menu, then Home** (the existing `menu-home`) goes to Home. The menu also keeps Rules and Card style. **New game is hidden** during the tutorial (§6.3).
3. On the lesson-done sheet, **Lessons** goes to the lessons screen.

A browser reload during a lesson returns to Home. The lesson isn't saved mid-way, because lessons are a minute long.

### 4.4 End of a lesson

When the last step's move lands, the success beat plays (§8.6) and the **lesson-done sheet** (`coach-lesson-done`) rises over the action bar:

- Heading: "Lesson 2 done" (the final one says "You've learned Cuttle")
- One summary line (the "Done" line in §5)
- Five progress pips (done in ochre, others `--cu-ink-line`), with the screen-reader text "2 of 5 lessons done"
- Buttons: **Next lesson** (ochre, `coach-next-lesson`) and **Lessons** (ghost, `coach-lessons`). After lesson 5: **Play a game** (ochre, `coach-play`, goes Home) and **Lessons**.

The lesson is marked done (§10) as soon as the sheet appears.

## 5. The lessons

### 5.1 Conventions

- **Seats.** Seat 0 is the learner. In docs and tests the learner is **Alice** and the scripted opponent is **Blake**. On screen the opponent is "Blake". The learner's own label comes from the last-used Player 1 name in settings, or "You" when there isn't one (builder's call B1).
- **Cards.** Positions name cards as rank plus suit initial (`9D` = nine of diamonds; suits C < D < H < S, `card/card.go` Suit constants). **Coach copy names cards in words only** ("your 9", "his 8 of clubs"), never with suit glyphs. SPEC §5.6 rule 1 forbids glyphs in component source, and `theme-glyph-boundary.test.ts` enforces it.
- **Positions.** Each lesson starts from an authored, structurally valid engine state: Alice to move (`Active` 0), `Phase` 0, empty history, no Jacks, no frozen cards. Every card the lesson doesn't name sits in the deck after the named top cards, in canonical order (clubs A–K, then diamonds, hearts, spades). The 52 cards are unique and accounted for (enforced by test, §11).
- **Step kinds.** `next` (the bubble's Next button), `move` (a legal move matching the step's predicate is applied), `appear` (an element with the given testid appears).
- **Spotlight stages** for a `move` step follow the staging pipeline, read from the DOM (§7.2). *Idle*: the card to play. *Selected*: the card plus its target. *Staged, right move*: Confirm, with the step's "staged" line. *Staged, wrong move*: Cancel, with the step's nudge plus "Tap Cancel to try again." (§7.2, ruling 2026-10-24). The "Wrong-move nudge" column below is used twice: before Confirm (staged wrong) and at commit (the gate, §6.2).
- **"Blake replies"** are scripted moves applied after the learner's move lands, following a short pause (§6.2).
- Copy length: the bubble holds at most 3 lines at 393 wide (about 120 characters). Every draft below fits. A staged-wrong line (a nudge plus "Tap Cancel to try again.") may take 4 lines, and bubble placement reserves room for 4 (§7.3).

### 5.2 Lesson 1, The goal (race to 21)

**Position:** Alice hand 9D 4S 2C; Alice points 7H 5C (12). Blake hand (5, face down) 3D 6S JC QD 8H; Blake points 10S (10). Scrap KC 4H (4H on top). Deck 39.

On entry the deal plays (§8.5).

| Step | Kind | Spotlight | Coach copy | Demo | Expected | Wrong-move nudge | Success |
|---|---|---|---|---|---|---|---|
| 1.1 | next | `score-bar` | "Cuttle is a race. First to 21 points wins. You have 12. Blake has 10." | — | — | — | — |
| 1.2 | next | `opponent-zone` | "This is Blake's side. His hand stays face down. Cards he plays land here." | — | — | — | — |
| 1.3 | next | `center-zone` | "In the middle: the deck you draw from, and the scrap pile, where used cards go." | — | — | — | — |
| 1.4 | next | `player-zone` | "This is your side. Only you see your hand. Cards you play go in the rows above it." | — | — | — | — |
| 1.5 | move | idle `hand-card` 9D *(as built: and `zone-points`)* · selected + `zone-points` · staged `staging-confirm` | idle/selected: "Your 9 gets you to 21. Drag it onto your Points row." staged: "Nothing counts until you confirm. Tap Confirm." | drag 9D to `zone-points`, then tap `staging-confirm` once staged | PlayPoint 9D | 9D on Blake's 10S (a 9 one-off): "That would send his 10 back to his hand. This time, put your 9 on your Points row." Anything else: "Not this one. Your 9 gets you to 21." | "You reached 21." under the "You win!" headline, plus the win wave (§8.6) |

*(As built, 2026-10-24, T12b.)* The 1.5 success line was "21. You win!". "You win!" is now only the bubble's headline, which sits in the same live region as the line (§8.6, §9), so the win is shown and announced once. *(As built, 2026-10-24, T14fix.)* The line became "You reached 21." (the bare "21." read as a fragment), and the idle spotlight at 1.5, the learner's very first move, lights `zone-points` as well as the 9.

**Done line:** "You know the goal: reach 21 first."
**Engine:** PlayPoint wins on the spot when the total reaches the threshold (`engine/apply.go:174-192`, `checkWin` `:817-826`, `Threshold` `engine/win.go:5-18`). Legal for 9D here: PlayPoint, and a 9 one-off on Blake's 10S (`apply.go:70-87`). A 9 can't scuttle a 10 (`card/card.go:51-56`).

### 5.3 Lesson 2, Your turn (points and drawing)

**Position:** Alice hand 7C 3D; Alice points 5S (5). Blake hand 6D AC 9S QH 4C; Blake points 4H (4). Scrap empty (so the 3 has no one-off, `apply.go:98-111`). Deck 43, top 10D then 8S.

| Step | Kind | Spotlight | Coach copy | Demo | Expected | Wrong-move nudge | Success |
|---|---|---|---|---|---|---|---|
| 2.1 | move | 7C → `zone-points` → Confirm | "Each turn you do one thing. Play your 7 for points." staged: "Tap Confirm." | drag 7C to `zone-points` | PlayPoint 7C | 7C on Blake's 4H (scuttle): "Knocking out his cards is the next lesson. Play the 7 for points." 7C on the middle spot (one-off): "That uses the 7's power. For now, play it for points." 3D: "Your 7 is worth more. Play the 7." Draw: "First, play your 7 for points." | "Your points add up: 5 and 7 make 12." |
| — | Blake | — | "Blake's turn." then "Blake played a 6. He has 10." | — | Blake: PlayPoint 6D | — | — |
| 2.2 | move | `deck-pile` → Confirm | "No good play? Draw a card instead. Tap the deck, then tap it again." | tap `deck-pile` twice | Draw | 3D for points: "That works in a real game. Here, try drawing a card." | "You drew a 10. Drawing uses up your turn too." |
| — | Blake | — | "Blake drew a card." | — | Blake: Draw | — | — |
| 2.3 | next | `player-hand` | "You can hold up to 8 cards. With 8 in hand, you can't draw." | — | — | — | — |

**Done line:** "One thing per turn: play a card or draw."
**Engine:** Draw needs a non-empty deck and a hand under 8 (`apply.go:34`, `HandLimit` `:11`). A second deck tap confirms a staged draw (SPEC §6.1, issue #24). 7C also offers a 7 one-off (`apply.go:124-126`) and a scuttle on 4H (`apply.go:112-123`); both are nudged.

### 5.4 Lesson 3, Scuttling

**Position:** Alice hand 10H 8H 4C; Alice points 6S (6). Blake hand 8C 5D JH 3S; Blake points 9D 6C (15). Scrap QC 2S. Deck 40.

| Step | Kind | Spotlight | Coach copy | Demo | Expected | Wrong-move nudge | Success |
|---|---|---|---|---|---|---|---|
| 3.1 | move | 10H → Blake's points row (`point-1-0`, `point-1-1`) → Confirm | "Blake has 15. Knock some out: drop your 10 on one of his point cards." staged: "Both cards go to the scrap. Tap Confirm." | drag 10H to `point-1-0` | Scuttle with 10H, either target | 10H for points: "That adds 10, but Blake keeps his 15. Drop the 10 on his cards." 4C one-off: "A 4 makes him discard. Try a scuttle instead." Other: "Use your 10 on one of his point cards." | "Scuttled. His card and your 10 both go to the scrap." |
| — | Blake | — | "Blake played an 8." | — | Blake: PlayPoint 8C | — | — |
| 3.2 | move | 8H → `point-1-<8C>` → Confirm | "Same number? The higher suit wins: clubs, then diamonds, hearts, spades. Your 8 of hearts beats his 8 of clubs." | drag 8H to Blake's 8C | Scuttle 8C with 8H | 8H on 6C: "That works too. Try the tie: your 8 on his 8." 8H anywhere else: "Put your 8 on his 8." | "Hearts beat clubs. Scuttled." |

**Done line:** "Scuttle with a bigger card, or the same number in a higher suit."
**Engine:** `Beats` is "higher rank, or the same rank and a higher suit" (`card/card.go:49-56`); a scuttle scraps both cards (`apply.go:243-268`). The step-3.2 target is found by card identity (8C), not by index, so it holds whichever card 3.1 took.

### 5.5 Lesson 4, One-offs and the 2

**Position:** Alice hand AS 2H 5C; Alice points 3D (3). Blake hand 4D 7S KC 9C (no 2); Blake points 10C 9H (19). Scrap JD 6H. Deck 40.

| Step | Kind | Spotlight | Coach copy | Demo | Expected | Wrong-move nudge | Success |
|---|---|---|---|---|---|---|---|
| 4.1 | move | AS → `zone-oneoff` → Confirm | "Blake has 19! Your Ace has a one-off power: it wipes every point card off the table. Drop it on the middle spot." *(as built; see below)* | drag AS to `zone-oneoff` | OneOff AS | AS for points: "On your Points row an Ace is just 1 point. Drop it on the middle spot to use its power." 5C one-off: "A 5 draws 2 cards, but Blake would still have 19. Use the Ace." Other: "Use your Ace. Drop it on the middle spot." | "Wiped, yours too. A one-off happens right away, then goes to the scrap." |
| — | Blake | — | "Blake's turn." | — | Blake: OneOff 4D. Alice holds a 2, so the engine opens a counter window and the counter prompt appears. | — | — |
| 4.2 | move | `counter-option-*` (the 2) → `staging-confirm` inside `counter-prompt` | "Blake played a 4: you'd have to throw away 2 cards. You hold a 2, so you can stop it. Tap your 2, then Confirm." staged: "Tap Confirm to stop his 4." | tap the counter option, then Confirm | Counter with 2H | "Let it resolve": "Letting it happen costs you 2 cards. Use your 2: tap it, then Confirm." (Refused by the gate; the prompt remounts fresh, §5.5.1.) | "Stopped. His 4 does nothing, and his turn is over." |

*(As built, 2026-10-24, T3.)* The 4.1 main line was "Blake has 19, so close. Some cards have a one-off power. Your Ace wipes every point card off the table. Drop it on the middle spot." At 131 characters it broke the 120-character bubble limit (§5.1), so it was shortened to the line in the table (112 characters).

**Done line:** "A one-off happens at once, and only a 2 can stop it. The Rules page in the menu lists every one-off." *(As built, 2026-10-24, T14fix: was "Rules in the menu lists every one-off.")*
**Engine (house rulings, verified):** A one-off resolves at once unless the opponent holds an unfrozen 2 (`apply.go:324-341`, `hasLegalCounter` `:489-497`). Blake holds no 2, so the Ace resolves immediately and wipes both sides (`resolveOneOffWith` case Ace, `apply.go:626-634`). The Ace resolves by where it's dropped: the middle spot is the one-off, the Points row is points, and no chooser opens (PRD R11 clarification, SPEC §6.4). Blake's 4 opens a window because Alice holds 2H. Countering makes the chain odd, so the 4 is cancelled, both cards are scrapped, and the turn passes back to Alice (`MoveCounter` `apply.go:342-365`, `resolvePending` `:591-608`). Rules sheet wording: `ONE_OFF_TIMING` in `lib/cardText.ts`.

#### 5.5.1 Step 4.2 in full: the counter window (decided call, ApisMellow, 2026-10-24)

`CounterPrompt` is once-only: after any of its buttons fires, it sets `acted = true` and ignores every later tap until it unmounts (`CounterPrompt.svelte:61-81`). "Let it resolve" goes straight to `applyMove` through `GameScreen.resolveAck`. If the gate refuses that Decline and nothing else changes, the prompt stays mounted and locked, which is a dead end. **Ruling (option (a), minimal form):** GameScreen keys the `CounterPrompt` on the source's refusal counter (§6.3), so a move the gate refuses remounts a fresh prompt. There is no logic change inside `CounterPrompt`.

The curtain stays `{kind:'ack', to:0}` for the whole window. It never drops to `none`, so the board never mounts while the counter window is open (SPEC §4.2: the live view comes only after the ack).

| State | How the coach knows | Spotlight | Copy | Learner can |
|---|---|---|---|---|
| Fresh prompt | `counter-prompt` present, no `staging-confirm` inside it | the counter option for 2H | the step's main line | tap the 2 (stages it), or Let it resolve |
| Counter staged | `staging-confirm` inside `counter-prompt` | `staging-confirm` | "Tap Confirm to stop his 4." | Confirm (the expected move: applied, step done) or Cancel (back to Fresh, same instance) |
| Let it resolve tapped | the gate refuses the Decline: no engine call, nudge set, `refusals` + 1 | — | — | — |
| Fresh again | GameScreen's `{#key}` remounts the prompt: `acted` and `staged` reset, heading focused, key guard re-armed | the counter option, demo replays once | "Letting it happen costs you 2 cards. Use your 2: tap it, then Confirm." (after two refusals, the §7.4 tap-route line) | everything in the first row again |

The window has only one legal Counter (2H), so a staged counter is always the right move: the staged-wrong check of §7.2 never applies inside this prompt. Its only wrong move is the one-tap Decline, which the remount handles. A test pins every row (S3, S4).

*(Note 2026-10-24: this step is built on the legacy counter prompt. It must be reworked when the #93 client work lands; see `docs/counter-rewind-design.md` §7.)*

### 5.6 Lesson 5, Royals and glasses

Glasses come first, so the learner sees Blake's Queen before he plays it.

**Position:** Alice hand JD JS 8C KH; Alice points 8S (8). Blake hand QS 5H 3C 6D; Blake points 7D 3H (10). Scrap 2D 4S. Deck 39, top AD.

| Step | Kind | Spotlight | Coach copy | Demo | Expected | Wrong-move nudge | Success |
|---|---|---|---|---|---|---|---|
| 5.1 | move | 8C → `zone-permanents` → Confirm | "An 8 can be glasses. Put it in your Permanents row and you'll see Blake's hand." | drag 8C to `zone-permanents` | PlayPermanent 8C | 8C for points or a scuttle: "Put the 8 in your Permanents row instead, as glasses." KH: "Save your King for the finish." A Jack: "Jacks are next. First, the 8." | "Now you can see his cards. He's holding a Queen." Blake's hand flips (§8.4). |
| — | Blake | — | "Blake drew an Ace. You saw it." | — | Blake: Draw (AD) | — | — |
| 5.2 | move | a Jack → `point-1-<7D>` → Confirm | "A Jack steals. Drop one on his 7, and that 7 counts for you." | drag JD to Blake's 7D | Either Jack steals 7D | A Jack on 3H: "That steals 3 points. His 7 is worth more." KH: "Save your King for the finish." | "Stolen. You have 15, he has 3." |
| — | Blake | — | "Blake played his Queen." | — | Blake: PlayPermanent QS | — | — |
| 5.3 | appear `card-detail-popover` | the Jack still in Alice's hand (found by rank) | "His Queen protects his other cards. Tap your other Jack and see." | tap the remaining Jack | — | — | (The popover shows the existing reason, "Their Queen protects their cards from your Jack.") |
| 5.4 | move | KH → `zone-permanents` → Confirm | "A King lowers the points you need to win. With one King you need 14. You have 15." | drag KH to `zone-permanents` | PlayPermanent KH | Draw: "Play your King." | "You need 14, and you have 15." under the "You win!" headline, plus the win wave |

*(As built, 2026-10-24, T12b.)* The 5.4 success line was "You need 14, and you have 15. You win!". As at 1.5, "You win!" is only the headline now (§8.6, §9).

**Done line:** "That's Cuttle. Jacks steal, Queens protect, Kings lower your goal, and an 8 can be glasses. You're ready to play."
**Engine:** Glasses are an 8 as a permanent (`apply.go:127-129`, `:232-242`), and the view shows the opponent's hand to its owner (SPEC §3.2). A Jack moves the point card to Alice's side (`apply.go:201-230`). A Queen blocks every Jack target (`apply.go:88-97`), so the remaining Jack has no move and is dimmed; tapping it opens the popover with `BLOCKED_REASON.jackQueen` (`lib/cardText.ts`). A King lowers the threshold to 14 (`engine/win.go:5-18`). Playing a permanent checks for a win right away (`apply.go:235-241`), so 15 ≥ 14 wins on the spot. **Why this order:** an 8 for points while holding 15 would win (23 ≥ 21), so glasses come before the steal; with 8 points, 8C for points makes only 16.

### 5.7 The finish

After lesson 5's win wave, the sheet reads "You've learned Cuttle" with **Play a game** and **Lessons**. Tutorial total: about five minutes.

## 6. Architecture: hooking GameScreen without forking it

```
App.svelte ── screen 'tutorial' ──┬── TutorialLessons.svelte          (lessons screen)
                                  └── {#key lessonId}
                                       ├── GameScreen source={tutorialTable}   (unchanged board)
                                       └── CoachOverlay.svelte                 (scrim, bubble, demo, flights)
lib/tutorial/
  lessons.ts          lesson data: positions (engine-state JSON), steps, predicates, Blake scripts, copy
  table.svelte.ts     TutorialTable implements TableSource: restore, apply gate, Blake replies
  tutorial.svelte.ts  TutorialStore: active, screen, lessonId, stepIndex, coach line, progress
  progress.ts         storage (cuttle-web:tutorial), try/catch, decode
  match.ts            pure: move predicate vs MoveView (+ public view for target identity);
                      the staged-setup matcher (page state + legal moves → right / wrong / unknown, §7.2)
  motion.ts           pure-ish: flight plans per move kind, durations, reduced-motion switch
lib/components/
  CoachOverlay.svelte, CoachBubble.svelte, CoachSpotlight.svelte,
  GhostDemo.svelte, FlightLayer.svelte, LessonDoneSheet.svelte, TutorialLessons.svelte
```

### 6.1 Positions and the restore mechanism

The bridge already restores any structurally valid snapshot: `__cuttleRestore(snapshotJson, viewerId)` (SPEC §2.4) runs `decodeSnapshot` (`internal/game/snapshot.go:122-153`), which checks shape (`validateState`, `internal/game/bridge.go:309-379`) and never game rules. A lesson position is therefore one snapshot string in the bridge's own format:

```json
{"ok":true,"v":2,
 "state":{"Players":[
   {"Hand":[{"Rank":9,"Suit":1},…],"Points":[{"Card":{"Rank":7,"Suit":2},"Owner":0,"JackStack":null,"JackOwners":null},…],"Permanents":null,"FrozenIDs":null},
   {"Hand":[…],"Points":[…],"Permanents":null,"FrozenIDs":null}],
  "Deck":[…],"Scrap":[…],"Active":0,"Phase":0,"Pending":null,"PassesInARow":0,"Winner":null},
 "history":[],"seed":"0","dealer":1}
```

- Positions are authored as data in `lib/tutorial/lessons.ts` (numeric Rank/Suit, no glyphs) and serialized to this string at load. Authoring a position is writing, not reading: no TypeScript ever reads inside an engine state that came back from the bridge (SPEC §3.3).
- Every authored point entry has `JackStack: null, JackOwners: null` (no Jack starts on the board). `[]PlayerID` marshals as base64 (SPEC §2.8), so the authoring format avoids non-empty `JackOwners`.
- `validateState` doesn't check that the 52 cards are unique. The strict test does (§11).
- This is the same mechanism as R4 resume, given a different source. No bridge or engine change is needed.

### 6.2 `TutorialTable`, the third `TableSource`

`GameScreen` already reads only the `TableSource` interface (W10, `lib/stores/tableSource.ts`). `TutorialTable` is the third implementation, after `GameStore` and `OnlineGameStore`.

| Field | Tutorial value |
|---|---|
| `envelope` | Always `view(0)`, Alice's own envelope. Never Blake's. |
| `viewer` | `0`, always. |
| `history` | `envelope.history`, already redacted for seat 0 by the bridge. |
| `seq` | `history.length`. |
| `curtain` | `{kind:'none'}`, or `{kind:'ack', to:0}` while the engine is at `PhaseAwaitingCounter` with Alice active (lesson 4.2), so GameScreen mounts the real `CounterPrompt`. The ack holds for the whole counter window, refusals included: it never drops to `none` mid-window (§5.5.1). Never a handoff, reveal, recap or result: there's one player at the phone. |
| `refusals` *(new optional field, §6.3)* | Starts at 0; the gate adds 1 for every move it refuses. |
| `drawReveal` | `null` (no lesson resolves a 5 for Alice). |
| `pending` | `true` while Blake is "thinking" (the board is inert and Confirm disabled, as for online play). *(As built: from the learner's match until Blake's last reply lands, on steps Blake answers; plan P3.)* |
| `names` *(new optional field, §6.3)* | `[learnerName, 'Blake']`. |
| `allowsNewGame` *(new optional field, §6.3)* | `false`. |
| `apply(i)` | The gate. See below. |
| `goHome()` | Ends the tutorial and goes Home. |
| `newGame()` | Restarts the current lesson. Only the DEV test hook calls it. |
| `advanceCurtain()`, `dismissDrawReveal()` | No-ops. |

**The apply gate (strict tier).** Every move the learner makes, whether by tap, drag, the deck's second tap, Confirm, a counter option or "Let it resolve", reaches `source.apply(i)`. GameScreen has exactly one path to it (`applyMove`), and StagingStore has one caller (`confirm`). In `apply(i)`:

1. Read `envelope.legalMoves[i]` and test it against the current step's predicate (`match.ts`: kind, card identity, and target card identity read from Alice's public view).
2. **No match:** apply nothing. Set the coach's nudge line (the step's specific nudge if one matches, else its generic one), add 1 to `refusals`, and resolve the promise normally. On the board, `StagingStore.confirm` then clears to idle (`staging.svelte.ts:352-371`). At the counter prompt, the `refusals` change remounts a fresh prompt (§5.5.1). Either way the screen is exactly as before and nothing can be stuck. No error is thrown, so GameScreen's `report` never logs. With the pre-Confirm check (§7.2) this is a backstop: on the board it fires only when the learner taps Confirm on a setup the coach already flagged, or on a setup the check marks "unknown".
3. **Match:** call `motion.capture(move)` synchronously (the pre-apply rects, §8.4), then `engine.apply(i)`. Drop the returned envelope (it is the mover's; for Alice it equals `view(0)`). Fetch `view(0)`, set the state, and advance the step. Then, if the step has Blake replies, set `pending = true` and schedule them (below).
4. Engine errors (`ok:false`) set a tutorial error. The coach shows "This lesson hit a snag." with **Restart lesson** and **Leave**: never a dead end.

*(As built, 2026-10-24.)*
- **Outside a move step** the gate refuses every commit (plan P1): "Tap Next first." at a `next` step, "First, tap your other Jack." at 5.3, and no copy change once the lesson is finished or in error.
- **Step 3's capture** is a hook, not a direct call. `TutorialTableDeps.beforeApply(move, view)` runs before the engine apply and `afterApply()` after the state is set. Both are learner-only and wrapped in try/catch, so a motion failure never breaks a lesson.
- **The snag** also covers a view that isn't seat 0's. While it shows, the overlay blocks the board below the score bar; the menu row, Restart lesson and Leave stay live.

**Blake's replies.** Each scripted reply is a structured predicate (`{kind, card, target?}`), not a list index. After the think pause (700 ms; 400 ms under reduced motion), the table calls `engine.legalMoves()` for Blake's legal list. Exactly one move must match the predicate (zero or several is a script error, see step 4). The table applies it, fetches `view(0)`, and sets `pending = false`. Blake's legal-move envelope lives only in a local variable inside that call: it is never assigned to a field, never rendered and never stored (a strict test mutates this, §11). The pause is a timer, not an awaited animation, so SPEC §5.9's "no state path awaits an animation" holds. Tests inject the clock.

*(As built, 2026-10-24, T11.)* Blake's flights get two hooks of their own, and both carry seat-0 public data only. `beforeReply(view0)` runs just before his move applies, with the seat-0 view on show. `afterReply(entry)` runs after it, with the new last entry of seat 0's history (`by === 1`), already redacted by the bridge. Neither ever receives his `Move`, his legal list or a seat-1 view, and the S6 walk covers every hook argument.

**Why the gate and not a filtered move list.** Filtering `legalMoves` to the expected move would break the R11 invariant (the UI offers exactly the engine's moves) and SPEC §3.3 (no recomputing engine output). With the gate, every legal card still lights up, the player can explore, and only the commit is checked.

### 6.3 The GameScreen seam: three optional fields, three small changes

GameScreen needs three optional read-only fields on `TableSource`. All three are absent on the existing sources, so their behaviour doesn't change:

- `readonly names?: [string, string]`. GameScreen uses `online?.names ?? source.names ?? session.names`. The tutorial must not write the pass-and-play session's names. *(As built, 2026-10-24, T2 review.)* "Absent on the existing sources" holds for `GameStore` only. `OnlineGameStore` already has a public `names` (its room names), which fits the optional field. GameScreen reaches it through `online.names` first, and `online` is non-null while that store is attached, so the online screen is unchanged. Nothing may treat "`names` present" as "this is the tutorial" (SPEC §5.4).
- `readonly allowsNewGame?: boolean`. GameScreen passes `newGame={!isOnline && source.allowsNewGame !== false}` to `GameMenu`, so New game is hidden in the tutorial (Home, Rules and Card style stay).
- `readonly refusals?: number` *(decided call, ApisMellow, 2026-10-24)*. GameScreen wraps its `<CounterPrompt …/>` in `{#key source.refusals ?? 0}`, so a refused counter-window move remounts a fresh prompt (§5.5.1). For `GameStore` and `OnlineGameStore` the key is the constant 0, so the prompt is never remounted.

**These are the only GameScreen changes:** the `names` fallback, the menu's `newGame` flag, and the `{#key}` around `CounterPrompt`. Nothing inside `CounterPrompt`, `Board` or any board component changes. **The `{#key}` touches counter-window code, so it is strict tier and needs an Opus review** (loop-workflow §4.5). The review mutates it: with the key removed, a refused "Let it resolve" leaves the prompt locked and S3/S4 fail; with the key on any other field, pass-and-play's counter tests must stay green. Table mode never rotates the tutorial, because the viewer is always seat 0 (`screenRotated`, SPEC §5.10). The theme is the player's chosen card style. **SPEC delta to land with the build:** add the three fields to §2.12/W10's TableSource description, the `{#key}` to §4.3's counter-prompt notes, and §5.2's GameScreen notes, and add a §5.11 "Tutorial" pointing here. *(As built, 2026-10-24, T15.)* The fields went into SPEC §5.4 and §2.4's note, where the `TableSource` text lives (plan P7), not §2.12. §4.3, §5.2 and §5.11 are as listed.

*(As built, 2026-10-24, T12b.)* There is one change below GameScreen. It is layout-neutral and applies to every game: `Board` keeps a `scroll-padding-top` equal to the sticky score bar's measured height, so a target scrolled into view stops below the bar instead of under it (§7.2).

### 6.4 App routing

- `App.svelte` gets a `'tutorial'` screen when `tutorial.active` is true, checked just before `'home'`. The tutorial starts only from Home, so `game.screen` stays `'home'` underneath.
- `reportScreen('game')` while in the tutorial, so a waiting app update never reloads a lesson mid-way (SPEC §5.8). The lessons screen reports `'home'`.
- `{#key lessonId}` around GameScreen and CoachOverlay gives every lesson a fresh GameScreen (staging, drag and menu state), even though every position starts at `seq` 0.
- *(As built, 2026-10-24, T9.)*
  - The `{#key}` block holds its own table (`heldLessonTable`) for its whole life. Leave, Lessons and the done sheet's Escape clear `tutorial.table` while GameScreen is still handling that same event, and a GameScreen's `source` must never change under it. The held table is disposed by then, so it applies nothing.
  - A `#/join/` link is ignored, though still cleared from the URL, while the tutorial is active.
  - A lesson whose table can't be built stays on the lessons screen with "This lesson hit a snag." (`role="alert"`).

### 6.5 Isolation from the real game (strict tier)

The bridge holds one game (SPEC §2.4). The tutorial's `restore` replaces it, which is safe for these reasons:

- On Home, `GameStore` holds no envelope. Every path from Home into a real game is `newGame` or `restore` from the save (SPEC §5.3 `goHome`, §5.7). Online play runs on the server and never uses the local bridge state.
- The tutorial never calls `GameStore`, never writes `cuttle-web:game`, never touches the session tally (`cuttle-web:tally`) or session names, and writes settings never. Its only storage is `cuttle-web:tutorial` (§10).
- Test: with a saved mid-game position, run every lesson, then Resume. The save is byte-identical before and after, and Resume lands at the same seq and curtain through the real wasm.

## 7. The coach overlay

### 7.1 Layers (bottom to top)

All overlay layers are `position: fixed` inside the game-screen box, below `GameMenu`, `RulesSheet`, `ScrapBrowser` and `CardDetailPopover`, and above the board and the counter prompt.

1. **Scrim** (`CoachSpotlight`): one full-screen `<svg>` with a `<mask>`. Ink fills `--cu-curtain` at 0.62 opacity, and each spotlight hole is a black rounded `<rect>` (radius 10 px, matching the well radius) padded 6 px around its target. `pointer-events: none` throughout, so the scrim never blocks a tap. Up to two holes. `aria-hidden`.
2. **Rings**: one `div` per hole with a 3 px `--cu-iris` ring (design.md §7 "highlighted"). It turns `--cu-ochre` for 200 ms on a successful drop. Transform and opacity only.
3. **Flight layer** (`FlightLayer`): clones of cards in motion (§8.4). `aria-hidden`.
4. **Ghost demo** (`GhostDemo`): the fingertip dot and the ghost card (§8.3). `aria-hidden`, `pointer-events: none`.
5. **Bubble** (`CoachBubble`, `coach-bubble`): the only overlay element that takes input.
6. **Lesson-done sheet** (`LessonDoneSheet`).

While the menu, Rules, the scrap browser or a card popover is open, the overlay fades to 0 and takes no input. The exception is an `appear` step waiting for that element (step 5.3); that step completes as the element appears, and the next step's coach shows once it closes.

*(As built, 2026-10-24.)*
- **The fade list** is `COVERING_SHEETS` in `coach.svelte.ts`: `game-menu`, `rules-sheet`, `scrap-browser`, `card-detail-popover` and `ambiguity-chooser`. A new sheet must join it, or the overlay will cover it.
- **Beat skips** (T9 review): a tap or Enter/Space ends a success or narration beat, and a tap finishes the lesson-1 deal. Presses on the coach's own controls (the bubble's and the done sheet's buttons) and on `menu-button` are excluded, so Leave, Show me and the menu act on their first tap. Taps on the bubble's copy still skip.

### 7.2 Targets and spotlight stages

Targets are named by **testid**, which is already contract (SPEC §5.1, §5.9): `score-bar`, `opponent-zone`, `center-zone`, `player-zone`, `player-hand`, `hand-card-<i>`, `deck-pile`, `zone-points`, `zone-permanents`, `zone-oneoff`, `point-<owner>-<i>`, `counter-option-<i>`, `staging-confirm`. Card targets are written as card identity in lesson data and resolved to a testid against Alice's public view at the moment of use (the 9D in her hand is `hand-card-0` now and may be `hand-card-2` later).

A `move` step watches the existing DOM state on the game-screen root with a `MutationObserver` (attributes and child list). It never reads the staging store and never writes the DOM. It reads:

- `aria-pressed="true"` on a `hand-card-<i>` (selected)
- `data-staged="true"` on a `hand-card-<i>` (that card is part of the staged move)
- `data-state="staged"` on `deck-pile`, on a `zone-points`, `zone-permanents` or `zone-oneoff` hit button, and on the theme face inside a `point-<o>-<i>` or `perm-<o>-<i>` button (theme faces reflect `state` as `data-state`, `lib/theme/types.ts`)
- whether `staging-confirm` is present

**Coach state machine for a `move` step** *(the staged states are a decided call, ApisMellow, 2026-10-24: nudge before Confirm)*:

| State | Entered when | Spotlight | Bubble |
|---|---|---|---|
| `idle` | nothing selected or staged | the card to play | the step's main line |
| `selected` | some hand card has `aria-pressed="true"` | the expected card and its expected target (even if a different card is selected; choosing a card is never nudged) | the main line |
| `staged-right` | `staging-confirm` present and the staged setup is **right** or **unknown** | `staging-confirm` | the step's "staged" line ("Tap Confirm…") |
| `staged-wrong` | `staging-confirm` present and the staged setup is **wrong** | `staging-cancel` | the step's wrong-move nudge for that setup, then "Tap Cancel to try again." The bubble shakes once (§8.2). Confirm is never mentioned. |
| `refused` | the gate refused a commit (§6.2) | back to `idle`'s spotlight; the demo replays once | the same nudge without the Cancel sentence (the board is already idle) |
| `done` | the expected move applied | — | the success line |

Leaving `staged-wrong` by Cancel returns to `idle` (main line). Confirming anyway reaches the gate, which refuses and goes to `refused`. Two refusals or two `staged-wrong` entries in one step switch the main line to the explicit tap route (§7.4).

*(As built, 2026-10-24.)*
- **The count** is the table's `wrongTries`: refused commits plus entries into `staged-wrong`, added together. At 2 or more the `idle` and `selected` lines become the tap route.
- **`refused` on the board** shows the bare nudge. It lasts until the learner next selects or stages a card.
- **At the counter prompt** the `refused` state is the "Fresh again" row (§5.5.1), so it shows the tap route once `wrongTries ≥ 2`.
- **The full stage set** on `coach-bubble`'s `data-stage` also has `next`, `appear`, `blake` and `error`.

**The staged-setup matcher** (`match.ts`, pure, tested):

1. **Source:** the hand card with `data-staged="true"` gives its hand index; `deck-pile` staged means the deck. With neither (a Pass, or something the tutorial never stages), the setup is **unknown**.
2. **Target key:** the staged drop zone (`zone:points`, `zone:permanents`, `zone:oneoff`) or the staged point or permanent card (`point:<o>:<i>`, `perm:<o>:<i>`), mapped with `targetKeyFromTestId` (`lib/dragDrop.ts`). A staged move with no target (a Draw, a one-off whose zone is the only target) uses the zone or `deck`.
3. **Candidates:** the legal moves in the board's envelope whose affordance slot is that (source, target). This uses the same slot grouping the board uses (`slotKey` and `groupAffordances` in `lib/affordances.ts`, SPEC §6.2); it reads the engine's list and computes no rule. *(As built, 2026-10-24, plan P4.)* Candidates group by `boardTargetKey`, the board location the DOM shows, not by `slotKey`. `slotKey` separates a scuttle from a 9 aimed at the same card, but those are one tap and open the chooser, so they must be one group ("unknown" when mixed, step 4). A staged counter takes every Counter, and Decline, Pass and DiscardPair have no slot.
4. **Verdict:** every candidate matches the step's predicate → **right**. No candidate matches → **wrong**, and the nudge is the step's specific nudge for the first candidate that has one, else the generic one. Some match and some don't (an ambiguity-chooser pair, SPEC §6.4) → **unknown**, and the coach shows the Confirm line, leaving the gate to decide.

**Lesson data rule (enforced by S2):** every expected move's (source, target) slot holds exactly one legal move, so the verdict on an expected setup is never "unknown". Lessons 1–5 satisfy it (§5): no expected move is a 9 or a 2 aimed at a point card it could also scuttle.

Before showing a hole, the overlay calls `scrollIntoView({block: 'nearest'})` on the target (instant under reduced motion), because at 393×660 the board scrolls (design.md §6). Holes and the bubble re-measure on resize, on board scroll and after every state change, throttled to one `requestAnimationFrame`.

*(As built, 2026-10-24, T12b.)*
- **Every spotlit target is scrolled into view, not just the first.** The board scrolls by the union of the targets' boxes, measured below the sticky score bar. When they can't all fit, the first target alone is brought into view. Targets outside the board (the action bar, the counter prompt) never scroll.
- **The board's scroll padding** is the score bar's measured height. `Board` keeps `scroll-padding-top` at the bar's height (a `ResizeObserver`, with the `--cu-zone-score` token as fallback), so `scrollIntoView` stops a card below the bar instead of under it.

**The counter prompt** (lesson 4.2) is covered in §5.5.1. There the coach reads `counter-prompt` and `staging-confirm` inside it.

### 7.3 Bubble

```
            ▲ notch (8 px) toward the hole
┌─────────────────────────────────┐
│ Your 9 gets you to 21. Drag it  │  --cu-text-md pearl, line-height 1.35
│ onto your Points row.           │
│                                 │
│ Show me      Leave       2 of 5 │  footer: text buttons ≥ 44 px; lesson count muted
└─────────────────────────────────┘
```

- `--cu-ink-raised`, 1 px `--cu-ink-line`, `--cu-radius-well`, a soft shadow (as the chooser panel). Width `min(320px, 100% − 32px)`, padding 12/16.
- `next` steps add **Next** (`coach-next`): a pill with pearl text and a 1 px iris ring. **Ochre stays reserved for the game's own Confirm**, so the learner learns that ochre means "commit".
- **Show me** (`coach-show-me`) replays the demo. **Leave** (`coach-leave`) exits (§4.3).
- *(As built, 2026-10-24, T14fix.)*
  - The footer count reads "Lesson 1/5"; screen readers hear "Lesson 1 of 5". "2 of 5" was unclear, and "Lesson 2 of 5" pushed Next onto a second row at 393 wide.
  - **Show me** renders only when the step has a demo and the stage plays it (judge M4: it showed with nothing to demonstrate). Otherwise an invisible, unfocusable, `aria-hidden` slot with no testid keeps the footer from jumping.
- **Placement.** Room is reserved for 4 lines of copy (the staged-wrong case, §7.2). The bubble never covers a spotlight hole, the card being demonstrated, `staging-bar`, `menu-button` or the counter-prompt options. It goes below the lowest hole if it fits above the action bar with 12 px to spare; else above the highest hole; else on the side with more room, allowed to overlap only unspotlit board; else docked under the score bar. Horizontally it centres on the hole and clamps to a 16 px gutter. At the counter prompt it docks under the menu row. An e2e geometry check covers every step at all three viewports (§11).

*(As built, 2026-10-24, T12 and T12b.)*
- **The dock slides past obstacles** (`dockAt` in `placement.ts`). It starts under the score bar and slides down past every hole or avoid box it would touch. It tries the wanted x, then the left gutter, then the right gutter. It stays at the top only when no free spot exists above the action bar.
- **At the counter prompt** the dock starts `promptDock` (108 px) under the menu row, below the prompt's heading and its "Blake played a 4…" line.
- **Final constants** (`PLACEMENT`): clearance 12, gutter 16, hole padding 6, notch 8, dock gap 8, `promptDock` 108. The bubble reserves 150 px of height, plus 34 px with a headline.
- **The avoid set** is the demonstrated card and its target, `staging-bar`, `menu-button`, the counter options and "Let it resolve", and the staged card and target once Confirm is up. *(T12b)* It also takes:
  - at `selected`, every lit target of the selected card (`data-state="highlighted"` on a `zone-*`, `point-*` or `perm-*` holder), *when there is room*. *(As built, GEOFIX.)* These are soft boxes, added last to the soft list, so they are the first dropped. Holes, `staging-bar`, `menu-button`, the counter options and the staged cards stay hard. With lit targets hard, no spot cleared them at 393×660 in step 3.1, and the fallback dock covered the spotlit holes;
  - `opp-hand` during the success beat (stage `done`), so the glasses flip in 5.1 stays in sight;
  - `opponent-zone` and `deck-pile` during Blake's think pause and narration, where his card leaves his hand and lands.
- *(As built, 2026-10-24, T14fix.)*
  - **Soft boxes.** `placeBubble` takes a `soft` list: boxes kept clear when there is room, most important first. When no spot clears them all, they are dropped from the end, one at a time. Holes and hard avoids are never given up for them.
  - **Flights during beats** feed the soft list (judge M2: the bubble hid Blake's points row during the 3.1 scuttle). In the learner's success beat and in Blake's beats, the move's `flightBoxes` (`motion.ts`) are soft: the hit card, every point card an Ace sweeps, the landing slot, the one-off spot, the scrap and the starting slot, in that order.
  - **At `staged-wrong`** the step's real target is soft too, because the nudge talks about it.
  - **Re-measuring after a drag** (judge M1: the bubble covered the staged card after a real drag). The coach also re-measures on `transitionend` and `transitioncancel` inside the GameScreen root, so a dragged card easing back into its slot is measured where it settles.

### 7.4 Wrong moves: never a dead end

- **Before Confirm** (the main path): a wrong move staged on the board puts the coach in `staged-wrong` (§7.2). The bubble shows the nudge with "Tap Cancel to try again.", the spotlight moves to Cancel, and the coach never says "Tap Confirm" for a wrong move. *(Decided call, ApisMellow, 2026-10-24.)*
- **At commit** (the backstop): a wrong commit is never applied (§6.2). The board returns to idle, or the counter prompt remounts fresh (§5.5.1). The bubble shows the nudge and shakes (§8.2), and the demo replays once.
- After two wrong setups or commits in one step, the main line becomes the explicit tap route ("Tap your 9, then the Points row, then Confirm."), and the demo replays.
- Exploring is free. Selecting other cards, opening the scrap pile, the menu or Rules: none of it is wrong, and none of it is nudged. Only a staged or committed wrong move is.
- **Every step can always be completed.** Its expected move is legal in its position (tested). Nothing the learner can do changes the position except the expected move (tested). The controls for the expected move are always live: on the board, a refused commit leaves staging idle with every card usable; at the counter prompt, a refused Decline remounts the prompt with its options, Confirm and Cancel enabled (`CounterPrompt`'s once-only lock is per instance, §5.5.1). No path leaves a screen with no enabled control that leads forward. S4 checks this for every step.
- **Show me**, **Leave** and the menu are always there.

## 8. Motion and visual direction

### 8.1 Direction

The design system is "ink and cuttlebone" (design.md §1): the cuttlefish hides behind ink. The coach uses the same idea in reverse. **Ink settles over the board and clears around the one thing to look at.** That cleared window, ringed in iridophore teal, is the single memorable element. Everything else stays disciplined. There are no new colours: the scrim is `--cu-curtain`, the rings use `--cu-iris` (play here) and `--cu-ochre` (done), and the text is pearl on raised ink. The scrim is plain ink, never the curtain's chromatophore dot field, so nobody mistakes it for a privacy curtain.

Motion answers the player (a card lands where they put it, a scuttle sends both cards to the scrap) or orchestrates one moment (the deal, a win). There's nothing decorative in between.

### 8.2 Tokens

New tokens in `tokens.css`, each zeroed (or set as noted) under `prefers-reduced-motion: reduce`. The tutorial also honours `settings.reducedMotion`.

| Token | Value | Use |
|---|---|---|
| `--cu-dur-flight` | 420 ms | a card flying to a zone |
| `--cu-dur-demo-travel` | 660 ms | the ghost card's travel |
| `--cu-dur-deal-stagger` | 80 ms | gap between dealt cards |
| `--cu-ease-land` | `cubic-bezier(0.3, 1.25, 0.5, 1)` | a slight overshoot as a card or chip lands |
| existing `--cu-dur-fast/med/slow`, `--cu-ease-out`, `--cu-ease-in-out` | 120/200/320 ms | as in design.md §9 |

`lib/tutorial/motion.ts` reads these once per lesson with `getComputedStyle` and exposes `motionOn()` (false if either the media query or the setting asks for reduced motion). Every WAAPI call checks it.

| Element | Motion | Reduced-motion version |
|---|---|---|
| Scrim, lesson start | opacity 0→1, 200 ms ease-out | appears at once |
| Hole change | old rings fade 120 ms, new ones fade in 200 ms; holes move instantly (no animated geometry) | instant |
| Ring pulse | scale 1→1.06→1 and opacity 0.9→0.55→0.9, 1400 ms ease-in-out, three cycles then steady | steady ring |
| Successful drop | the ring flips iris→ochre for 200 ms | ochre for 600 ms, no fade |
| Bubble in | opacity 0→1, translateY 8→0 px, 200 ms ease-out (Svelte `fly`) | appears at once |
| Bubble copy change | crossfade 120 ms (Svelte `fade`) | instant |
| Nudge | translateX 0, −6, 6, −4, 4, 0 px over 280 ms | none (the new copy alone) |
| Success chip (✓) | scale 0.6→1, 240 ms `--cu-ease-land` | appears at once |
| Lesson-done sheet | translateY 100%→0, 320 ms ease-out (Svelte `fly`) | appears at once |

*(As built, 2026-10-24.)*
- **No Svelte transitions** (T4 ruling). The bubble, chip and sheet enter with CSS keyframes, not Svelte `fly`/`fade`. Only enter motion exists, so rings vanish at once when removed.
- **`--cu-ease-land` under reduced motion** is `var(--cu-ease-out)`, because an easing can't be zeroed.
- **Rings** *(T12b)*:
  - Each ring is keyed by its target, so a new target gets a fresh ring (fade-in, then pulse) and a target that stays spotlit keeps its ring running.
  - The pulse starts after the 200 ms fade-in, because both animate opacity and a running pulse would override the fade.
  - A ring wider than 360 px (a zone, the score bar) pulses in opacity only, so its edges stay on screen.

### 8.3 Ghost demo ("ghost hand")

**Art-hold call:** the ghost hand is not a drawn hand, which would be new imagery. It is a **fingertip dot** plus a **ghost card**:

- Fingertip dot: a 36 px circle, `--cu-pearl` at 85%, a 2 px `--cu-iris` ring and a soft shadow. This is the familiar touch-indicator idiom, built from UI primitives.
- Ghost card: the real card drawn by the player's current theme `Face` at hand size, at 72% opacity with a lifted shadow. Existing art only.

**Drag demo** (one play about 1.5 s; source = the card, target = the drop zone or card):

| t (ms) | What moves |
|---|---|
| 0–200 | The dot fades in over the card's centre (opacity 0→1, scale 1.25→1, ease-out). |
| 200–320 | Press: the dot scales to 0.85. The ghost card appears over the real card and lifts 12 px. |
| 320–980 | The ghost and dot travel to the target centre on a gentle arc (a midpoint keyframe 24 px higher), rotating −4°→0, `--cu-ease-in-out`. |
| 980–1180 | Release: the target ring flashes ochre and the dot returns to scale 1. |
| 1180–1500 | The ghost and dot fade out (320 ms). |

**Tap demo** (about 900 ms): the dot fades in over 200 ms, presses to 0.82 over 90 ms, a ripple ring expands (scale 1→2.2, opacity 0.6→0, 360 ms), and the dot fades over 200 ms. "Tap twice" (2.2) repeats the press and ripple 300 ms apart.

**When it plays:** once on step entry, after the bubble lands (+250 ms). It replays after 3.5 s with no pointer or key input, at most three automatic plays per step, and on **Show me** any time. It stops the moment the player presses anywhere (a `pointerdown` listener on window, passive). It never intercepts input.

**Reduced motion:** nothing moves. Two static numbered markers appear (the order is a real sequence): a "1" dot on the card and a "2" dot on the target, joined by a 2 px dashed iris line drawn as a rotated `div`. Confirm gets a "3" once staged. Show me re-shows them for 3 s.

*(As built, 2026-10-24.)*
- **The "3" sits just above Confirm's top-right corner** (T14fix), so it never covers the label.
- **The 4.2 tap demo waits for Blake's 4** (T14fix, motion on). Its first play is held about 990 ms after the prompt appears: the one-off's flight into the prompt (740 ms), then the 250 ms entry gap. Show me releases the hold at once. The hold is spent when it is read (`takeDemoHold()`), so a restart can't carry it into another step.
- **A tap on a labelled button lands near its right end** (T14fix). A tap target more than twice as wide as it is tall, which in practice is 4.2's counter option, is treated as a labelled button. The tap dot, its ripple and the reduced-motion "1" marker land 28 px in from its right end, vertically centred, which clears the "Counter with 2♥: stop their card." label. The deck is still tapped at its centre.
- **The markers stay visible.** A press does not clear them, because they are not an animation.
- **Step 4.2, accepted exception (T13 ruling).** At `staged-right` no Confirm "3" shows. Staging the counter option replaces the option button with the staged line, so the demo's only spot is gone and no marker is drawn until Confirm is tapped. The Confirm ring and the bubble still lead the way.

### 8.4 Card flights and flips (tutorial-only in v1)

The board itself has no card-movement animation today (only the score meter's transform). The tutorial adds motion from outside the board, using the **FLIP pattern on clones**: no Board component changes.

1. **Before** the engine apply, `motion.capture(move)` records the screen rects of the cards involved (from testids) and their identities (from Alice's public view, so no hidden card is ever cloned face up).
2. **After** the new state renders (`tick()`), the flight layer finds each card's destination by testid, renders a clone (theme `Face` or `Back` in a box sized from the rect, which is the container owning geometry per SPEC §5.6 rule 2), and animates it with WAAPI from the old rect to the new one using `transform` and `opacity` only.
3. While its clone flies, the real destination card is held invisible by a WAAPI opacity animation on that element (`[{opacity:0},{opacity:0}]` for the flight's duration, `fill: 'none'`), then shown. This writes no state, no attribute and no class, and nothing awaits it.

Flight plans (`motion.ts`, one per move kind; any kind without a plan falls back to "arrive"):

| Move | Flight |
|---|---|
| PlayPoint, PlayPermanent (Q, K, 8) | hand card → new last card of the mover's row, `--cu-dur-flight` `--cu-ease-land`. An 8 as glasses turns 90° in flight (it lies sideways, design.md §6). |
| Jack steal | the Jack flies to the stolen card's new spot; the stolen point card slides from its old rect to its new one at the same time (FLIP). The "Stole" badge arrives with the final frame. |
| Scuttle | the attacker flies onto the target (300 ms), holds 80 ms, then both cards fly to `scrap-pile`, shrinking to the pile's size (320 ms, `--cu-ease-in-out`). |
| One-off | the card flies to `zone-oneoff` (300 ms), holds 240 ms, then goes to `scrap-pile`. Ace effect: every captured point card flies to the scrap, 50 ms apart. |
| Draw (Alice) | a back flies from `deck-pile` to the new hand slot; at 60% of the flight it flips (rotateY 0→180°, CSS 3D, `perspective: 900px` on the flight layer, two faces with `backface-visibility: hidden`) to show the drawn card, which is Alice's own. |
| Draw (Blake) | a back flies from `deck-pile` to `opp-hand` and stays a back. Under glasses (lesson 5) it flips like Alice's, because Alice's view shows that hand. |
| Blake plays a card | a back leaves `opp-hand`, flips face up at the midpoint (the card is public once played), and lands as above. |
| Glasses go down (5.1) | after the 8 lands, Blake's hand backs flip to faces in place, 70 ms apart. |
| Counter (4.2) | the counter prompt unmounts and the board returns; the scrap pile's top card "arrives". |
| arrive (fallback) | the destination element plays scale 0.92→1 and opacity 0→1 over 200 ms `--cu-ease-out`. |

**Reduced motion:** no clones and no flips. Cards appear where the engine put them, as in the real game today, and each destination gets a static ochre ring for 600 ms so the change is still visible.

*(As built, 2026-10-24, T10 and T11.)* **Opponent flights come from public history only.** Step 1 above holds for the learner's own move: `capture(move, view0, root)` runs from the table's `beforeApply` hook, and it throws unless it is the learner's turn. Blake's flights never see his `Move`, whose hand index and target indices are hidden information (issue #69's class):

1. `snapshot(view0, root)` records rects and seat-0 identities before his apply, from the `beforeReply` hook.
2. `captureReply(snap, entry)` builds the capture from his redacted seat-0 history entry, from the `afterReply` hook. It reads only `by`, `kind`, `card` and `targetCard`.

Plans take a `FlightMove = { kind, card, targetCard }`, never a `Move`. A target is found on the table by card identity, never by index. His clone leaves a fixed slot (his last) as a back and turns face up at the midpoint. Only when glasses already show his hand does it leave the slot that holds that card. Clones are built from plain `{x, y, width, height}` rects, never from `DOMRect` spreads (T10 review: a spread gave NaN keyframes).

*(As built, 2026-10-24, T14fix.)* **A one-off into a counter window flies into the prompt.** When Blake's one-off opens a counter window (lesson 4's 4), the board is unmounted by the time it lands. `intoPrompt` aims it at the counter prompt's thumbnail of the played card instead of the one-off spot and the scrap: it shrinks into the thumbnail and fades.

*(As built, 2026-10-24, T14fix.)* **An iris ring flashes on `opp-hand` during the glasses flip** (720 ms) to say "look here" while Blake's hand turns over. Ochre stays the colour that answers the learner's own drop.

*(As built, 2026-10-24, T12b.)* **The glasses clone carries the glasses face.** The 8's clone fades into the theme's glasses face (`variant="glasses"`, laid out landscape and turned back) during its quarter turn, so it lands looking like the card that replaces it. This applies to Blake's glasses 8 too, which is public once played.

### 8.5 The deal (lesson 1 only, about 1.4 s)

The board mounts with the lesson position, its point cards fading in (opacity 0→1, 200 ms). Alice's three hand cards leave `deck-pile` as backs, 80 ms apart (360 ms each, `--cu-ease-land`), and flip to faces over their last 160 ms. Blake's five backs fly to `opp-hand`, interleaved, 70 ms apart. The score meters fill through their existing 200 ms transition. The coach's first bubble appears after the last card lands. Input is never blocked: a tap during the deal finishes it instantly (`animation.finish()`). Reduced motion: the board appears complete.

### 8.6 Success and win beats

- **Every correct move:** the flight lands, the ring flashes ochre, the bubble switches to the success line with a ✓ chip, and 1.2 s later (or on the next tap) the next step begins. *(As built, 2026-10-24, T14fix: 2.2 s, `SUCCESS_BEAT_MS`; Blake's narration beat `BLAKE_DONE_BEAT_MS` is 2.2 s too. The judge found 1.2 s too fast to read. The think pause is unchanged, and a tap still skips.)*
- **A win (lessons 1 and 5):** Alice's point cards rise in a wave (translateY 0→−10→0 px, 420 ms each, 70 ms apart, `--cu-ease-in-out`). Her score meter pulses once (scaleY 1→1.6→1, 300 ms). The bubble says "You win!" in `--cu-font-display` at `--cu-text-xl`. The lesson-done sheet rises 600 ms later. Reduced motion: the static headline only. The board at engine `PhaseGameOver` stays under the overlay at curtain `none` (builder check B6).

*(As built, 2026-10-24.)*
- **B6 passed in T1.** The post-win `view(0)` stays on show, inert, under the overlay.
- **The headline is the only "You win!"** *(T12b)*. It sits inside the bubble's single live region, before the success line ("You reached 21." or "You need 14, and you have 15."). Until T12b, "You win!" appeared in both the headline and the line.
- **The finale's pips fill in turn** (T14fix). On "You've learned Cuttle" the five pips fill with ochre one after another, 90 ms apart, after the sheet has risen (transform and opacity only). Under reduced motion they are simply ochre.

### 8.7 Why no motion library

Every effect above is a keyframe list on `transform` and `opacity`, which WAAPI runs natively on the compositor. `Animation.finish()`, `cancel()` and `getAnimations()` cover skipping and testing. Svelte's `fly` and `fade` cover the overlay's own enter and exit. A library (Motion One, GSAP) would add bytes to the precached shell (SPEC §5.8) and a second animation model for reviewers. No concrete need for one was found, so v1 ships none.

### 8.8 Later: a three.js hero moment (future work, not v1)

The natural slot is the tutorial finale (after lesson 5's win) or the real game's result screen: the winning point cards rising into a slow 3D fan over the ink table. It would be a lazily imported, tutorial-only `CoachFinale3D` behind the same `motionOn()` switch, falling back to §8.6. Its bytes must stay outside the first-load budget and be weighed against R18's precache. Not designed further here.

## 9. Accessibility

- **Copy is announced.** The bubble is `<section aria-label="Coach">`. Its copy sits in an `aria-live="polite"` paragraph, so each step, nudge, success line and Blake's narrated reply is read once. The scrim, rings, ghost, flights and markers are `aria-hidden`. *(As built, 2026-10-24, T12b.)* The live region is one element that holds the headline and the copy, headline first, so a win is announced once with its line. Focus at lesson start goes to that region.
- *(As built, 2026-10-24.)* The lessons screen's snag line, shown when a lesson can't start, is `role="alert"`.
- **Words carry the instruction.** Every action step names what to do in words that work for taps and keys alike. The two-wrong-tries line spells out the tap route (§7.4). Every board target is already its own `<button>` (SPEC §6.1 "Desktop keyboard"), so all five lessons can be finished by keyboard alone (tested).
- **Focus.**
  - On lesson start, focus goes to the bubble copy (`tabindex="-1"`), so a screen reader starts there.
  - On a `next` step, Next takes focus only if the last input was a key.
  - On a `move` step, focus is left alone: GameScreen's own focus rescue (SPEC §6.1, r16) stays in charge.
  - The coach never traps focus. The bubble follows the action bar in DOM order.
  - The lesson-done sheet is a non-modal `role="dialog"` that focuses its heading. Escape there means Lessons.
  - The coach doesn't handle Escape on the board, because GameScreen uses it to clear a selection.
- **Targets and contrast.** Every new control is ≥ 44×44 and uses existing token pairs (pearl on raised ink 11.92:1; iris on ink 8.76:1).
- **Motion.** Reduced motion is honoured through the media query and `settings.reducedMotion` (§8), with no information lost.

## 10. Persistence

- Key `cuttle-web:tutorial`, value `{ "v": 1, "done": [1, 2] }`: the lesson numbers finished, unique, 1–5. Nothing else. There is no "seen" flag of any kind (D1).
- Written when a lesson's done sheet appears. Read when Home and the lessons screen mount.
- Every `getItem` and `setItem` is wrapped in try/catch. If storage throws, progress lives in memory for the tab, and the tutorial and the game work normally.
- A malformed value, a wrong `v` or unknown lesson numbers read as "nothing done" (unknown numbers dropped) and are rewritten on the next completion.
- Never part of the game snapshot, the settings key or the session tally.

## 11. Test plan by tier (loop-workflow §4.5)

**Strict tier** (test-first with red evidence, Opus developer and reviewer with mutation probes). This covers engine-driven scenario correctness, the apply gate, isolation from the real game, and storage.

| ID | Test |
|---|---|
| S1 | **Every lesson replays through the real wasm** (`createWasmEngine()`, `web/tests/scenario/wasm-engine.ts`). Restore the position, walk the steps applying the expected move (and every alternative the predicate allows, e.g. both Jacks in 5.2, both targets in 3.1), apply Blake's replies, and assert each engine description against a golden list kept **in the test file** (the SPEC §7.3 `expect` guard rail; descriptions carry suit glyphs, so they stay out of `src`). Checkpoints: L1 ends `phase 4, winner 0`; L2 ends with Alice at 12 points holding 3D and 10D; L3 ends with 8C scrapped; L4 has both points rows empty after 4.1, then `phase 1, active 0` after Blake's 4 (the ack), and `phase 0, active 0` after the counter; L5 has Blake's hand visible after 5.1, Alice's remaining Jack dimmed (no legal move) after the Queen, and `phase 4, winner 0, threshold 14, points 15` at the end. |
| S2 | **Positions are valid:** each restores `ok`, holds 52 unique cards, and is `Active 0, Phase 0` with empty history. Every step's expected move is legal in the position it meets, and its (source, target) slot holds exactly one legal move (the §7.2 lesson data rule, so its verdict is never "unknown"). |
| S3 | **The gate and the pre-Confirm check.** (a) At every move step, committing each legal move that fails the predicate changes nothing (seq, envelope and bridge snapshot identical), adds 1 to `refusals`, sets that step's nudge, and the expected move still completes the step afterwards. (b) **Matcher**, through the real wasm and the mounted GameScreen: at every board move step, staging each legal move (by tap) puts the coach in `staged-right` exactly when the move matches the predicate, `staged-wrong` (spotlight on `staging-cancel`, the step's nudge plus "Tap Cancel to try again.", no "Confirm" anywhere in the bubble) exactly when it doesn't, and `unknown` only for a mixed chooser slot. The coach reads only page state (a spy confirms it never reads the StagingStore). (c) **Step 4.2:** "Let it resolve" is refused, the engine stays at phase 1 with seat 0 active, the curtain is `ack` at every observed moment (never `none`), a new `CounterPrompt` instance mounts with its counter option and "Let it resolve" enabled, the nudge shows, and counter then Confirm completes the step. Mutants: let a wrong move through; drop the predicate's card check; drop its target check; remove the `{#key}` (the second tap does nothing and the test fails); show the Confirm line on `staged-wrong`. |
| S4 | **No dead end:** a fuzz walk takes, at each step, up to N random actions drawn from wrong stagings (then Cancel, or Confirm into the gate), wrong commits and, at 4.2, repeated "Let it resolve" taps, then the right move, and every lesson still finishes. After every action, at least one enabled control leads to the expected move. Every step has a nudge. The script-error path shows Restart and Leave. |
| S5 | **Isolation:** with a saved mid-game position and a tally in storage, run all five lessons, then Resume. `cuttle-web:game` and `cuttle-web:tally` are byte-identical, and Resume restores the same seq and curtain (real wasm). Session names unchanged. No key other than `cuttle-web:tutorial` written (spy on storage). |
| S6 | **Seat-0 view only:** `TutorialTable.envelope.state.viewer === 0` at every step. `opponent.hand` is null except after glasses (L5). Blake's legal-move envelope is never assigned to a field (mutation: store it and expose it; the test fails). |
| S7 | **Storage:** throwing storage, malformed JSON, a wrong `v` and unknown lesson numbers all behave per §10. Progress round-trips. |
| S8 | **Routing and exits:** Leave from any step returns to the lessons screen; menu Home returns Home; New game is absent from the menu in the tutorial and present in pass-and-play (`allowsNewGame`); with `refusals` absent, the counter prompt is the same instance across a whole pass-and-play counter window (no remount); the existing GameScreen suites stay green (the seam changes nothing for the other sources). The `{#key}` change gets an Opus review (§6.3). |
| S9 | **No prompt, ever (D1):** with empty storage, Home shows only the static Learn to play control. No dialog, toast, badge or overlay about the tutorial appears on Home, in a game or on the result screen. |

**Light tier** (render or smoke test plus a fit check, Sonnet developer, review blocks only on real defects). This covers the overlay's looks, placement and motion.

| ID | Test |
|---|---|
| L1 | Render tests for CoachBubble, the lessons screen and LessonDoneSheet (copy, buttons, testids, Next only on `next` steps). |
| L2 | e2e geometry at 393×852, 430×932 and 393×660 for every step: the bubble doesn't intersect any hole, `staging-bar`, `menu-button` or counter options; no horizontal scroll; new testids ≥ 44×44. |
| L3 | e2e touch walkthrough at 393×852: all five lessons by drag and tap. A keyboard-only walkthrough of all five. Both walkthroughs also make one deliberate wrong staging per lesson and expect the `staged-wrong` bubble (the nudge plus "Tap Cancel to try again.", Cancel spotlit, no Confirm line), then Cancel and the right move. In lesson 4 they tap "Let it resolve" once, expect the nudge and a usable fresh prompt, then counter. |
| L4 | Reduced motion (forced media query): no running animation on any element after each step (`document.getAnimations()` empty once settled), the numbered markers present, all five lessons completable. |
| L5 | A unit check that no tutorial state change awaits an animation (the gate and the Blake timer complete with WAAPI stubbed to never finish). |
| L6 | `screenshot-judge`: deal, a scuttle flight, the glasses flip and the lesson-5 win at 393×852, judged for legibility, pacing, "does it feel alive", and whether the spotlight ever hides what the copy talks about. |

## 12. Builder's calls (with recommendations)

- **B1. The learner's on-screen name.** Recommend the last-used Player 1 name from settings when set, else "You". The score bar's turn header then reads "You, your turn", which is acceptable for a lesson.
- **B2. Exact bubble placement thresholds.** Start from §7.3 and tune against L2's geometry check.
- **B3. Blake's think pause.** Start at 700 ms (400 ms reduced). Tune by feel, staying under 1 s.
- **B4. Step 2.3** (the hand limit, a `next` step). Recommend keeping it. Cut it if lesson 2 runs well over a minute in playtest.
- **B5. Flights in the real game.** Recommend a separate ROADMAP item after the tutorial ships, reusing `FlightLayer` and `motion.ts`. Out of scope here.
- **B6. Board at `PhaseGameOver` under curtain `none`.** This hasn't been exercised in pass-and-play (the app routes to the result screen first). Check it renders cleanly with an empty move list. If it doesn't, the tutorial keeps the pre-win board under the finale and shows the win in the overlay only.
- **B7. The lessons screen as its own screen** (recommended) versus a sheet on Home. Recommend the screen: it is simpler to focus and to test.

## 13. Notes from the engine read

- No locked decision conflicts with engine v0.2.1. Every lesson position and script above was checked by reading `engine/apply.go`, `engine/win.go` and `card/card.go`. S1 makes that check executable.
- **Position authoring is constrained by wins.** In lesson 5, an 8 for points at 15 would win (23 ≥ 21), so the order is glasses, Jack, Queen, King. Lesson 1's only winning move is the expected one.
- `validateState` checks shape only, so the 52-card uniqueness check lives in S2.
- A 2's one-off can target the player's own permanents too (`apply.go:47-68` loops both players). No lesson relies on that, and the Rules sheet doesn't contradict it.
- The tutorial reads Blake's legal-move envelope transiently to resolve his scripted move (§6.2). Blake is fictional, so there's no privacy question, but the field-free handling is still pinned by S6 so the pattern can't leak into a real store.
