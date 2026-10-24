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
// The staged-setup half of this module (readStagedPage, classifyStaged)
// lands in T6.

import type { Card, Envelope, Move, PlayerView, Target } from '../bridge/schema';
import { MoveKind, TargetZone } from '../enums';
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
