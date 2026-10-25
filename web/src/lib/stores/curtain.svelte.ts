// SPEC §4 — the curtain state machine (R13–R16, R20).
//
// Pure functions only. The machine implements no game rule: it reads
// post.active and post.phase (the engine is canon) and applies §4.1's
// predicate. A one-off happens at once and is followed exactly like any
// other move: one `turn` handoff (or `discard` when the opponent opens an
// owed discard) to the opponent, whatever they hold (§4.3, issue #93). A
// Counter and an owed discard's pair keep the mover active, so they raise no
// curtain; a pending win hands to the decider with `turn`. The only `ack` is
// a legacy counter window (phase 1, a v0.2.x save). AppliedMove.index is
// never read: it is absent for non-movers (§2.7).

import type { AppliedMove, MoveKind, Phase, PlayerId, PlayerView } from '../bridge/schema';
import { MoveKind as MK, Phase as Ph } from '../enums';

// SPEC §2.5, pinned from source, via the shared enums module (round 2 W7).
const PhaseNormal = Ph.Normal;
const PhaseAwaitingCounter = Ph.AwaitingCounter;
const PhaseSevenChoosing = Ph.SevenChoosing;
const PhaseAwaitingDiscard = Ph.AwaitingDiscard;
const PhaseGameOver = Ph.GameOver;
const PhasePendingWin = Ph.PendingWin;

const MoveDraw = MK.Draw;
const MovePlayPoint = MK.PlayPoint;
const MovePlayPermanent = MK.PlayPermanent;
const MoveScuttle = MK.Scuttle;
const MoveOneOff = MK.OneOff;
const MoveCounter = MK.Counter;
const MoveDecline = MK.Decline;
const MoveSevenPick = MK.SevenPick;
const MoveDiscardPair = MK.DiscardPair;
const MovePass = MK.Pass;

/**
 * `resume` (ruling 2026-09-29, SPEC §5.7) is the gate a restore raises in
 * front of a resting position (`none` or an `ack`). It is held in memory
 * only and is never written to the save: the save keeps the resting
 * position itself, so a reload during the gate comes back to the gate.
 */
export type HandoffReason = 'turn' | 'counter' | 'discard' | 'seven-return' | 'resume';

export type CurtainState =
  | { kind: 'none' }
  | { kind: 'handoff'; to: PlayerId; reason: HandoffReason }
  | { kind: 'reveal'; to: PlayerId }
  /** A legacy counter window (§4.3, v0.2.x saves only): `to` holds a legal 2. */
  | { kind: 'ack'; to: PlayerId }
  | { kind: 'result' };

/**
 * The only slice of a PlayerView the machine reads (§4.1: the engine is
 * canon, and post.active/post.phase are public).
 */
export type CurtainView = Pick<PlayerView, 'active' | 'phase'>;

/**
 * What `advance` needs to walk one applied move's receiving sequence.
 *
 * The store must keep only the `CurtainView` projection here — never an
 * envelope's PlayerView. `post` comes from the mover's envelope and carries
 * the mover's hand; holding it while the opponent has the phone violates
 * SPEC §3.3 rule 4.
 */
export interface CurtainContext {
  pre: CurtainView;
  /** The applied move this sequence follows, or `null` for the opening deal (W25: see `opening`). */
  move: AppliedMove | null;
  post: CurtainView;
}

/** A curtain-machine bug. `code` mirrors the bridge's INTERNAL (§2.9). */
export class CurtainError extends Error {
  readonly code = 'INTERNAL' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CurtainError';
  }
}

// §4.4 (amended 2026-10-24, issue #93): the (pre.phase, mv.kind) pairs the
// engine can produce. A Counter is the first play of a turn after a
// counterable one, in phase 0, in an owed discard (phase 3) or at a pending
// win (phase 5). Phase 1 is a legacy counter window only. Phase 5's Decline
// is "Let it happen".
const REACHABLE: Record<Phase, readonly MoveKind[]> = {
  [PhaseNormal]: [MoveDraw, MovePlayPoint, MovePlayPermanent, MoveScuttle, MoveOneOff, MovePass, MoveCounter],
  [PhaseAwaitingCounter]: [MoveCounter, MoveDecline],
  [PhaseSevenChoosing]: [MoveSevenPick],
  [PhaseAwaitingDiscard]: [MoveDiscardPair, MoveCounter],
  [PhaseGameOver]: [],
  [PhasePendingWin]: [MoveCounter, MoveDecline],
};

/** §4.1: curtainRequired ⟺ post.active !== pre.active ∧ post.phase !== PhaseGameOver. */
export function curtainRequired(pre: CurtainView, post: CurtainView): boolean {
  return post.active !== pre.active && post.phase !== PhaseGameOver;
}

