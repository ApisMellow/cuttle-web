// Two-phone W11 (docs/two-phone-plan.md §3, §9): create and join over HTTP.
// The token comes back in the reply body only; it is never in a URL and
// never in an error message.
import { describe, expect, it, vi } from 'vitest';

import { OnlineHttpError, createRoom, joinRoom, normalizeRoomCode } from '../../src/lib/online/http';
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

describe('normalizeRoomCode', () => {
  it('upper-cases, trims and folds the Crockford look-alikes like the server', () => {
    expect(normalizeRoomCode(' k7qx ')).toBe('K7QX');
    expect(normalizeRoomCode('O1LI')).toBe('0111');
    expect(normalizeRoomCode('U7QX')).toBeNull(); // U is outside the alphabet
    expect(normalizeRoomCode('K7Q')).toBeNull();
  });
});
