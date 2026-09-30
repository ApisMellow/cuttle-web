// Two-phone W11 (docs/two-phone-plan.md §7, §14 q3): the phone's one saved
// online seat. One record under one namespaced key, and no game state (the
// server holds the game; SPEC OQ-9 closes for online play). The token in it
// authorizes play: never log a record or put it in a URL.

import type { PlayerId } from '../bridge/schema';
import { parseServerOrigin } from './config';
import type { SeatNames } from './protocol';

export const SEAT_STORAGE_KEY = 'cuttle.online.v1';

export interface SeatRecord {
  v: 1;
  /** Server origin the seat belongs to. */
  server: string;
  /** Room code. */
  code: string;
  seat: PlayerId;
  token: string;
  /** Names by seat, for "Resume online game with Blake". */
  names: SeatNames;
}

type SeatStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): SeatStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isName(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** A clean copy with only the record's fields, or null if the shape is wrong. */
function validRecord(value: unknown): SeatRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.server !== 'string' || parseServerOrigin(r.server) !== r.server) return null;
  if (typeof r.code !== 'string' || r.code === '') return null;
  if (r.seat !== 0 && r.seat !== 1) return null;
  if (typeof r.token !== 'string' || r.token === '') return null;
  if (!Array.isArray(r.names) || r.names.length !== 2 || !r.names.every(isName)) return null;
  return {
    v: 1,
    server: r.server,
    code: r.code,
    seat: r.seat,
    token: r.token,
    names: [r.names[0] as string | null, r.names[1] as string | null],
  };
}

/** The saved seat, or null when there is none or it can't be read. */
export function loadSeat(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): SeatRecord | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SEAT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return validRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Saves the phone's one seat, replacing any earlier one. False if it couldn't. */
export function saveSeat(record: SeatRecord, storage: SeatStorage | undefined = defaultStorage()): boolean {
  const clean = validRecord(record);
  if (!clean || !storage) return false;
  try {
    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the saved seat (UNAUTHORIZED, ROOM_GONE, or a new game). */
export function clearSeat(storage: SeatStorage | undefined = defaultStorage()): void {
  try {
    storage?.removeItem(SEAT_STORAGE_KEY);
  } catch {
    // Best effort: an unreadable store has nothing to forget.
  }
}
