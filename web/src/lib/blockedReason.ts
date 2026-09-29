// Playtest 2026-09-29 (findings, Friction 2): when a card or a tap does
// nothing, say why, where the reason is knowable from public state.
//
// Every function here runs only AFTER the engine has already said no: a
// dimmed hand card (no legal move uses it), the deck when Draw isn't
// offered, or a tap on a card the selected card can't target. None of them
// decides legality; they pick the most likely explanation for a refusal the
// engine made, and fall back to generic text (or nothing) when unsure.
//
// Privacy: the inputs are the viewer's own hand and frozen indices, the
// public board (both sides' points and permanents), the deck count and the
// phase. Never the opponent's hand, the deck's cards or history, so no
// reason can name or hint at hidden information. Wording lives in
// lib/cardText.ts.

import type { Card, PlayerView } from './bridge/schema';
import { BLOCKED_REASON, HAND_LIMIT, NO_MOVES_REASON, theirQueenProtects } from './cardText';
import type { TargetKey } from './targetKey';

type BoardView = Pick<PlayerView, 'viewer' | 'active' | 'phase' | 'you' | 'opponent' | 'deckCount'>;

const QUEEN = 12;
const JACK = 11;
// SPEC §2.5 Phase values.
const PHASE_NORMAL = 0;
const PHASE_SEVEN = 2;

function hasQueen(permanents: readonly Card[]): boolean {
  return permanents.some((c) => c.Rank === QUEEN);
}

/**
 * Why the viewer's own hand card at `handIndex` has no legal move (the R9.3
 * popover). Engine v0.2.0 LegalMoves: a frozen card is skipped; in
 * PhaseSevenChoosing only the revealed cards play; a Jack needs an
 * opponent point card and no opponent Queen. Every other rank can at least
 * be played for points or as a permanent in PhaseNormal, so those reasons
 * cover the dimmed cases a player meets; anything else gets the generic
 * line.
 */
export function handCardReason(handIndex: number, view: BoardView): string {
  const card = view.you.hand[handIndex];
  if (card === undefined) return NO_MOVES_REASON;
  if (view.you.frozenHandIndices.includes(handIndex)) return BLOCKED_REASON.frozen;
  if (view.phase === PHASE_SEVEN && view.viewer === view.active) return BLOCKED_REASON.sevenFirst;
  if (view.phase !== PHASE_NORMAL) return NO_MOVES_REASON;
  if (card.Rank === JACK) {
    if (hasQueen(view.opponent.permanents)) return BLOCKED_REASON.jackQueen;
    if (view.opponent.points.length === 0) return BLOCKED_REASON.jackNoPoints;
  }
  return NO_MOVES_REASON;
}

/**
 * Why a deck tap drew nothing, when the engine offered no Draw (engine
 * v0.2.0 LegalMoves: `len(Deck) > 0 && len(Hand) < HandLimit`). null when
 * neither applies (for example outside the viewer's normal turn).
 */
export function deckReason(view: BoardView): string | null {
  if (view.phase !== PHASE_NORMAL) return null;
  if (view.deckCount === 0) return BLOCKED_REASON.deckEmpty;
  if (view.you.hand.length >= HAND_LIMIT) return BLOCKED_REASON.handFull;
  return null;
}

/**
 * Why tapping a board card with `selected` in hand did nothing: the tap
 * landed on a card the engine didn't light. Only Queen protection is
 * explained (engine v0.2.0 LegalMoves: a 2's, a 9's and a Jack's targets
 * skip a side with a Queen, except a Queen itself). null otherwise, and the
 * tap simply clears the selection as before (SPEC §6.1).
 */
export function targetReason(selected: Card, key: TargetKey, view: BoardView): string | null {
  const m = key.match(/^(point|perm):([01]):(\d+)$/);
  if (m === null) return null;
  const rank = selected.Rank;
  const owner = Number(m[2]);
  const mine = owner === view.viewer;
  const side = mine ? view.you : view.opponent;
  const index = Number(m[3]);
  const isPerm = m[1] === 'perm';
  const entry = isPerm ? undefined : side.points[index];
  const tapped = isPerm ? side.permanents[index] : entry?.Card;
  if (tapped === undefined) return null;
  // The Queen is named only where she is the cause: the card is one this
  // rank could otherwise target (engine/apply.go v0.2.0 LegalMoves):
  //   2    -> a permanent or a Jack-topped point, on either side;
  //   9    -> any opponent point or permanent;
  //   Jack -> an opponent point.
  let targetable: boolean;
  if (rank === 2) targetable = isPerm || (entry !== undefined && entry.JackStack.length > 0);
  else if (rank === 9) targetable = !mine;
  else if (rank === JACK) targetable = !mine && !isPerm;
  else targetable = false;
  if (!targetable || !hasQueen(side.permanents)) return null;
  if (isPerm && tapped.Rank === QUEEN) return null;
  if (mine) return BLOCKED_REASON.ownQueen;
  return theirQueenProtects(rank);
}
