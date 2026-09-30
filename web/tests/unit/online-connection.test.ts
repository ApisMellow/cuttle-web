// Two-phone W11 (docs/two-phone-plan.md §3, §8, §9): the client's WebSocket
// connection. Hello first and the token only there; typed frames; schema
// validation of state; reconnect with capped, jittered backoff; immediate
// retry on visible/online; ping timeouts for the silently dead iOS socket;
// terminal server errors stop everything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKOFF_MS,
  HANDSHAKE_TIMEOUT_MS,
  JITTER_RATIO,
  MAX_FAILED_ATTEMPTS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  RATE_LIMIT_FLOOR_MS,
  createConnection,
  type ConnectionOptions,
  type ConnectionStatus,
} from '../../src/lib/online/connection';
import type { ServerFrame } from '../../src/lib/online/protocol';
import {
  CODE,
  FakeEnvironment,
  ORIGIN,
  TOKEN,
  WS_URL,
  socketFactory,
  stateFrame,
  welcomeFrame,
  type FakeSocket,
} from './online-fakes';

function harness(overrides: Partial<ConnectionOptions> = {}) {
  const sockets = socketFactory();
  const env = new FakeEnvironment();
  const statuses: ConnectionStatus[] = [];
  const frames: ServerFrame[] = [];
  const protocolErrors: Error[] = [];
  const conn = createConnection({
    serverOrigin: ORIGIN,
    code: CODE,
    seat: 0,
    token: TOKEN,
    socketFactory: sockets.factory,
    environment: env,
    random: () => 0.5, // no jitter unless a test says so
    ...overrides,
  });
  conn.subscribe((s) => statuses.push(s));
  conn.onFrame((f) => frames.push(f));
  conn.onProtocolError((e) => protocolErrors.push(e));
  return { conn, sockets, env, statuses, frames, protocolErrors };
}

