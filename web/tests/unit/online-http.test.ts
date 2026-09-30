// Two-phone W11 (docs/two-phone-plan.md §3, §9): create and join over HTTP.
// The token comes back in the reply body only; it is never in a URL and
// never in an error message.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_TIMEOUT_MS, OnlineHttpError, createRoom, joinRoom } from '../../src/lib/online/http';
import { ORIGIN, TOKEN } from './online-fakes';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

async function caught(p: Promise<unknown>): Promise<OnlineHttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OnlineHttpError);
    return err as OnlineHttpError;
  }
  throw new Error('expected the call to reject');
}

describe('createRoom', () => {
  it('POSTs {name} to /api/rooms and returns code, seat 0 and token', async () => {
    const f = fakeFetch(() => jsonResponse(200, { code: 'K7QX', seat: 0, token: TOKEN }));
    await expect(createRoom(ORIGIN, '  Alice ', { fetch: f.fetch })).resolves.toEqual({ code: 'K7QX', seat: 0, token: TOKEN });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://cuttle.example.com/api/rooms');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Alice' });
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts 201 Created, which the server sends for a new room', async () => {
    const f = fakeFetch(() => jsonResponse(201, { code: 'K7QX', seat: 0, token: TOKEN }));
    await expect(createRoom(ORIGIN, 'Alice', { fetch: f.fetch })).resolves.toEqual({ code: 'K7QX', seat: 0, token: TOKEN });
  });

  it('maps 503 SERVER_FULL, with or without a code, and reads Retry-After', async () => {
    const withCode = fakeFetch(
      () =>
        new Response(JSON.stringify({ code: 'SERVER_FULL', message: 'Too many games right now.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
        }),
    );
    const a = await caught(createRoom(ORIGIN, 'Alice', { fetch: withCode.fetch }));
    expect(a.code).toBe('SERVER_FULL');
    expect(a.status).toBe(503);
    expect(a.retryAfterMs).toBe(30_000);

    const bare = fakeFetch(() => new Response('busy', { status: 503 }));
    const b = await caught(createRoom(ORIGIN, 'Alice', { fetch: bare.fetch }));
    expect(b.code).toBe('SERVER_FULL');
    expect(b.retryAfterMs).toBeNull();
  });

  it('keeps FORBIDDEN from an origin rejection body', async () => {
    const f = fakeFetch(() => jsonResponse(403, { code: 'FORBIDDEN' }));
    const err = await caught(createRoom(ORIGIN, 'Alice', { fetch: f.fetch }));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
  });

  it('refuses an empty name without calling the server', async () => {
    const f = fakeFetch(() => jsonResponse(200, {}));
    const err = await caught(createRoom(ORIGIN, '   ', { fetch: f.fetch }));
    expect(err.code).toBe('BAD_REQUEST');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a reply with the wrong seat, a missing token or a bad code', async () => {
    for (const body of [
      { code: 'K7QX', seat: 1, token: TOKEN },
      { code: 'K7QX', seat: 0 },
      { code: 'K7QX', seat: 0, token: '' },
      { code: 'K7QX', seat: 0, token: 'has spaces in it and is long' },
      { code: 'NOPE!', seat: 0, token: TOKEN },
      'not an object',
    ]) {
      const f = fakeFetch(() => jsonResponse(200, body));
      const err = await caught(createRoom(ORIGIN, 'Alice', { fetch: f.fetch }));
      expect(err.code).toBe('BAD_RESPONSE');
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it('rejects a reply that is not JSON', async () => {
    const f = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await caught(createRoom(ORIGIN, 'Alice', { fetch: f.fetch }))).code).toBe('BAD_RESPONSE');
  });
});

describe('joinRoom', () => {
  it('POSTs {name} to /api/rooms/{code}/join and returns seat 1', async () => {
    const f = fakeFetch(() => jsonResponse(200, { code: 'K7QX', seat: 1, token: TOKEN }));
    await expect(joinRoom(ORIGIN, 'k7qx', 'Blake', { fetch: f.fetch })).resolves.toEqual({ code: 'K7QX', seat: 1, token: TOKEN });
    expect(f.calls[0].url).toBe('https://cuttle.example.com/api/rooms/K7QX/join');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ name: 'Blake' });
    expect(f.calls[0].init.method).toBe('POST');
  });

  it('refuses an invalid code without calling the server', async () => {
    const f = fakeFetch(() => jsonResponse(200, {}));
    for (const bad of ['', 'K7Q', 'K7QXX', 'K7Q!', '../x']) {
      const err = await caught(joinRoom(ORIGIN, bad, 'Blake', { fetch: f.fetch }));
      expect(err.code).toBe('BAD_REQUEST');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a reply for a different room', async () => {
    const f = fakeFetch(() => jsonResponse(200, { code: 'Z9W2', seat: 1, token: TOKEN }));
    expect((await caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch }))).code).toBe('BAD_RESPONSE');
  });

  it('maps a server error body to its code', async () => {
    const f = fakeFetch(() => jsonResponse(409, { code: 'ROOM_FULL', message: 'That game already has two players.' }));
    const err = await caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch }));
    expect(err.code).toBe('ROOM_FULL');
    expect(err.status).toBe(409);
  });

  it('falls back to the HTTP status when the error body has no code', async () => {
    const cases: Array<[number, string]> = [
      [404, 'ROOM_GONE'],
      [409, 'ROOM_FULL'],
      [429, 'RATE_LIMITED'],
      [400, 'BAD_REQUEST'],
      [403, 'FORBIDDEN'],
      [500, 'INTERNAL'],
      [502, 'INTERNAL'],
      [503, 'SERVER_FULL'],
    ];
    for (const [status, code] of cases) {
      const f = fakeFetch(() => new Response('oops', { status }));
      const err = await caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch }));
      expect(err.code, String(status)).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  it('reports a network failure as NETWORK', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch }));
    expect(err.code).toBe('NETWORK');
    expect(err.status).toBeNull();
  });
});

