// Issue #37, SPEC §5.10 — table mode: the phone lies flat between the two
// players. Player 1 (seat 0) sits at the phone's bottom edge and player 2
// (seat 1) at its top edge. Every game screen addressed to player 2 is turned
// 180° at the game-screen root, so it reads the right way up from across the
// table. Each player's own view draws their side at the bottom of the view,
// so after the turn player 2's side lands at the phone's top edge and the
// board never appears to flip.
//
// Pure functions only. Orientation is presentation: nothing here reads a
// hand, a card or any hidden state, and the curtain is untouched.

import type { PlayerId } from './bridge/schema';
import type { CurtainState } from './stores/curtain.svelte';

/** The seat that sits at the phone's top edge in table mode. */
const TOP_SEAT: PlayerId = 1;

/**
 * Who the current game screen is for. An addressed curtain (handoff, reveal
 * gate, recap, counter prompt) faces its own `to`. The live board, and the
 * draw reveal and pickers drawn in its place, face whoever holds the view.
 * The result screen, and a board with no view yet, face player 1.
 */
export function screenAddressee(curtain: CurtainState, viewer: PlayerId | null): PlayerId {
  switch (curtain.kind) {
    case 'handoff':
    case 'reveal':
    case 'recap':
    case 'ack':
      return curtain.to;
    case 'none':
      return viewer ?? 0;
    case 'result':
      return 0;
  }
}

/** Whether the game screen is turned 180°: table mode, and the screen is player 2's. */
export function screenRotated(tableMode: boolean, curtain: CurtainState, viewer: PlayerId | null): boolean {
  return tableMode && screenAddressee(curtain, viewer) === TOP_SEAT;
}

/**
 * A pointer delta measured on the screen, expressed in the (possibly turned)
 * view's own frame. A 180° turn negates both axes, so a card translated by
 * the result follows the finger. `+ 0` keeps -0 out of the style string.
 */
export function toViewDelta(dx: number, dy: number, rotated: boolean): { x: number; y: number } {
  return rotated ? { x: -dx + 0, y: -dy + 0 } : { x: dx, y: dy };
}
