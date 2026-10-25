# Learn to play: implementation plan

**Status:** plan, 2026-10-24; built on the `feat/tutorial` integration branch the same day (Progress below), pending T14fix's merge and the final merge to `main`. Implements `docs/tutorial-design.md` (decisions by ApisMellow, PRD §10 A-8, ledger R25.1–R25.12).
**Executed by:** the loop orchestrator, one dispatch per T-item, in rounds (`docs/loop-workflow.md` §5). Each card below is the WHAT for a brief: the orchestrator copies its goal, files, acceptance and red tests into the dispatch, with the absolute worktree path. `AGENTS.md` stays the HOW.
**Format precedent:** `docs/two-phone-plan.md`. Work items are `T1`–`T15` (the `W` namespace belongs to two-phone play).

## Progress

Item PRs merge into the `feat/tutorial` integration branch; one final PR takes it to `main` (§4.1). Build log: `docs/loop-log/tutorial-build.md`.

| # | Item | Round | Status |
|---|---|---|---|
| T1 | Spike: the board at game over under curtain `none` (B6) | 1 | merged #81 (B6 PASS) |
| T2 | GameScreen seam: `names`, `allowsNewGame`, `refusals` key | 1 | merged #84 |
| T3 | Lessons as data, positions, move predicate, real-wasm replay | 1 | merged #85 |
| T4 | Coach visual kit: bubble, spotlight, done sheet, placement, tokens | 1 | merged #82 |
| T5 | `TutorialTable`: the apply gate, Blake's replies, isolation | 2 | merged #89 |
| T6 | Staged-setup reader and classifier (nudge before Confirm) | 2 | merged #87 |
| T7 | Progress storage, `TutorialStore`, Home control, lessons screen | 2 | merged #88 |
| T8 | `motion.ts` base and the ghost demo | 2 | merged #86 |
| T9 | Coach controller, `CoachOverlay`, App routing | 3 | merged #92 |
| T10 | `FlightLayer` and flight plans | 3 | merged #90 |
| T11 | Motion in the lesson: deal, flights, success and win beats | 4 | merged #98 |
| T12 | Bubble placement tuning and the geometry e2e | 4 | merged #97 |
| T12b | *(added)* Coach polish from the T11 and T12 reviews | 5 | merged #100 |
| T13 | End-to-end walkthroughs: touch, keyboard, reduced motion | 5 | merged #99 |
| T14 | Screenshot judge | 5 | REVISE, then ACCEPT on re-check after T14fix |
| T14fix | *(added)* The judge's must-fixes M1–M4 | 5 | built; merging |
| T15 | Docs sync: SPEC, ledger, ROADMAP, AGENTS | 5 | this item |

Also on the integration branch: #83, which runs the CI gate on PRs into and pushes to `feat/**`, so item PRs get checks.

## 1. Shape of the build

The design fixes the architecture (§6): a third `TableSource` (`TutorialTable`) restores authored positions into the real bridge, gates every commit against the current step, and plays Blake's scripted replies; `GameScreen` gains three optional fields and nothing else; a coach overlay reads page state from the DOM and draws on top. This plan cuts that into items that can each be gated on their own, and orders them so the risky seams land first:

- **Round 1** proves the four things everything else stands on: the `{#key}` remount and the other two seam fields (T2), every lesson position and script through the real wasm with the 52-unique-cards check (T3), and whether the board survives `PhaseGameOver` at curtain `none` (T1, design B6). The coach's presentational kit (T4) has no code dependencies and runs alongside.
- **Round 2** builds the strict core on top: the gate (T5), the staged-setup matcher (T6), the store and entry screens (T7), and the demo motion (T8).
- **Round 3** joins them into a playable tutorial (T9) while the flight layer (T10) is built standalone.
- **Round 4** is motion polish and placement tuning (T11, T12).
- **Round 5** is the final gate: end-to-end walkthroughs, the judge, and the docs sync (T13–T15).

Nothing reaches players between rounds: accepted items merge into the integration branch the orchestrator names, and Pages deploys only from `main` after the final round. An intermediate state (for example a Home control that sets `tutorial.active` before T9 routes it) is acceptable on the integration branch.

### 1.1 Files

```
web/src/lib/tutorial/
  types.ts          T3   Lesson, Step, MovePredicate, SpotTarget, DemoSpec, BlakeReply, LessonId
  position.ts       T3   c(), positionCards(), positionSnapshot()
  lessons.ts        T3   LESSONS: the five lessons (positions, steps, copy, Blake scripts)
  match.ts          T3   moveMatches, targetCardOf, matchingIndices, nudgeFor
                    T6   + readStagedPage, classifyStaged
  table.svelte.ts   T5   TutorialTable (TableSource), TutorialEngine, constants
  progress.ts       T7   TUTORIAL_KEY, decode/encode/load/save
  tutorial.svelte.ts T7  TutorialStore + `tutorial` singleton
                    T9   + default table factory
  coach.svelte.ts   T9   CoachController (page stage, spotlight, copy selection)
  placement.ts      T4   placeBubble (pure); tuned in T12
  motion.ts         T8   motionOn, readMotionTokens, demo keyframes
                    T10  + capture, flightPlan, playFlights
web/src/lib/components/
  CoachBubble.svelte, CoachSpotlight.svelte, LessonDoneSheet.svelte   T4
  GhostDemo.svelte                                                    T8
  TutorialLessons.svelte                                              T7
  CoachOverlay.svelte                                                 T9 (motion wiring T11)
  FlightLayer.svelte                                                  T10
changed: stores/tableSource.ts, components/GameScreen.svelte (T2); HomeScreen.svelte (T7);
         App.svelte (T9); styles/tokens.css (T4)
```

## 2. Global constraints

Every item's brief includes these. Values are copied from the design.

- **Engine is canon.** `github.com/ApisMellow/cuttle@v0.2.1`. No engine edit, no `replace`, no bridge change: positions load through the existing `__cuttleRestore` (design §6.1). Rule claims in tests and comments cite v0.2.1 `file:line`.
- **Seat 0 is the learner (Alice in tests and docs), seat 1 is Blake.** On screen the opponent is "Blake". The tutorial's envelope is always `view(0)`.
- **The UI offers exactly the engine's moves (R11).** The gate refuses at commit; it never filters `legalMoves`.
- **Nothing the tutorial does writes `cuttle-web:game`, `cuttle-web:tally`, `cuttle-web:settings` or the session's names.** Its only key is `cuttle-web:tutorial` = `{"v":1,"done":[…]}`. Every storage access is in try/catch.
- **Never prompt (D1, R25.12).** The one way in is the static `learn-to-play` control on Home. No nudge, badge, pulse, toast or banner anywhere.
- **Copy:** card names in words only, never suit glyphs (SPEC §5.6 rule 1). Coach lines are fixed lesson text from `lessons.ts`, approved in the design; that is not card rendering from `Card` fields. Main, staged, success and tap-route lines are at most 120 characters; a nudge plus " Tap Cancel to try again." at most 160 (4 lines at 393 wide).
- **Tokens only** (D6): no new colours, art, themes or imagery. Scrim `--cu-curtain` at 0.62; rings `--cu-iris` (3 px), `--cu-ochre` for a successful drop; ochre fill is reserved for the game's Confirm.
- **Motion:** `transform` and `opacity` only; WAAPI, CSS 3D and Svelte `fly`/`fade`; no library, no three.js. No state path awaits an animation (SPEC §5.9). Reduced motion (media query or `settings.reducedMotion`) shows the calm variant of every effect with nothing hidden.
- **Devices:** 393×852 primary, 430×932, and the 393×660 toolbar view. Every new `[data-testid]` is ≥ 44×44. No horizontal scroll.
- **Testids are contract.** New ones: `learn-to-play`, `tutorial-lessons`, `tutorial-lessons-back`, `tutorial-lesson-1`…`-5`, `tutorial-continue`, `coach-bubble`, `coach-next`, `coach-show-me`, `coach-leave`, `coach-restart`, `coach-lesson-done`, `coach-next-lesson`, `coach-lessons`, `coach-play`. Select them by exact match: `coach-next` is a prefix of `coach-next-lesson`. The scrim, rings, ghost and flights carry no testid (they are `aria-hidden`).
- **Public repo:** sample names Alice and Blake; decisions credited to ApisMellow; no machine-local paths, hostnames or secrets.
- **Svelte 5 runes only;** component tests per AGENTS "Svelte 5 conventions". Wasm-backed jsdom tests follow `web/tests/unit/glasses-leave-restore.test.ts` (boot with `await createWasmEngine()`, then the production `lib/bridge/engine.ts` calls).

## 3. Review focus

Failure modes the design implies but no S/L test names. Each has a test in the owning item.

