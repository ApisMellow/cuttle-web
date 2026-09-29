// R4.4 (docs/requirements.yaml), round-1 review carry-overs 3 and 7, and the
// restore half of R7.4's store leg (opponent.hand null-vs-[] survives a
// snapshot round trip).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY, type Snapshot, encodeSnapshot } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, Phase, appliedMove, createFakeEngine, envelope, fakeStorage, passResumeGate, playerView, startGame } from './game-test-support';

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 2,
    savedAt: '2026-09-27T00:00:00.000Z',
    engineState: '"opaque-blob"',
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Blake'],
    seed: '42',
    dealer: 1,
    ...overrides,
  };
}

describe('R4.4: version-mismatched snapshot is discarded without a crash, no migration attempted', () => {
  let storage: Storage;
  let session: SessionStore;

  beforeEach(() => {
    storage = fakeStorage();
    session = new SessionStore();
  });

  it('an unknown v (neither 2 nor the migratable 1) -> home screen with a notice, engine.restore never called, no throw', async () => {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...baseSnapshot(), v: 3 }));
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session });

    await expect(store.restore()).resolves.toBeUndefined();

    expect(store.screen).toBe('home');
    expect(store.notice).toBeTruthy();
    expect(engine.restore).not.toHaveBeenCalled();
    expect(store.envelope).toBeNull();
  });

  it('the stale snapshot is removed from storage so it is not retried on the next load', async () => {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...baseSnapshot(), v: 99 }));
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session });

    await store.restore();

    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it('an absent snapshot restores to home with no error and no notice', async () => {
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session });

    await store.restore();

    expect(store.screen).toBe('home');
    expect(store.error).toBeNull();
  });

  it('malformed JSON is discarded the same way (no crash, home + notice)', async () => {
    storage.setItem(SNAPSHOT_KEY, 'not json{{{');
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session });

    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.screen).toBe('home');
    expect(store.notice).toBeTruthy();
    expect(engine.restore).not.toHaveBeenCalled();
  });
});

