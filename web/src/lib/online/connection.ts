// Two-phone W11 (docs/two-phone-plan.md §3, §8, §9): the phone's WebSocket
// connection to the game server. Framework-light on purpose: no Svelte, no
// game state. OnlineGameStore (W12) sits on top of it.
//
//   - Connects to <origin>/api/play. The seat token goes only in the first
//     frame, `hello`, never in the URL, so it never lands in access logs.
//   - `open` means the server answered hello with `welcome`. Moves and
//     rematch requests are refused (return false) until then; the client
//     never queues or resends a move (plan §3 "Seq rules").
//   - Every inbound `state` is validated by schema.ts (via protocol.ts) and
//     must be addressed to this seat. A bad frame is reported through
//     onProtocolError and not delivered; the connection stays up.
//   - A drop reconnects with backoff 0.5, 1, 2, 4, 8, 16, then every 30 s,
//     each with ±20% jitter so two phones don't retry in step. A successful
//     welcome resets it. `online` resets it and retries at once;
//     `visibilitychange` to visible retries at once without resetting. A
//     socket factory that throws (SecurityError, bad URL) counts as a drop.
//   - An `error` frame with RATE_LIMITED sets a floor: no socket for at
//     least RATE_LIMIT_FLOOR_MS, whatever `online`, `visibilitychange` or
//     retry() say.
//   - After MAX_FAILED_ATTEMPTS failures in a row without a welcome the
//     connection is `stalled`: no more retries, whatever the page does, until
//     retry() is called (the UI's "Tap to reconnect").
//   - Heartbeat: an app-level `ping` every PING_INTERVAL_MS; any inbound
//     frame counts as life. No frame within PONG_TIMEOUT_MS of a ping means
//     the socket is dead (iOS suspends a backgrounded page and the socket
//     can die without a close event), so it is dropped and replaced. On
//     visible, an open socket is probed at once with a shorter deadline.
//   - REPLACED (a newer hello for this seat, on another tab or phone) stops
//     auto-reconnecting, so two devices don't take the seat back and forth.
//     The status is `replaced` and the seat stays valid; retry() resumes
//     here ("tap to play here").
//   - A `welcome` while already open is normal (a waiting room's seat 0 gets
//     a second one when someone joins): it is delivered and the status stays
//     `open`. A welcome with no `state` after it leaves the status `open` too.
//   - ROOM_GONE, UNAUTHORIZED and UPGRADE_REQUIRED are terminal: the socket
//     closes and nothing reconnects. The frame is still delivered, so the
//     store can forget the seat and say why. A `welcome` for another seat or
//     a `state` for another viewer is terminal too, as the client-side code
//     SEAT_MISMATCH (the saved seat is wrong; W12 clears it).
//   - `state` and non-terminal `error` frames before `welcome` are dropped.
//     `lastSeq` never goes backwards within a game and resets when a newer
//     game starts.
//   - Each listener call is isolated: one that throws doesn't skip the
//     others. The throw is reported through onProtocolError as a
//     ListenerError whose message is fixed text (never frame contents).
//   - `navigator.onLine` false, or an `offline` event, puts the connection
//     in `offline`: socket closed, no retries until `online`.
//
// Nothing here logs. The token lives only in this closure and in the hello
// frame; statuses, errors and the returned object never carry it.

import type { PlayerId } from '../bridge/schema';
import { webSocketUrl } from './config';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  decodeServerFrame,
  encodeClientFrame,
  isTerminalErrorCode,
  type ClientFrame,
  type ServerFrame,
  type TerminalErrorCode,
} from './protocol';

/** Backoff before reconnect attempt 1, 2, 3, ...; the last value repeats. */
export const BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000];
/** The least wait before the next socket after the server says RATE_LIMITED. */
export const RATE_LIMIT_FLOOR_MS = 60_000;
/** Failures in a row, without a welcome, after which the connection stalls. */
export const MAX_FAILED_ATTEMPTS = 10;
/** Each delay is scaled by a random factor in [1 - JITTER_RATIO, 1 + JITTER_RATIO). */
export const JITTER_RATIO = 0.2;
/** How often an open socket sends `ping`. */
export const PING_INTERVAL_MS = 15_000;
/** How long after a ping an inbound frame must arrive. */
export const PONG_TIMEOUT_MS = 10_000;
/** The shorter deadline for the probe sent when the page becomes visible. */
export const PROBE_TIMEOUT_MS = 5_000;
/** From socket creation to `welcome`. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

const OPEN = 1;

/** The part of a browser WebSocket this module uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type EnvironmentEvent = 'online' | 'offline' | 'visibilitychange';

/** Network and page-visibility signals, injectable for tests. */
export interface ConnectionEnvironment {
  isOnline(): boolean;
  isVisible(): boolean;
  /** Adds a listener; returns its remover. */
  listen(type: EnvironmentEvent, fn: () => void): () => void;
}

