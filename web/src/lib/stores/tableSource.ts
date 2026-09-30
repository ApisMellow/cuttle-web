// Two-phone W10 (docs/two-phone-plan.md §7): the seam between the board UI
// and whatever holds the game. `GameScreen` and its children read only this
// interface, so the local pass-and-play `GameStore` and the future online
// store can drive the same board.
//
// The shape is taken from what GameScreen actually reads and calls. It adds
// one field no local caller needed before, `pending`: true while a move has
// been sent and its result has not come back. The local store applies in
// the same task and is never pending; an online store is pending from the
// moment it sends a move until the next state (or error) arrives. While it
// is true the board is inert, Confirm is disabled and no second apply is
// sent.
//
// Privacy (SPEC §3.3 rule 4): everything here is whatever the source is
// currently willing to show. A source that has a curtain keeps `envelope`
// and `viewer` null behind it, exactly as GameStore does; one that has no
// curtain reports `curtain.kind === 'none'` (or `result`) always.
//
// `history` is the exception to "whatever is on show": it must ALWAYS be
// redacted for `viewer`, curtain or not. No mover-only `index` and no
// hidden-card detail from the other seat's moves. An online source never
// raises a curtain, so nothing else stands between the wire and the screen;
// GameScreen renders `history` as given and does not redact it again.

import type { AppliedMove, Envelope, PlayerId } from '../bridge/schema';
import type { DrawReveal } from '../drawReveal';
import type { CurtainState } from './curtain.svelte';

/**
 * Two-phone W12: `apply` rejects with this when it sent nothing (the
 * connection is down). The staged move is still wanted, so the staging
 * pipeline goes back to `staged` instead of clearing (plan §7: "Staging
 * survives a failed send"). Its message is fixed text.
 */
export class MoveNotSent extends Error {
  constructor() {
    super('The move was not sent: no connection to the game server.');
    this.name = 'MoveNotSent';
  }
}

/**
 * Two-phone W12: what an online source adds for the board. Absent (the
 * local store) means pass-and-play: session names, table mode, no status.
 * Every string here is public room data or fixed text, never card data.
 */
export interface OnlineTableInfo {
  /** Seat names, by seat, from the server's `welcome`. */
  readonly names: [string, string];
  /** The connection status line ("Reconnecting…", "You're offline…"), or null when all is well. */
  readonly statusText: string | null;
  /** The button that goes with the status line ("Tap to reconnect", "Play here"), or null. */
  readonly statusAction: string | null;
  /** Name of the seat answering a counterable move while this seat waits (the hold, SPEC §2.12.5), or null. */
  readonly respondingName: string | null;
  /** A one-line notice about the last move or error ("Your move wasn't sent…"), or null. */
  readonly notice: string | null;
  /** The status line's button: `retry()` on the connection. */
  runStatusAction(): void;
}

export interface TableSource {
  /** Two-phone W12: set only by an online source. */
  readonly online?: OnlineTableInfo | null;
  /** The only full view in memory; null whenever nobody's view is safe to show. */
  readonly envelope: Envelope | null;
  /**
   * Move history, ALWAYS redacted for `viewer` (no mover-only `index`, no
   * hidden-card detail from the other seat's moves), with or without a
   * curtain. Consumers use it as-is.
   */
  readonly history: readonly AppliedMove[];
  /** History length of the position on show. A change resets staging. */
  readonly seq: number;
  /** Whose view `envelope` holds, or null. */
  readonly viewer: PlayerId | null;
  /**
   * The pass-and-play curtain. A source with no curtain reports `none` (or
   * `result` at game over). The online store also reports `ack` for its own
   * counter window, so GameScreen mounts the counter prompt (W12): the
   * envelope stays exposed there, exactly as the local store's at `ack`.
   */
  readonly curtain: CurtainState;
  /** SPEC §4.7 draw reveal (hand indices only), or null. */
  readonly drawReveal: DrawReveal | null;
  /** True while an apply is in flight (sent, result not yet in). The local store is never pending. */
  readonly pending: boolean;

  /**
   * Submits legal move `moveIndex` of the current envelope. The promise
   * settles when the source has taken the move; the new position may arrive
   * later (an online source clears `pending` then). Callers must not call
   * apply while `pending` is true.
   */
  apply(moveIndex: number): Promise<void>;
  /** Ends the draw reveal. A no-op when none is up. */
  dismissDrawReveal(): void;
  /** Steps the curtain. A source with no curtain never needs it. */
  advanceCurtain(): Promise<void>;
  /** The menu's Home. */
  goHome(): void;
  /** The menu's New game (and the dev test hook). */
  newGame(opts?: { seed?: string; dealer?: PlayerId }): Promise<void>;
}