describe('carry-over 3: restore pushes the snapshot\'s dealer and names back into the session store', () => {
  it('applies names and dealer from a valid snapshot onto the injected session', async () => {
    const storage = fakeStorage();
    const session = new SessionStore();
    storage.setItem(SNAPSHOT_KEY, encodeSnapshot(baseSnapshot({ names: ['Blake', 'Alice'], dealer: 1 })));
    const engine = createFakeEngine({
      restore: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await store.restore();

    expect(session.names).toEqual(['Blake', 'Alice']);
    expect(session.lastDealer).toBe(1);
  });
});

describe('carry-over 7: a persisted curtain is re-raised before the store exposes any view', () => {
  let storage: Storage;
  let session: SessionStore;

  beforeEach(() => {
    storage = fakeStorage();
    session = new SessionStore();
  });

  it('restoring mid-curtain (kind: handoff) exposes the curtain state but NOT a board view (R4.2 precondition)', async () => {
    storage.setItem(
      SNAPSHOT_KEY,
      encodeSnapshot(
        baseSnapshot({
          viewer: 1, // N2: a handoff persists the incoming player as viewer
          curtain: { kind: 'handoff', to: 1, reason: 'turn' },
          history: [appliedMove({ by: 0, kind: Kind.Draw, seq: 1 })],
        }),
      ),
    );
    const engine = createFakeEngine({
      // The bridge restore() call succeeds and would happily hand back a
      // full PlayerView for the persisted viewer — the STORE must still not
      // expose it while curtain.kind !== 'none'.
      restore: () => envelope({ state: playerView({ active: 1, viewer: 1, you: { hand: [{ Rank: 3, Suit: 1 }], frozenHandIndices: [], points: [], permanents: [], watched: false } }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await store.restore();

    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
    expect(store.view).toBeNull();
    expect(store.screen).toBe('game');
  });

  it('restoring while curtain is already "none" raises the resume gate, then shows the board (ruling 2026-09-29)', async () => {
    storage.setItem(
      SNAPSHOT_KEY,
      encodeSnapshot(baseSnapshot({ curtain: { kind: 'none' }, viewer: 0 })),
    );
    const engine = createFakeEngine({
      restore: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      view: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await store.restore();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'resume' });
    expect(store.envelope).toBeNull();
    await passResumeGate(store);

    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.envelope).not.toBeNull();
    expect(store.view?.active).toBe(0);
  });

  it('a restored mid-curtain sequence can still be advanced afterward (handoff -> reveal -> ... -> none)', async () => {
    const history = [appliedMove({ by: 0, kind: Kind.Draw, seq: 1 })];
    storage.setItem(
      SNAPSHOT_KEY,
      encodeSnapshot(baseSnapshot({ viewer: 1, curtain: { kind: 'handoff', to: 1, reason: 'turn' }, history, lastSeenSeq: { 0: 1, 1: 0 } })),
    );
    const engine = createFakeEngine({
      restore: () => envelope({ state: playerView({ active: 1, viewer: 1 }), history }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p, phase: Phase.Normal }), history }),
    });
    const store = new GameStore({ engine, storage, session });
    await store.restore();

    await store.advanceCurtain(); // -> reveal
    expect(store.curtain).toEqual({ kind: 'reveal', to: 1 });

    await store.advanceCurtain(); // -> recap (1 unseen entry for P2) or none if already seen
    await (store.curtain.kind === 'recap' ? store.advanceCurtain() : Promise.resolve());

    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.envelope).not.toBeNull();
  });
});

// R7.4 store leg (restore half): see 'N4: R7.4 null-vs-[] through a real snapshot() -> restore() round trip' below.

describe('restore bridge-error handling', () => {
  it('when engine.restore() itself fails, discards the snapshot and shows a notice rather than crashing', async () => {
    const storage = fakeStorage();
    const session = new SessionStore();
    storage.setItem(SNAPSHOT_KEY, encodeSnapshot(baseSnapshot()));
    const engine = createFakeEngine({
      restore: () => ({ ok: false, code: 'BAD_REQUEST', message: 'structurally invalid' }),
    });
    const store = new GameStore({ engine, storage, session });

    await expect(store.restore()).resolves.toBeUndefined();

    expect(store.screen).toBe('home');
    expect(store.notice).toBeTruthy();
    expect(store.envelope).toBeNull();
  });
});

describe('B4: restore into every curtain kind exposes exactly what that kind allows (R4.2)', () => {
  const SECRET = { Rank: 13, Suit: 3 } as const;
  const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 } });

  function restoreWith(snap: Snapshot, restored: ReturnType<typeof envelope>, extra: Parameters<typeof createFakeEngine>[0] = {}) {
    const storage = fakeStorage();
    const session = new SessionStore();
    storage.setItem(SNAPSHOT_KEY, encodeSnapshot(snap));
    const engine = createFakeEngine({ restore: vi.fn(() => restored), ...extra });
    return { store: new GameStore({ engine, storage, session }), engine, storage };
  }

  function viewerEnvelope(viewer: 0 | 1, active: 0 | 1, phase: number, history = [oneOff]) {
    return envelope({
      state: playerView({ viewer, active, phase: phase as 0 | 1 | 2 | 3 | 4, you: { hand: [SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      history,
    });
  }

  it('none: behind the resume gate, then the persisted viewer\'s board is exposed', async () => {
    const env = viewerEnvelope(1, 1, Phase.Normal);
    const { store, engine } = restoreWith(baseSnapshot({ viewer: 1, history: [oneOff] }), env, { view: () => env });
    await store.restore();
    expect(engine.restore).toHaveBeenCalledWith('"opaque-blob"', 1);
    expect(store.view).toBeNull();
    await passResumeGate(store);
    expect(store.viewer).toBe(1);
    expect(store.view?.you.hand).toEqual([SECRET]);
  });

  for (const curtain of [
    { kind: 'handoff', to: 1, reason: 'counter' },
    { kind: 'reveal', to: 1 },
    { kind: 'recap', to: 1, entries: [oneOff] },
  ] satisfies CurtainState[]) {
    it(`${curtain.kind}: nothing is exposed, and no card identity from the fetched view is reachable`, async () => {
      const { store } = restoreWith(baseSnapshot({ viewer: 1, curtain, history: [oneOff] }), viewerEnvelope(1, 1, Phase.AwaitingCounter));
      await store.restore();
      expect(store.curtain).toEqual(curtain);
      expect(store.envelope).toBeNull();
      expect(store.view).toBeNull();
      expect(store.viewer).toBeNull();
      expect(store.legalMoves).toEqual([]);
      expect(JSON.stringify([store.history, store.curtain])).not.toContain(JSON.stringify(SECRET));
    });
  }

  it('counter window (ack): behind the resume gate, then the decider\'s envelope is exposed and apply() works', async () => {
    const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2 });
    const restored = envelope({
      ...viewerEnvelope(1, 1, Phase.AwaitingCounter),
      legalMoves: [{ Kind: Kind.Decline, Card: null, HandIndex: -1, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null }],
      descriptions: ['decline'],
    });
    const apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 1, phase: Phase.Normal }), lastMove: decline, history: [oneOff, decline] }));
    const { store } = restoreWith(
      baseSnapshot({ viewer: 1, curtain: { kind: 'ack', to: 1 }, history: [oneOff] }),
      restored,
      { apply, view: () => restored },
    );
    await store.restore();
    expect(store.view).toBeNull();
    await passResumeGate(store);

    expect(store.curtain).toEqual({ kind: 'ack', to: 1 });
    expect(store.viewer).toBe(1);
    expect(store.view?.phase).toBe(Phase.AwaitingCounter);
    expect(store.legalMoves).toHaveLength(1);
    expect(store.isViewerActive).toBe(true);

    await store.apply(0);
    expect(apply).toHaveBeenCalledWith(0);
    expect(store.error).toBeNull();
  });

  // A pre-ruling save resting at a synthetic ack is covered in
  // curtain-one-off-ruling.test.ts (it comes back as that player's reveal).

  it('result: the final view (winner, scoreboard) is exposed', async () => {
    const restored = envelope({ state: playerView({ viewer: 0, active: 0, phase: Phase.GameOver, winner: 0 }), history: [oneOff] });
    const { store } = restoreWith(baseSnapshot({ viewer: 0, curtain: { kind: 'result' }, history: [oneOff] }), restored);
    await store.restore();
    expect(store.curtain).toEqual({ kind: 'result' });
    expect(store.view?.winner).toBe(0);
    expect(store.view?.scoreboard).toBeDefined();
  });
});

