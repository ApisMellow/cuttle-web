// Learn to play (R25): the shapes a lesson is written in. Data only, no
// behaviour. Interfaces are pinned by docs/tutorial-plan.md §5; the lesson
// content itself lives in `lessons.ts` (design §5).
//
// Cards are numeric `Card` values (`c(rank, suit)` in `position.ts`), never
// glyphs (SPEC §5.6 rule 1). Coach lines are fixed lesson text.

import type { Card, MoveKind, Rank } from '../bridge/schema';

export type LessonId = 1 | 2 | 3 | 4 | 5;

/** Suit initials in engine order: clubs < diamonds < hearts < spades (`card/card.go:7-12`). */
export type SuitLetter = 'C' | 'D' | 'H' | 'S';

/**
 * An authored start position. Seat 0 is the learner (Alice), seat 1 is
 * Blake. No Jacks, permanents or frozen cards at the start (design §5.1).
 */
export interface LessonPosition {
  aliceHand: Card[];
  alicePoints: Card[];
  blakeHand: Card[];
  blakePoints: Card[];
  /** Bottom first, last = top (`engine/state.go` GameState.Scrap). */
  scrap: Card[];
  /** Index 0 = top; every unnamed card follows in canonical order. */
  deckTop: Card[];
}

/**
 * A move described by identity, not by index: the kind, the mover's card
 * (any of a list) and the targeted point or permanent card (any of a list).
 * An omitted `card` or `target` matches any. A present `target` requires the
 * move to have one.
 */
export interface MovePredicate {
  /** A `lib/enums` MoveKind value. */
  kind: MoveKind;
  /** The mover's card, any of. */
  card?: Card | Card[];
  /** The targeted point or permanent card (`Target` or `JackTarget`), any of. */
  target?: Card | Card[];
}

export type SpotTarget =
  /** score-bar, opponent-zone, center-zone, player-zone, player-hand, deck-pile, zone-*, counter-link… */
  | { kind: 'testid'; id: string }
  /** → `hand-card-<i>` against view(0) */
  | { kind: 'hand'; card: Card | Card[] }
  /** Step 5.3: the Jack still in hand. */
  | { kind: 'handRank'; rank: Rank }
  /** → `point-<owner>-<i>` */
  | { kind: 'point'; card: Card | Card[] };

export type DemoSpec =
  | { kind: 'drag'; from: SpotTarget; to: SpotTarget; thenConfirm: boolean }
  /** 2.2: [deck, deck]. */
  | { kind: 'tap'; at: SpotTarget[]; thenConfirm: boolean }
  | { kind: 'none' };

export interface NudgeRule {
  when: MovePredicate;
  text: string;
}

export interface BlakeReply {
  move: MovePredicate;
  thinking: string;
  done?: string;
}

interface StepBase {
  /** "1.5" etc. (design §5 step numbers). */
  id: string;
  main: string;
  /**
   * The step's resting spotlight. For a `move` step this is the idle hole,
   * `[source]` (step 1.5 adds its drop target, the first move); the coach
   * shows `source` and `target` once a card is selected.
   */
  spot: SpotTarget[];
}

export interface NextStep extends StepBase {
  kind: 'next';
}

export interface AppearStep extends StepBase {
  kind: 'appear';
  testId: string;
  /** The line shown when a commit is refused during this step (plan P1). */
  refusal: string;
}

export interface MoveStep extends StepBase {
  kind: 'move';
  expect: MovePredicate;
  /** Idle hole; selected adds the target hole. */
  source: SpotTarget;
  target: SpotTarget;
  staged: string;
  tapRoute: string;
  /** First matching rule wins, else `generic`. */
  nudges: NudgeRule[];
  generic: string;
  success: string;
  demo: DemoSpec;
  blake: BlakeReply[];
}

export type Step = NextStep | AppearStep | MoveStep;

export interface Lesson {
  id: LessonId;
  title: string;
  subtitle: string;
  done: string;
  position: LessonPosition;
  steps: Step[];
  /** The last move wins the game (lessons 1 and 5). */
  win: boolean;
  /** The deal animation plays on entry (lesson 1 only). */
  deal: boolean;
}