/** Open the latest socket and complete the handshake. */
function handshake(s: FakeSocket, opts: { seq?: number } = {}) {
  s.serverOpen();
  s.serverSend(welcomeFrame(0));
  s.serverSend(stateFrame({ seq: opts.seq ?? 0 }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handshake', () => {
  it('connects to /api/play with no token in the URL and sends hello first', () => {
    const h = harness({ lastSeq: 4 });
    expect(h.conn.status).toEqual({ kind: 'idle' });
    h.conn.start();
    expect(h.conn.status).toEqual({ kind: 'connecting' });
    expect(h.sockets.sockets).toHaveLength(1);
    const s = h.sockets.last;
    expect(s.url).toBe(WS_URL);
    expect(s.url).not.toContain(TOKEN);
    expect(s.url).not.toContain('?');
    expect(s.url).not.toContain('#');

    s.serverOpen();
    expect(s.frames()).toEqual([{ t: 'hello', v: 1, code: CODE, token: TOKEN, lastSeq: 4 }]);
    // Still connecting until the server welcomes us.
    expect(h.conn.status).toEqual({ kind: 'connecting' });
    s.serverSend(welcomeFrame(0));
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('sends the token only in hello, never in any other frame', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last);
    h.conn.sendMove(1, 0, 2);
    h.conn.sendRematch(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    const withToken = h.sockets.last.sent.filter((f) => f.includes(TOKEN));
    expect(withToken).toHaveLength(1);
    expect(JSON.parse(withToken[0]).t).toBe('hello');
    expect(h.sockets.last.sent[0]).toBe(withToken[0]);
  });

  it('refuses to send a move or rematch before welcome', () => {
    const h = harness();
    h.conn.start();
    expect(h.conn.sendMove(1, 0, 0)).toBe(false);
    h.sockets.last.serverOpen();
    expect(h.conn.sendMove(1, 0, 0)).toBe(false);
    expect(h.conn.sendRematch(1)).toBe(false);
    expect(h.sockets.last.frames().map((f) => f.t)).toEqual(['hello']);
    h.sockets.last.serverSend(welcomeFrame(0));
    expect(h.conn.sendMove(1, 0, 0)).toBe(true);
  });

  it('start is idempotent', () => {
    const h = harness();
    h.conn.start();
    h.conn.start();
    expect(h.sockets.sockets).toHaveLength(1);
  });

  it('reports status to a new subscriber at once', () => {
    const h = harness();
    const seen: ConnectionStatus[] = [];
    h.conn.subscribe((s) => seen.push(s));
    expect(seen).toEqual([{ kind: 'idle' }]);
  });
});

describe('frames', () => {
  it('round-trips move and rematch, and delivers every server frame type', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s, { seq: 2 });
    expect(h.conn.sendMove(1, 2, 5)).toBe(true);
    expect(h.conn.sendRematch(1)).toBe(true);
    expect(s.frames().slice(1)).toEqual([
      { t: 'move', game: 1, seq: 2, index: 5 },
      { t: 'rematch', game: 1 },
    ]);

    s.serverSend({ t: 'responding', by: 1 });
    s.serverSend({ t: 'presence', opponentOnline: false });
    s.serverSend({ t: 'rematch', requestedBy: 1 });
    s.serverSend({ t: 'error', code: 'STALE', message: 'old seq', seq: 1 });
    expect(h.frames.map((f) => f.t)).toEqual(['welcome', 'state', 'responding', 'presence', 'rematch', 'error']);
    const state = h.frames[1];
    expect(state.t === 'state' && state.envelope.seq).toBe(2);
    // A non-terminal error keeps the connection open.
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(h.protocolErrors).toEqual([]);
  });

  it('rejects a malformed state through schema.ts and does not deliver it', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend(welcomeFrame(0));
    const bad = stateFrame({ seq: 1 }) as unknown as { envelope: { state: Record<string, unknown> } };
    bad.envelope.state.deck = [{ Rank: 13, Suit: 3 }];
    s.serverSend(bad);
    expect(h.frames.map((f) => f.t)).toEqual(['welcome']);
    expect(h.protocolErrors).toHaveLength(1);
    expect(h.protocolErrors[0].name).toBe('SchemaError');
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it("treats a state addressed to the other seat's viewer as terminal SEAT_MISMATCH", () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend(welcomeFrame(0));
    s.serverSend(stateFrame({ viewer: 1 }));
    expect(h.frames.map((f) => f.t)).toEqual(['welcome']);
    expect(h.protocolErrors).toHaveLength(1);
    expect(h.conn.status).toEqual({ kind: 'closed-by-server', code: 'SEAT_MISMATCH' });
    expect(s.closedWith).not.toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets.sockets).toHaveLength(1);
  });

  it('drops state and non-terminal error frames that arrive before welcome', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend(stateFrame({ seq: 3 }));
    s.serverSend({ t: 'error', code: 'STALE', message: 'x' });
    expect(h.frames).toEqual([]);
    expect(h.conn.status).toEqual({ kind: 'connecting' });
    s.serverSend(welcomeFrame(0));
    s.serverSend(stateFrame({ seq: 1 }));
    expect(h.frames.map((f) => f.t)).toEqual(['welcome', 'state']);
    // The pre-welcome state did not move lastSeq.
    s.serverClose();
    vi.advanceTimersByTime(500);
    h.sockets.last.serverOpen();
    expect(h.sockets.last.frames()[0]).toMatchObject({ t: 'hello', lastSeq: 1 });
  });

  it('still closes on a terminal error that arrives before welcome', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend({ t: 'error', code: 'UNAUTHORIZED', message: 'no' });
    expect(h.conn.status).toEqual({ kind: 'closed-by-server', code: 'UNAUTHORIZED' });
    expect(h.frames.map((f) => f.t)).toEqual(['error']);
  });

  it('treats a welcome for a different seat as terminal SEAT_MISMATCH', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend(welcomeFrame(1));
    expect(h.conn.status).toEqual({ kind: 'closed-by-server', code: 'SEAT_MISMATCH' });
    expect(s.closedWith).not.toBeNull();
    expect(h.frames).toEqual([]);
    expect(h.protocolErrors).toHaveLength(1);
    // No reconnect loop: nothing retries, whatever the page does.
    vi.advanceTimersByTime(10 * 60_000);
    h.env.show();
    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.env.listenerCount()).toBe(0);
  });

  it('ignores unknown frame types and binary data safely', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    s.serverSend({ t: 'fireworks', n: 3 });
    s.onmessage?.({ data: new ArrayBuffer(4) });
    expect(h.frames.map((f) => f.t)).toEqual(['welcome', 'state']);
    expect(h.protocolErrors).toEqual([]);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('reports non-JSON text as a protocol error and stays open', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last);
    h.sockets.last.serverSend('garbage{');
    expect(h.protocolErrors).toHaveLength(1);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('does not forward pong', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last);
    h.sockets.last.serverSend({ t: 'pong' });
    expect(h.frames.map((f) => f.t)).toEqual(['welcome', 'state']);
  });
});