describe('room codes', () => {
  it('sends the normalized code in the join path (code.ts is the one implementation)', async () => {
    const f = fakeFetch(() => jsonResponse(200, { code: 'o1li', seat: 1, token: TOKEN }));
    await expect(joinRoom(ORIGIN, ' oili ', 'Blake', { fetch: f.fetch })).resolves.toMatchObject({ code: '0111' });
    expect(f.calls[0].url).toBe('https://cuttle.example.com/api/rooms/0111/join');
  });
});

describe('timeouts and aborts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never settles and ignores its signal. */
  function hangingFetch() {
    const calls: RequestInit[] = [];
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Promise<Response>(() => {});
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
  }

  it(`gives up after ${HTTP_TIMEOUT_MS / 1000} s with TIMEOUT and aborts the request`, async () => {
    vi.useFakeTimers();
    expect(HTTP_TIMEOUT_MS).toBe(10_000);
    const f = hangingFetch();
    let settled = false;
    const p = caught(createRoom(ORIGIN, 'Alice', { fetch: f.fetch })).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err.code).toBe('TIMEOUT');
    expect(err.status).toBeNull();
    expect(f.calls[0].signal?.aborted).toBe(true);
  });

  it('times out a reply whose body never finishes', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream({ start() {} }); // never closes
    const f = fakeFetch(() => new Response(body, { status: 200 }));
    const p = caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch }));
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    expect((await p).code).toBe('TIMEOUT');
  });

  it("honours the caller's signal as ABORTED", async () => {
    vi.useFakeTimers();
    const f = hangingFetch();
    const ctl = new AbortController();
    const p = caught(joinRoom(ORIGIN, 'K7QX', 'Blake', { fetch: f.fetch, signal: ctl.signal }));
    ctl.abort();
    const err = await p;
    expect(err.code).toBe('ABORTED');
    expect(f.calls[0].signal?.aborted).toBe(true);
  });

  it('refuses at once with an already-aborted caller signal', async () => {
    const f = hangingFetch();
    const ctl = new AbortController();
    ctl.abort();
    const err = await caught(createRoom(ORIGIN, 'Alice', { fetch: f.fetch, signal: ctl.signal }));
    expect(err.code).toBe('ABORTED');
  });

  it('clears its timer once the reply arrives', async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => jsonResponse(200, { code: 'K7QX', seat: 0, token: TOKEN }));
    await expect(createRoom(ORIGIN, 'Alice', { fetch: f.fetch })).resolves.toMatchObject({ seat: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
