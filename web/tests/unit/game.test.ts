// SPEC §5.3 (game store), round-1 review carry-overs 1, 2, 8, 9, and R7.4's
// store leg / R3.3's unit bullet (docs/requirements.yaml). Core newGame/apply
// mechanics; curtain-sequence behavior lives in game-curtain.test.ts and
// restore behavior in game-restore.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';

import type { NewGameOpts } from '../../src/lib/bridge/engine';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { Kind, Phase, appliedMove, createFakeEngine, engineError, envelope, fakeStorage, playerView, startGame } from './game-test-support';

describe('GameStore.newGame (carry-overs 1, 2)', () => {
  let storage: Storage;
  let session: SessionStore;

  beforeEach(() => {
    storage = fakeStorage();
    session = new SessionStore();
  });

  it('carry-over 2: the first game\'s NewGameOpts has no "dealer" key at all', async () => {
    let captured: NewGameOpts | undefined;
    const engine = createFakeEngine({
      newGame: (opts) => {
        captured = opts;
        return envelope({ state: playerView({ active: 0, viewer: 0 }) });
      },
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(captured).toBeDefined();
    expect('dealer' in (captured as object)).toBe(false);
  });

  it('carry-over 2: a rematch passes session.nextDealer as the dealer', async () => {
    session.recordDealer(1); // last game's dealer was P2 -> nextDealer is P1 (0)
    let captured: NewGameOpts | undefined;
    const engine = createFakeEngine({
      newGame: (opts) => {
        captured = opts;
        return envelope({ state: playerView({ active: 1, viewer: 1 }) });
      },
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(captured?.dealer).toBe(0);
  });

  it('carry-over 1: derives dealer as 1 - envelope.state.active and records it on the session', async () => {
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 1, viewer: 1 }) }), // non-dealer (active) is P2 -> dealer is P1
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(session.lastDealer).toBe(0);
  });

  it('carry-over 1: the other dealer parity also derives correctly', async () => {
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(session.lastDealer).toBe(1);
  });

  it('always supplies an explicit seed to the bridge, even when the caller gives none (engineState stays opaque — see game-persistence.test.ts)', async () => {
    let captured: NewGameOpts | undefined;
    const engine = createFakeEngine({
      newGame: (opts) => {
        captured = opts;
        return envelope({ state: playerView() });
      },
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(typeof captured?.seed).toBe('string');
    expect(captured?.seed?.length).toBeGreaterThan(0);
  });

  it('passes through an explicit seed unchanged (for deterministic tests/scenarios)', async () => {
    let captured: NewGameOpts | undefined;
    const engine = createFakeEngine({
      newGame: (opts) => {
        captured = opts;
        return envelope({ state: playerView() });
      },
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame({ seed: '42' });

    expect(captured?.seed).toBe('42');
  });

  it('on success: raises the opening curtain to the first actor and holds no view (W25; the full walk is in game-opening-curtain.test.ts)', async () => {
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 1, viewer: 1 }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await store.newGame();

    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.viewer).toBeNull();
    expect(store.envelope).toBeNull();
    expect(store.screen).toBe('game');
  });

  it('on bridge error: surfaces the EngineError and does not transition to the game screen', async () => {
    const engine = createFakeEngine({ newGame: () => engineError('BAD_REQUEST', 'bad opts') });
    const store = new GameStore({ engine, storage, session });

    await startGame(store, engine);

    expect(store.error).toEqual(engineError('BAD_REQUEST', 'bad opts'));
    expect(store.screen).toBe('home');
    expect(store.envelope).toBeNull();
  });
});

describe('GameStore.apply — basic success/error handling', () => {
  let storage: Storage;
  let session: SessionStore;

  beforeEach(() => {
    storage = fakeStorage();
    session = new SessionStore();
  });

  it('R7.4 store leg: opponent.hand stays null (hidden) through a plain apply with no curtain', async () => {
    // DiscardPair applied from PhaseAwaitingDiscard lands back on the same
    // actor (SPEC §4.4's double-flip note) — the one (phase, kind) pair that
    // produces a "no curtain" result while still exercising a real apply().
    const engine = createFakeEngine({
      newGame: () =>
        envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.AwaitingDiscard, opponent: { handCount: 6, hand: null, points: [], permanents: [] } }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 0, viewer: 0, phase: Phase.Normal, opponent: { handCount: 6, hand: null, points: [], permanents: [] } }),
          lastMove: appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 }),
          history: [appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 })],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);

    expect(store.view?.opponent.hand).toBeNull();
  });

  it('R7.4 store leg: opponent.hand [] (visible, empty) is preserved distinctly from null', async () => {
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, opponent: { handCount: 0, hand: [], points: [], permanents: [] } }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await startGame(store, engine);

    expect(store.view?.opponent.hand).toEqual([]);
    expect(store.view?.opponent.hand).not.toBeNull();
  });

  it('N4 / R7.4 store leg: opponent.hand [] (visible, empty) survives a plain apply with no curtain', async () => {
    const visibleEmpty = { handCount: 0, hand: [], points: [], permanents: [] };
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.AwaitingDiscard, opponent: { ...visibleEmpty, handCount: 1, hand: [{ Rank: 4, Suit: 0 }] } }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 0, viewer: 0, phase: Phase.Normal, opponent: visibleEmpty }),
          lastMove: appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 }),
          history: [appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 })],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);

    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.opponent.hand).toEqual([]);
    expect(store.view?.opponent.hand).not.toBeNull();
  });

  it('on ILLEGAL_MOVE: sets error, leaves envelope/history/curtain untouched (SPEC §2.9 held state unchanged)', async () => {
    const startEnvelope = envelope({ state: playerView({ active: 0, viewer: 0 }) });
    const engine = createFakeEngine({
      newGame: () => startEnvelope,
      apply: () => engineError('ILLEGAL_MOVE', 'nope'),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    const beforeEnvelope = store.envelope;
    const beforeHistory = store.history;
    const beforeCurtain = store.curtain;

    await store.apply(99);

    expect(store.error).toEqual(engineError('ILLEGAL_MOVE', 'nope'));
    expect(store.envelope).toBe(beforeEnvelope);
    expect(store.history).toBe(beforeHistory);
    expect(store.curtain).toBe(beforeCurtain);
  });

  it('throws if apply() is called with no active envelope (defensive — no component exists yet to prevent this)', async () => {
    const engine = createFakeEngine();
    const store = new GameStore({ engine, storage, session });
    await expect(store.apply(0)).rejects.toThrow();
  });
});

describe('R3.3 unit bullet: session tally is never written to the R4 snapshot', () => {
  it('the persisted snapshot JSON has no "tally" key, even with a non-zero tally', async () => {
    const storage = fakeStorage();
    const session = new SessionStore();
    session.recordResult(0);
    session.recordResult(0);
    session.recordResult(1);
    expect(session.tally).toEqual({ 0: 2, 1: 1 });

    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
    });
    const store = new GameStore({ engine, storage, session });

    await startGame(store, engine);

    const raw = storage.getItem(SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'tally')).toBe(false);
    // Belt and suspenders: the whole tally object must not appear anywhere
    // nested either (it would only ever appear at the top level per the
    // Snapshot interface, but assert the values aren't smuggled in some
    // other field's shape).
    expect(JSON.stringify(parsed)).not.toContain('"tally"');
  });
});