describe('reconnect backoff', () => {
  it('retries at 0.5, 1, 2, 4, 8, 16, then every 30 seconds', () => {
    expect(BACKOFF_MS).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
    const h = harness();
    h.conn.start();
    const expected = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (const [i, delay] of expected.entries()) {
      h.sockets.last.serverClose();
      expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: i + 1, retryInMs: delay });
      const before = h.sockets.sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(h.sockets.sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(h.sockets.sockets).toHaveLength(before + 1);
      expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: i + 1, retryInMs: null });
    }
  });

  it(`adds ±${JITTER_RATIO * 100}% jitter`, () => {
    const low = harness({ random: () => 0 });
    low.conn.start();
    low.sockets.last.serverClose();
    expect(low.conn.status).toMatchObject({ retryInMs: 400 });

    const high = harness({ random: () => 0.999999 });
    high.conn.start();
    for (let i = 0; i < 8; i++) {
      high.sockets.last.serverClose();
      vi.runOnlyPendingTimers();
    }
    high.sockets.last.serverClose();
    // The cap holds with jitter: 30 s + 20% at most.
    const s = high.conn.status as { retryInMs: number };
    expect(s.retryInMs).toBeGreaterThan(35_900);
    expect(s.retryInMs).toBeLessThanOrEqual(36_000);
  });

  it('treats a socket error the same as a close, once', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.onerror?.({});
    s.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    vi.advanceTimersByTime(500);
    expect(h.sockets.sockets).toHaveLength(2);
  });

  it('gives up on a handshake that never completes', () => {
    const h = harness();
    h.conn.start();
    h.sockets.last.serverOpen(); // opened, but no welcome ever arrives
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1);
    expect(h.conn.status).toEqual({ kind: 'connecting' });
    vi.advanceTimersByTime(1);
    expect(h.sockets.sockets[0].closedWith).not.toBeNull();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
  });
});

describe('socket factory that throws', () => {
  it('does not throw out of start(); it schedules a retry instead', () => {
    let calls = 0;
    const sockets = socketFactory();
    const h = harness({
      socketFactory: (url) => {
        calls += 1;
        if (calls === 1) throw new DOMException('blocked', 'SecurityError');
        return sockets.factory(url);
      },
    });
    expect(() => h.conn.start()).not.toThrow();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    vi.advanceTimersByTime(500);
    expect(sockets.sockets).toHaveLength(1);
    sockets.last.serverOpen();
    sockets.last.serverSend(welcomeFrame(0));
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('treats a throw from a reconnect timer as a drop and keeps backing off', () => {
    let fail = false;
    const sockets = socketFactory();
    const h = harness({
      socketFactory: (url) => {
        if (fail) throw new SyntaxError('bad url');
        return sockets.factory(url);
      },
    });
    h.conn.start();
    handshake(sockets.last);
    fail = true;
    sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 2, retryInMs: 1000 });
    fail = false;
    vi.advanceTimersByTime(1000);
    expect(sockets.sockets).toHaveLength(2);
    handshake(sockets.last);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });
});

