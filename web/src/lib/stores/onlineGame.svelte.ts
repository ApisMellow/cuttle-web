// Two-phone W12 (docs/two-phone-plan.md §7, §8; SPEC §2.12): the online
// TableSource. It holds one seat's game as the server shows it, on top of a
// W11 connection (lib/online/connection.ts). GameScreen drives it exactly as
// it drives the local store.
//
// What differs from the local GameStore:
//   - No pass-and-play curtain. `curtain` is `none` while playing, `result`
//     at game over, and `ack` at this seat's own counter window (engine
//     phase AwaitingCounter with this seat active) so GameScreen mounts the
//     counter prompt there, as in pass-and-play (plan §6). The envelope
//     stays exposed at `ack`, exactly as the local store's does.
//     `advanceCurtain()` does nothing.
//   - `envelope`, `history` and `seq` come from `state` frames, whole (never
//     a diff). `viewer` is this seat whenever an envelope is held.
//   - `apply(i)` sends `move {game, seq, i}` and returns; `pending` holds
//     from then until the next `state`, `error` or `welcome`, or a stall or
//     replacement (a send from before a drop may never be answered). It also
//     holds while the server has this seat under the response hold
//     (`responding`), since the envelope on show is the pre-move one. The
//     client never queues or resends a move (SPEC §2.12.2 "Seq rules"): a
//     second apply while pending sends nothing, and an apply while the
//     socket is down sends nothing and rejects with `MoveNotSent`, so the
//     staged move survives. A resent state for the same position keeps the
//     same `curtain` object, so GameScreen keeps that staged move; a state
//     for a new position says the game moved on.
//   - `rematchWhenResumed(game)`: after an update reload taken at the
//     result screen's Rematch, the first state of that finished game sends
//     the rematch (lib/pwa/register.ts).
//   - Draw reveal (SPEC §4.7): there is no pass online, so "before the pass"
//     maps to "as soon as the state arrives on the drawer's phone". The
//     reveal is always the `beforePass: false` form (the whole hand, drawn
//     cards marked): the phone never changes hands (plan §7). A draw in the
//     first state of a game this store sees (a resume, a reload) is not
//     replayed, matching the local store's reload rule.
//   - `newGame()` asks for a rematch, and only at game over, once, and
//     never while a move is pending. Leaving is `goHome()` (the seat is
//     kept, so Resume on Home comes back to the game).
//   - Terminal errors (SPEC §2.12.3): ROOM_GONE, UNAUTHORIZED and the
//     client-side SEAT_MISMATCH forget the seat and leave for Home with a
//     message. UPGRADE_REQUIRED keeps the seat and leaves for Home asking for
//     an update: Home is a safe screen for the service-worker update policy
//     (lib/pwa/update.ts), whose `setScreen('home')` runs the update check.
//   - REPLACED and a stall leave the status line with a button that calls
//     the connection's `retry()`.
//
// Privacy: the only game data held is this seat's own envelope; `history`
// keeps a mover-only `index` only on this seat's own entries. The seat
// record (with its token) is kept privately and never exposed; it is sent
// only to the server it belongs to (the caller checks `seatMatchesServer`).
// Nothing here logs.

import type { AppliedMove, Envelope, PlayerId } from '../bridge/schema';
import { type DrawReveal, drawnHandIndices, unseenDrawFor } from '../drawReveal';
import { Phase } from '../enums';
import type { RoomEvent } from '../online/actions';
import { createConnection, type ConnectionOptions, type ConnectionStatus, type OnlineConnection } from '../online/connection';
import type { RoomStatus, SeatNames, ServerFrame } from '../online/protocol';
import { clearSeat, saveSeat, type SeatRecord } from '../online/seat';
import type { CurtainState } from './curtain.svelte';
import { online } from './online.svelte';
import { MoveNotSent, type OnlineTableInfo, type TableSource } from './tableSource';

type SeatStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface OnlineGameDeps {
  /** Opens the W11 connection. Tests inject a fake socket through it. */
  connect?: (options: ConnectionOptions) => OnlineConnection;
  /** Where the seat record lives (localStorage by default). */
  seatStorage?: SeatStorage;
  /** Leave the online game for Home, with a notice to show there (or null). */
  onLeave?: (notice: string | null) => void;
}

