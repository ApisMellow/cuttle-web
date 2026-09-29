// SPEC §4 — the curtain state machine (R13–R16, R20).
//
// Pure functions only. The machine implements no game rule: it reads
// post.active and post.phase (the engine is canon) and applies §4.1's
// predicate. A one-off the engine resolved at once (the responder held no
// legal 2) is followed exactly like any other resolved move: there is no
// acknowledgment step (§4.3, ruling 2026-09-29). The only `ack` is the real
// counter window. AppliedMove.index is never read: it is absent for
// non-movers (§2.7).

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
  | { kind: 'recap'; to: PlayerId; entries: RecapEntry[] }
  /** The real counter window (§4.3): `to` holds a legal 2. */
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

/** A one-off entry: a OneOff, or a SevenPick whose sub-move was a OneOff. Kinds only. */
function isOneOff(mv: AppliedMove): boolean {
  return mv.kind === MoveOneOff || (mv.kind === MoveSevenPick && mv.subKind === MoveOneOff);
}

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

/** The handoff reason for `post.active` receiving control in `post.phase`. */
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
 * The recap entries left once the counter prompt will show the chain
 * (ruling 2026-09-29, #23 follow-up): the prompt already lists the one-off
 * and every 2 on it, so those are dropped here and only what the prompt
 * does not show stays (for example the responder's own discard before a
 * one-off). The window is open, so history ends with that chain, and the
 * unseen entries are a tail of it: drop trailing Counters, then the one-off
 * that opened the chain. Kinds only; no card is read.
 */
function withoutPromptEntries(entries: RecapEntry[]): RecapEntry[] {
  let end = entries.length;
  while (end > 0 && entries[end - 1].kind === MoveCounter) end--;
  if (end > 0 && isOneOff(entries[end - 1])) end--;
  return entries.slice(0, end);
}

/**
 * The step after reveal/recap: the real counter window, or the live view.
 * A sequence addressed to someone who is not the decider hands the phone
 * on instead; the live machine never produces one (every handoff goes to
 * `post.active`), but a save from before the 2026-09-29 ruling can hold
 * such a curtain (snapshot.ts maps an old acknowledgment to `reveal`).
 */
function afterRecap(to: PlayerId, ctx: CurtainContext): CurtainState {
  if (ackFollows(to, ctx)) return { kind: 'ack', to };
  if (ctx.post.active !== to) return { kind: 'handoff', to: ctx.post.active, reason: reasonFor(ctx.post.phase) };
  return { kind: 'none' };
}

/**
 * Advances the receiving player's sequence one step (§4.2):
 * handoff → reveal → [recap] → [counter prompt] → none.
 * Before the counter prompt the recap keeps only what the prompt does not
 * show, and is skipped when that leaves nothing.
 *
 * `none`, `result`, and the counter window (`ack`) are resting states: the
 * first two are terminal, the third leaves only via a bridge apply and a
 * fresh `next()`. Advancing any of them throws.
 */
export function advance(state: CurtainState, ctx: CurtainContext): CurtainState {
  switch (state.kind) {
    case 'handoff':
      return { kind: 'reveal', to: state.to };
    case 'reveal': {
      const unseen = ctx.recapFor(state.to);
      const entries = ackFollows(state.to, ctx) ? withoutPromptEntries(unseen) : unseen;
      if (entries.length > 0) return { kind: 'recap', to: state.to, entries };
      return afterRecap(state.to, ctx);
    }
    case 'recap':
      return afterRecap(state.to, ctx);
    case 'ack':
      throw new CurtainError('the counter window resolves through apply(), not advance() (SPEC §4.3)');
    case 'none':
    case 'result':
      throw new CurtainError(`cannot advance a resting curtain state '${state.kind}'`);
  }
}
