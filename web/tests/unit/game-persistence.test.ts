// SPEC §5.7 persistence details not covered by game-curtain.test.ts's
// ordering test: carry-over 8 (engineState opacity) and the general shape of
// what gets written (key, version, dealer/seed/names, curtain).

import { beforeEach, describe, expect, it } from 'vitest';

import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY, decodeSnapshot } from '../../src/lib/stores/snapshot';
import { createFakeEngine, envelope, fakeStorage, playerView } from './game-test-support';

describe('carry-over 8: engineState is opaque — the store never reads inside it, only echoes the raw string', () => {
  it('persists exactly what engine.snapshot() returned, byte for byte, with no re-encoding', async () => {
    const storage = fakeStorage();
    const session = new SessionStore();
    const rawEngineBlob = '{"ok":true,"v":1,"state":{"totally":"opaque","nested":[1,2,3]},"history":[],"seed":"99","dealer":0}';
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      snapshot: () => rawEngineBlob,
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    const raw = storage.getItem(SNAPSHOT_KEY);
    const decoded = decodeSnapshot(raw);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.snapshot.engineState).toBe(rawEngineBlob);
    }
  });

  it('an engineState that is not even valid JSON is still persisted and round-trips untouched (truly opaque)', async () => {
    const storage = fakeStorage();
    const session = new SessionStore();
    const weirdBlob = 'not-json-at-all, deliberately';
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      snapshot: () => weirdBlob,
    });
    const store = new GameStore({ engine, storage, session });

    await expect(store.newGame()).resolves.toBeUndefined();

    const decoded = decodeSnapshot(storage.getItem(SNAPSHOT_KEY));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.snapshot.engineState).toBe(weirdBlob);
  });
});

describe('persisted snapshot shape', () => {
  let storage: Storage;
  let session: SessionStore;

  beforeEach(() => {
    storage = fakeStorage();
    session = new SessionStore();
  });

  it('writes under the SPEC §5.7 key with v:1 and the current names/seed/dealer/curtain', async () => {
    session.setNames('Alice', 'Blake');
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 1, viewer: 1 }) }), // dealer derives to 0
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame({ seed: '7' });

    const decoded = decodeSnapshot(storage.getItem(SNAPSHOT_KEY));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.snapshot.v).toBe(1);
    expect(decoded.snapshot.names).toEqual(['Alice', 'Blake']);
    expect(decoded.snapshot.seed).toBe('7');
    expect(decoded.snapshot.dealer).toBe(0);
    expect(decoded.snapshot.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' }); // W25 opening curtain
    expect(typeof decoded.snapshot.savedAt).toBe('string');
  });

  it('does not persist anything before a game has started', () => {
    const engine = createFakeEngine();
    // Constructing the store must not itself touch storage.
    expect(() => new GameStore({ engine, storage, session })).not.toThrow();
    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});
