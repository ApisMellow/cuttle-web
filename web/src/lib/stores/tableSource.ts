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

export interface TableSource {
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
  /** The pass-and-play curtain. A source with no curtain reports `none` (or `result` at game over). */
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