describe('rate limiting and stalling', () => {
  function rateLimited(h: ReturnType<typeof harness>) {
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend({ t: 'error', code: 'RATE_LIMITED', message: 'slow down' });
    s.serverClose(1008);
  }

  it(`waits at least ${RATE_LIMIT_FLOOR_MS / 1000} s after RATE_LIMITED, even on online or visible`, () => {
    const h = harness();
    h.conn.start();
    rateLimited(h);
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: RATE_LIMIT_FLOOR_MS });
    h.env.goOnline();
    h.env.hide();
    h.env.show();
    vi.advanceTimersByTime(RATE_LIMIT_FLOOR_MS - 1);
    expect(h.sockets.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets.sockets).toHaveLength(2);
  });

  it('holds the floor across offline and back online', () => {
    const h = harness();
    h.conn.start();
    rateLimited(h);
    h.env.goOffline();
    vi.advanceTimersByTime(1000);
    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.status).toMatchObject({ kind: 'reconnecting', retryInMs: RATE_LIMIT_FLOOR_MS - 1000 });
    vi.advanceTimersByTime(RATE_LIMIT_FLOOR_MS - 1001);
    expect(h.sockets.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets.sockets).toHaveLength(2);
  });

  it('lets online and visible retry at once again after the floor has passed', () => {
    const h = harness();
    h.conn.start();
    rateLimited(h);
    vi.advanceTimersByTime(RATE_LIMIT_FLOOR_MS);
    h.sockets.last.serverClose();
    const before = h.sockets.sockets.length;
    h.env.show();
    expect(h.sockets.sockets).toHaveLength(before + 1);
  });

  it(`stalls after ${MAX_FAILED_ATTEMPTS} failed attempts without a welcome`, () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(10);
    const h = harness();
    h.conn.start();
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      h.sockets.last.serverClose();
      expect(h.conn.status).toMatchObject({ kind: 'reconnecting', attempt: i });
      vi.runOnlyPendingTimers();
    }
    expect(h.sockets.sockets).toHaveLength(MAX_FAILED_ATTEMPTS);
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'stalled', attempt: MAX_FAILED_ATTEMPTS });
    vi.advanceTimersByTime(10 * 60_000);
    h.env.show();
    h.env.goOnline();
    h.env.goOffline();
    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(MAX_FAILED_ATTEMPTS);
    expect(h.conn.status).toEqual({ kind: 'stalled', attempt: MAX_FAILED_ATTEMPTS });
  });

  it('retry() restarts from a clean backoff', () => {
    const h = harness();
    h.conn.start();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      h.sockets.last.serverClose();
      vi.runOnlyPendingTimers();
    }
    expect(h.conn.status.kind).toBe('stalled');
    const before = h.sockets.sockets.length;
    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(before + 1);
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 0, retryInMs: null });
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    vi.advanceTimersByTime(500);
    handshake(h.sockets.last);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('retry() does nothing while open, idle or closed', () => {
    const h = harness();
    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(0);
    h.conn.start();
    handshake(h.sockets.last);
    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(1);
    h.conn.close();
    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.status).toEqual({ kind: 'closed' });
  });

  it('a welcome clears the failure count so stalling needs a fresh run', () => {
    const h = harness();
    h.conn.start();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      h.sockets.last.serverClose();
      vi.runOnlyPendingTimers();
    }
    handshake(h.sockets.last);
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
  });
});

describe('lastSeq', () => {
  function helloSeqAfterDrop(h: ReturnType<typeof harness>): unknown {
    h.sockets.last.serverClose();
    vi.runOnlyPendingTimers();
    h.sockets.last.serverOpen();
    return h.sockets.last.frames()[0].lastSeq;
  }

  it('never goes backwards within a game', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last, { seq: 5 });
    h.sockets.last.serverSend(stateFrame({ seq: 3 }));
    expect(helloSeqAfterDrop(h)).toBe(5);
  });

  it('resets when a new game starts', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last, { seq: 9 });
    h.sockets.last.serverSend(stateFrame({ seq: 0, game: 2 }));
    expect(helloSeqAfterDrop(h)).toBe(0);
    h.sockets.last.serverSend(welcomeFrame(0));
    // A late frame from the old game does not move it.
    h.sockets.last.serverSend(stateFrame({ seq: 9, game: 1 }));
    expect(helloSeqAfterDrop(h)).toBe(0);
  });

  it('holds lastSeq from options against a lower seq in the same known game', () => {
    const h = harness({ lastSeq: 7, lastGame: 1 });
    h.conn.start();
    handshake(h.sockets.last, { seq: 4 });
    expect(helloSeqAfterDrop(h)).toBe(7);
  });
});

