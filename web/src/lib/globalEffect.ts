// SPEC §4.8 (issue #53): global effects, shown and replayed. Pure half.
//
// A global effect is an Ace one-off (every point card on both sides goes to
// the scrap, with the Jacks on them) or a 6 one-off (every permanent on both
// sides goes), played from the hand or picked from a 7 (a SevenPick whose
// sub-move is that one-off). Nothing else is global.
//
// Which cards left is read client-side from the board rows before and after
// the apply: a card on a point or permanent row (a Jack on a point card
// included) before, and on no such row after. Rows are public to both
// viewers (SPEC §3.2), so the list leaks nothing; no hand is read. The list
// is kept in memory only, keyed to the wipe's history `seq`.

import type { AppliedMove, Card, PlayerId, PlayerView } from './bridge/schema';
import { MoveKind } from './enums';

/** Issue #53: how long the sweep (or the reduced-motion outline) lasts. */
export const WIPE_EFFECT_MS = 1200;

export interface WipedCard {
  readonly card: Card;
  /** The seat whose side of the table the card was on. */
  readonly seat: PlayerId;
  readonly row: 'points' | 'permanents';
  /** Its position in that row before the wipe. */
  readonly slot: number;
  /** Its place in the slot's Jack stack, or -1 for the row card itself. */
  readonly jack: number;
}

/** A global wipe that removed at least one card. */
export interface GlobalWipe {
  /** The history `seq` of the entry that made it. */
  readonly seq: number;
  /** Who played it. */
  readonly by: PlayerId;
  readonly cards: readonly WipedCard[];
}

/**
 * What GameScreen plays: `show` on the mover's own board right after the
 * apply, `replay` on the next player's board. `to` is the viewer whose board
 * it plays on. `beforePass` is the pass-and-play hold: the handoff is saved
 * and is raised when it ends, and a tap ends it early.
 */
export interface WipeEffect extends GlobalWipe {
  readonly to: PlayerId;
  readonly mode: 'show' | 'replay';
  readonly beforePass: boolean;
}

/** An Ace or 6 one-off, from the hand or picked from a 7. */
export function isGlobalWipeMove(move: Pick<AppliedMove, 'kind' | 'subKind' | 'card'>): boolean {
  const oneOff = move.kind === MoveKind.OneOff || (move.kind === MoveKind.SevenPick && move.subKind === MoveKind.OneOff);
  if (!oneOff || move.card === null) return false;
  return move.card.Rank === 1 || move.card.Rank === 6;
}

function key(card: Card): string {
  return `${card.Rank}:${card.Suit}`;
}

type Rows = Pick<PlayerView, 'viewer'> & {
  you: Pick<PlayerView['you'], 'points' | 'permanents'>;
  opponent: Pick<PlayerView['opponent'], 'points' | 'permanents'>;
};

function rowCards(view: Rows): WipedCard[] {
  const out: WipedCard[] = [];
  const sides: Array<[PlayerId, Rows['you'] | Rows['opponent']]> = [
    [view.viewer, view.you],
    [(1 - view.viewer) as PlayerId, view.opponent],
  ];
  for (const [seat, side] of sides) {
    side.points.forEach((entry, slot) => {
      out.push({ card: entry.Card, seat, row: 'points', slot, jack: -1 });
      entry.JackStack.forEach((jack, j) => out.push({ card: jack, seat, row: 'points', slot, jack: j }));
    });
    side.permanents.forEach((card, slot) => out.push({ card, seat, row: 'permanents', slot, jack: -1 }));
  }
  return out;
}

/**
 * The cards a global wipe took off the rows: on a row in `before`, on no row
 * in `after`, in row order (each side's points, then its permanents; the
 * `before` viewer's side first). Empty for any other move, and for a wipe
 * that removed nothing. `before` and `after` may be different viewers' views.
 */
export function wipedCards(
  move: Pick<AppliedMove, 'kind' | 'subKind' | 'card'>,
  before: Rows,
  after: Rows,
): WipedCard[] {
  if (!isGlobalWipeMove(move)) return [];
  const still = new Set(rowCards(after).map((w) => key(w.card)));
  return rowCards(before).filter((w) => !still.has(key(w.card)));
}

/** The wipe made by `move`, or null when it isn't one or removed nothing. */
export function globalWipe(move: AppliedMove, before: Rows, after: Rows): GlobalWipe | null {
  const cards = wipedCards(move, before, after);
  return cards.length === 0 ? null : { seq: move.seq, by: move.by, cards };
}