/**
 * §4.5 (amended 2026-09-27): the label the handoff screen may display.
 * Every response-type reason shares one neutral label. The raw
 * HandoffReason must not reach the DOM before the reveal gate.
 *
 * Table mode (SPEC §5.10): the heading already reads "NAME's turn", so the
 * turn-like label names the reveal control instead of repeating it. The
 * response-like and resume labels stay as they are.
 */
export function handoffLabel(reason: HandoffReason, tableMode = false): string {
  switch (reason) {
    case 'turn':
    case 'seven-return':
      return tableMode ? 'Hold to show your hand' : 'Your turn';
    case 'counter':
    case 'discard':
      return 'Your response';
    // One label for every resume gate, whatever it resumes into (a board or
    // a counter window): SPEC §5.7.
    case 'resume':
      return 'Resume game';
  }
}

/**
 * The handoff reason for `post.active` receiving control in `post.phase`.
 * Issue #93: phase 3 is now an owed discard opening the opponent's turn
 * (`discard`); a pending win (phase 5) is `turn`. `counter` comes only from
 * a legacy counter window.
 */
export function reasonFor(phase: Phase): HandoffReason {
  switch (phase) {
    case PhaseAwaitingCounter:
      return 'counter';
    case PhaseAwaitingDiscard:
      return 'discard';
    case PhaseSevenChoosing:
      return 'seven-return';
    default:
      return 'turn';
  }
}

function assertReachable(pre: CurtainView, mv: AppliedMove): void {
  const allowed = REACHABLE[pre.phase];
  if (allowed === undefined || !allowed.includes(mv.kind)) {
    throw new CurtainError(
      `unreachable transition: MoveKind ${mv.kind} applied in phase ${pre.phase} (SPEC §4.4)`,
    );
  }
}

/**
 * W25: the curtain a new game starts behind. The player who tapped "New
 * game" is not necessarily the first actor, so the deal is handed to the
 * first actor exactly like a turn (SPEC §4.5): handoff -> reveal -> none.
 * Its sequence is advanced with a `CurtainContext` whose `move` is `null`
 * and whose `pre`/`post` are both the first actor's `CurtainView`.
 */
export function opening(first: PlayerId): CurtainState {
  return { kind: 'handoff', to: first, reason: 'turn' };
}

/**
 * §5.3: `next(pre, appliedMove, post) -> CurtainState` — the first curtain
 * state after a successful apply. Throws CurtainError for a §4.4
 * unreachable (phase, kind) pair.
 *
 * §4.3 (ruling 2026-09-29): a one-off the engine resolved at once needs
 * nothing extra. §4.1's predicate alone decides: a handoff when control
 * passes, no curtain when it stays with the mover (a 7's pick, a cancelled
 * chain that lets the counterer play on).
 */
export function next(pre: CurtainView, mv: AppliedMove, post: CurtainView): CurtainState {
  assertReachable(pre, mv);
  if (post.phase === PhaseGameOver) return { kind: 'result' };
  if (curtainRequired(pre, post)) {
    return { kind: 'handoff', to: post.active, reason: reasonFor(post.phase) };
  }
  return { kind: 'none' };
}

/** Whether `to`'s sequence ends at the real counter window (§4.3). */
function ackFollows(to: PlayerId, ctx: CurtainContext): boolean {
  return ctx.post.phase === PhaseAwaitingCounter && ctx.post.active === to;
}

/**
 * The step after reveal: the real counter window, or the live view.
 * A sequence addressed to someone who is not the decider hands the phone
 * on instead; the live machine never produces one (every handoff goes to
 * `post.active`), but a save from before the 2026-09-29 ruling can hold
 * such a curtain (snapshot.ts maps an old acknowledgment to `reveal`).
 */
function afterReveal(to: PlayerId, ctx: CurtainContext): CurtainState {
  if (ackFollows(to, ctx)) return { kind: 'ack', to };
  if (ctx.post.active !== to) return { kind: 'handoff', to: ctx.post.active, reason: reasonFor(ctx.post.phase) };
  return { kind: 'none' };
}

/**
 * Advances the receiving player's sequence one step (§4.2):
 * handoff → reveal → [counter prompt] → none. (Issue #95, ApisMellow
 * 2026-10-25: pass-and-play no longer shows a recap between the reveal and
 * what follows it.)
 *
 * `none`, `result`, and the counter window (`ack`) are resting states: the
 * first two are terminal, the third leaves only via a bridge apply and a
 * fresh `next()`. Advancing any of them throws.
 */
export function advance(state: CurtainState, ctx: CurtainContext): CurtainState {
  switch (state.kind) {
    case 'handoff':
      return { kind: 'reveal', to: state.to };
    case 'reveal':
      return afterReveal(state.to, ctx);
    case 'ack':
      throw new CurtainError('the counter window resolves through apply(), not advance() (SPEC §4.3)');
    case 'none':
    case 'result':
      throw new CurtainError(`cannot advance a resting curtain state '${state.kind}'`);
  }
}