/**
 * Client-side terminal codes, reported as `closed-by-server` like the
 * server's terminal codes. SEAT_MISMATCH: the server answered for a
 * different seat than the saved one, so the saved seat should be cleared.
 */
export type ClientTerminalCode = 'SEAT_MISMATCH';

/** A status or frame listener threw. The message is fixed text. */
export class ListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListenerError';
  }
}

export type ConnectionStatus =
  | { kind: 'idle' }
  /** First connection, before any welcome and with no failure yet. */
  | { kind: 'connecting' }
  | { kind: 'open' }
  /**
   * After a drop or a failed attempt. `attempt` counts failures since the
   * last welcome (0 after `online` reset the backoff). `retryInMs` is the
   * wait before the next socket, or null while a socket is in flight.
   */
  | { kind: 'reconnecting'; attempt: number; retryInMs: number | null }
  | { kind: 'offline' }
  /**
   * MAX_FAILED_ATTEMPTS failures in a row without a welcome. Nothing retries
   * (not `online`, not `visibilitychange`) until retry() is called; the UI
   * offers "Tap to reconnect".
   */
  | { kind: 'stalled'; attempt: number }
  /**
   * The server sent REPLACED: this seat was taken over by a newer hello. No
   * auto-reconnect; the seat is still good, and retry() takes it back.
   */
  | { kind: 'replaced' }
  | { kind: 'closed-by-server'; code: TerminalErrorCode | ClientTerminalCode }
  /** close() was called. */
  | { kind: 'closed' };

export interface ConnectionOptions {
  serverOrigin: string;
  code: string;
  seat: PlayerId;
  token: string;
  /** The last envelope seq this phone saw; sent in hello. Default 0. */
  lastSeq?: number;
  /**
   * The game `lastSeq` belongs to, if known. With it, a `state` for the same
   * game can't move lastSeq backwards; without it, the first `state` sets it.
   */
  lastGame?: number;
  socketFactory?: SocketFactory;
  environment?: ConnectionEnvironment;
  /** Jitter source in [0, 1). Default Math.random. */
  random?: () => number;
}

export interface OnlineConnection {
  readonly status: ConnectionStatus;
  /** Calls `fn` with the current status now and on every change. */
  subscribe(fn: (status: ConnectionStatus) => void): () => void;
  /** Every validated server frame except `pong`. */
  onFrame(fn: (frame: ServerFrame) => void): () => void;
  /** A frame that failed validation (ProtocolError or SchemaError). */
  onProtocolError(fn: (error: Error) => void): () => void;
  /** Opens the connection. Idempotent; does nothing once closed. */
  start(): void;
  /**
   * Retries now with a clean backoff (still no sooner than a RATE_LIMITED
   * floor). The way out of `stalled` and `replaced`; also skips a backoff
   * wait or leaves `offline`. Does nothing while idle, connecting, open or closed.
   */
  retry(): void;
  /** Sends `move`. False (nothing sent) unless the connection is open. */
  sendMove(game: number, seq: number, index: number): boolean;
  /** Sends `rematch`. False (nothing sent) unless the connection is open. */
  sendRematch(game: number): boolean;
  /** Closes for good: socket, timers and listeners. */
  close(): void;
}