describe('listener isolation', () => {
  it('a throwing frame listener does not stop the others, and is reported without frame contents', () => {
    const h = harness();
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const seen: string[] = [];
    h.conn.onFrame(() => {
      throw new Error(`boom ${TOKEN} Alice`);
    });
    h.conn.onFrame((f) => seen.push(f.t));
    h.conn.start();
    handshake(h.sockets.last);
    expect(seen).toEqual(['welcome', 'state']);
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(h.protocolErrors.length).toBe(2);
    for (const e of h.protocolErrors) {
      expect(`${e.message} ${e.stack}`).not.toContain(TOKEN);
      expect(`${e.message} ${e.stack}`).not.toContain('Alice');
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('a throwing status or error listener does not stop the others or the connection', () => {
    const h = harness();
    const seen: string[] = [];
    h.conn.subscribe(() => {
      throw new Error('status boom');
    });
    h.conn.subscribe((s) => seen.push(s.kind));
    h.conn.onProtocolError(() => {
      throw new Error('error boom');
    });
    const errors: Error[] = [];
    h.conn.onProtocolError((e) => errors.push(e));
    expect(() => h.conn.start()).not.toThrow();
    expect(() => handshake(h.sockets.last)).not.toThrow();
    expect(() => h.sockets.last.serverSend('garbage{')).not.toThrow();
    expect(seen).toEqual(['idle', 'connecting', 'open']);
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(errors.some((e) => e.name === 'ProtocolError')).toBe(true);
  });
});

describe('replaced by a newer hello (SPEC §2.12)', () => {
  it('stops reconnecting on REPLACED, keeps the seat, and retry() resumes', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    s.serverSend({ t: 'error', code: 'REPLACED', message: 'Playing on another device.' });
    expect(h.conn.status).toEqual({ kind: 'replaced' });
    expect(s.closedWith).not.toBeNull();
    // Delivered, so the UI can say why; not closed-by-server, so W12 keeps the seat.
    expect(h.frames.at(-1)).toMatchObject({ t: 'error', code: 'REPLACED' });
    s.serverClose(1000);
    vi.advanceTimersByTime(10 * 60_000);
    h.env.hide();
    h.env.show();
    h.env.goOffline();
    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.status).toEqual({ kind: 'replaced' });
    expect(h.conn.sendMove(1, 0, 0)).toBe(false);

    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(2);
    h.sockets.last.serverOpen();
    expect(h.sockets.last.frames()[0]).toMatchObject({ t: 'hello', token: TOKEN });
    h.sockets.last.serverSend(welcomeFrame(0));
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('honours REPLACED even before welcome', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend({ t: 'error', code: 'REPLACED', message: 'x' });
    expect(h.conn.status).toEqual({ kind: 'replaced' });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets.sockets).toHaveLength(1);
  });

  it('close() still ends a replaced connection for good', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last);
    h.sockets.last.serverSend({ t: 'error', code: 'REPLACED', message: 'x' });
    h.conn.close();
    expect(h.conn.status).toEqual({ kind: 'closed' });
    expect(h.env.listenerCount()).toBe(0);
    h.conn.retry();
    expect(h.sockets.sockets).toHaveLength(1);
  });
});

describe('waiting room (SPEC §2.12)', () => {
  it('stays open on a welcome with no state, then takes a second welcome and the first state', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    s.serverOpen();
    s.serverSend({ t: 'welcome', seat: 0, names: ['Alice', null], status: 'waiting' });
    expect(h.conn.status).toEqual({ kind: 'open' });
    // Well past the handshake deadline, with the heartbeat answered.
    expect(PING_INTERVAL_MS).toBeGreaterThan(HANDSHAKE_TIMEOUT_MS);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    s.serverSend({ t: 'pong' });
    expect(h.conn.status).toEqual({ kind: 'open' });

    s.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    s.serverSend(stateFrame({ seq: 0 }));
    expect(h.protocolErrors).toEqual([]);
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(h.statuses.filter((st) => st.kind === 'open')).toHaveLength(1);
    expect(h.frames.map((f) => f.t)).toEqual(['welcome', 'welcome', 'state']);
    const second = h.frames[1];
    expect(second.t === 'welcome' && second.names).toEqual(['Alice', 'Blake']);
    expect(h.sockets.sockets).toHaveLength(1);
  });
});

