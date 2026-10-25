// Learn to play (R25), design §6.2 and §7.2: the lesson move predicate.
// Pure. It compares a legal move the engine already produced against a
// lesson's `MovePredicate` by identity (kind, card, target card); it decides
// no rule and filters no move list (R11, SPEC §3.3).
//
// Engine v0.2.1 move shapes (engine/moves.go:24-34, emitted by
// engine/apply.go:15-135, :524-586):
//   - PlayPermanent with a Jack carries JackTarget (apply.go:88-97); every
//     other PlayPermanent carries neither target.
//   - Scuttle carries Target (apply.go:112-123); a targeted OneOff (a 2 or a 9)
//     carries Target (apply.go:44-87); other OneOffs carry none.
//   - SevenPick wraps a SubMove, which is null at a dead end
//     (apply.go:524-544).
//   - Target.Owner is an absolute seat (engine/state.go:78-82).
//
// The staged-setup half (readStagedPage, classifyStaged, design §7.2, T6)
// reads the page's existing staging attributes and the engine's legal-move
// list. It imports nothing from `lib/stores/`: the coach never reads the
// staging store, only what the board already shows.

import { boardTargetKey } from '../affordances';
import type { Card, Envelope, Move, PlayerView, Target } from '../bridge/schema';
import { targetKeyFromTestId } from '../dragDrop';
import { MoveKind, TargetZone } from '../enums';
import type { TargetKey } from '../targetKey';
import type { MovePredicate, MoveStep } from './types';

function sameCard(a: Card, b: Card): boolean {
  return a.Rank === b.Rank && a.Suit === b.Suit;
}

function anyOf(x: Card, wanted: Card | Card[]): boolean {
  return Array.isArray(wanted) ? wanted.some((w) => sameCard(x, w)) : sameCard(x, wanted);
}

/** The move's target, by kind (the engine sets at most one of the two fields). */
function targetOf(move: Move): Target | null {
  switch (move.Kind) {
    case MoveKind.PlayPermanent:
      return move.JackTarget;
    case MoveKind.Scuttle:
    case MoveKind.OneOff:
      return move.Target;
    default:
      return null;
  }
}

/**
 * The card a move targets, read from the given public view: a point card
 * (`PointEntry.Card`) or a permanent. A SevenPick reads its SubMove; a
 * dead-end SevenPick and every untargeted move give null.
 */
export function targetCardOf(move: Move, view: PlayerView): Card | null {
  if (move.Kind === MoveKind.SevenPick) return move.SubMove ? targetCardOf(move.SubMove, view) : null;
  const t = targetOf(move);
  if (!t) return null;
  const side = t.Owner === view.viewer ? view.you : view.opponent;
  if (t.Zone === TargetZone.Points) return side.points[t.Index]?.Card ?? null;
  if (t.Zone === TargetZone.Permanents) return side.permanents[t.Index] ?? null;
  return null;
}

/**
 * True when the move is the predicate's kind, its card is one of the
 * predicate's cards (when given) and its target card is one of the
 * predicate's targets (when given). `view` is the envelope the move came
 * from, so target indices resolve against the right seat.
 */
export function moveMatches(move: Move, pred: MovePredicate, view: PlayerView): boolean {
  if (move.Kind !== pred.kind) return false;
  if (pred.card !== undefined) {
    if (!move.Card || !anyOf(move.Card, pred.card)) return false;
  }
  if (pred.target !== undefined) {
    const target = targetCardOf(move, view);
    if (!target || !anyOf(target, pred.target)) return false;
  }
  return true;
}

/** The indices in `env.legalMoves` that match, in order. */
export function matchingIndices(env: Envelope, pred: MovePredicate): number[] {
  const out: number[] = [];
  env.legalMoves.forEach((m, i) => {
    if (moveMatches(m, pred, env.state)) out.push(i);
  });
  return out;
}

/** The coach line for a wrong move: the first matching nudge rule, else the step's generic line. */
export function nudgeFor(move: Move, step: MoveStep, view: PlayerView): string {
  for (const rule of step.nudges) {
    if (moveMatches(move, rule.when, view)) return rule.text;
  }
  return step.generic;
}

// ---------------------------------------------------------------------------
// Staged-setup matcher (design §7.2, plan P4, T6)
// ---------------------------------------------------------------------------

/** What the page shows of the staging pipeline, read from DOM attributes only. */
export interface StagedPage {
  /** The hand card with `aria-pressed="true"`. */
  selectedHand: number | null;
  /** The one hand card with `data-staged="true"`, or the deck at `data-state="staged"`. */
  source: { hand: number } | 'deck' | null;
  /** The staged zone, point or permanent (via `targetKeyFromTestId`); the deck for a staged draw. */
  target: TargetKey | null;
  /** `staging-confirm` is present. */
  confirm: boolean;
  /** `counter-prompt` is present: `staged` when `staging-confirm` is inside it. */
  counter: 'fresh' | 'staged' | null;
}

export type StagedVerdict = { verdict: 'right' } | { verdict: 'wrong'; nudge: string } | { verdict: 'unknown' };