const NOTICE_NOT_SENT = 'You’re offline, so your move wasn’t sent. It stays staged: Confirm it again once you’re back.';
const NOTICE_MOVED_ON = 'The game moved on while you were away, so the move you kept was cleared.';
const NOTICE_NOT_THROUGH = 'That move didn’t go through. Try again.';
const NOTICE_STUCK = 'The game hit an error it could not recover from.';
const NOTICE_RATE = 'Too many tries. Wait a moment and try again.';

const LEAVE_ENDED = 'This game has ended.';
const LEAVE_UNRESUMABLE = 'This game couldn’t be resumed.';
const LEAVE_UPDATE = 'This app needs an update to keep playing online. It updates on its own shortly, or reload the page. Your game is kept.';

/** Engine errors after which the game can't go on from this position (SPEC §2.10). */
const STUCK_CODES = new Set(['ILLEGAL_MOVE', 'NO_LEGAL_MOVES']);
/** Errors the server follows with a fresh `state` (SPEC §2.12.3); they need no notice of their own. */
const RESYNC_CODES = new Set(['NOT_YOUR_TURN', 'STALE', 'GAME_OVER']);

function defaultSeatStorage(): SeatStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Drops a mover-only `index` key from another seat's entry (SPEC §3.2). A pure deletion. */
function redactedFor(seat: PlayerId, entry: AppliedMove): AppliedMove {
  if (entry.by === seat || !Object.prototype.hasOwnProperty.call(entry, 'index')) return entry;
  const copy = { ...entry };
  delete copy.index;
  return copy;
}

export class OnlineGameStore implements TableSource {
  readonly #connect: (options: ConnectionOptions) => OnlineConnection;
  readonly #storage: SeatStorage | undefined;
  readonly #onLeave: (notice: string | null) => void;

  #connection: OnlineConnection | null = null;
  #unsubscribe: Array<() => void> = [];
  /** The seat record, token included. Private; never exposed or logged. */
  #record: SeatRecord | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a private listener registry, never read by a template or a derived.
  #roomListeners = new Set<(event: RoomEvent) => void>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private pending promises, never read by a template or a derived.
  #welcomeWaiters = new Set<(names: SeatNames | null) => void>();
  /** A welcome has been seen with the second seat still empty (the host's waiting room). */
  #sawWaiting = false;
  /** SPEC §4.7: the seq of the last draw shown (or not to be shown) in the current game. */
  #drawSeen = 0;
  /** The game of the last state; 0 before any. */
  #lastGame = 0;
  /**
   * An apply was refused with MoveNotSent and nothing has been sent since:
   * the player may still have that move staged. A state for a different
   * position then says the game moved on (review F2).
   */
  #unsent = false;
  /** Review F4: the finished game to ask a rematch for once its state arrives (after an update reload), or null. */
  #rematchOnResume: number | null = null;

  // ---- TableSource ----------------------------------------------------------
  envelope = $state<Envelope | null>(null);
  history = $state<AppliedMove[]>([]);
  seq = $state(0);
  viewer = $state<PlayerId | null>(null);
  curtain = $state<CurtainState>({ kind: 'none' });
  drawReveal = $state<DrawReveal | null>(null);

  // ---- Room and connection state --------------------------------------------
  /** True from attach() until detach() (or a terminal error). */
  attached = $state(false);
  seat = $state<PlayerId | null>(null);
  roomNames = $state<SeatNames>([null, null]);
  roomStatus = $state<RoomStatus | null>(null);
  /** The room's game number (1, 2, … across rematches); 0 before any state. */
  game = $state(0);
  tally = $state<[number, number]>([0, 0]);
  opponentOnline = $state(true);
  /** The seat answering this seat's counterable move (the hold), or null. */
  responding = $state<PlayerId | null>(null);
  /** A pending rematch request, by seat, or null. */
  rematchRequestedBy = $state<PlayerId | null>(null);
  status = $state<ConnectionStatus>({ kind: 'idle' });
  /** One line about the last move or error; cleared by the next state. */
  notice = $state<string | null>(null);

  /** A move has been sent and neither its state nor an error is back. */
  #sending = $state(false);
  /** A rematch request has been sent and not yet echoed. */
  #rematchSent = $state(false);

  /** W10: an apply is in flight, or the server holds this seat's next state (the response hold). */
  get pending(): boolean {
    return this.#sending || this.responding !== null;
  }

