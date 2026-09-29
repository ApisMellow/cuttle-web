// SPEC §4.7 — the 5's draw reveal (issue #27), pure half.
//
// When a 5 resolves, the cards it drew are shown face up to the player who
// drew them, on that player's own screen only. This module answers two
// questions without reading a card identity from history (SPEC §3.3 rule 5):
//
//   - `unseenDrawFor`: has `viewer` drawn with a 5 since `seenSeq`? Read
//     from `drawn` (a public count, SPEC §2.7) and from kinds and `by` only.
//   - `drawnHandIndices`: which cards of the viewer's OWN hand are the drawn
//     ones. The identities come from the viewer's own envelope at render
//     time; the store keeps only these indices.
//
// Engine canon (github.com/ApisMellow/cuttle@v0.2.0, engine/apply.go):
//   - `resolveOneOffWith` case Five appends the drawn cards to the end of
//     the drawer's hand, then the turn ends.
//   - Between that and the drawer's next own view (their board, or an ack
//     for the opponent's one-off) only the opponent moves, and the only
//     opponent move that adds to the drawer's hand is a 9 (case Nine): it
//     runs `endTurn` first, then appends the returned card and freezes it.
//     `endTurn` clears the NEW active player's `FrozenIDs`, so when that
//     view is the drawer's own normal turn, its frozen indices are exactly
//     the cards a 9 sent back, all at the end of the hand.
//   - Anywhere else (a 4's discard, a counter window, the opponent's 7) no
//     `endTurn` has handed the drawer the turn, so a freeze can be stale,
//     and no 9 has resolved, so nothing is skipped.
//   - The drawer's own moves never come first: the store shows the reveal
//     at the drawer's first own view, before any move of theirs.

import type { AppliedMove, PlayerId, PlayerView } from './bridge/schema';
import { fiveDrawer } from './recap';

/** Issue #27: how long the reveal waits before continuing on its own. */
export const DRAW_REVEAL_MS = 3000;

/** The reveal the store is showing: whose screen, and which of their own hand's indices were drawn. */
export interface DrawReveal {
  to: PlayerId;
  indices: number[];
  /**
   * Shown before the pass, while the phone is about to change hands: the
   * screen shows ONLY the drawn cards, never the rest of the hand. False at
   * the drawer's own next view, where the whole hand is theirs to see.
   */
  beforePass: boolean;
}

export interface UnseenDraw {
  /** The seq of the entry that resolved the 5. */
  seq: number;
  /** How many cards it drew (> 0). */
  count: number;
}

/** The latest 5-draw by `viewer` resolved after `seenSeq` that drew at least one card, or null. */
export function unseenDrawFor(history: readonly AppliedMove[], viewer: PlayerId, seenSeq: number): UnseenDraw | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.seq <= seenSeq) return null;
    if (entry.drawn === null || entry.drawn <= 0) continue;
    if (fiveDrawer(history, i) !== viewer) continue;
    return { seq: entry.seq, count: entry.drawn };
  }
  return null;
}

/**
 * The indices of the `count` drawn cards in the viewer's own hand: the last
 * `count` cards, after skipping a frozen tail when `skipFrozenTail` is set
 * (the drawer's own normal turn, where a frozen tail is a 9's returned
 * card; see the module note). Never more indices than the hand holds.
 */
export function drawnHandIndices(
  you: Pick<PlayerView['you'], 'hand' | 'frozenHandIndices'>,
  count: number,
  skipFrozenTail: boolean,
): number[] {
  let end = you.hand.length;
  if (skipFrozenTail) {
    while (end > 0 && you.frozenHandIndices.includes(end - 1)) end--;
  }
  const start = Math.max(0, end - Math.max(0, count));
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
