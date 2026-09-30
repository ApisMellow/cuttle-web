// Two-phone W12: the real OnlineActions behind the Home, Create, Join and
// Waiting screens. Create and join go over HTTP (http.ts); the grant is
// saved as the phone's one seat (seat.ts) and handed to the online store,
// which opens the socket. The screens never see a token.
//
// Seats are tied to the server that issued them: `savedSeat()` and
// `resume()` use a record only when `seatMatchesServer(record, origin)`, so
// a token is never sent to a server that didn't issue it.

import type { CreatedRoom, JoinedRoom, OnlineActions, OnlineErrorCode, Result, RoomEvent, SavedSeat } from './actions';
import { HTTP_TIMEOUT_MS, OnlineHttpError, createRoom, joinRoom, type SeatGrant } from './http';
import type { SeatNames } from './protocol';
import { clearSeat, loadSeat, saveSeat, seatMatchesServer, type SeatRecord } from './seat';

/** What the actions need from the online store (OnlineGameStore). */
export interface OnlineStoreLike {
  attach(record: SeatRecord): void;
  detach(): void;
  onRoomEvent(handler: (event: RoomEvent) => void): () => void;
  whenWelcomed(timeoutMs: number): Promise<SeatNames | null>;
}

export interface RealActionsDeps {
  /** This build's server origin (config.ts `serverOrigin()`). */
  origin: string;
  store: OnlineStoreLike;
  /** Shows the table for a resumed seat (online.svelte.ts `connected`). */
  ui: { connected(opponentName: string): void };
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch?: typeof globalThis.fetch;
  /** How long a join waits for the welcome that names the host. */
  welcomeTimeoutMs?: number;
}

function errorFor(err: unknown): OnlineErrorCode {
  if (!(err instanceof OnlineHttpError)) return 'network';
  switch (err.code) {
    case 'ROOM_GONE':
      return 'not-found';
    case 'ROOM_FULL':
      return 'full';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'SERVER_FULL':
      return 'busy';
    case 'BAD_REQUEST':
      return 'bad-request';
    default:
      return 'network';
  }
}

export function createRealOnlineActions(deps: RealActionsDeps): OnlineActions {
  const { origin, store, ui } = deps;
  const storage = deps.storage ?? defaultStorage();
  const http = { fetch: deps.fetch };
  const welcomeTimeoutMs = deps.welcomeTimeoutMs ?? HTTP_TIMEOUT_MS;

  function start(grant: SeatGrant, names: SeatNames): SeatRecord {
    const record: SeatRecord = { v: 1, server: origin, code: grant.code, seat: grant.seat, token: grant.token, names };
    saveSeat(record, storage);
    store.attach(record);
    return record;
  }

  function matchingSeat(): SeatRecord | null {
    const record = loadSeat(storage);
    return record !== null && seatMatchesServer(record, origin) ? record : null;
  }

  return {
    async createRoom(name: string): Promise<Result<CreatedRoom>> {
      let grant: SeatGrant;
      try {
        grant = await createRoom(origin, name, http);
      } catch (err) {
        return { ok: false, error: errorFor(err) };
      }
      start(grant, [name.trim(), null]);
      return { ok: true, value: { code: grant.code } };
    },

    async joinRoom(code: string, name: string): Promise<Result<JoinedRoom>> {
      let grant: SeatGrant;
      try {
        grant = await joinRoom(origin, code, name, http);
      } catch (err) {
        return { ok: false, error: errorFor(err) };
      }
      const welcomed = store.whenWelcomed(welcomeTimeoutMs);
      start(grant, [null, name.trim()]);
      // The join reply doesn't name the host; the welcome does. A slow
      // socket still lets the player in (the name fills in on welcome).
      const names = await welcomed;
      return { ok: true, value: { code: grant.code, opponentName: names?.[0] ?? '' } };
    },

    async cancelRoom(): Promise<void> {
      store.detach();
      clearSeat(storage);
    },

    onRoomEvent(handler) {
      return store.onRoomEvent(handler);
    },

    savedSeat(): SavedSeat | null {
      const record = matchingSeat();
      if (record === null) return null;
      return { code: record.code, opponentName: record.names[record.seat === 0 ? 1 : 0] };
    },

    resume(): void {
      const record = matchingSeat();
      if (record === null) return;
      store.attach(record);
      ui.connected(record.names[record.seat === 0 ? 1 : 0] ?? '');
    },
  };
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