export function browserEnvironment(): ConnectionEnvironment {
  return {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    listen(type, fn) {
      const target: EventTarget | undefined =
        type === 'visibilitychange'
          ? typeof document === 'undefined'
            ? undefined
            : document
          : typeof window === 'undefined'
            ? undefined
            : window;
      if (!target) return () => {};
      target.addEventListener(type, fn);
      return () => target.removeEventListener(type, fn);
    },
  };
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function createConnection(options: ConnectionOptions): OnlineConnection {
  const url = webSocketUrl(options.serverOrigin);
  const { code, seat } = options;
  const token = options.token;
  const makeSocket = options.socketFactory ?? defaultSocketFactory;
  const env = options.environment ?? browserEnvironment();
  const random = options.random ?? Math.random;

  let status: ConnectionStatus = { kind: 'idle' };
  let lastSeq = options.lastSeq ?? 0;
  let lastGame: number | null = options.lastGame ?? null;
  let failures = 0;
  let everOpened = false;
  /** Any attempt has failed, so a new socket is a reconnect, not a first try. */
  let everFailed = false;
  /** Date.now() before which no socket may be made (RATE_LIMITED). */
  let floorUntil = 0;

  let socket: SocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let removeEnvListeners: Array<() => void> = [];

  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const frameListeners = new Set<(f: ServerFrame) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  const isFinal = () => status.kind === 'closed' || status.kind === 'closed-by-server';

  /** Reports to the error listeners; one that throws is skipped over. */
  function emitError(error: Error): void {
    for (const fn of [...errorListeners]) {
      try {
        fn(error);
      } catch {
        // An error listener's own throw has nowhere safe to go.
      }
    }
  }

  /** Calls one status or frame listener; a throw is reported, never rethrown. */
  function callListener<T>(fn: (value: T) => void, value: T, what: string): void {
    try {
      fn(value);
    } catch {
      emitError(new ListenerError(`${what} listener threw`));
    }
  }

  function setStatus(next: ConnectionStatus): void {
    status = next;
    for (const fn of [...statusListeners]) callListener(fn, next, 'status');
  }

  function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
    if (t !== null) clearTimeout(t);
    return null;
  }

  function stopSocketTimers(): void {
    handshakeTimer = clearTimer(handshakeTimer);
    deadlineTimer = clearTimer(deadlineTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
  }

  /** Detaches and closes the current socket; its late events are ignored. */
  function discardSocket(): void {
    stopSocketTimers();
    const s = socket;
    socket = null;
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    try {
      s.close(1000);
    } catch {
      // Already closing or closed.
    }
  }

  function send(frame: ClientFrame): boolean {
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(encodeClientFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Arms (or shortens) the "some frame must arrive by then" deadline. */
  function armDeadline(ms: number): void {
    if (deadlineTimer !== null) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      drop();
    }, ms);
  }

  function ping(deadlineMs: number): void {
    // A socket that can't even take a ping is gone, close event or not.
    if (send({ t: 'ping' })) armDeadline(deadlineMs);
    else drop();
  }

  function backoffDelay(attempt: number): number {
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
    return Math.round(base * (1 - JITTER_RATIO + 2 * JITTER_RATIO * random()));
  }

  /** Milliseconds left on a RATE_LIMITED floor, or 0. */
  function floorRemaining(): number {
    return Math.max(0, floorUntil - Date.now());
  }

  function scheduleConnect(delay: number): void {
    reconnectTimer = clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    setStatus({ kind: 'reconnecting', attempt: failures, retryInMs: delay });
  }

  /** The current socket failed or died: go offline, stall, or schedule a retry. */
  function drop(): void {
    if (isFinal()) return;
    discardSocket();
    if (!env.isOnline()) {
      goOffline();
      return;
    }
    failures += 1;
    everFailed = true;
    if (failures >= MAX_FAILED_ATTEMPTS) {
      reconnectTimer = clearTimer(reconnectTimer);
      setStatus({ kind: 'stalled', attempt: failures });
      return;
    }
    scheduleConnect(Math.max(backoffDelay(failures), floorRemaining()));
  }

  function goOffline(): void {
    discardSocket();
    reconnectTimer = clearTimer(reconnectTimer);
    failures = 0;
    setStatus({ kind: 'offline' });
  }

  function connect(): void {
    if (isFinal()) return;
    discardSocket();
    reconnectTimer = clearTimer(reconnectTimer);
    if (!env.isOnline()) {
      goOffline();
      return;
    }
    let s: SocketLike;
    try {
      s = makeSocket(url);
    } catch {
      // SecurityError, a bad URL, ...: no socket to wait on, so it's a drop.
      drop();
      return;
    }
    socket = s;
    const current = () => socket === s;
    s.onopen = () => {
      if (!current()) return;
      const hello = send({ t: 'hello', v: PROTOCOL_VERSION, code, token, lastSeq });
      if (!hello) {
        drop();
        return;
      }
      pingTimer = setInterval(() => ping(PONG_TIMEOUT_MS), PING_INTERVAL_MS);
    };
    s.onmessage = (ev) => {
      if (current()) receive(ev.data);
    };
    s.onclose = () => {
      if (current()) drop();
    };
    s.onerror = () => {
      if (current()) drop();
    };
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      drop();
    }, HANDSHAKE_TIMEOUT_MS);
    setStatus(
      everOpened || everFailed ? { kind: 'reconnecting', attempt: failures, retryInMs: null } : { kind: 'connecting' },
    );
  }

  function reportError(err: unknown): void {
    emitError(err instanceof Error ? err : new ProtocolError('frame: could not be decoded'));
  }

  /** Wrong seat from the server: report it, then stop for good. */
  function seatMismatch(error: ProtocolError): void {
    reportError(error);
    finish({ kind: 'closed-by-server', code: 'SEAT_MISMATCH' });
  }

  function receive(data: unknown): void {
    // Any inbound frame proves the socket is alive.
    deadlineTimer = clearTimer(deadlineTimer);
    if (typeof data !== 'string') return;
    let frame: ServerFrame | null;
    try {
      frame = decodeServerFrame(data);
    } catch (err) {
      reportError(err);
      return;
    }
    if (frame === null || frame.t === 'pong') return;

    if (frame.t === 'error' && frame.code === 'RATE_LIMITED') {
      floorUntil = Math.max(floorUntil, Date.now() + RATE_LIMIT_FLOOR_MS);
    }
    const welcomed = status.kind === 'open';
    const stops = frame.t === 'error' && (isTerminalErrorCode(frame.code) || frame.code === 'REPLACED');
    if (!welcomed && (frame.t === 'state' || (frame.t === 'error' && !stops))) {
      // Nothing but welcome (or a terminal error) may come first.
      return;
    }

    if (frame.t === 'welcome') {
      if (frame.seat !== seat) {
        seatMismatch(new ProtocolError('welcome.seat: must be this phone\'s seat'));
        return;
      }
      handshakeTimer = clearTimer(handshakeTimer);
      failures = 0;
      everOpened = true;
      if (!welcomed) setStatus({ kind: 'open' });
    } else if (frame.t === 'state') {
      if (frame.envelope.state.viewer !== seat) {
        seatMismatch(new ProtocolError('state.envelope.state.viewer: must be this phone\'s seat'));
        return;
      }
      noteSeq(frame.game, frame.envelope.seq);
    } else if (frame.t === 'error' && isTerminalErrorCode(frame.code)) {
      finish({ kind: 'closed-by-server', code: frame.code });
    } else if (frame.t === 'error' && frame.code === 'REPLACED') {
      // Park: no socket, no timer. Env listeners stay for retry() but ignore
      // everything while replaced.
      discardSocket();
      reconnectTimer = clearTimer(reconnectTimer);
      setStatus({ kind: 'replaced' });
    }
    for (const fn of [...frameListeners]) callListener(fn, frame, 'frame');
  }

  /** lastSeq only moves forward within a game; a newer game starts it over. */
  function noteSeq(game: number, seq: number): void {
    if (lastGame === null || game > lastGame) {
      lastGame = game;
      lastSeq = seq;
    } else if (game === lastGame && seq > lastSeq) {
      lastSeq = seq;
    }
  }

  function finish(final: ConnectionStatus): void {
    discardSocket();
    reconnectTimer = clearTimer(reconnectTimer);
    for (const remove of removeEnvListeners) remove();
    removeEnvListeners = [];
    setStatus(final);
  }

  /**
   * Retry now instead of waiting out the backoff; optionally reset it. A
   * RATE_LIMITED floor still holds: then the retry waits it out instead.
   */
  function retryNow(resetBackoff: boolean): void {
    if (resetBackoff) failures = 0;
    const wait = floorRemaining();
    if (wait > 0 && env.isOnline()) {
      discardSocket();
      scheduleConnect(wait);
      return;
    }
    connect();
  }

  function onVisibility(): void {
    if (isFinal() || !env.isVisible()) return;
    if (status.kind === 'open') {
      // The socket may have died while the page was suspended. Probe it.
      deadlineTimer = clearTimer(deadlineTimer);
      ping(PROBE_TIMEOUT_MS);
      return;
    }
    if (status.kind === 'offline') {
      if (env.isOnline()) retryNow(true);
      return;
    }
    if (status.kind === 'reconnecting' && status.retryInMs !== null) retryNow(false);
  }

  function onOnline(): void {
    if (isFinal()) return;
    if (status.kind === 'open') {
      // A network change can strand the socket; make sure it still answers.
      deadlineTimer = clearTimer(deadlineTimer);
      ping(PROBE_TIMEOUT_MS);
      return;
    }
    if (status.kind === 'offline' || (status.kind === 'reconnecting' && status.retryInMs !== null)) retryNow(true);
  }

  function onOffline(): void {
    // Stalled and replaced stay put until retry(), network or not.
    if (!isFinal() && status.kind !== 'stalled' && status.kind !== 'replaced') goOffline();
  }

  return {
    get status() {
      return status;
    },
    subscribe(fn) {
      statusListeners.add(fn);
      callListener(fn, status, 'status');
      return () => statusListeners.delete(fn);
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    onProtocolError(fn) {
      errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },
    start() {
      if (status.kind !== 'idle') return;
      removeEnvListeners = [
        env.listen('visibilitychange', onVisibility),
        env.listen('online', onOnline),
        env.listen('offline', onOffline),
      ];
      if (env.isOnline()) connect();
      else goOffline();
    },
    retry() {
      const k = status.kind;
      if (k === 'stalled' || k === 'replaced' || k === 'offline' || (k === 'reconnecting' && status.retryInMs !== null)) {
        retryNow(true);
      }
    },
    sendMove(game, seq, index) {
      return status.kind === 'open' && send({ t: 'move', game, seq, index });
    },
    sendRematch(game) {
      return status.kind === 'open' && send({ t: 'rematch', game });
    },
    close() {
      if (isFinal()) return;
      finish({ kind: 'closed' });
    },
  };
}