describe('resume after a drop', () => {
  it('reconnects, says hello with the stored token and last seq, and resets the backoff', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last, { seq: 5 });
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    expect(h.conn.sendMove(1, 5, 0)).toBe(false);
    vi.advanceTimersByTime(500);
    const s2 = h.sockets.last;
    expect(h.sockets.sockets).toHaveLength(2);
    expect(s2.url).toBe(WS_URL);
    s2.serverOpen();
    expect(s2.frames()[0]).toEqual({ t: 'hello', v: 1, code: CODE, token: TOKEN, lastSeq: 5 });
    s2.serverSend(welcomeFrame(0));
    expect(h.conn.status).toEqual({ kind: 'open' });
    s2.serverSend(stateFrame({ seq: 6 }));

    // Backoff starts over after a successful resume.
    s2.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
    vi.advanceTimersByTime(500);
    h.sockets.last.serverOpen();
    expect(h.sockets.last.frames()[0]).toMatchObject({ t: 'hello', lastSeq: 6 });
  });

  it('ignores late events from a replaced socket', () => {
    const h = harness();
    h.conn.start();
    const old = h.sockets.last;
    handshake(old);
    old.serverClose();
    vi.advanceTimersByTime(500);
    handshake(h.sockets.last);
    const count = h.frames.length;
    old.serverSend({ t: 'presence', opponentOnline: false });
    old.serverClose();
    old.onerror?.({});
    expect(h.frames).toHaveLength(count);
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(h.sockets.sockets).toHaveLength(2);
  });
});

describe('terminal server errors', () => {
  for (const code of ['ROOM_GONE', 'UNAUTHORIZED', 'UPGRADE_REQUIRED'] as const) {
    it(`${code} closes for good`, () => {
      const h = harness();
      h.conn.start();
      const s = h.sockets.last;
      s.serverOpen();
      s.serverSend({ t: 'error', code, message: 'no' });
      expect(h.conn.status).toEqual({ kind: 'closed-by-server', code });
      expect(s.closedWith).not.toBeNull();
      expect(h.frames.map((f) => f.t)).toEqual(['error']);
      s.serverClose(1008);
      vi.advanceTimersByTime(10 * 60_000);
      h.env.show();
      h.env.goOffline();
      h.env.goOnline();
      h.conn.start();
      expect(h.sockets.sockets).toHaveLength(1);
      expect(h.conn.status).toEqual({ kind: 'closed-by-server', code });
      expect(h.env.listenerCount()).toBe(0);
    });
  }
});

describe('visibility', () => {
  it('reconnects at once when the page becomes visible during a backoff wait', () => {
    const h = harness();
    h.conn.start();
    for (let i = 0; i < 5; i++) {
      h.sockets.last.serverClose();
      vi.runOnlyPendingTimers();
    }
    h.sockets.last.serverClose();
    expect(h.conn.status).toMatchObject({ kind: 'reconnecting', retryInMs: 16000 });
    const before = h.sockets.sockets.length;
    h.env.hide();
    expect(h.sockets.sockets).toHaveLength(before);
    h.env.show();
    expect(h.sockets.sockets).toHaveLength(before + 1);
    // The cancelled backoff timer does not fire a second socket.
    vi.advanceTimersByTime(16000);
    expect(h.sockets.sockets).toHaveLength(before + 1);
  });

  it('probes an open socket on visible and reconnects if it is silently dead', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    h.env.hide();
    h.env.show();
    expect(s.frames().at(-1)).toEqual({ t: 'ping' });
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS - 1);
    expect(h.conn.status).toEqual({ kind: 'open' });
    vi.advanceTimersByTime(1);
    expect(s.closedWith).not.toBeNull();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
  });

  it('keeps a live socket open when the probe is answered', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    h.env.show();
    s.serverSend({ t: 'pong' });
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS * 2);
    expect(h.conn.status).toEqual({ kind: 'open' });
    expect(h.sockets.sockets).toHaveLength(1);
  });
});

describe('heartbeat', () => {
  it('pings on an interval and drops a socket that stops answering', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(s.frames().at(-1)).toEqual({ t: 'ping' });
    s.serverSend({ t: 'pong' });
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(s.frames().filter((f) => f.t === 'ping')).toHaveLength(2);
    // No answer to the second ping: the socket is dead (iOS background).
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1);
    expect(h.conn.status).toEqual({ kind: 'open' });
    vi.advanceTimersByTime(1);
    expect(s.closedWith).not.toBeNull();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
  });

  it('counts any inbound frame as a sign of life', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    s.serverSend({ t: 'presence', opponentOnline: true });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('stops pinging a closed socket', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    s.serverClose();
    const sent = s.sent.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(s.sent).toHaveLength(sent);
  });
});

