// Two-phone W11 (docs/two-phone-plan.md §3, §9): create and join a room over
// HTTP. The seat token comes back in the reply body, once; it is never put
// in a URL and never in an error message.

import type { PlayerId } from '../bridge/schema';
import { parseRoomCode } from './code';

/** What create and join hand back. Save it with seat.ts; never log it. */
export interface SeatGrant {
  code: string;
  seat: PlayerId;
  token: string;
}

/** How long a create or join may take, reply body included. */
export const HTTP_TIMEOUT_MS = 10_000;

/**
 * `code` is the server's error code when it sent one (ROOM_FULL, ROOM_GONE,
 * RATE_LIMITED, SERVER_FULL, FORBIDDEN, ...), else one derived from the HTTP
 * status, or NETWORK / TIMEOUT / ABORTED / BAD_RESPONSE / BAD_REQUEST from
 * the client side. `status` is null when no HTTP response arrived.
 * `retryAfterMs` is the reply's Retry-After (whole seconds), if it sent one.
 */
export class OnlineHttpError extends Error {
  /**
   * May be the server's own text, so treat it as untrusted: render it as
   * text (Svelte `{message}`), never as HTML (`{@html}`, innerHTML).
   */
  declare message: string;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'OnlineHttpError';
  }
}

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  /** Cancels the request; it rejects with ABORTED. */
  signal?: AbortSignal;
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
  if (status === 503) return 'SERVER_FULL';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'INTERNAL';
}

/** Retry-After as delta-seconds, in ms; null when absent or an HTTP date. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('Retry-After')?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return null;
  return Number(raw) * 1000;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

const timeoutError = () => new OnlineHttpError('TIMEOUT', 'The game server took too long to answer.');
const abortedError = () => new OnlineHttpError('ABORTED', 'The request was cancelled.');

/**
 * One request's deadline: HTTP_TIMEOUT_MS, or sooner if the caller's signal
 * aborts. A setTimeout plus AbortController rather than AbortSignal.timeout
 * and AbortSignal.any, which older iOS Safari lacks. `race` also settles a
 * promise whose fetch ignores the signal.
 */
function deadline(callerSignal: AbortSignal | undefined) {
  const controller = new AbortController();
  let reason: OnlineHttpError | null = null;
  let rejectAbort: (err: OnlineHttpError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => {}); // settled by race(); never an unhandled rejection
  const abort = (err: OnlineHttpError) => {
    if (reason) return;
    reason = err;
    controller.abort();
    rejectAbort(err);
  };
  const onCallerAbort = () => abort(abortedError());
  const timer = setTimeout(() => abort(timeoutError()), HTTP_TIMEOUT_MS);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    /** The reason the request was cut short, if it was. */
    get reason(): OnlineHttpError | null {
      return reason;
    },
    race<T>(p: Promise<T>): Promise<T> {
      return Promise.race([p, aborted]);
    },
    done(): void {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

async function post(origin: string, path: string, body: unknown, opts: HttpOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const limit = deadline(opts.signal);
  try {
    return await exchange(doFetch, `${origin}${path}`, body, limit);
  } finally {
    limit.done();
  }
}

async function exchange(
  doFetch: typeof globalThis.fetch,
  url: string,
  body: unknown,
  limit: ReturnType<typeof deadline>,
): Promise<unknown> {
  if (limit.reason) throw limit.reason;
  let res: Response;
  try {
    res = await limit.race(
      doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: limit.signal,
      }),
    );
  } catch {
    throw limit.reason ?? new OnlineHttpError('NETWORK', 'Could not reach the game server.');
  }
  let data: unknown;
  try {
    data = await limit.race(readJson(res));
  } catch {
    data = undefined;
  }
  if (limit.reason) throw limit.reason;
  if (!res.ok) {
    const code =
      typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'string'
        ? (data as { code: string }).code
        : statusCode(res.status);
    const message =
      typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message
        : `The game server answered ${res.status}.`;
    throw new OnlineHttpError(code, message, res.status, retryAfterMs(res));
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
  const code = typeof r.code === 'string' ? parseRoomCode(r.code) : null;
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
  const normalized = parseRoomCode(code);
  if (normalized === null) throw new OnlineHttpError('BAD_REQUEST', 'That code is not a game code.');
  const body = { name: cleanName(name) };
  return grantFrom(await post(origin, `/api/rooms/${normalized}/join`, body, opts), 1, normalized);
}
