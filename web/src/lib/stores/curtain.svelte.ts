// SPEC §4 — the curtain state machine (R13–R16, R20).
//
// Pure functions only. The machine implements no game rule: it reads
// post.active and post.phase (the engine is canon) and applies §4.1's
// predicate, plus the one addition of §4.3 — the synthetic acknowledgment
// the client must stage when the engine auto-resolved a counterable move.
// AppliedMove.index is never read: it is absent for non-movers (§2.7).

import type { AppliedMove, MoveKind, Phase, PlayerId, PlayerView } from '../bridge/schema';
import { MoveKind as MK, Phase as Ph } from '../enums';

// SPEC §2.5, pinned from source, via the shared enums module (round 2 W7).
const PhaseNormal = Ph.Normal;
const PhaseAwaitingCounter = Ph.AwaitingCounter;
const PhaseSevenChoosing = Ph.SevenChoosing;
const PhaseAwaitingDiscard = Ph.AwaitingDiscard;
const PhaseGameOver = Ph.GameOver;

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

/** A history entry the incoming player has not yet seen (§4.6). Formatting is the recap formatter's job. */
export type RecapEntry = AppliedMove;

export type HandoffReason = 'turn' | 'counter' | 'discard' | 'seven-return' | 'acknowledge';

export type CurtainState =
  | { kind: 'none' }
  | { kind: 'handoff'; to: PlayerId; reason: HandoffReason }
  | { kind: 'reveal'; to: PlayerId }
  | { kind: 'recap'; to: PlayerId; entries: RecapEntry[] }
  | { kind: 'ack'; to: PlayerId; synthetic: boolean }
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
  /** Unseen history for a player, evaluated when that player passes the reveal gate. */
  recapFor(viewer: PlayerId): RecapEntry[];
}

/** A curtain-machine bug. `code` mirrors the bridge's INTERNAL (§2.9). */
export class CurtainError extends Error {
  readonly code = 'INTERNAL' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CurtainError';
  }
}

// §4.4: the (pre.phase, mv.kind) pairs the engine can produce.
const REACHABLE: Record<Phase, readonly MoveKind[]> = {
  [PhaseNormal]: [MoveDraw, MovePlayPoint, MovePlayPermanent, MoveScuttle, MoveOneOff, MovePass],
  [PhaseAwaitingCounter]: [MoveCounter, MoveDecline],
  [PhaseSevenChoosing]: [MoveSevenPick],
  [PhaseAwaitingDiscard]: [MoveDiscardPair],
  [PhaseGameOver]: [],
};

function other(p: PlayerId): PlayerId {
  return (1 - p) as PlayerId;
}

/** §4.1: curtainRequired ⟺ post.active !== pre.active ∧ post.phase !== PhaseGameOver. */
export function curtainRequired(pre: CurtainView, post: CurtainView): boolean {
  return post.active !== pre.active && post.phase !== PhaseGameOver;
}

/** §4.3 detection code, verbatim in logic. No rank filter is needed or permitted. */
export function needsSyntheticAck(_pre: CurtainView, mv: AppliedMove, post: CurtainView): boolean {
  const counterable =
    mv.kind === MoveOneOff ||
    mv.kind === MoveCounter ||
    (mv.kind === MoveSevenPick && mv.subKind === MoveOneOff);
  if (!counterable) return false;
  return post.phase !== PhaseAwaitingCounter;
}

/**
 * §4.5 (amended 2026-09-27): the label the handoff screen may display.
 * The acting player sees this screen while passing the phone, so every
 * response-type reason shares one neutral label — distinct labels would
 * reveal whether the opponent held a 2 (R14). The raw HandoffReason must
 * not reach the DOM before the reveal gate.
 */
export function handoffLabel(reason: HandoffReason): string {
  switch (reason) {
    case 'turn':
    case 'seven-return':
      return 'Your turn';
    case 'counter':
    case 'acknowledge':
    case 'discard':
      return 'Your response';
  }
}

/** The handoff reason for `post.active` receiving control in `post.phase`. */
function reasonFor(phase: Phase): HandoffReason {
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

/** True when the §4.3 synthetic ack is part of this move's sequence (game over pre-empts it, §4.4). The opening deal has no move, so no ack. */
function syntheticAckPending(pre: CurtainView, mv: AppliedMove | null, post: CurtainView): boolean {
  return mv !== null && post.phase !== PhaseGameOver && needsSyntheticAck(pre, mv, post);
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
 */
export function next(pre: CurtainView, mv: AppliedMove, post: CurtainView): CurtainState {
  assertReachable(pre, mv);
  if (post.phase === PhaseGameOver) return { kind: 'result' };

  if (syntheticAckPending(pre, mv, post)) {
    const to = other(pre.active);
    // The ack target is the incoming decider only when the engine left control
    // with them; then the reason names what they do next (a 4's discard).
    const reason: HandoffReason =
      post.active === to && post.phase === PhaseAwaitingDiscard ? 'discard' : 'acknowledge';
    return { kind: 'handoff', to, reason };
  }

  if (curtainRequired(pre, post)) {
    return { kind: 'handoff', to: post.active, reason: reasonFor(post.phase) };
  }
  return { kind: 'none' };
}

/** The step after reveal/recap: the ack (synthetic or the real counter window), or the live view. */
function afterRecap(to: PlayerId, ctx: CurtainContext): CurtainState {
  if (syntheticAckPending(ctx.pre, ctx.move, ctx.post) && to === other(ctx.pre.active)) {
    return { kind: 'ack', to, synthetic: true };
  }
  if (ctx.post.phase === PhaseAwaitingCounter && ctx.post.active === to) {
    return { kind: 'ack', to, synthetic: false };
  }
  return { kind: 'none' };
}

/**
 * Advances the receiving player's sequence one step (§4.2):
 * handoff → reveal → [recap] → [ack | counter-prompt] → none.
 * After a synthetic ack, control hands back to post.active when it is not
 * the acknowledging player (the 7's round trip, §4.3; a cancelled counter
 * chain likewise).
 *
 * `none`, `result`, and the real counter window (`ack`, synthetic: false)
 * are resting states: the first two are terminal, the third leaves only via
 * a bridge apply and a fresh `next()`. Advancing any of them throws.
 */
export function advance(state: CurtainState, ctx: CurtainContext): CurtainState {
  switch (state.kind) {
    case 'handoff':
      return { kind: 'reveal', to: state.to };
    case 'reveal': {
      const entries = ctx.recapFor(state.to);
      if (entries.length > 0) return { kind: 'recap', to: state.to, entries };
      return afterRecap(state.to, ctx);
    }
    case 'recap':
      return afterRecap(state.to, ctx);
    case 'ack': {
      if (!state.synthetic) {
        throw new CurtainError('the real counter window resolves through apply(), not advance() (SPEC §4.3)');
      }
      if (ctx.post.active !== state.to) {
        return { kind: 'handoff', to: ctx.post.active, reason: reasonFor(ctx.post.phase) };
      }
      return { kind: 'none' };
    }
    case 'none':
    case 'result':
      throw new CurtainError(`cannot advance a resting curtain state '${state.kind}'`);
  }
}
