// Two-phone W11 (docs/two-phone-plan.md §3, §9): create and join a room over
// HTTP. The seat token comes back in the reply body, once; it is never put
// in a URL and never in an error message.

import type { PlayerId } from '../bridge/schema';

/** What create and join hand back. Save it with seat.ts; never log it. */
export interface SeatGrant {
  code: string;
  seat: PlayerId;
  token: string;
}

/**
 * `code` is the server's error code when it sent one (ROOM_FULL, ROOM_GONE,
 * RATE_LIMITED, ...), else one derived from the HTTP status, or NETWORK /
 * BAD_RESPONSE / BAD_REQUEST from the client side. `status` is null when no
 * HTTP response arrived.
 */
export class OnlineHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'OnlineHttpError';
  }
}

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
}

/** Same alphabet and folding as the server's store.NormalizeCode. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 4;

/** The canonical room code, or null if the input can't be one. */
export function normalizeRoomCode(input: string): string | null {
  const s = input.trim().toUpperCase();
  if (s.length !== CODE_LENGTH) return null;
  let out = '';
  for (let c of s) {
    if (c === 'O') c = '0';
    else if (c === 'I' || c === 'L') c = '1';
    if (!CODE_ALPHABET.includes(c)) return null;
    out += c;
  }
  return out;
}

/** base64url, at least 16 characters (the server sends 32 bytes: 43). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,}$/;

function statusCode(status: number): string {
  if (status === 404 || status === 410) return 'ROOM_GONE';
  if (status === 409) return 'ROOM_FULL';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 426) return 'UPGRADE_REQUIRED';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'INTERNAL';
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function post(origin: string, path: string, body: unknown, opts: HttpOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new OnlineHttpError('NETWORK', 'Could not reach the game server.');
  }
  const data = await readJson(res);
  if (!res.ok) {
    const code =
      typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'string'
        ? (data as { code: string }).code
        : statusCode(res.status);
    const message =
      typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message
        : `The game server answered ${res.status}.`;
    throw new OnlineHttpError(code, message, res.status);
  }
  if (data === undefined) throw new OnlineHttpError('BAD_RESPONSE', 'The game server sent a reply that is not JSON.', res.status);
  return data;
}

/** Checks a create/join reply. Messages name the field, never its value. */
function grantFrom(data: unknown, expectedSeat: PlayerId, expectedCode: string | null): SeatGrant {
  const bad = (field: string): never => {
    throw new OnlineHttpError('BAD_RESPONSE', `The game server's reply has a bad ${field}.`);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) bad('body');
  const r = data as Record<string, unknown>;
  const code = typeof r.code === 'string' ? normalizeRoomCode(r.code) : null;
  if (code === null || (expectedCode !== null && code !== expectedCode)) bad('code');
  if (r.seat !== expectedSeat) bad('seat');
  if (typeof r.token !== 'string' || !TOKEN_SHAPE.test(r.token)) bad('token');
  return { code: code as string, seat: expectedSeat, token: r.token as string };
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new OnlineHttpError('BAD_REQUEST', 'Enter a name first.');
  return trimmed;
}

/** POST /api/rooms: makes a room and takes seat 0. */
export async function createRoom(origin: string, name: string, opts: HttpOptions = {}): Promise<SeatGrant> {
  const body = { name: cleanName(name) };
  return grantFrom(await post(origin, '/api/rooms', body, opts), 0, null);
}

/** POST /api/rooms/{code}/join: takes seat 1 of an open room. */
export async function joinRoom(origin: string, code: string, name: string, opts: HttpOptions = {}): Promise<SeatGrant> {
  const normalized = normalizeRoomCode(code);
  if (normalized === null) throw new OnlineHttpError('BAD_REQUEST', 'That code is not a game code.');
  const body = { name: cleanName(name) };
  return grantFrom(await post(origin, `/api/rooms/${normalized}/join`, body, opts), 1, normalized);
}
