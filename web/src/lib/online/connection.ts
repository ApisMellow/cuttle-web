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
//   - A drop reconnects with backoff 0.5, 1, 2, 4, then every 8 s, each with
//     ±20% jitter so two phones don't retry in step. A successful welcome
//     resets it. `online` resets it and retries at once; `visibilitychange`
//     to visible retries at once without resetting.
//   - Heartbeat: an app-level `ping` every PING_INTERVAL_MS; any inbound
//     frame counts as life. No frame within PONG_TIMEOUT_MS of a ping means
//     the socket is dead (iOS suspends a backgrounded page and the socket
//     can die without a close event), so it is dropped and replaced. On
//     visible, an open socket is probed at once with a shorter deadline.
//   - ROOM_GONE, UNAUTHORIZED and UPGRADE_REQUIRED are terminal: the socket
//     closes and nothing reconnects. The frame is still delivered, so the
//     store can forget the seat and say why.
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
export const BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
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
  | { kind: 'closed-by-server'; code: TerminalErrorCode }
  /** close() was called. */
  | { kind: 'closed' };

export interface ConnectionOptions {
  serverOrigin: string;
  code: string;
  seat: PlayerId;
  token: string;
  /** The last envelope seq this phone saw; sent in hello. Default 0. */
  lastSeq?: number;
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
  let failures = 0;
  let everOpened = false;

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

  function setStatus(next: ConnectionStatus): void {
    status = next;
    for (const fn of [...statusListeners]) fn(next);
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

  /** The current socket failed or died: go offline or schedule a retry. */
  function drop(): void {
    if (isFinal()) return;
    discardSocket();
    if (!env.isOnline()) {
      goOffline();
      return;
    }
    failures += 1;
    const delay = backoffDelay(failures);
    reconnectTimer = clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    setStatus({ kind: 'reconnecting', attempt: failures, retryInMs: delay });
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
    const s = makeSocket(url);
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
      everOpened || failures > 0 ? { kind: 'reconnecting', attempt: failures, retryInMs: null } : { kind: 'connecting' },
    );
  }

  function reportError(err: unknown): void {
    const error = err instanceof Error ? err : new ProtocolError('frame: could not be decoded');
    for (const fn of [...errorListeners]) fn(error);
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

    if (frame.t === 'welcome') {
      if (frame.seat !== seat) {
        reportError(new ProtocolError('welcome.seat: must be this phone\'s seat'));
        return;
      }
      handshakeTimer = clearTimer(handshakeTimer);
      failures = 0;
      everOpened = true;
      setStatus({ kind: 'open' });
    } else if (frame.t === 'state') {
      if (frame.envelope.state.viewer !== seat) {
        reportError(new ProtocolError('state.envelope.state.viewer: must be this phone\'s seat'));
        return;
      }
      lastSeq = frame.envelope.seq;
    } else if (frame.t === 'error' && isTerminalErrorCode(frame.code)) {
      finish({ kind: 'closed-by-server', code: frame.code });
    }
    for (const fn of [...frameListeners]) fn(frame);
  }

  function finish(final: ConnectionStatus): void {
    discardSocket();
    reconnectTimer = clearTimer(reconnectTimer);
    for (const remove of removeEnvListeners) remove();
    removeEnvListeners = [];
    setStatus(final);
  }

  /** Retry now instead of waiting out the backoff; optionally reset it. */
  function retryNow(resetBackoff: boolean): void {
    if (resetBackoff) failures = 0;
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
    if (!isFinal()) goOffline();
  }

  return {
    get status() {
      return status;
    },
    subscribe(fn) {
      statusListeners.add(fn);
      fn(status);
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