1. **The overlay paints over the menu.** `.game-screen` sets `isolation: isolate`, so a sibling overlay sits above `GameMenu`, `RulesSheet`, `ScrapBrowser`, `CardDetailPopover` and `AmbiguityChooser` whatever their z-index. The design's "fade to 0, take no input" rule is the only thing that keeps `menu-home` and Rules tappable. T9: with the overlay up, open each of those and click a control inside it.
2. **A commit during a `next`, `appear` or finished step.** At step 1.1 the learner can already stage 9D and Confirm, which would win before the lesson has started. T5: every legal move is refused during non-move steps and after the lesson finishes.
3. **A stale Blake timer.** Leave, Restart, or a new lesson during Blake's think pause must not apply his move to the next restored position. T5: dispose mid-pause, then flush timers; the bridge snapshot is unchanged.
4. **Table mode on.** `settings.tableMode = true` must not turn the tutorial (viewer is always 0, SPEC §5.10). T9: `data-table-rotated="false"` at every step of lesson 4, the counter prompt included.
5. **The learner's name.** Blank, the "Player 1" default, a 40-character name, or a name with emoji: the label is "You" for the first two and the name otherwise, and nothing writes settings. T7.

## 4. Builder's calls (design §12) and planner's calls

Each is the planner's call unless the design already decided it.

