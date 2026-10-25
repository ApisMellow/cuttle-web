// Issue #53 (SPEC §4.8) through the real wasm engine and the pass-and-play
// store: an Ace's wipe shows on the mover's board before the pass, then
// replays once on the next player's board (unless the setting is off).
// Positions are written with the tutorial's `positionSnapshot`.

import { beforeAll, describe, expect, it } from 'vitest';

import type { Card, Move } from '../../src/lib/bridge/schema';
import { MoveKind } from '../../src/lib/enums';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonPosition } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { fakeStorage, passResumeGate } from './game-test-support';

const ACE = c(1, 'H');

const POSITION: LessonPosition = {
  aliceHand: [ACE, c(4, 'S'), c(10, 'D')],
  alicePoints: [c(7, 'C')],
  blakeHand: [c(3, 'D'), c(8, 'S'), c(13, 'H')],
  blakePoints: [c(9, 'D'), c(6, 'C')],
  scrap: [],
  deckTop: [c(9, 'C'), c(12, 'D')],
};

function save(engineState: string): string {
  return JSON.stringify({
    v: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    engineState,
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Blake'],
    seed: '0',
    dealer: 1,
  });
}

interface Started {
  store: GameStore;
  storage: Storage;
  replay: { on: boolean };
}

async function startAt(pos: LessonPosition, replayOn = true): Promise<Started> {
  const storage = fakeStorage();
  storage.setItem(SNAPSHOT_KEY, save(positionSnapshot(pos)));
  const replay = { on: replayOn };
  const store = new GameStore({ storage, session: new SessionStore(), replayEffects: () => replay.on });
  await store.restore();
  expect(store.error).toBeNull();
  await passResumeGate(store);
  return { store, storage, replay };
}

const sameCard = (a: Card | null, b: Card) => a !== null && a.Rank === b.Rank && a.Suit === b.Suit;

function aceIndex(store: GameStore): number {
  const i = store.legalMoves.findIndex((m: Move) => m.Kind === MoveKind.OneOff && sameCard(m.Card, ACE));
  if (i < 0) throw new Error('no Ace one-off');
  return i;
}

async function pass(store: GameStore): Promise<void> {
  for (let i = 0; i < 4 && (store.curtain.kind === 'handoff' || store.curtain.kind === 'reveal'); i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}

const wiped = [
  { card: c(7, 'C'), seat: 0, row: 'points', slot: 0, jack: -1 },
  { card: c(9, 'D'), seat: 1, row: 'points', slot: 0, jack: -1 },
  { card: c(6, 'C'), seat: 1, row: 'points', slot: 1, jack: -1 },
];

beforeAll(async () => {
  await createWasmEngine();
});

describe('issue #53: the Ace before the pass (pass-and-play)', () => {
  it('holds the saved handoff on the mover’s board until dismissed; apply, refresh and advance throw meanwhile', async () => {
    const { store, storage } = await startAt(POSITION);
    await store.apply(aceIndex(store));

    expect(store.wipeEffect).toEqual({ seq: store.seq, by: 0, cards: wiped, to: 0, mode: 'show', beforePass: true });
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.legalMoves).toEqual([]);
    expect(store.view?.you.points).toEqual([]);
    expect(store.view?.opponent.points).toEqual([]);
    // The save already holds the handoff.
    expect(JSON.parse(storage.getItem(SNAPSHOT_KEY)!).curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });

    await expect(store.apply(0)).rejects.toThrow(/SPEC §4\.8/);
    await expect(store.refresh()).rejects.toThrow(/SPEC §4\.8/);
    await expect(store.advanceCurtain()).rejects.toThrow(/SPEC §4\.8/);

    store.dismissWipeEffect();
    expect(store.wipeEffect).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    expect(store.history.some((h) => 'index' in h)).toBe(false);
    store.dismissWipeEffect();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
  });
});

describe('issue #53: the next player’s replay', () => {
  it('replays once at the next board with the setting on, and not again after a refresh', async () => {
    const { store } = await startAt(POSITION);
    await store.apply(aceIndex(store));
    const seq = store.seq;
    store.dismissWipeEffect();
    await store.advanceCurtain(); // handoff -> reveal
    expect(store.wipeEffect).toBeNull();
    await store.advanceCurtain(); // reveal -> Blake's board
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.wipeEffect).toEqual({ seq, by: 0, cards: wiped, to: 1, mode: 'replay', beforePass: false });

    store.dismissWipeEffect();
    expect(store.wipeEffect).toBeNull();
    await store.refresh();
    expect(store.wipeEffect).toBeNull();
  });

  it('plays nothing for the next player with the setting off; the mover’s show still plays', async () => {
    const { store } = await startAt(POSITION, false);
    await store.apply(aceIndex(store));
    expect(store.wipeEffect?.mode).toBe('show');
    store.dismissWipeEffect();
    await pass(store);
    expect(store.viewer).toBe(1);
    expect(store.wipeEffect).toBeNull();
  });

  it('turning the setting on later never replays an old wipe', async () => {
    const { store, replay } = await startAt(POSITION, false);
    await store.apply(aceIndex(store));
    store.dismissWipeEffect();
    await pass(store);
    replay.on = true;
    await store.refresh();
    expect(store.wipeEffect).toBeNull();
  });

  it('a non-global move shows nothing', async () => {
    const { store } = await startAt(POSITION);
    const i = store.legalMoves.findIndex((m) => m.Kind === MoveKind.PlayPoint && sameCard(m.Card, c(10, 'D')));
    await store.apply(i);
    expect(store.wipeEffect).toBeNull();
    expect(store.curtain.kind).toBe('handoff');
    await pass(store);
    expect(store.wipeEffect).toBeNull();
  });
});

describe('issue #53: a reload skips the show and the replay', () => {
  it('a reload mid-show comes back to the saved handoff, and the next board has no replay', async () => {
    const { store, storage } = await startAt(POSITION);
    await store.apply(aceIndex(store));
    expect(store.wipeEffect?.beforePass).toBe(true);

    const reloaded = new GameStore({ storage, session: new SessionStore(), replayEffects: () => true });
    await reloaded.restore();
    expect(reloaded.wipeEffect).toBeNull();
    expect(reloaded.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    await pass(reloaded);
    expect(reloaded.viewer).toBe(1);
    expect(reloaded.wipeEffect).toBeNull();
  });

  it('a reload at the next board (behind the resume gate) shows no replay; goHome clears one in flight', async () => {
    const { store, storage } = await startAt(POSITION);
    await store.apply(aceIndex(store));
    store.dismissWipeEffect();
    await pass(store);
    expect(store.wipeEffect?.mode).toBe('replay');
    store.goHome();
    expect(store.wipeEffect).toBeNull();

    const reloaded = new GameStore({ storage, session: new SessionStore(), replayEffects: () => true });
    await reloaded.restore();
    await passResumeGate(reloaded);
    expect(reloaded.curtain).toEqual({ kind: 'none' });
    expect(reloaded.viewer).toBe(1);
    expect(reloaded.wipeEffect).toBeNull();
  });
});