describe('offline and online', () => {
  it('starts offline without a socket when the browser is offline', () => {
    const h = harness();
    h.env.online = false;
    h.conn.start();
    expect(h.conn.status).toEqual({ kind: 'offline' });
    expect(h.sockets.sockets).toHaveLength(0);
    h.env.goOnline();
    expect(h.conn.status).toEqual({ kind: 'connecting' });
    expect(h.sockets.sockets).toHaveLength(1);
  });

  it('goes offline on the offline event, closes the socket and stops retrying', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    h.env.goOffline();
    expect(h.conn.status).toEqual({ kind: 'offline' });
    expect(s.closedWith).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    h.env.show(); // visible while still offline: nothing to do
    expect(h.sockets.sockets).toHaveLength(1);

    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(2);
    // Coming back online starts a fresh backoff: attempt 0, in flight now.
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 0, retryInMs: null });
    handshake(h.sockets.last);
    expect(h.conn.status).toEqual({ kind: 'open' });
  });

  it('goes offline when a socket drops while the browser reports offline', () => {
    const h = harness();
    h.conn.start();
    handshake(h.sockets.last);
    h.env.online = false; // no event yet
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'offline' });
    vi.advanceTimersByTime(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
  });

  it('reconnects at once, with a fresh backoff, on online during a wait', () => {
    const h = harness();
    h.conn.start();
    for (let i = 0; i < 4; i++) {
      h.sockets.last.serverClose();
      vi.runOnlyPendingTimers();
    }
    h.sockets.last.serverClose();
    const before = h.sockets.sockets.length;
    h.env.goOnline();
    expect(h.sockets.sockets).toHaveLength(before + 1);
    h.sockets.last.serverClose();
    expect(h.conn.status).toEqual({ kind: 'reconnecting', attempt: 1, retryInMs: 500 });
  });
});

describe('close', () => {
  it('closes the socket, stops every timer and removes its listeners', () => {
    const h = harness();
    h.conn.start();
    const s = h.sockets.last;
    handshake(s);
    h.conn.close();
    expect(h.conn.status).toEqual({ kind: 'closed' });
    expect(s.closedWith).not.toBeNull();
    expect(h.env.listenerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(s.frames().filter((f) => f.t === 'ping')).toHaveLength(0);
    expect(h.conn.sendMove(1, 0, 0)).toBe(false);
  });

  it('unsubscribes listeners', () => {
    const h = harness();
    const seen: ConnectionStatus[] = [];
    const off = h.conn.subscribe((st) => seen.push(st));
    off();
    h.conn.start();
    expect(seen).toEqual([{ kind: 'idle' }]);
  });
});

describe('token hygiene', () => {
  it('never writes the token to the console, a status or an error', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const h = harness();
    h.conn.start();
    let s = h.sockets.last;
    handshake(s, { seq: 3 });
    s.serverSend('garbage{');
    s.serverSend({ t: 'error', code: 'STALE', message: 'x' });
    const bad = stateFrame() as unknown as { envelope: Record<string, unknown> };
    delete bad.envelope.history;
    s.serverSend(bad);
    vi.advanceTimersByTime(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(500);
    s = h.sockets.last;
    s.serverOpen();
    s.serverSend({ t: 'error', code: 'UNAUTHORIZED', message: 'who?' });

    for (const spy of spies) {
      for (const args of spy.mock.calls) {
        expect(args.map((a) => String(a instanceof Error ? a.stack : JSON.stringify(a))).join(' ')).not.toContain(TOKEN);
      }
    }
    expect(JSON.stringify(h.statuses)).not.toContain(TOKEN);
    expect(JSON.stringify(h.frames)).not.toContain(TOKEN);
    for (const e of h.protocolErrors) expect(`${e.message} ${e.stack}`).not.toContain(TOKEN);
    expect(JSON.stringify(h.conn)).not.toContain(TOKEN);
    expect(Object.values(h.conn).map(String).join(' ')).not.toContain(TOKEN);
  });
});
