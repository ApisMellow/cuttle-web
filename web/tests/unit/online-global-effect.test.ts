// Issue #53 (SPEC §4.8) online: OnlineGameStore, over the real W11
// connection and a FakeSocket, plays a wipe on this seat's board when a
// state arrives whose new history holds one. The other seat's wipe is a
// replay (none with the setting off); this seat's own is the show. No hold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, Envelope, PlayerId, PointEntry } from '../../src/lib/bridge/schema';
import { createConnection } from '../../src/lib/online/connection';
import { SEAT_STORAGE_KEY, type SeatRecord } from '../../src/lib/online/seat';
import { OnlineGameStore } from '../../src/lib/stores/onlineGame.svelte';
import { Kind, Phase, appliedMove, envelope, fakeStorage, playerView } from './game-test-support';
import { CODE, ORIGIN, TOKEN, FakeEnvironment, socketFactory } from './online-fakes';

const ACE = { Rank: 1, Suit: 3 } as const;
const SEVEN = { Rank: 7, Suit: 0 } as const;
const NINE = { Rank: 9, Suit: 1 } as const;

function point(card: Card, owner: PlayerId): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) => appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1 }));
}

/** Alice's view (seat 0) at `seq`, with or without the point cards. */
function aliceSees(history: AppliedMove[], withPoints: boolean, active: PlayerId): Envelope {
  return envelope({
    state: playerView({
      viewer: 0,
      active,
      phase: Phase.Normal,
      you: { hand: [], frozenHandIndices: [], points: withPoints ? [point(SEVEN, 0)] : [], permanents: [], watched: false },
      opponent: { handCount: 4, hand: null, points: withPoints ? [point(NINE, 1)] : [], permanents: [] },
    }),
    history,
  });
}

function setup(replayOn: boolean) {
  const sockets = socketFactory();
  const env = new FakeEnvironment();
  const storage = fakeStorage();
  const store = new OnlineGameStore({
    connect: (o) => createConnection({ ...o, socketFactory: sockets.factory, environment: env, random: () => 0.5 }),
    seatStorage: storage,
    onLeave: () => {},
    replayEffects: () => replayOn,
  });
  const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] };
  storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
  store.attach(record);
  sockets.last.serverOpen();
  sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
  const send = (e: Envelope) => sockets.last.serverSend({ t: 'state', game: 1, envelope: e, opponentOnline: true, tally: [0, 0] });
  return { store, send };
}

let stores: OnlineGameStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  stores = [];
});

afterEach(() => {
  for (const s of stores) s.detach();
  vi.useRealTimers();
});

const wiped = [
  { card: SEVEN, seat: 0, row: 'points', slot: 0, jack: -1 },
  { card: NINE, seat: 1, row: 'points', slot: 0, jack: -1 },
];

describe('issue #53 online', () => {
  it("a state holding the other seat's Ace replays the wipe on this seat's board", () => {
    const { store, send } = setup(true);
    stores.push(store);
    send(aliceSees(draws(2), true, 1));
    expect(store.wipeEffect).toBeNull();
    const ace = appliedMove({ by: 1, kind: Kind.OneOff, card: ACE, seq: 3 });
    send(aliceSees([...draws(2), ace], false, 0));
    expect(store.wipeEffect).toEqual({ seq: 3, by: 1, cards: wiped, to: 0, mode: 'replay', beforePass: false });
    expect(store.curtain).toEqual({ kind: 'none' });
    store.dismissWipeEffect();
    expect(store.wipeEffect).toBeNull();
  });

  it('with the setting off, no replay', () => {
    const { store, send } = setup(false);
    stores.push(store);
    send(aliceSees(draws(2), true, 1));
    send(aliceSees([...draws(2), appliedMove({ by: 1, kind: Kind.OneOff, card: ACE, seq: 3 })], false, 0));
    expect(store.wipeEffect).toBeNull();
  });

  it("this seat's own Ace is shown even with the setting off, and never holds", () => {
    const { store, send } = setup(false);
    stores.push(store);
    send(aliceSees(draws(2), true, 0));
    send(aliceSees([...draws(2), appliedMove({ by: 0, kind: Kind.OneOff, card: ACE, seq: 3 })], false, 1));
    expect(store.wipeEffect?.mode).toBe('show');
    expect(store.wipeEffect?.beforePass).toBe(false);
    expect(store.wipeEffect?.cards).toEqual(wiped);
  });

  it('a first state (a resume) replays nothing', () => {
    const { store, send } = setup(true);
    stores.push(store);
    send(aliceSees([...draws(2), appliedMove({ by: 1, kind: Kind.OneOff, card: ACE, seq: 3 })], false, 0));
    expect(store.wipeEffect).toBeNull();
  });
});
