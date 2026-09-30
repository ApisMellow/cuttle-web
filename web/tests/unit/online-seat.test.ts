// Two-phone W11 (docs/two-phone-plan.md §7, §14 q3): the phone keeps one
// online seat, under one namespaced localStorage key, and no game state.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEAT_STORAGE_KEY, clearSeat, loadSeat, saveSeat, seatMatchesServer, type SeatRecord } from '../../src/lib/online/seat';
import { fakeStorage } from './game-test-support';
import { CODE, ORIGIN, TOKEN } from './online-fakes';

function record(overrides: Partial<SeatRecord> = {}): SeatRecord {
  return { v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'], ...overrides };
}

describe('seat storage', () => {
  it('uses the one namespaced key cuttle.online.v1', () => {
    expect(SEAT_STORAGE_KEY).toBe('cuttle.online.v1');
  });

  it('round-trips a seat record', () => {
    const storage = fakeStorage();
    expect(saveSeat(record(), storage)).toBe(true);
    expect(loadSeat(storage)).toEqual(record());
    expect(JSON.parse(storage.getItem(SEAT_STORAGE_KEY)!)).toEqual(record());
  });

  it('stores only the seat fields, never game state', () => {
    const storage = fakeStorage();
    saveSeat({ ...record(), envelope: { secret: true } } as unknown as SeatRecord, storage);
    expect(Object.keys(JSON.parse(storage.getItem(SEAT_STORAGE_KEY)!)).sort()).toEqual(
      ['code', 'names', 'seat', 'server', 'token', 'v'],
    );
  });

  it('keeps one online game per phone: a second save replaces the first', () => {
    const storage = fakeStorage();
    saveSeat(record(), storage);
    saveSeat(record({ code: 'Z9W2', seat: 1, names: ['Blake', 'Alice'] }), storage);
    expect(storage.length).toBe(1);
    expect(loadSeat(storage)?.code).toBe('Z9W2');
  });

  it('clears the seat', () => {
    const storage = fakeStorage();
    saveSeat(record(), storage);
    clearSeat(storage);
    expect(storage.getItem(SEAT_STORAGE_KEY)).toBeNull();
    expect(loadSeat(storage)).toBeNull();
  });

  it('returns null for a missing, malformed or wrong-version record', () => {
    const storage = fakeStorage();
    expect(loadSeat(storage)).toBeNull();
    for (const raw of [
      'not json',
      '[]',
      JSON.stringify({ ...record(), v: 2 }),
      JSON.stringify({ ...record(), seat: 2 }),
      JSON.stringify({ ...record(), token: '' }),
      JSON.stringify({ ...record(), code: '' }),
      JSON.stringify({ ...record(), server: 'cuttle.example.com' }),
      JSON.stringify({ ...record(), names: ['Alice'] }),
    ]) {
      storage.setItem(SEAT_STORAGE_KEY, raw);
      expect(loadSeat(storage), raw).toBeNull();
    }
  });

  it('accepts a waiting-room record whose opponent name is not known yet', () => {
    const storage = fakeStorage();
    saveSeat(record({ names: ['Alice', null] }), storage);
    expect(loadSeat(storage)?.names).toEqual(['Alice', null]);
  });

  it('survives storage that throws (private mode, quota)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadSeat(throwing)).toBeNull();
    expect(saveSeat(record(), throwing)).toBe(false);
    expect(() => clearSeat(throwing)).not.toThrow();
  });

  it('refuses to save an invalid record', () => {
    const storage = fakeStorage();
    expect(saveSeat(record({ token: '' }), storage)).toBe(false);
    expect(storage.getItem(SEAT_STORAGE_KEY)).toBeNull();
  });
});

describe('seatMatchesServer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('matches only the configured server origin', () => {
    expect(seatMatchesServer(record(), ORIGIN)).toBe(true);
    expect(seatMatchesServer(record(), 'https://other.example.com')).toBe(false);
    expect(seatMatchesServer(record(), null)).toBe(false);
  });

  it("defaults to this build's serverOrigin()", () => {
    vi.stubEnv('VITE_CUTTLE_SERVER', ORIGIN);
    expect(seatMatchesServer(record())).toBe(true);
    vi.stubEnv('VITE_CUTTLE_SERVER', 'https://other.example.com');
    expect(seatMatchesServer(record())).toBe(false);
  });
});