describe('B2 on restore: no index survives into a restored curtain', () => {
  it('handoff: the bridge-restored history loses every index key; a stored recap\'s entries likewise', async () => {
    const withIndex = appliedMove({ by: 1, kind: Kind.Draw, seq: 1, index: 3 });
    for (const curtain of [
      { kind: 'handoff', to: 1, reason: 'turn' },
      { kind: 'recap', to: 1, entries: [withIndex] },
    ] satisfies CurtainState[]) {
      const storage = fakeStorage();
      storage.setItem(SNAPSHOT_KEY, encodeSnapshot(baseSnapshot({ viewer: 1, curtain, history: [withIndex] })));
      const engine = createFakeEngine({ restore: () => envelope({ state: playerView({ viewer: 1, active: 1 }), history: [withIndex] }) });
      const store = new GameStore({ engine, storage, session: new SessionStore() });
      await store.restore();
      expect(JSON.stringify(store.history)).not.toContain('"index"');
      expect(JSON.stringify(store.curtain)).not.toContain('"index"');
      expect(JSON.stringify(store.recapFor(1))).not.toContain('"index"');
    }
  });
});

describe('N1 at the store: a structurally inconsistent snapshot is discarded like a version mismatch', () => {
  it('a curtain whose target is not the persisted viewer is discarded (never exposes the wrong player at ack)', async () => {
    const storage = fakeStorage();
    storage.setItem(
      SNAPSHOT_KEY,
      encodeSnapshot(baseSnapshot({ viewer: 0, curtain: { kind: 'ack', to: 1 }, history: [appliedMove({ by: 0, kind: Kind.OneOff, seq: 1 })] })),
    );
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.screen).toBe('home');
    expect(store.notice).toBeTruthy();
    expect(engine.restore).not.toHaveBeenCalled();
    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe('N4: R7.4 null-vs-[] through a real snapshot() -> restore() round trip', () => {
  /** A fake engine whose snapshot()/restore() genuinely round-trip its held views through the opaque string. */
  function roundTrippingEngine(initial: ReturnType<typeof envelope>) {
    let held = initial;
    return createFakeEngine({
      newGame: () => held,
      view: () => held,
      snapshot: () => JSON.stringify(held),
      restore: (json) => {
        held = JSON.parse(json);
        return held;
      },
    });
  }

  for (const hand of [null, []] as const) {
    it(`opponent.hand ${JSON.stringify(hand)} survives newGame -> persisted snapshot -> restore in a fresh store`, async () => {
      const storage = fakeStorage();
      const first = envelope({ state: playerView({ viewer: 0, active: 0, opponent: { handCount: 0, hand: hand === null ? null : [], points: [], permanents: [] } }) });
      const writerEngine = roundTrippingEngine(first);
      const writer = new GameStore({ engine: writerEngine, storage, session: new SessionStore() });
      await startGame(writer, writerEngine, { seed: '5' });

      // A fresh engine instance that knows nothing but what the snapshot carries.
      const reader = new GameStore({ engine: roundTrippingEngine(envelope({ state: playerView({ opponent: { handCount: 9, hand: [{ Rank: 1, Suit: 0 }], points: [], permanents: [] } }) })), storage, session: new SessionStore() });
      await reader.restore();
      await passResumeGate(reader);
      expect(reader.view?.opponent.hand).toEqual(hand);
      if (hand === null) expect(reader.view?.opponent.hand).toBeNull();
      else expect(reader.view?.opponent.hand).not.toBeNull();
    });
  }

  it('against the real WASM bridge: a mid-curtain snapshot restores to the curtain, then to the same board the live game reaches', async () => {
    await createWasmEngine(); // boots the bridge; the stores below use the production engine.ts
    const storage = fakeStorage();
    const live = new GameStore({ storage, session: new SessionStore() });
    await live.newGame({ seed: '42' });
    await advance(live); // W25: through the opening curtain to the first player's board
    const hiddenAtStart = live.view?.opponent.hand;
    expect(hiddenAtStart).toBeNull(); // no glasses on move 0
    const drawIndex = live.envelope!.legalMoves.findIndex((m) => m.Kind === Kind.Draw);
    expect(drawIndex).toBeGreaterThanOrEqual(0);
    await live.apply(drawIndex);
    expect(live.curtain.kind).toBe('handoff');
    const persistedRaw = storage.getItem(SNAPSHOT_KEY);

    const restoredStorage = fakeStorage();
    restoredStorage.setItem(SNAPSHOT_KEY, persistedRaw as string);
    const reloaded = new GameStore({ storage: restoredStorage, session: new SessionStore() });
    await reloaded.restore();
    expect(reloaded.curtain).toEqual(live.curtain);
    expect(reloaded.envelope).toBeNull();

    await advance(live);
    await advance(reloaded);
    expect(reloaded.viewer).toBe(live.viewer);
    expect(reloaded.view).toEqual(live.view);
    expect(reloaded.view?.opponent.hand).toBeNull();
  }, 15_000);
});

async function advance(store: GameStore): Promise<void> {
  for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}
