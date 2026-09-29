// W25 item 1 (strict, privacy): a new game starts behind the curtain.
//
// SPEC §3.3 rule 4 / §4.5: no hand renders until the player who will hold
// it has passed the reveal gate. Whoever tapped "New game" is not
// necessarily the first player, so the opening deal gets the same
// handoff -> reveal -> none walk as any turn, addressed to the first actor,
// with a fresh `engine.view(first)` fetched only at `none`.

import { describe, expect, it, vi } from 'vitest';

import type { Card, PlayerId } from '../../src/lib/bridge/schema';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY, decodeSnapshot } from '../../src/lib/stores/snapshot';
import { createFakeEngine, envelope, fakeStorage, playerView } from './game-test-support';

const FIRST_SECRET: Card = { Rank: 12, Suit: 3 };

function openingGame(first: PlayerId) {
  const storage = fakeStorage();
  const session = new SessionStore();
  const handState = (p: PlayerId) =>
    playerView({ active: first, viewer: p, you: { hand: [FIRST_SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } });
  const engine = createFakeEngine({
    newGame: vi.fn(() => envelope({ state: handState(first) })),
    view: vi.fn((p: PlayerId) => envelope({ state: handState(p) })),
    restore: vi.fn((_s: string, p: PlayerId) => envelope({ state: handState(p) })),
  });
  const store = new GameStore({ engine, storage, session });
  return { store, engine, storage, session };
}

function reachable(store: GameStore): string {
  return JSON.stringify({
    envelope: store.envelope,
    view: store.view,
    legalMoves: store.legalMoves,
    history: store.history,
    curtain: store.curtain,
    viewer: store.viewer,
  });
}

describe('W25: newGame raises the opening curtain to the first player', () => {
  for (const first of [0, 1] as const) {
    it(`first player ${first}: handoff 'turn' to them, and no view is held`, async () => {
      const { store } = openingGame(first);
      await store.newGame();

      expect(store.screen).toBe('game');
      expect(store.curtain).toEqual({ kind: 'handoff', to: first, reason: 'turn' });
      expect(store.envelope).toBeNull();
      expect(store.view).toBeNull();
      expect(store.viewer).toBeNull();
      expect(reachable(store)).not.toContain(JSON.stringify(FIRST_SECRET));
    });
  }

  it('walks handoff -> reveal -> none, fetching a fresh view for the first player only at none', async () => {
    const { store, engine } = openingGame(1);
    await store.newGame();

    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'reveal', to: 1 });
    expect(store.envelope).toBeNull();
    expect(engine.view).not.toHaveBeenCalled();

    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(engine.view).toHaveBeenCalledTimes(1);
    expect(engine.view).toHaveBeenCalledWith(1);
    expect(store.viewer).toBe(1);
    expect(store.view?.you.hand).toEqual([FIRST_SECRET]);
  });

  it('apply() refuses during the opening curtain', async () => {
    const { store, engine } = openingGame(0);
    await store.newGame();
    await expect(store.apply(0)).rejects.toThrow();
    await store.advanceCurtain();
    await expect(store.apply(0)).rejects.toThrow();
    expect(engine.apply).not.toHaveBeenCalled();
  });

  it('persists the opening handoff (viewer = first player) before the store exposes anything', async () => {
    const { store, storage } = openingGame(1);
    const writes: Array<{ curtain: string; storeCurtain: string }> = [];
    const original = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      writes.push({ curtain: JSON.parse(value).curtain.kind, storeCurtain: store.curtain.kind });
      original(key, value);
    });
    await store.newGame();
    expect(writes).toEqual([{ curtain: 'handoff', storeCurtain: 'none' }]);

    const decoded = decodeSnapshot(storage.getItem(SNAPSHOT_KEY));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.snapshot.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
      expect(decoded.snapshot.viewer).toBe(1);
      expect(decoded.snapshot.history).toEqual([]);
    }
  });

  it('a reload during the opening curtain restores behind it, and the walk still reaches the board', async () => {
    const { store, storage, session } = openingGame(1);
    await store.newGame();
    await store.advanceCurtain(); // reveal, then the page reloads

    const { engine: engine2 } = openingGame(1);
    const reloaded = new GameStore({ engine: engine2, storage, session });
    await reloaded.restore();
    expect(reloaded.curtain).toEqual({ kind: 'reveal', to: 1 });
    expect(reloaded.envelope).toBeNull();
    expect(reachable(reloaded)).not.toContain(JSON.stringify(FIRST_SECRET));

    await reloaded.advanceCurtain();
    expect(reloaded.curtain).toEqual({ kind: 'none' });
    expect(engine2.view).toHaveBeenCalledWith(1);
    expect(reloaded.view?.you.hand).toEqual([FIRST_SECRET]);
  });
});