  /** Names by seat, blanks filled so the board always has two. */
  names = $derived<[string, string]>([this.roomNames[0] ?? 'Player 1', this.roomNames[1] ?? 'Player 2']);

  online = $derived<OnlineTableInfo | null>(this.attached ? this.#info() : null);

  constructor(deps: OnlineGameDeps = {}) {
    this.#connect = deps.connect ?? createConnection;
    this.#storage = deps.seatStorage ?? defaultSeatStorage();
    this.#onLeave = deps.onLeave ?? (() => {});
  }

  // ---- Lifecycle --------------------------------------------------------------

  /**
   * Starts playing `record`'s seat: opens the connection and listens. The
   * caller has already checked that the record belongs to `serverOrigin`.
   * Replaces any earlier attachment.
   */
  attach(record: SeatRecord): void {
    this.detach();
    this.#record = record;
    this.seat = record.seat;
    this.roomNames = [record.names[0], record.names[1]];
    this.attached = true;
    const connection = this.#connect({ serverOrigin: record.server, code: record.code, seat: record.seat, token: record.token });
    this.#connection = connection;
    this.#unsubscribe = [
      connection.subscribe((status) => this.#onStatus(status)),
      connection.onFrame((frame) => this.#onFrame(frame)),
    ];
    connection.start();
  }

  /** Closes the connection and drops everything held. The saved seat is untouched. */
  detach(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#connection?.close();
    this.#connection = null;
    this.#record = null;
    for (const resolve of [...this.#welcomeWaiters]) resolve(null);
    this.#welcomeWaiters.clear();
    this.#sawWaiting = false;
    this.#drawSeen = 0;
    this.#lastGame = 0;
    this.#unsent = false;
    this.#rematchOnResume = null;
    this.#sending = false;
    this.#rematchSent = false;
    this.envelope = null;
    this.history = [];
    this.seq = 0;
    this.viewer = null;
    this.curtain = { kind: 'none' };
    this.drawReveal = null;
    this.attached = false;
    this.seat = null;
    this.roomNames = [null, null];
    this.roomStatus = null;
    this.game = 0;
    this.tally = [0, 0];
    this.opponentOnline = true;
    this.responding = null;
    this.rematchRequestedBy = null;
    this.status = { kind: 'idle' };
    this.notice = null;
  }

  /** Room events for the attached seat (the host's "opponent joined"). */
  onRoomEvent(handler: (event: RoomEvent) => void): () => void {
    this.#roomListeners.add(handler);
    return () => this.#roomListeners.delete(handler);
  }

  /** The names from the next `welcome`, or null after `timeoutMs` (or a detach). */
  whenWelcomed(timeoutMs: number): Promise<SeatNames | null> {
    return new Promise((resolve) => {
      const done = (names: SeatNames | null) => {
        clearTimeout(timer);
        this.#welcomeWaiters.delete(done);
        resolve(names);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.#welcomeWaiters.add(done);
    });
  }

  /** The connection's retry(): "Tap to reconnect" and "Play here". */
  retry(): void {
    this.#connection?.retry();
  }

  // ---- TableSource methods ----------------------------------------------------

  async apply(moveIndex: number): Promise<void> {
    if (this.drawReveal !== null) {
      throw new Error('OnlineGameStore.apply() is not allowed while the draw reveal is up (SPEC §4.7)');
    }
    const env = this.envelope;
    const kind = this.curtain.kind;
    if (env === null || (kind !== 'none' && kind !== 'ack') || env.state.viewer !== env.state.active) {
      throw new Error('OnlineGameStore.apply() needs this seat to be the one to act (SPEC §3.3)');
    }
    // The client never sends a second move before the first one's answer.
    if (this.pending) return;
    const connection = this.#connection;
    if (connection === null || !connection.sendMove(this.game, env.seq, moveIndex)) {
      this.notice = NOTICE_NOT_SENT;
      this.#unsent = true;
      throw new MoveNotSent();
    }
    this.notice = null;
    this.#unsent = false;
    this.#sending = true;
  }

  dismissDrawReveal(): void {
    this.drawReveal = null;
  }

  /** No curtain online. */
  async advanceCurtain(): Promise<void> {}

  /** Leave for Home. The seat is kept: Resume on Home reconnects. */
  goHome(): void {
    this.detach();
    this.#onLeave(null);
  }

  /**
   * Online, New game asks for a rematch (SPEC §2.12.4). Only at game over,
   * never while a move is pending, and once: nothing is sent again until the
   * server answers. Seed and dealer are the server's (R1, R3); options are
   * ignored.
   */
  async newGame(): Promise<void> {
    if (this.curtain.kind !== 'result' || this.pending || this.#rematchSent) return;
    if (this.seat !== null && this.rematchRequestedBy === this.seat) return;
    if (this.#connection?.sendRematch(this.game)) this.#rematchSent = true;
  }

  /**
   * Review F4: a Rematch tapped just before an update reload. Call right
   * after attach(): the first state, if it is finished game `game`, sends the
   * rematch (through newGame()'s gates). Any other first state drops it. One
   * shot; a detach drops it too.
   */
  rematchWhenResumed(game: number): void {
    this.#rematchOnResume = game;
  }

  /** True while this seat's rematch request is out (sent, or echoed and waiting for the other seat). */
  get rematchPending(): boolean {
    return this.#rematchSent || (this.seat !== null && this.rematchRequestedBy === this.seat);
  }

  // ---- Frames -----------------------------------------------------------------

  #onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'welcome':
        this.#onWelcome(frame.names, frame.status);
        return;
      case 'state':
        this.#onState(frame.game, frame.envelope, frame.opponentOnline, frame.tally);
        return;
      case 'responding':
        this.#sending = false;
        this.responding = frame.by;
        return;
      case 'presence':
        this.opponentOnline = frame.opponentOnline;
        return;
      case 'rematch':
        this.#rematchSent = false;
        this.rematchRequestedBy = frame.requestedBy;
        return;
      case 'error':
        this.#onError(frame.code);
        return;
      default:
        return;
    }
  }

  #onWelcome(names: SeatNames, status: RoomStatus): void {
    // A welcome is followed by exactly one of state / responding / nothing,
    // so any earlier hold is over (SPEC §2.12.2). So is a send from before
    // the drop: its answer is that state (or hold), or never comes (review
    // F5). A second Confirm meanwhile can't apply twice: the server refuses
    // an old seq (STALE).
    this.responding = null;
    this.#sending = false;
    this.roomStatus = status;
    const joined = this.#sawWaiting && names[1] !== null && this.roomNames[1] === null;
    this.roomNames = [names[0], names[1]];
    if (names[1] === null) this.#sawWaiting = true;
    this.#saveNames(names);
    for (const resolve of [...this.#welcomeWaiters]) resolve([names[0], names[1]]);
    if (joined && names[1] !== null) {
      const event: RoomEvent = { kind: 'opponent-joined', opponentName: names[1] };
      for (const fn of [...this.#roomListeners]) fn(event);
    }
  }

  #onState(game: number, env: Envelope, opponentOnline: boolean, tally: [number, number]): void {
    const seat = this.seat;
    if (seat === null || env.state.viewer !== seat) return; // the connection already refuses these
    const newGame = game !== this.#lastGame;
    // A kept (unsent) move is still good only at the same position (review F2).
    const movedOn = this.#unsent && (newGame || env.seq !== this.seq);
    if (movedOn) this.#unsent = false;
    if (newGame) {
      // A first state (resume, reload) or a rematch: nothing already drawn is replayed.
      this.#drawSeen = env.seq;
      this.drawReveal = null;
      this.rematchRequestedBy = null;
      this.#rematchSent = false;
    }
    this.#lastGame = game;
    this.game = game;
    this.tally = [tally[0], tally[1]];
    this.opponentOnline = opponentOnline;
    this.#sending = false;
    this.responding = null;
    this.notice = movedOn ? NOTICE_MOVED_ON : null;
    this.history = env.history.map((entry) => redactedFor(seat, entry));
    this.seq = env.seq;
    this.envelope = { ...env, history: this.history };
    this.viewer = seat;
    // Reassign only on a real change: a resent identical state (a reconnect)
    // must not look like a new curtain to GameScreen's staging reset (review F2).
    const curtain = curtainFor(env, seat);
    if (!sameCurtain(this.curtain, curtain)) this.curtain = curtain;
    if (!newGame) this.#revealUnseenDraw(env, seat);
    const rematchFor = this.#rematchOnResume;
    if (rematchFor !== null) {
      this.#rematchOnResume = null;
      if (game === rematchFor && this.curtain.kind === 'result') void this.newGame();
    }
  }

  #onError(code: string): void {
    this.#sending = false;
    this.#rematchSent = false;
    if (RESYNC_CODES.has(code) || code === 'REPLACED') return;
    if (code === 'RATE_LIMITED') this.notice = NOTICE_RATE;
    else if (STUCK_CODES.has(code)) this.notice = `${NOTICE_STUCK} (${code})`;
    else this.notice = NOTICE_NOT_THROUGH;
  }

  #onStatus(status: ConnectionStatus): void {
    this.status = status;
    // Review F5: no answer comes while stalled or replaced; free the board.
    if (status.kind === 'stalled' || status.kind === 'replaced') this.#sending = false;
    if (status.kind !== 'closed-by-server') return;
    // Terminal (SPEC §2.12.3). Read what is needed, then drop everything.
    const forget = status.code !== 'UPGRADE_REQUIRED';
    const notice = status.code === 'ROOM_GONE' ? LEAVE_ENDED : status.code === 'UPGRADE_REQUIRED' ? LEAVE_UPDATE : LEAVE_UNRESUMABLE;
    if (forget) clearSeat(this.#storage);
    this.detach();
    this.#onLeave(notice);
  }

  /** SPEC §4.7 online: the drawer sees their draw as soon as the state that resolved it arrives. */
  #revealUnseenDraw(env: Envelope, seat: PlayerId): void {
    const unseen = unseenDrawFor(env.history, seat, this.#drawSeen);
    if (unseen === null) return;
    this.#drawSeen = unseen.seq;
    const view = env.state;
    const ownTurn = view.phase === Phase.Normal && view.active === seat;
    const indices = drawnHandIndices(view.you, unseen.count, ownTurn);
    if (indices.length === 0) return;
    this.drawReveal = { to: seat, indices, beforePass: false };
  }

  /** Keeps the saved seat's names current, for "Resume online game with Blake". */
  #saveNames(names: SeatNames): void {
    const record = this.#record;
    if (record === null || (record.names[0] === names[0] && record.names[1] === names[1])) return;
    const next: SeatRecord = { ...record, names: [names[0], names[1]] };
    this.#record = next;
    saveSeat(next, this.#storage);
  }

  #info(): OnlineTableInfo {
    const seat = this.seat ?? 0;
    const other = (1 - seat) as PlayerId;
    const otherName = this.names[other];
    const status = this.status;
    let statusText: string | null;
    let statusAction: string | null = null;
    switch (status.kind) {
      case 'idle':
      case 'connecting':
        statusText = 'Connecting…';
        break;
      case 'reconnecting':
        statusText = 'Reconnecting…';
        break;
      case 'offline':
        statusText = 'You’re offline. Online games need a connection.';
        break;
      case 'stalled':
        statusText = 'Can’t reach the game server.';
        statusAction = 'Tap to reconnect';
        break;
      case 'replaced':
        statusText = 'This game is open somewhere else.';
        statusAction = 'Play here';
        break;
      case 'open':
        statusText = this.opponentOnline || this.roomNames[other] === null ? null : `${otherName} is offline.`;
        break;
      default:
        statusText = null;
    }
    return {
      names: this.names,
      statusText,
      statusAction,
      respondingName: this.responding === null ? null : this.names[this.responding],
      notice: this.notice,
      runStatusAction: () => this.retry(),
    };
  }
}

/** None while playing, `result` at game over, `ack` at this seat's own counter window. */
function curtainFor(env: Envelope, seat: PlayerId): CurtainState {
  const view = env.state;
  if (view.phase === Phase.GameOver) return { kind: 'result' };
  if (view.phase === Phase.AwaitingCounter && view.active === seat) return { kind: 'ack', to: seat };
  return { kind: 'none' };
}

/** Same kind and, where it has one, same `to`: the only curtains this store makes. */
function sameCurtain(a: CurtainState, b: CurtainState): boolean {
  if (a.kind !== b.kind) return false;
  const aTo = 'to' in a ? a.to : null;
  const bTo = 'to' in b ? b.to : null;
  return aTo === bTo;
}

/** The app's one online store. Nothing runs until `attach()`. Leaving goes back to Home. */
export const onlineGame = new OnlineGameStore({ onLeave: (notice) => online.leave(notice) });