- **B1, learner name:** `settings.lastNames?.[0]`, trimmed, unless it is empty or `"Player 1"` (HomeScreen's default, `HomeScreen.svelte` `prefill`); otherwise `"You"`. Read once when a lesson starts; never written. *Reason: matches how Home already treats the default name.*
- **B2, bubble placement:** T4 implements design §7.3's order with these starting constants: 12 px clearance above the action bar, 16 px gutter, 6 px hole padding, 8 px notch, room reserved for 4 lines. T12 tunes them against the geometry e2e and records final values in its hand-back. *Reason: the design asks for tuning against L2, which needs the whole overlay.*
- **B3, Blake's think pause:** 700 ms, 400 ms under reduced motion (`BLAKE_THINK_MS`, `BLAKE_THINK_REDUCED_MS`). *Reason: the design's starting values; tuning is a playtest note, not a build task.*
- **B4, step 2.3:** kept. Cutting it is ApisMellow's call after the T14 judge or a playtest. *Reason: the design recommends keeping it.*
- **B5, flights in real games:** out of scope; T15 adds a ROADMAP item. *Reason: design non-goal.*
- **B6, board at game over:** T1 checks it in round 1. If the board renders cleanly, T5 shows the post-win `view(0)` at curtain `none`. If not, T5 keeps the pre-move envelope on show after a winning move, with `pending = true` (board inert), and the overlay carries the win. *Reason: only a test can settle it, and the fallback lives entirely in T5.*
- **B7, lessons screen:** its own screen. *Reason: the design's recommendation; simpler to focus and test.*
- **P1, commits outside a move step:** the gate refuses every move during `next` and `appear` steps and once the lesson is finished. Copy: next steps "Tap Next first."; step 5.3 "First, tap your other Jack."; finished: no copy change. *Reason: design §7.4 "nothing the learner can do changes the position except the expected move", and Review focus 2.*
- **P2, missing copy:** the design gives no tap-route line for most steps, no staged line for some, and no subtitles for lessons 3–5. Appendix A drafts them. *Reason: the developer can't invent lesson copy; ApisMellow can overrule any line before T15.*
- **P3, beat order after a correct move:** success line (1200 ms, or the next tap) → if Blake replies: "Blake's turn." with `pending = true`, then the think pause, then his move applies and his narration line shows → after 1200 ms (or a tap) the next step begins. `pending` is true from the learner's match until Blake's last reply lands. A tap during the think pause is ignored (never a double apply). *Reason: design §6.2 and §8.6 give the pieces but not their order; this order never cuts the success line short.* *(As built, T14fix: the success and narration beats are 2200 ms, after the judge found 1200 ms too fast; the think pause is unchanged and a tap still skips.)*
- **P4, the matcher's slot:** the staged setup's candidates are the legal moves with that `HandIndex` (or Kind Draw for the deck) whose `boardTargetKey` (`lib/affordances.ts`) equals the staged target key. That is the board location, which is what the DOM shows, not `slotKey`, which separates a scuttle from a 9 aimed at the same card. *Reason: a scuttle and a targeted one-off on one card are one tap and open the chooser, so they must be one candidate group ("unknown" when mixed, design §7.2 step 4).*
- **P5, Card style from the menu during a lesson:** allowed; it is the existing menu writing settings at the player's request. S5 runs lessons without touching it. *Reason: the design keeps Card style in the tutorial menu (§4.3).*
- **P6, lesson 2 ends on Next:** its last step (2.3) is a `next` step, so its done sheet rises when Next is tapped. *Reason: design §4.4 assumes a move ends each lesson; this is the one that doesn't.*
- **P7, SPEC location:** the `TableSource` description lives in SPEC §5.4 (and §2.4's note), not §2.12. T15 adds the fields there. *Reason: where the text is today.*
- **P8, coach state in the DOM:** `CoachBubble`'s root carries `data-step` (e.g. `"1.5"`), `data-stage` (`idle | selected | staged-right | staged-wrong | refused | done | next | appear | blake | error`) and `data-tone`. Each spotlight ring carries `data-coach-hole`. Tests and e2e read the coach from these and never from timers. *Reason: e2e needs a stable, state-based wait, and these carry no game data.*
- **P9, the engine dependency:** `TutorialTable` defaults to the production `lib/bridge/engine.ts` calls. Tests boot the bridge with `await createWasmEngine()` as `game-restore.test.ts` does. No harness change. *Reason: existing precedent.*

### 4.1 Orchestrator rulings during the build (2026-10-24)

The orchestrator made these calls while the build ran. ApisMellow can overrule any of them. Each is recorded in the design as an as-built amendment where it changes design text, and in SPEC §5.11 where it became contract. The per-item detail is in `docs/loop-log/tutorial-build.md`.

- **Integration branch.** Item PRs merge into `feat/tutorial`; one final PR takes it to `main`, so nothing reaches players (Pages deploys from `main`) until the whole tutorial is in. CI runs on PRs into and pushes to `feat/**` (#83).
- **No three.js in v1** (design D5, §8.8).
- **Step 4.2's counter prompt remounts via `{#key refusals}`** (design §5.5.1 option (a), minimal form; T2).
- **The coach nudges before Confirm** (design §7.2 `staged-wrong`; T6, T9).
- **The 4.1 copy was shortened** to fit the 120-character limit: "Blake has 19! Your Ace has a one-off power: it wipes every point card off the table. Drop it on the middle spot." (T3).
- **Refusal copy.** On the board, `refused` shows the bare nudge (no Cancel sentence; the board is already idle). At the counter prompt, the "Fresh again" row shows the tap route once `wrongTries ≥ 2` (T9).
- **`heldLessonTable`** holds the table for each lesson's `{#key}` block, so GameScreen's `source` never changes under an event that clears `tutorial.table` (T9).
- **The error phase blocks the board below the score bar**; the menu stays live, and so do Restart lesson and Leave (T9, from the T5 review).
- **The snag line is `role="alert"`** where a lesson can't start (T9, from the T7 review).
- **Reduced-motion markers stay visible**: a press doesn't clear them (T8). At step 4.2's `staged-right`, no Confirm "3" marker shows; accepted (T13).
- **Beat skips exclude the coach's own controls and `menu-button`**, so Leave, Show me and the menu act on their first tap; taps on the copy still skip (T9 review B1, corrected ruling). The deal skip uses the same rule (T11), from one definition (`OWN_CONTROLS`, T12b).
- **Join links are ignored while the tutorial is active** and still cleared from the URL (T9 review N1).
- **Blake's flights use public-only hooks** (`beforeReply(view0)`, `afterReply(entry)`), never his `Move` (T10/T11 review, §5 amendment below).
- **"You win!" is the bubble headline only**, inside its single live region (T12b).
- **The judge's must-fixes were routed as one new item, T14fix** (an Opus developer, an Opus review and a judge re-check), instead of to the owning items (T4, T11, T12) as the T14 card planned.

## 5. Interfaces

These are the names and types neighbouring items rely on. An item's brief quotes the blocks it consumes.

```ts
// lib/tutorial/types.ts (T3)
export type LessonId = 1 | 2 | 3 | 4 | 5;
export type SuitLetter = 'C' | 'D' | 'H' | 'S';
export interface LessonPosition {
  aliceHand: Card[]; alicePoints: Card[]; blakeHand: Card[]; blakePoints: Card[];
  scrap: Card[];    // bottom first, last = top (engine/state.go GameState.Scrap)
  deckTop: Card[];  // index 0 = top; every unnamed card follows in canonical order
}
export interface MovePredicate {
  kind: MoveKind;            // lib/enums MoveKind value
  card?: Card | Card[];      // the mover's card, any of
  target?: Card | Card[];    // the targeted point or permanent card (Target or JackTarget), any of
}
export type SpotTarget =
  | { kind: 'testid'; id: string }          // score-bar, opponent-zone, deck-pile, zone-points, player-hand…
  | { kind: 'hand'; card: Card | Card[] }   // → hand-card-<i> against view(0)
  | { kind: 'handRank'; rank: Rank }        // step 5.3: the Jack still in hand
  | { kind: 'point'; card: Card | Card[] }  // → point-<owner>-<i>
  | { kind: 'counterOption' };              // the one counter-option-*
export type DemoSpec =
  | { kind: 'drag'; from: SpotTarget; to: SpotTarget; thenConfirm: boolean }
  | { kind: 'tap'; at: SpotTarget[]; thenConfirm: boolean }   // 2.2: [deck, deck]; 4.2: [counterOption]
  | { kind: 'none' };
export interface NudgeRule { when: MovePredicate; text: string }
export interface BlakeReply { move: MovePredicate; thinking: string; done?: string }
interface StepBase { id: string; main: string; spot: SpotTarget[] }
export interface NextStep extends StepBase { kind: 'next' }
export interface AppearStep extends StepBase { kind: 'appear'; testId: string; refusal: string }
export interface MoveStep extends StepBase {
  kind: 'move'; expect: MovePredicate;
  source: SpotTarget; target: SpotTarget;   // idle hole; selected adds the target hole
  staged: string; tapRoute: string;
  nudges: NudgeRule[]; generic: string;     // first matching rule wins, else generic
  success: string; demo: DemoSpec; blake: BlakeReply[];
}
export type Step = NextStep | AppearStep | MoveStep;
export interface Lesson {
  id: LessonId; title: string; subtitle: string; done: string;
  position: LessonPosition; steps: Step[]; win: boolean; deal: boolean;
}

// lib/tutorial/position.ts (T3)
export function c(rank: Rank, suit: SuitLetter): Card;
export function positionCards(pos: LessonPosition): Card[];        // all 52, deck filled
export function positionSnapshot(pos: LessonPosition): string;     // bridge snapshot JSON, v 2, seed "0", dealer 1, history []

// lib/tutorial/match.ts (T3)
export function targetCardOf(move: Move, view: PlayerView): Card | null;   // Target or JackTarget → PointEntry.Card / permanent
export function moveMatches(move: Move, pred: MovePredicate, view: PlayerView): boolean;
export function matchingIndices(env: Envelope, pred: MovePredicate): number[];
export function nudgeFor(move: Move, step: MoveStep, view: PlayerView): string;
// lib/tutorial/match.ts (T6)
export interface StagedPage {
  selectedHand: number | null;              // aria-pressed="true"
  source: { hand: number } | 'deck' | null; // data-staged="true" / deck-pile data-state="staged"
  target: TargetKey | null;                 // staged zone, point or perm, via targetKeyFromTestId
  confirm: boolean;                         // staging-confirm present
  counter: 'fresh' | 'staged' | null;       // counter-prompt present / staging-confirm inside it
}
export function readStagedPage(root: ParentNode): StagedPage;
export type StagedVerdict = { verdict: 'right' } | { verdict: 'wrong'; nudge: string } | { verdict: 'unknown' };
export function classifyStaged(page: StagedPage, env: Envelope, step: MoveStep): StagedVerdict;

// lib/tutorial/table.svelte.ts (T5)
export interface TutorialEngine {
  restore(json: string, viewer: PlayerId): BridgeResult; apply(i: number): BridgeResult;
  view(viewer: PlayerId): BridgeResult; legalMoves(): BridgeResult; snapshot(): string;
}
export interface TutorialClock { set(fn: () => void, ms: number): number; clear(handle: number): void }
export type RunPhase = 'step' | 'success' | 'blake' | 'finished' | 'error';
export type LineTone = 'main' | 'nudge' | 'success' | 'blake' | 'error';
export interface TutorialTableDeps {
  engine?: TutorialEngine; clock?: TutorialClock;
  learnerName: string; reducedMotion: () => boolean;
  onHome(): void;                                        // menu Home
  beforeApply?(move: Move, view: PlayerView): void;      // motion.capture, sync, pre-apply (T11)
  afterApply?(): void;                                   // after the new state is set (T11)
}
export const SUCCESS_BEAT_MS = 1200, BLAKE_THINK_MS = 700, BLAKE_THINK_REDUCED_MS = 400, BLAKE_DONE_BEAT_MS = 1200;
export class TutorialTable implements TableSource {
  constructor(lesson: Lesson, deps: TutorialTableDeps);
  // TableSource: envelope, history, seq, viewer (0), curtain, drawReveal (null), pending,
  //   names ([learner, 'Blake']), allowsNewGame (false), refusals, apply, goHome, newGame (restart),
  //   advanceCurtain / dismissDrawReveal (no-ops)
  readonly lesson: Lesson; readonly stepIndex: number; readonly step: Step | null;
  readonly phase: RunPhase; readonly line: { text: string; tone: LineTone };
  readonly lastNudge: string | null; readonly wrongTries: number;
  next(): void;                    // completes a next step
  appeared(testId: string): void;  // completes an appear step
  skipBeat(): void;                // a tap during a success or done beat
  noteStagedWrong(): void;         // the coach saw a staged-wrong entry (counts toward the tap route)
  restart(): void; dispose(): void;
}

// lib/tutorial/progress.ts (T7)
export const TUTORIAL_KEY = 'cuttle-web:tutorial';
export function decodeProgress(raw: string | null): LessonId[];   // sorted, unique, 1–5
export function encodeProgress(done: Iterable<LessonId>): string; // exactly {"v":1,"done":[…]}
export function loadProgress(storage?: Pick<Storage, 'getItem'>): LessonId[];
export function saveProgress(done: Iterable<LessonId>, storage?: Pick<Storage, 'setItem'>): boolean;

// lib/tutorial/tutorial.svelte.ts (T7)
export type TableFactory = (lesson: Lesson, deps: TutorialTableDeps) => TutorialTable;
export class TutorialStore {
  constructor(deps: { storage?: StorageLike; createTable: TableFactory; learnerName?: () => string });
  readonly active: boolean; readonly lessonId: LessonId | null;  // null = lessons screen
  readonly done: readonly LessonId[]; readonly table: TutorialTable | null;
  readonly nextUnfinished: LessonId | null;
  reload(): void; open(): void; start(id: LessonId): void; leave(): void;
  exitHome(): void; finishLesson(id: LessonId): void; nextLesson(): void;
}
export function learnerName(lastNames: readonly [string, string] | null): string;   // B1
export const tutorial: TutorialStore;   // T7 exports it with a factory that throws; T9 wires the real one

// lib/tutorial/motion.ts (T8, extended T10)
export function motionOn(settingsReduced: boolean, mql?: Pick<MediaQueryList, 'matches'>): boolean;
export interface MotionTokens { flight: number; demoTravel: number; dealStagger: number; easeLand: string; fast: number; med: number; slow: number }
export function readMotionTokens(el: Element): MotionTokens;
export function dragDemoFrames(from: DOMRect, to: DOMRect): { dot: Keyframe[]; card: Keyframe[]; durationMs: number };
export function tapDemoFrames(times: 1 | 2): { dot: Keyframe[]; ripple: Keyframe[]; durationMs: number };
// T10
export interface FlightCapture { kind: MoveKind; rects: Record<string, DOMRect>; cards: Record<string, Card | 'back'> }
export function capture(move: Move, view: PlayerView, root: ParentNode): FlightCapture;
export type FlightPlanName = 'toRow' | 'jackSteal' | 'scuttle' | 'oneOff' | 'drawFlip' | 'drawBack' | 'blakePlays' | 'glassesFlip' | 'counter' | 'arrive';
export function flightPlan(move: Move, by: PlayerId, glasses: boolean): FlightPlanName;

// lib/tutorial/placement.ts (T4)
export interface Box { x: number; y: number; width: number; height: number }
export interface PlacementInput { viewport: Box; holes: Box[]; avoid: Box[]; actionBarTop: number; scoreBarBottom: number; bubble: { width: number; height: number }; dock?: 'under-menu' }
export interface BubblePlacement { x: number; y: number; notch: 'up' | 'down' | null; notchX: number }
export function placeBubble(input: PlacementInput): BubblePlacement;
```

`TableSource` gains (T2), all optional and read-only: `names?: [string, string]`, `allowsNewGame?: boolean`, `refusals?: number`. *(As built: `OnlineGameStore` already has a public `names`, read through `online.names`; see the T2 card.)*

**As-built signature changes** *(2026-10-24, T10 and T11 reviews)*. The plan's flight functions took the opponent's `Move`, whose hand index and target indices are hidden information. As built:

```ts
// lib/tutorial/motion.ts
export interface FlightMove { kind: MoveKindValue; card: Card | null; targetCard: Card | null }  // public facts only
export function flightMoveOf(move: Move, view: PlayerView): FlightMove;                  // the learner's own move
export function flightPlan(move: FlightMove, side: PlayerId, glasses: boolean): FlightPlanName;  // was (move: Move, by, glasses)
export function capture(move: Move, view: PlayerView, root: ParentNode): FlightCapture;  // learner only: throws unless view.active === 0
export function snapshot(view0: PlayerView, root: ParentNode): FlightSnapshot;           // new: pre-apply rects + seat-0 identities; throws for viewer ≠ 0
export function captureReply(snap: FlightSnapshot,
  entry: Pick<AppliedMove, 'by' | 'kind' | 'card' | 'targetCard'>): FlightCapture;     // new: Blake's flight from his redacted history entry
// FlightLayer.svelte
export function play(cap: FlightCapture, root: ParentNode, after?: PlayerView | null): void;
// lib/tutorial/table.svelte.ts: TutorialTableDeps gains
beforeReply?(view: PlayerView): void;   // Blake only: the seat-0 view on show, before his apply
afterReply?(entry: AppliedMove): void;  // Blake only: the new last seat-0 history entry (by === 1)
```

`capture` is never called with Blake's `Move`. `TutorialStore` routes the four table hooks to the mounted overlay through `attachMotion`.

---

## 6. Work items

Commands use `<wt>` for the absolute worktree path. Every item ends with `<wt>/scripts/ci.sh` at 9/9. A targeted unit run is `npm --prefix <wt>/web run test:unit -- tests/unit/<file>`, after `<wt>/scripts/build-wasm.sh` for any wasm-backed file. e2e runs only through `ci.sh`. **Models:** strict tier = Opus developer and Opus reviewer with mutation probes; light tier = Sonnet developer and Sonnet reviewer blocking only on real defects (loop-workflow §4.5). Briefs override the agent files' default model.

### T1. Spike: the board at game over under curtain `none` (B6)

- **Goal:** settle design B6 before T5 needs it.
- **Files:** create `web/tests/unit/game-screen-game-over.svelte.test.ts`. No production change. If the board breaks, report it; do not fix GameScreen.
- **Ledger:** none directly (decides R25.2/R25.8 behaviour). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** nothing. **Size:** S.
- **Test (jsdom, real wasm):** build lesson 1's position as a literal snapshot JSON inside the test (design §5.2, §6.1), `restore(json, 0)`, apply the PlayPoint 9D index, then `view(0)`: `state.phase === 4`, `winner === 0`. Hand that envelope to a `FakeTableSource` at curtain `none` and mount `GameScreen`. Assert: `board` mounts; `console.error` is not called; no `pass`, no `staging-bar`; `deck-pile` is not lit; tapping each `hand-card-*` stages nothing (no `staging-confirm`); `menu-button` works and `menu-home` calls `goHome`.
- **Acceptance:** the hand-back says PASS (T5 shows the post-win board) or FAIL with what broke (T5 uses the B6 fallback in §4). The orchestrator records the verdict in the round log before dispatching T5.

### T2. GameScreen seam: `names`, `allowsNewGame`, `refusals` key

- **Goal:** the only GameScreen changes the tutorial needs (design §6.3), with the counter-window remount proven.
- **Files:** modify `web/src/lib/stores/tableSource.ts` (three optional read-only fields with doc comments); `web/src/lib/components/GameScreen.svelte`: the `names` derivation (`online?.names ?? source.names ?? session.names`), `GameMenu`'s `newGame={!isOnline && source.allowsNewGame !== false}`, and `{#key source.refusals ?? 0}` around the `<CounterPrompt …/>` branch, with a comment citing design §5.5.1; modify the test helper `web/tests/unit/fake-table-source.svelte.ts` (settable `names`, `allowsNewGame`, `refusals`); create `web/tests/unit/game-screen-tutorial-seam.svelte.test.ts`.
- **Out of scope:** anything inside `CounterPrompt`, `Board` or board components; `GameStore` and `OnlineGameStore` (the fields stay absent there). *(As built, T2 review: `OnlineGameStore` already has a public `names`, its room names, which fits the optional field. GameScreen reaches it through `online.names` first, so its screen is unchanged. Nothing may treat "`names` present" as "tutorial".)*
- **Ledger:** R25.6 (second criterion; the `allowsNewGame` half of the first). **Tier:** strict. **Owner:** `cuttle-svelte-dev`, Opus; review Opus. **Depends on:** nothing. **Size:** S.
- **Red tests first:**
  - `source names win over session names`: source names `['Alice','Blake']`, session names set otherwise → the sr-only `<h1>` reads "Alice vs Blake". With `names` absent, the session's names show (unchanged).
  - `menu hides New game when allowsNewGame is false`: open the menu → no `menu-new-game`; `menu-home`, `menu-rules` and the theme options are present. Field absent → present. An online source → absent, as today.
  - `a refused Decline remounts a fresh prompt`: source at `{kind:'ack', to:0}` with one Counter and a Decline; its `apply` adds 1 to `refusals` and resolves. Tap `counter-resolve` → `apply(declineIndex)`; tap `counter-resolve` again → `apply` is called a second time, and the `counter-prompt` element is a new node. (Red without the key: the second tap does nothing.)
  - `the fresh prompt can counter`: after a refusal, tap `counter-option-*`, then `staging-confirm` → `apply(counterIndex)`.
  - `no remount without refusals`: `refusals` absent; stage the counter, then toggle `pending` true→false and change `history` to an equal copy → the same `counter-prompt` node, still staged.
- **Acceptance:** the five tests; `counter-prompt.svelte.test.ts`, `game-screen*.svelte.test.ts`, `online-game-screen.svelte.test.ts`, `game-menu.svelte.test.ts` unchanged and green. Reviewer mutants: remove the key; key on `source.seq` or `source.pending`; drop the `!== false`; swap the `names` fallback order.

### T3. Lessons as data, positions, move predicate, real-wasm replay

- **Goal:** the five lessons as data, and the executable proof that every position is valid and every script plays exactly as the design says through engine v0.2.1.
- **Files:** create `web/src/lib/tutorial/types.ts`, `position.ts`, `lessons.ts`, `match.ts` (predicate half: `targetCardOf`, `moveMatches`, `matchingIndices`, `nudgeFor`); tests `web/tests/unit/tutorial-positions.test.ts`, `tutorial-lessons-wasm.test.ts`, `tutorial-match.test.ts`.
- **Content:** positions, steps, copy, nudges, Blake scripts and done lines exactly as design §5.2–§5.6, plus Appendix A. Cards are authored with `c(rank, suit)` (numeric `Card` values, no glyphs). Every point entry serializes with `JackStack: null, JackOwners: null`; `Permanents` and `FrozenIDs` null; `Pending` and `Winner` null; `PassesInARow` 0. Deck = `deckTop`, then every unnamed card in canonical order (clubs A–K, diamonds, hearts, spades).
- **Ledger:** R25.2. **Tier:** strict. **Owner:** `cuttle-bridge-dev` (engine-citation discipline), Opus; review Opus. The brief grants `web/src/lib/tutorial/{types,position,lessons,match}.ts` and the three test files. **Depends on:** nothing. **Size:** M.
- **Red tests first:**
  - S2 `positions are valid` (per lesson): `positionCards` has 52 cards, all unique by `Rank:Suit`; `restore(positionSnapshot(pos), 0)` is ok, `active 0`, `phase 0`, `history []`; `deckCount` is 39, 43, 40, 40, 39; the snapshot's `Deck` starts with `deckTop` (lesson 2: 10D, 8S; lesson 5: AD).
  - S1 `lesson N replays` (one `it` per lesson and per predicate alternative: 3.1 × {9D, 6C}, 5.2 × {JD, JS}): restore, then walk the steps. At each move step: `matchingIndices(view(0), expect)` is non-empty; for each match, the legal moves sharing its `HandIndex` (or Kind Draw) and `boardTargetKey` number exactly one (P4, the design §7.2 data rule); apply it and record `descriptions[i]`. For each Blake reply: `matchingIndices(legalMoves(), reply.move)` has exactly one index; apply it and record. Compare the recorded descriptions with a golden list in the test file (glyphs allowed there). Checkpoints: L1 ends phase 4, winner 0; L2 ends with Alice at 12 points holding 3D and 10D; L3 ends with 8C in the scrap; L4 has both points rows empty after 4.1, `phase 1, active 0` after Blake's 4, `phase 0, active 0` after the counter; L5 has `opponent.hand` non-null after 5.1, no legal move for the remaining Jack after the Queen, and ends `phase 4, winner 0`, `scoreboard.you.threshold 14`, `points 15`.
  - `every nudge rule is reachable`: at each move step, each `nudges[k].when` matches at least one legal move that fails `expect` (no dead copy).
  - `copy fits`: every main, staged, success and tap-route line ≤ 120 characters; every nudge + " Tap Cancel to try again." ≤ 160; no line contains a suit glyph.
  - `tutorial-match.test.ts`: `moveMatches` refuses a kind mismatch, a card mismatch and a target mismatch; accepts either card of a `card` array and either target of a `target` array; reads `JackTarget` for a Jack and `Target` otherwise; `targetCardOf` maps `Owner`/`Zone`/`Index` against both `you` and `opponent` for a viewer of 0 and of 1.
- **Acceptance:** R25.2 both criteria. The test file header cites v0.2.1 `file:line` for each rule the checkpoints rely on (design §5 "Engine" lines). A checkpoint that fails against the engine is not "fixed" by changing the lesson: stop and report (it is an ApisMellow decision on copy or position).

### T4. Coach visual kit

- **Goal:** the overlay's presentational parts, the motion tokens, and the pure placement function, all driven by props.
- **Files:** modify `web/src/lib/styles/tokens.css` (`--cu-dur-flight: 420ms`, `--cu-dur-demo-travel: 660ms`, `--cu-dur-deal-stagger: 80ms`, `--cu-ease-land: cubic-bezier(0.3, 1.25, 0.5, 1)`, each zeroed under `prefers-reduced-motion: reduce`); create `web/src/lib/tutorial/placement.ts`, `web/src/lib/components/CoachBubble.svelte`, `CoachSpotlight.svelte`, `LessonDoneSheet.svelte`; tests `web/tests/unit/coach-bubble.svelte.test.ts`, `coach-spotlight.svelte.test.ts`, `lesson-done-sheet.svelte.test.ts`, `tutorial-placement.test.ts`.
- **Props:** `CoachBubble { text, tone: LineTone, stepId, stage, showNext, onnext, onshowme, onleave, lessonNumber, placement: BubblePlacement, shake: number, headline?: string, error?: { onrestart } }`: `<section aria-label="Coach" data-testid="coach-bubble" data-step data-stage data-tone>`, copy in `<p aria-live="polite" tabindex="-1">`, footer Show me / Leave / "N of 5", Next only when `showNext`, Restart lesson + Leave only when `error`. `CoachSpotlight { holes: Box[], ring: 'iris' | 'ochre', visible }`: one `<svg>` mask (`--cu-curtain` at 0.62, 10 px radius, 6 px padding), one ring `div` per hole with `data-coach-hole`, `aria-hidden`, `pointer-events: none`. `LessonDoneSheet { lesson, doneLine, done: readonly number[], final, onnext, onlessons, onplay }`: non-modal `role="dialog"`, focuses its heading, Escape calls `onlessons`, five pips with "N of 5 lessons done" for screen readers.
- **Ledger:** R25.7 (render half), R25.10 (aria-hidden and live region parts). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** nothing. **Size:** M.
- **Tests (L1):** bubble renders the text, testids and data attributes; Next only when `showNext`; the copy paragraph is `aria-live="polite"`; Restart shows only with `error`; a `shake` change runs no animation under reduced motion. Spotlight renders N holes and N rings, is `aria-hidden`, and takes no pointer events. Done sheet: heading "Lesson 2 done", or "You've learned Cuttle" when `final`; Next lesson and Lessons, or Play a game and Lessons when final; Escape → `onlessons`; the heading has focus. `placeBubble`: below the lowest hole when it fits above the action bar with 12 px spare; else above the highest hole; else the side with more room; else docked under the score bar; `under-menu` docking; never intersects a hole or an `avoid` box in each fixture; x clamps to a 16 px gutter.
- **Acceptance:** the tests above; tokens present and zeroed under reduced motion; a fit check of each component at 393×852 in the hand-back (screenshot from a component harness or a Playwright mount).

### T5. `TutorialTable`: the apply gate, Blake's replies, isolation

- **Goal:** the third `TableSource`: restores a lesson, refuses every commit but the expected one, plays Blake's script on timers, and never touches the real game.
- **Files:** create `web/src/lib/tutorial/table.svelte.ts`; tests `web/tests/unit/tutorial-table.test.ts`, `tutorial-isolation.test.ts`; test helper `web/tests/unit/tutorial-driver.ts` (`expectedIndex(table)`, `wrongIndices(table)`, `driveLesson(table, opts: { wrongFirst?: number; seed?: number })` using fake timers).
- **Behaviour:** design §6.2 plus §4 B6, P1, P3. `curtain` is `{kind:'ack', to:0}` exactly while `view(0).state.phase === 1` with `active 0`, else `none`. `apply(i)`: if `pending`, return; at a move step in phase `step`, if `moveMatches(legalMoves[i], step.expect, view)`: `beforeApply?.(move, view)`, `engine.apply(i)` (its envelope is dropped), set state from `view(0)`, `afterApply?.()`, then the P3 beats. Otherwise apply nothing, set `lastNudge` (`nudgeFor`, or the P1 copy outside a move step), add 1 to `refusals` and to `wrongTries` (move steps only), resolve normally. Blake's legal list is a local inside the reply callback only. Every timer carries a generation number; `dispose`, `restart` and `newGame` bump it, so a stale callback is a no-op. `ok:false` from the engine, or a Blake predicate matching zero or several moves, sets phase `error` with the line "This lesson hit a snag."
- **Ledger:** R25.3 (S3a, S3c at store level, S4 at store level, "the apply gate is TutorialTable.apply only"), R25.4 (S5, S6). **Tier:** strict. **Owner:** `cuttle-svelte-dev`, Opus; review Opus. **Depends on:** T1 (verdict), T2, T3. **Size:** L.
- **Red tests first** (real wasm, `vi.useFakeTimers`):
  - `starts on Alice's view`: `viewer 0`, `envelope.state.viewer 0`, `curtain none`, `seq 0`, `names [learner, 'Blake']`, `allowsNewGame false`, `refusals 0`, `pending false`.
  - S3a `refuses every wrong move at every move step`: for each legal index failing the predicate, `snapshot()`, `envelope`, `seq` and `history` are unchanged, `refusals` +1, `lastNudge === nudgeFor(...)`; the expected move then completes the step.
  - `refuses every commit outside a move step` (Review focus 2): at 1.1–1.4, 2.3, 5.3 and after the lesson finishes, every legal index is refused and the bridge snapshot is unchanged.
  - S3c `step 4.2 at the store`: the curtain is `ack` to 0 on arrival; a refused Decline leaves `view(0)` at phase 1, active 0, curtain `ack` at every observation; the counter index completes the step, then phase 0, active 0, curtain `none`.
  - S4 `fuzz finishes every lesson`: seeded (fixed seeds 1–20), up to 6 wrong commits before each right move; every lesson reaches `finished`; every move step has a non-empty `generic`.
  - P3 `beat order`: after a match, phase `success` with the success line; +1200 ms → `blake` with "Blake's turn." and `pending true`; +700 ms (400 with `reducedMotion`) → his move applied and its `done` line; +1200 ms → next step, `pending false`. `skipBeat()` during `success` moves on at once; during the think pause it does nothing.
  - `stale timers never apply` (Review focus 3): `dispose()` (and separately `restart()`) during the think pause, then `vi.runAllTimers()` → snapshot equals the restored position.
  - `errors are never a dead end`: a lesson copy whose Blake predicate matches nothing → phase `error`; a fake engine whose `apply` returns `ok:false` → phase `error`; `restart()` from `error` restores the position at step 0.
  - `the legal list is the engine's`: at each step, `table.envelope.legalMoves` deep-equals `view(0).legalMoves`.
  - `motion hooks`: `beforeApply` runs before `engine.apply` with the matched move; `afterApply` after the state is set; neither runs on a refusal.
  - S6 `seat-0 view only`: at every step and every alternative, `envelope.state.viewer === 0`; `opponent.hand` is `null` except in lesson 5 after 5.1; after each Blake reply, a recursive walk of the table's enumerable fields finds no object with `state.viewer === 1`. The reviewer repeats the walk on `#` fields renamed in a scratch copy.
  - B6: at a lesson-1 or lesson-5 win, the shown envelope is the post-win `view(0)` (or the pre-move one under the fallback).
  - S5 `tutorial-isolation.test.ts`: with a real `GameStore` save mid-game and a tally in a spied storage, run all five lessons with the driver; no `setItem`/`removeItem` at all; `cuttle-web:game` and `cuttle-web:tally` are byte-identical; a fresh `GameStore` `restore()` lands at the same `seq` and curtain; `session.names` unchanged.
- **Acceptance:** every test above maps to its ledger criterion in the hand-back. Mutants the reviewer must see killed: let a wrong move through; drop the predicate's card check; drop its target check; store Blake's envelope on a field; drop the timer generation check; set `curtain none` during the counter window.

### T6. Staged-setup reader and classifier

- **Goal:** design §7.2's matcher: page state plus the engine's list gives right, wrong (with the nudge) or unknown, so the coach can nudge before Confirm.
- **Files:** modify `web/src/lib/tutorial/match.ts` (add `readStagedPage`, `classifyStaged`); create `web/tests/unit/tutorial-staged-match.svelte.test.ts` (jsdom, real wasm, mounted GameScreen), `web/tests/unit/tutorial-staged-match.test.ts` (pure, fixture DOM).
- **Rules:** `readStagedPage` reads only attributes design §7.2 lists (`aria-pressed`, `data-staged`, `data-state="staged"` on `deck-pile`, `zone-*` and the face inside `point-*`/`perm-*`, presence of `staging-confirm` and `counter-prompt`) and imports nothing from `lib/stores/`. `classifyStaged`: candidates per P4; every candidate matches → right; none → wrong with the first candidate's specific nudge, else `generic`; mixed → unknown; no source (Pass, or nothing staged) → unknown.
- **Ledger:** R25.3 (S3b at the matcher). **Tier:** strict. **Owner:** `cuttle-svelte-dev`, Opus; review Opus. **Depends on:** T2, T3. **Size:** M.
- **Red tests first:**
  - S3b `every staging at every board move step` (mounted): for each lesson, walk to each board move step with the engine directly (no `TutorialTable`), put `view(0)` into a `FakeTableSource`, mount `GameScreen`, and for each legal move: tap its hand card (or the deck), tap its `boardTargetKey`'s testid, pick its option if the chooser opens, then `readStagedPage(screen)` → `classifyStaged`. Verdict is right exactly when `moveMatches`, wrong exactly when not (with the step's nudge), unknown only for a mixed chooser group. Cancel between moves.
  - `expected setups are never unknown`: the verdict at every expected move is right.
  - pure fixtures: deck staged → source `deck`; a staged point face → `point:o:i`; `staging-confirm` inside `counter-prompt` → `counter: 'staged'`; nothing staged → all null.
  - `reads no store`: a source scan of `match.ts` finds no import from `stores/`.
- **Acceptance:** the tests above. Mutants: classify by `slotKey` instead of `boardTargetKey`; drop the source check; return right for unknown.

### T7. Progress storage, `TutorialStore`, Home control, lessons screen

- **Goal:** how a player gets in, where progress lives, and the lessons screen.
- **Files:** create `web/src/lib/tutorial/progress.ts`, `web/src/lib/tutorial/tutorial.svelte.ts`, `web/src/lib/components/TutorialLessons.svelte`; modify `web/src/lib/components/HomeScreen.svelte` (the `learn-to-play` pill directly under the title, above Pass and play, with the muted line; `onclick` → `tutorial.open()`; `tutorial.reload()` at mount); tests `web/tests/unit/tutorial-progress.test.ts`, `tutorial-store.test.ts`, `tutorial-lessons.svelte.test.ts`, `home-learn-to-play.svelte.test.ts`.
- **Behaviour:** design §4.1, §4.2, §10. `TutorialStore` holds `done` in memory and writes through `saveProgress` (a throwing storage keeps the memory copy). `start(id)` disposes any previous table and creates one with `createTable(lesson, { learnerName, reducedMotion, onHome: exitHome, … })`. `leave()` disposes the table and shows the lessons screen; `exitHome()` disposes it and sets `active = false`. `finishLesson(id)` adds `id` and saves. `nextLesson()` starts `id + 1`. The exported singleton's factory throws until T9 wires it.
- **Ledger:** R25.1, R25.5, R25.12 (Home half), R25.6 (routing half of "menu Home returns Home" at store level). **Tier:** strict (store, storage, no-prompt); the lessons screen's looks are light within it. **Owner:** `cuttle-svelte-dev`, Opus; review Opus. **Depends on:** T3 (types, lesson titles). **Size:** M.
- **Red tests first:**
  - S7 progress: `null` → `[]`; `{"v":1,"done":[2,1,2]}` → `[1,2]`; unknown numbers `0, 6, 2.5, "3"` dropped; `v: 2` → `[]`; malformed JSON → `[]`; a non-object → `[]`; `getItem` throws → `[]`; `setItem` throws → `false`, no throw; `encodeProgress` keys are exactly `v` and `done`.
  - store: `open` → `active`, `lessonId null`; `start(3)` → `lessonId 3`, a table from the factory; `leave` → `lessonId null`, the table disposed; `exitHome` → `active false`; `finishLesson` writes only `cuttle-web:tutorial` (storage spy); storage that throws keeps `done` in memory; `nextUnfinished` is the first missing number, `null` when all five are done.
  - B1 `learnerName` (Review focus 5): `null`, `['','x']` and `['Player 1','x']` → "You"; a 40-character name and an emoji name pass through; the store never calls `settings.setLastNames` or writes `cuttle-web:settings`.
  - Home (R25.1, S9 Home half): `learn-to-play` ≥ 44 px, under the title and above `mode-pass-play`; line "Five short lessons", "3 of 5 done", "All 5 lessons done" from storage; no animation, `aria-live`, badge or dialog with empty storage; tapping calls `tutorial.open()`.
  - Lessons screen (R25.1, L1 part): five rows `tutorial-lesson-1…5` (≥ 56 px) in order with an ochre ✓ and "done" text for finished ones; any row calls `start(n)`; `tutorial-continue` reads "Start", "Continue: lesson N" or "Play again from lesson 1"; `tutorial-lessons-back` and Escape call `exitHome`.
- **Acceptance:** the tests above; R25.1 both criteria at unit level; R25.5 both criteria (the "written when the done sheet appears" half is asserted in T9).

### T8. `motion.ts` base and the ghost demo

- **Goal:** the reduced-motion switch, token reading, and the fingertip demo (design §8.2, §8.3).
- **Files:** create `web/src/lib/tutorial/motion.ts` (`motionOn`, `readMotionTokens`, `dragDemoFrames`, `tapDemoFrames`), `web/src/lib/components/GhostDemo.svelte` (props `{ demo: { kind: 'drag'; from: Box; to: Box; card: Card } | { kind: 'tap'; at: Box[] } | null; playKey: number; motion: boolean; confirmBox?: Box; theme }`); tests `web/tests/unit/tutorial-motion.test.ts`, `ghost-demo.svelte.test.ts`.
- **Behaviour:** the drag timeline and tap timeline exactly as design §8.3; the ghost card is the theme `Face` at hand size at 72% opacity inside a container that owns geometry (SPEC §5.6 rule 2); `pointer-events: none`, `aria-hidden`; a `pointerdown` on window (passive) cancels the running demo. With `motion` false: static "1", "2" and (with `confirmBox`) "3" markers and a dashed iris line, no `animate()` call.
- **Ledger:** R25.8 (demo part), R25.9 (markers, unit level). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** T4 (tokens). **Size:** M.
- **Tests:** `motionOn` false when the media query or the setting asks; frames use only `transform` and `opacity` keys; a drag demo calls `Element.animate` (stubbed in jsdom) with the design durations; a `playKey` change replays; a `pointerdown` cancels; `motion: false` renders the numbered markers and calls no `animate`; the root is `aria-hidden` with no testid.

### T9. Coach controller, `CoachOverlay`, App routing

- **Goal:** a playable tutorial: the coach state machine read from the page, the composed overlay, and the App routes.
- **Files:** create `web/src/lib/tutorial/coach.svelte.ts` (`CoachController`), `web/src/lib/components/CoachOverlay.svelte`; modify `web/src/App.svelte` and `web/src/lib/tutorial/tutorial.svelte.ts` (the real table factory); tests `web/tests/unit/coach-controller.svelte.test.ts`, `coach-overlay.svelte.test.ts`, `app-tutorial.svelte.test.ts`.
- **Controller:** owns a `MutationObserver` (attributes and child list) on the game-screen root and `readStagedPage`; computes the stage per design §7.2 with these exit rules: `refused` is entered when `table.refusals` rises and left at the next page change away from idle; `staged-wrong` calls `table.noteStagedWrong()` once per entry; idle and selected show `tapRoute` once `wrongTries ≥ 2`, else the main line. It resolves `SpotTarget`s to testids against `table.envelope.state` and measures holes (6 px padding) once per animation frame on resize, board scroll and every change, after `scrollIntoView({block:'nearest'})`. It completes `appear` steps via `table.appeared(testId)`. It imports nothing from `lib/stores/staging.svelte.ts`. `dispose()` disconnects the observer and cancels its frame.
- **Overlay:** composes `CoachSpotlight`, `GhostDemo`, `CoachBubble`, `LessonDoneSheet` (and a slot for `FlightLayer`, filled in T11). It fades to opacity 0 with no pointer events while `game-menu`, `rules-sheet`, `scrap-browser`, `card-detail-popover` or `ambiguity-chooser` is in the DOM, except that an `appear` step waiting for that element completes first. Focus per design §9. On the done sheet's mount it calls `tutorial.finishLesson(id)`. Next lesson → `tutorial.nextLesson()`; Lessons → `leave()`; Play a game → `exitHome()`; Leave → `leave()`; Restart lesson → `table.restart()`.
- **App:** inside the `game.screen === 'home'` branch, before the online checks, `tutorial.active` routes to `'tutorial'`: `TutorialLessons` when `lessonId` is null, else `{#key tutorial.lessonId}` `<GameScreen source={tutorial.table} /><CoachOverlay … />{/key}`. `reportScreen` gets `'home'` for the lessons screen and `'game'` for a lesson (map it; don't widen `UpdateScreen`). A reload lands on Home (the store is memory only).
- **Ledger:** R25.3 (S3b through the overlay, S3c in the DOM, S4 "an enabled control leads forward"), R25.5 ("written when the done sheet appears"), R25.6 (Leave from every step, menu Home), R25.7 (unit), R25.10 (unit), R25.12 (in-game and result-screen half). **Tier:** strict. **Owner:** `cuttle-svelte-dev`, Opus; review Opus. **Depends on:** T2, T4, T5, T6, T7, T8. **Size:** L.
- **Red tests first** (jsdom, real wasm, the real `TutorialTable`):
  - S3b `the coach follows staging` (every board move step, every legal move): `data-stage` is `staged-right` exactly for matching setups (bubble = the staged line, hole on `staging-confirm`), `staged-wrong` exactly for wrong ones (bubble = nudge + " Tap Cancel to try again.", hole on `staging-cancel`, the word "Confirm" nowhere in the bubble), and the main line again after Cancel. A wrong Confirm → `refused` with the nudge and no Cancel sentence. Two wrong entries → the tap-route line.
  - S3c `step 4.2 in the DOM`: "Let it resolve" → `refused`, a new `counter-prompt` node with `counter-option-*`, `counter-resolve` enabled; no `board` in the DOM at any point of the window; counter, then Confirm → `done`.
  - S4 `always a way forward`: after every action of a seeded fuzz walk, some enabled control on screen leads to the expected move (the expected hand card, the counter option, `staging-cancel`, or `coach-next`), and Leave, Show me and `menu-button` are enabled.
  - S8 `exits`: `coach-leave` from every step of every lesson lands on `tutorial-lessons`; `menu-home` lands on `home-screen` with `tutorial.active` false; no `menu-new-game` in the tutorial menu.
  - R25.5: `cuttle-web:tutorial` is written when `coach-lesson-done` mounts, not before.
  - Review focus 1: with the overlay up, open the menu, Rules, the scrap browser and the popover in turn; the overlay is at opacity 0 with `pointer-events: none`, and `menu-home`, `rules-close`, `scrap-browser-close` and `card-detail-popover-close` receive their clicks.
  - Review focus 4: with `settings.tableMode` true, `data-table-rotated="false"` at every step of lesson 4.
  - S9 App half: empty storage, App at Home, then a pass-and-play game to its result screen: no tutorial dialog, toast, badge or overlay anywhere.
  - a11y: the bubble copy is `aria-live="polite"`; focus goes to the copy at lesson start; Next takes focus only after key input; the done sheet's heading takes focus.
  - `no store reads`: a source scan of `coach.svelte.ts` and `CoachOverlay.svelte` finds no `staging` import.
  - `dispose`: after Leave, mutating the old root fires no controller callback.
- **Acceptance:** each listed ledger criterion maps to a test. Mutants: drop the fade rule for one sheet; show the Confirm line on `staged-wrong`; skip `noteStagedWrong`; read `StagingStore` directly; call `finishLesson` at the last move instead of the sheet.

### T10. `FlightLayer` and flight plans

- **Goal:** design §8.4's FLIP-on-clones motion, standalone and tested, ready for T11 to wire.
- **Files:** modify `web/src/lib/tutorial/motion.ts` (`capture`, `flightPlan`, plan keyframes per design §8.4 table); create `web/src/lib/components/FlightLayer.svelte` (props `{ theme; motion: boolean }`, method `play(capture: FlightCapture, root: ParentNode): void`); test `web/tests/unit/flight-layer.svelte.test.ts`.
- **Rules:** clones only from public identities in the capture (Blake's hand as backs unless glasses are down; a card Blake plays flips face up at the midpoint). The destination element is held invisible with a WAAPI `[{opacity:0},{opacity:0}]`, `fill: 'none'`; no attribute, class or state is written; nothing awaits. `perspective: 900px` on the layer; flips use `rotateY` with `backface-visibility: hidden`. Reduced motion: no clones, a static 600 ms ochre ring on each destination.
- **Ledger:** R25.8 (second criterion, unit). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** T3, T8. **Size:** M.
- **Tests:** every move kind in the five lessons (PlayPoint, PlayPermanent including the Jack steal and the glasses 8, Scuttle, OneOff including the Ace's sweep, Draw by Alice and by Blake, Counter) maps to a named plan, and an unknown kind to `arrive`; Blake's draw without glasses clones a `Back` only; keyframes use only `transform` and `opacity`; the reduced path calls no `animate` and draws the rings.
- **As built (review REVISE):**
  - B1: spreading a `DOMRect` gave NaN keyframes, which left Jack and scuttle movers stuck in a real browser. Rects are now copied to plain objects.
  - B2: Blake's flights needed his `Move`, which carries hidden indices. They now use the public-only `FlightMove`, `snapshot` and `captureReply` (§5, "As-built signature changes").

### T11. Motion in the lesson: deal, flights, success and win beats

- **Goal:** the tutorial feels alive without blocking anything.
- **Files:** modify `web/src/lib/components/CoachOverlay.svelte` (mount `FlightLayer`; deal on lesson 1; ring flash; win wave, score-meter pulse and "You win!" headline; glasses flip in place), `web/src/lib/tutorial/tutorial.svelte.ts` (pass `beforeApply`/`afterApply` to the table: `capture` then `tick()` and `play`); tests `web/tests/unit/tutorial-motion-wiring.svelte.test.ts`, `tutorial-no-await.svelte.test.ts`.
- **Ledger:** R25.8 (both criteria), R25.9 (unit side). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** T9, T10. **Size:** M.
- **Tests:** L5: with `Element.prototype.animate` stubbed to return animations that never finish, all five lessons complete through the driver and the mounted overlay, and every phase change happens on its timer; a tap during the lesson-1 deal calls `finish()` on every deal animation; reduced motion → no clone and `document.getAnimations()` empty once each step settles; win beats run only in lessons 1 and 5.
- **As built:** T11 also added the Blake flight hooks `beforeReply(view0)` and `afterReply(entry)` to `table.svelte.ts`, so that part was strict tier. The S6 walk now covers every hook argument. The learner's flights are wired as `beforeApply` → `capture(move, view0, boardRoot)`, then `afterApply` → `tick()` → `play(cap, boardRoot, view(0))`. Blake's are wired as `beforeReply` → `snapshot(view0, boardRoot)`, then `afterReply(entry)` → `captureReply(snap, entry)` → `tick()` → `play`. The board root is passed, never the overlay's.

### T12. Bubble placement tuning and the geometry e2e

- **Goal:** design §7.3 holds at all three viewports for every step.
- **Files:** create `web/tests/e2e/tutorial-geometry.spec.ts` and `web/tests/e2e/helpers/tutorial.ts` (navigate Home → lesson N; read the step from `data-step`/`data-stage`; play a step's expected move by taps using the DEV test hook's envelope to resolve card identities to testids); modify `web/src/lib/tutorial/placement.ts` constants only as tuning needs.
- **Ledger:** R25.7 (L2 criterion). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** T9 (T11 merged first if both are in the integration branch; geometry is measured with motion settled). **Size:** M.
- **Tests (L2):** at 393×852, 430×932 and 393×660 (`test.use({ viewport })`), for every step of every lesson and each of its stages reachable by the helper (idle, selected, staged-right, one staged-wrong, refused at 4.2): the bubble box intersects no `[data-coach-hole]`, `staging-bar`, `menu-button` or `counter-option-*`; `scrollWidth <= clientWidth`; every new testid is ≥ 44×44. Waits are on `data-stage`, never on fixed timeouts.
- **Acceptance:** green under `ci.sh` with no `flaky` or retries; the hand-back records the final placement constants (B2).
- **As built:** the final constants are clearance 12, gutter 16, hole padding 6, notch 8 and dock gap 8, plus a new `promptDock` of 108 px. The counter-prompt dock had covered the prompt's heading and played line. The last-resort dock now slides down past holes and staged cards instead of covering them.

### T12b. Coach polish *(added during round 5)*

- **Goal:** close the non-blocking findings from the T11 and T12 reviews before the judge.
- **Files:** `CoachSpotlight.svelte`, `CoachBubble.svelte`, `CoachOverlay.svelte`, `FlightLayer.svelte`, `Board.svelte` (scroll padding only), `lib/tutorial/{coach.svelte,lessons,motion}.ts`, `web/tests/e2e/helpers/tutorial.ts`, and their tests.
- **Content:**
  - Spotlight rings are keyed by target. The pulse waits out the 200 ms fade-in. Rings wider than 360 px pulse opacity only.
  - The board keeps `scroll-padding-top` at the sticky score bar's measured height, and the coach scrolls every target into view, not just the first.
  - Lit drop targets at `selected` join the bubble's avoid set, as do `opp-hand` during the success beat and `opponent-zone` and `deck-pile` during Blake's beats.
  - "You win!" is the headline only, inside the bubble's single live region; the 1.5 and 5.4 success lines drop it.
  - The glasses 8's clone carries the theme's glasses face.
  - `OWN_CONTROLS` and `ownsInput` are exported from `coach.svelte.ts` and shared with `CoachOverlay`.
- **Ledger:** R25.7, R25.8, R25.10 (no new criteria). **Tier:** light, with an Opus review. **Depends on:** T13, which merges first because both touch `helpers/tutorial.ts`.

### T13. End-to-end walkthroughs (final round)

- **Goal:** all five lessons, as a player would do them, at both phone sizes, by touch and by keyboard, plus reduced motion.
- **Files:** create `web/tests/e2e/tutorial-walkthrough.spec.ts`, `tutorial-keyboard.spec.ts`, `tutorial-reduced-motion.spec.ts` (reuse `helpers/tutorial.ts`).
- **Ledger:** R25.7 (L3), R25.9 (L4), R25.10 (keyboard e2e). **Tier:** light. **Owner:** `cuttle-svelte-dev`, Sonnet; review Sonnet. **Depends on:** T11, T12. **Size:** M.
- **Tests:**
  - touch, at 393×852 and at 430×932: Home → `learn-to-play` → `tutorial-continue` → all five lessons by drag (play moves) and tap (deck, counter); one deliberate wrong staging per lesson (expect `staged-wrong`, the nudge plus "Tap Cancel to try again.", Cancel spotlit, no Confirm line), then Cancel and the right move; in lesson 4 one "Let it resolve" tap, expect the nudge and a usable fresh prompt, then counter. Each done sheet shows; the final reads "You've learned Cuttle"; Play a game lands on Home with "All 5 lessons done".
  - keyboard only at 393×852: the same five lessons with Tab, Enter and Space; Escape on the done sheet goes to Lessons.
  - reduced motion: `page.emulateMedia({ reducedMotion: 'reduce' })`, and separately `settings.reducedMotion` seeded in `cuttle-web:settings` before load: after each step settles `document.getAnimations()` is empty, the numbered markers show, all five lessons complete.
  - after the run, `cuttle-web:settings` (when seeded) and `cuttle-web:game` are unchanged.
- **Acceptance:** green under `ci.sh` with no retries; the hand-back lists run time per spec.

### T14. Screenshot judge (final round)

- **Goal:** R25.11's taste verdict.
- **Owner:** the playtest judge role (loop-workflow §4), Opus. No repo files change; evidence goes in the round log.
- **Scope (L6):** at 393×852, the lesson 1 deal, a lesson 3 scuttle flight, the lesson 5 glasses flip and the lesson 5 win. Rule accept or revise on legibility, pacing, liveliness, and whether the spotlight or bubble ever hides what the copy talks about. A revise routes to the owning item's developer (T4, T11 or T12) with screenshots.
- **Depends on:** T11, T12. Runs in parallel with T13.
- **As built:** the first pass was REVISE. Legibility and liveliness were ACCEPT; pacing, "hides what the copy talks about" and first-impression clarity were REVISE. Must-fixes:
  - M1: the bubble covered the staged card after a real drag.
  - M2: the bubble hid Blake's points row during success beats (the 3.1 scuttle).
  - M3: the beats were too fast at 1.2 s.
  - M4: Show me rendered with no demo.
  They went to a new item, T14fix (below). On re-check M1–M4 were fixed in a real browser at 393×852, and the verdict was ACCEPT on all five criteria. R25.11 is verified.

### T14fix. The judge's must-fixes *(added during round 5)*

- **Goal:** M1–M4 from T14, plus the judge's smaller notes.
- **Changes:**
  - Success and narration beats are 2200 ms.
  - `placeBubble` takes a `soft` list. Flight boxes (`flightBoxes`) are soft during beats, and the step target is soft at `staged-wrong`.
  - The coach re-measures on `transitionend`/`transitioncancel` in the GameScreen root.
  - `coach-show-me` is conditional.
  - The footer reads "Lesson N/5".
  - Step 1.5 spotlights the 9 and `zone-points`, and its success line is "You reached 21."
  - Lesson 4's done line names "The Rules page".
  - The reduced-motion "3" sits above Confirm.
  - The 4.2 demo is held until Blake's 4 has landed in the prompt (`intoPrompt`).
  - The finale's pips fill in turn.
  - An iris ring shows on `opp-hand` during the glasses flip.
- **Review:** Opus REVISE, test-only (Show me must release the 4.2 hold, plus N1–N4); judge re-check ACCEPT.
- **Ledger:** R25.11. **Tier:** light, Opus on both sides.

### T15. Docs sync (final round, after T13 and T14 merge)

- **Goal:** the docs match what shipped.
- **Owner:** the orchestrator (docs and ledger are its writes), Sonnet for the edit, read through by the orchestrator. No application code.
- **Files and content:**
  - `docs/SPEC.md`: §5.4 and §2.4's note gain `names`, `allowsNewGame`, `refusals` (P7); §4.3 notes `GameScreen` keys `CounterPrompt` on `refusals ?? 0`; §5.2 adds the tutorial components and the GameScreen notes; new **§5.11 Tutorial**, pointing to the design and this plan and stating what became contract: the gate (incl. P1), the `cuttle-web:tutorial` shape, the new testids and `data-step`/`data-stage`/`data-tone`/`data-coach-hole`, and the P3 beats; Appendix A gets the R25 rows.
  - `docs/requirements.yaml`: R25.1–R25.12 statuses and evidence strings (test names and round numbers), per loop-workflow §3.1.
  - `docs/ROADMAP.md`: mark Learn to play shipped; add "Card flights in real games" (B5), reusing `FlightLayer` and `motion.ts`.
  - `AGENTS.md`: a short "Tutorial (R25)" playbook section: the gate is `TutorialTable.apply`; the coach reads the DOM, never the staging store; Blake's envelope stays local; tutorial storage is `cuttle-web:tutorial` only; lesson copy lives in `lessons.ts` and is checked by `tutorial-lessons-wasm.test.ts`.
  - `docs/traceability.md`: R25 rows, if the file maps requirement IDs to tests.
  - this file's Progress table.
- **As built:** written in parallel with T12b and T14, from a base before T12b merged (#100). T12b's changes are checked against its merged code and marked "T12b" in the design and SPEC. It also fixes the `ci.yml` header comment (#83 left it saying main only), records the build-time rulings (§4.1) and the flight signature change (§5), and adds `docs/loop-log/tutorial-build.md`. It records the T14 verdict (REVISE, then ACCEPT on re-check after T14fix), so R25.11 is verified, and folds in T14fix's as-built changes.

## 7. Rounds

| Round | Items (parallel worktrees) | Merges | Why this order |
|---|---|---|---|
| 1 | T1, T2, T3, T4 | each on acceptance; T1's verdict recorded before round 2 | The risky seams first: the `{#key}` remount (T2), every position and script through the real engine with the 52-card check (T3), the untested game-over render (T1). T4 has no dependencies. |
| 2 | T5, T6, T7, T8 | each on acceptance | The strict core on proven ground. T5, T6 and T7 touch separate files; T6 extends `match.ts` after T3 merged it. |
| 3 | T9, T10 | T9, then T10 | T9 joins everything into a playable tutorial; T10 builds the flight layer standalone. |
| 4 | T11, T12 | T11 first, then T12 rebased on it | Motion polish only after the gate, matcher and overlay are accepted. |
| 5 | T13, T14, then T15 | T13 and T14 fixes, then T15 | The final gate: walkthroughs at 393×852 and 430×932, reduced motion, the judge, then the docs. |

Revise routing, the three-strike stall and the post-merge gate are loop-workflow §5 unchanged. A T3 checkpoint that fails against the engine, or a T13 walkthrough that shows a design rule can't hold, stops that item for an ApisMellow decision (loop-workflow §10): it is never reinterpreted.

## 8. Risks

1. **The overlay above the menu** (Review focus 1). The design's fade rule carries the whole guarantee; a sheet the rule doesn't list (a future one included) would be covered by the bubble. T9 tests each known sheet; T15 records the rule in SPEC §5.11 so new sheets join it.
2. **The design's engine reading meets the engine in round 1.** If a position, a counter window or a win check doesn't behave as design §5 says, lesson copy or positions change, which is ApisMellow's call. Front-loading T3 keeps that from surfacing after the overlay is built.
3. **Timers across lessons** (Review focus 3). The generation check in T5 is the guard; T9's Leave and Restart tests exercise it through the UI.
4. **Unit-suite run time.** T6 and T9 mount GameScreen on the real wasm for every legal move at every step (roughly 150 stagings across the five lessons). Keep one bridge per file and one mount per step; if the `test:unit` row grows past a minute, the orchestrator splits the files by lesson.
5. **e2e flakiness from motion.** T12 and T13 wait on `data-stage` and `data-step`, never on timeouts, and a retry under `CI=1` is a finding (AGENTS "Running the gate").
6. **B6 fallback.** If T1 fails, the lesson 1 and 5 finales show the pre-win board under the overlay; the done sheet and progress are unaffected.

## Appendix A. Copy the design leaves open (planner's drafts)

ApisMellow may change any line before T15; T3's copy-fit test applies to all of them.

| Step | Staged line | Tap route (after two wrong tries) |
|---|---|---|
| 1.5 | (design) | "Tap your 9, then your Points row, then Confirm." |
| 2.1 | "Tap Confirm." (design) | "Tap your 7, then your Points row, then Confirm." |
| 2.2 | "Tap the deck again, or tap Confirm." | "Tap the deck, then tap it again." |
| 3.1 | (design) | "Tap your 10, then one of his point cards, then Confirm." |
| 3.2 | "Tap Confirm to scuttle his 8." | "Tap your 8, then his 8, then Confirm." |
| 4.1 | "Tap Confirm to use your Ace." | "Tap your Ace, then the middle spot, then Confirm." |
| 4.2 | (design) | "Tap your 2, then Confirm." |
| 5.1 | "Tap Confirm to put on your glasses." | "Tap your 8, then your Permanents row, then Confirm." |
| 5.2 | "Tap Confirm to steal his 7." | "Tap a Jack, then his 7, then Confirm." |
| 5.4 | "Tap Confirm to play your King." | "Tap your King, then your Permanents row, then Confirm." |

- **Lesson subtitles:** 1 "Race to 21" (design), 2 "Points and drawing" (design), 3 "Knock out his points", 4 "Powers, and how to stop them", 5 "Jack, Queen, King and glasses".
- **Blake's thinking line:** "Blake's turn." for every reply; the `done` lines are the design's ("Blake played a 6. He has 10.", "Blake drew a card.", "Blake played an 8.", "Blake drew an Ace. You saw it.", "Blake played his Queen."). Lesson 4's reply has no `done` line: step 4.2's main line follows it.
- **Refusals outside a move step (P1):** next steps "Tap Next first."; step 5.3 "First, tap your other Jack."
- **Script or engine error:** "This lesson hit a snag." with Restart lesson (`coach-restart`) and Leave (design §6.2 step 4).
