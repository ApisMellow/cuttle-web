// Two-phone W12: the real OnlineActions (REST create/join, the saved seat,
// the online store) and the startup choice between it and the W13a fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnlineActions, RoomEvent } from '../../src/lib/online/actions';
import type { SeatNames } from '../../src/lib/online/protocol';
import { configureOnlineActions, getOnlineActions, setOnlineActions } from '../../src/lib/online/provider';
import { createRealOnlineActions, type OnlineStoreLike } from '../../src/lib/online/realActions';
import { SEAT_STORAGE_KEY, loadSeat, type SeatRecord } from '../../src/lib/online/seat';
import { createFakeOnlineActions } from '../../src/lib/online/actions';
import { fakeStorage } from './game-test-support';
import { CODE, ORIGIN, TOKEN } from './online-fakes';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

class StubStore implements OnlineStoreLike {
  attached: SeatRecord[] = [];
  detached = 0;
  handlers = new Set<(e: RoomEvent) => void>();
  welcome: SeatNames | null = ['Alice', 'Blake'];
  attach(record: SeatRecord): void {
    this.attached.push(record);
  }
  detach(): void {
    this.detached += 1;
  }
  onRoomEvent(handler: (e: RoomEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  whenWelcomed(): Promise<SeatNames | null> {
    return Promise.resolve(this.welcome);
  }
}

function setup(fetchImpl?: typeof fetch) {
  const store = new StubStore();
  const storage = fakeStorage();
  const connected: string[] = [];
  const fetchFn = vi.fn(fetchImpl ?? (async () => reply(201, { code: CODE, seat: 0, token: TOKEN })));
  const actions = createRealOnlineActions({
    origin: ORIGIN,
    store,
    ui: { connected: (name) => connected.push(name) },
    storage,
    fetch: fetchFn as unknown as typeof fetch,
  });
  return { actions, store, storage, connected, fetchFn };
}

describe('real OnlineActions', () => {
  it('createRoom posts the name, saves the seat for this server and attaches the store', async () => {
    const { actions, store, storage, fetchFn } = setup();
    const result = await actions.createRoom('Alice');
    expect(result).toEqual({ ok: true, value: { code: CODE } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${ORIGIN}/api/rooms`);
    const saved = loadSeat(storage);
    expect(saved).toEqual({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', null] });
    expect(store.attached).toEqual([saved]);
  });

  it('joinRoom saves seat 1, attaches, and names the host from the welcome', async () => {
    const { actions, store, storage } = setup(async () => reply(200, { code: CODE, seat: 1, token: TOKEN }));
    const result = await actions.joinRoom('k7qx', 'Blake');
    expect(result).toEqual({ ok: true, value: { code: CODE, opponentName: 'Alice' } });
    expect(loadSeat(storage)?.seat).toBe(1);
    expect(loadSeat(storage)?.names).toEqual([null, 'Blake']);
    expect(store.attached).toHaveLength(1);
  });

  it.each([
    [404, 'ROOM_GONE', 'not-found'],
    [409, 'ROOM_FULL', 'full'],
    [429, 'RATE_LIMITED', 'rate-limited'],
    [503, 'SERVER_FULL', 'busy'],
    [400, 'BAD_REQUEST', 'bad-request'],
    [500, 'INTERNAL', 'network'],
  ])('a %i %s maps to %s and saves nothing', async (status, code, error) => {
    const { actions, store, storage } = setup(async () => reply(status, { code, message: 'x' }));
    const result = await actions.joinRoom(CODE, 'Blake');
    expect(result).toEqual({ ok: false, error });
    expect(loadSeat(storage)).toBeNull();
    expect(store.attached).toEqual([]);
  });

  it('a network failure is "network"', async () => {
    const { actions } = setup(async () => {
      throw new TypeError('offline');
    });
    await expect(actions.createRoom('Alice')).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('cancelRoom detaches and forgets the seat', async () => {
    const { actions, store, storage } = setup();
    await actions.createRoom('Alice');
    await actions.cancelRoom();
    expect(store.detached).toBe(1);
    expect(loadSeat(storage)).toBeNull();
  });

  it('onRoomEvent passes the store’s events through', async () => {
    const { actions, store } = setup();
    const events: RoomEvent[] = [];
    const off = actions.onRoomEvent((e) => events.push(e));
    for (const h of store.handlers) h({ kind: 'opponent-joined', opponentName: 'Blake' });
    off();
    expect(events).toEqual([{ kind: 'opponent-joined', opponentName: 'Blake' }]);
    expect(store.handlers.size).toBe(0);
  });

  it('savedSeat offers only a seat for this server, with the opponent’s name and no token', () => {
    const { actions, storage } = setup();
    expect(actions.savedSeat()).toBeNull();
    const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] };
    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
    expect(actions.savedSeat()).toEqual({ code: CODE, opponentName: 'Blake' });
    expect(JSON.stringify(actions.savedSeat())).not.toContain(TOKEN);

    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ ...record, server: 'https://other.example.com' }));
    expect(actions.savedSeat()).toBeNull();
  });

  it('resume attaches the saved seat and shows the table; a seat for another server is never sent', () => {
    const { actions, store, storage, connected } = setup();
    const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat: 1, token: TOKEN, names: ['Alice', 'Blake'] };
    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ ...record, server: 'https://other.example.com' }));
    actions.resume();
    expect(store.attached).toEqual([]);
    expect(connected).toEqual([]);

    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
    actions.resume();
    expect(store.attached).toEqual([record]);
    expect(connected).toEqual(['Alice']);
  });
});

describe('configureOnlineActions (startup choice)', () => {
  let before: OnlineActions;
  beforeEach(() => {
    before = getOnlineActions();
  });
  afterEach(() => {
    setOnlineActions(before);
  });

  it('installs the real actions when a server is configured', () => {
    const real = createFakeOnlineActions();
    const make = vi.fn(() => real);
    expect(configureOnlineActions({ origin: ORIGIN, make })).toBe('real');
    expect(make).toHaveBeenCalledWith(ORIGIN);
    expect(getOnlineActions()).toBe(real);
  });

  it('keeps the fake when no server is configured (dev)', () => {
    const make = vi.fn(() => createFakeOnlineActions());
    expect(configureOnlineActions({ origin: null, make })).toBe('fake');
    expect(make).not.toHaveBeenCalled();
    expect(getOnlineActions()).toBe(before);
  });
});