const HAND_CARD = /^hand-card-(\d+)$/;

function testIdOf(el: Element): string {
  return el.getAttribute('data-testid') ?? '';
}

/**
 * Reads the staging state the board already renders (design §7.2): only
 * `aria-pressed` and `data-staged` on `hand-card-<i>`; `data-state="staged"`
 * on `deck-pile`, on a `zone-*` hit button, and on the theme face inside a
 * `point-<o>-<i>` or `perm-<o>-<i>` button; and whether `staging-confirm`
 * and `counter-prompt` are present. Never writes the DOM.
 */
export function readStagedPage(root: ParentNode): StagedPage {
  let selectedHand: number | null = null;
  const stagedHands: number[] = [];
  for (const el of root.querySelectorAll('[data-testid^="hand-card-"]')) {
    const m = HAND_CARD.exec(testIdOf(el));
    if (!m) continue;
    const i = Number(m[1]);
    if (el.getAttribute('aria-pressed') === 'true' && selectedHand === null) selectedHand = i;
    if (el.getAttribute('data-staged') === 'true') stagedHands.push(i);
  }

  const deckStaged = root.querySelector('[data-testid="deck-pile"]')?.getAttribute('data-state') === 'staged';

  let target: TargetKey | null = null;
  for (const el of root.querySelectorAll('[data-testid^="zone-"]')) {
    if (el.getAttribute('data-state') !== 'staged') continue;
    const key = targetKeyFromTestId(testIdOf(el));
    if (key !== null && key.startsWith('zone:')) {
      target = key;
      break;
    }
  }
  if (target === null) {
    for (const el of root.querySelectorAll('[data-testid^="point-"], [data-testid^="perm-"]')) {
      const key = targetKeyFromTestId(testIdOf(el));
      if (key === null) continue;
      if (el.querySelector('[data-state="staged"]') !== null) {
        target = key;
        break;
      }
    }
  }

  // One staged hand card is a source; two (a discard pair) is not a slot.
  const source: StagedPage['source'] = stagedHands.length === 1 ? { hand: stagedHands[0] } : deckStaged ? 'deck' : null;
  if (target === null && source === 'deck') target = 'deck';

  const prompt = root.querySelector('[data-testid="counter-prompt"]');
  const counter: StagedPage['counter'] =
    prompt === null ? null : prompt.querySelector('[data-testid="staging-confirm"]') !== null ? 'staged' : 'fresh';

  return {
    selectedHand,
    source,
    target,
    confirm: root.querySelector('[data-testid="staging-confirm"]') !== null,
    counter,
  };
}

/** Kinds a hand card stages on the board through a target tap (StagingStore's in-scope set). */
const HAND_STAGED_KINDS: ReadonlySet<Move['Kind']> = new Set<Move['Kind']>([
  MoveKind.PlayPoint,
  MoveKind.PlayPermanent,
  MoveKind.Scuttle,
  MoveKind.OneOff,
]);

/**
 * Plan P4: the legal moves the staged setup could stand for, in engine order.
 * A staged counter takes every Counter (the page doesn't say which 2 is
 * staged); the deck takes the Draw; a hand card takes its board moves whose
 * `boardTargetKey` is the staged target. That is the board location, not
 * `slotKey`: a scuttle and a 9 aimed at one card are one tap and one group.
 * Decline, Pass and DiscardPair have no slot, and a SevenPick is rooted at a
 * revealed card, never at a hand index.
 */
function stagedCandidates(page: StagedPage, env: Envelope): Move[] {
  if (page.counter === 'staged') return env.legalMoves.filter((m) => m.Kind === MoveKind.Counter);
  if (!page.confirm || page.source === null) return [];
  if (page.source === 'deck') return env.legalMoves.filter((m) => m.Kind === MoveKind.Draw);
  const { hand } = page.source;
  const target = page.target;
  if (target === null) return [];
  return env.legalMoves.filter((m) => HAND_STAGED_KINDS.has(m.Kind) && m.HandIndex === hand && boardTargetKey(m) === target);
}

/**
 * Design §7.2 step 4: every candidate matches the step → right; none does →
 * wrong, with the step's nudge for the first candidate that has one, else its
 * generic line; some do and some don't (an ambiguity-chooser pair) → unknown,
 * left to the gate. Nothing staged, a Pass, or a setup with no legal move →
 * unknown. Decides no rule: it only compares the engine's own moves.
 */
export function classifyStaged(page: StagedPage, env: Envelope, step: MoveStep): StagedVerdict {
  const candidates = stagedCandidates(page, env);
  if (candidates.length === 0) return { verdict: 'unknown' };
  const view = env.state;
  const hits = candidates.filter((m) => moveMatches(m, step.expect, view)).length;
  if (hits === candidates.length) return { verdict: 'right' };
  if (hits > 0) return { verdict: 'unknown' };
  for (const m of candidates) {
    const rule = step.nudges.find((r) => moveMatches(m, r.when, view));
    if (rule) return { verdict: 'wrong', nudge: rule.text };
  }
  return { verdict: 'wrong', nudge: step.generic };
}
