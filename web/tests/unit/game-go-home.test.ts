// In-game menu, Home (SPEC §5.3 goHome, §5.7; R4). Strict tier: save/resume.
//
// The menu's Home leaves a game at ANY curtain kind, and Resume must bring
// back exactly what was there: the same curtain, the same viewer (or none
// behind a withheld curtain), the same envelope, history, seq and
// lastSeenSeq, and a save that is byte-for-byte the one Home left behind.
// Home writes nothing; Resume only reads.
//
// Walked through the REAL engine (the production bridge, booted by
// createWasmEngine) on the golden deal (seed "42", dealer P2): Alice holds
// 2♥ 3♣ A♥ K♦ Q♣, Blake 5♥ 9♥ 8♦ 4♦ 5♠ 4♥. Alice draws (keeping her 2),
// Blake plays 5♥ as a one-off, so Alice gets a REAL counter window. Every
// state on the way (opening handoff and reveal, the board, Blake's handoff,
// reveal and recap, Alice's response handoff, reveal, recap and the real
// ack) is round-tripped through Home -> Resume and then played on.

import { describe, expect, it } from 'vitest';

import type { PlayerId } from '../../src/lib/bridge/schema';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, createFakeEngine, envelope, fakeStorage, passResumeGate, playerView } from './game-test-support';

/** Everything Resume must restore, as plain data. */
function capture(store: GameStore): unknown {
  return JSON.parse(
    JSON.stringify({
      curtain: store.curtain,
      viewer: store.viewer,
      envelope: store.envelope,
      history: store.history,
      seq: store.seq,
      lastSeenSeq: store.lastSeenSeq,
      screen: store.screen,
    }),
  );
}

/**
 * Home then Resume; asserts the save is untouched and the state comes back
 * identical. At a resting curtain (`none`, an `ack`) Resume first raises the
 * resume gate (SPEC §5.7, ruling 2026-09-29), holding no view; the state is
 * compared once the gate is passed, and the gate writes nothing.
 */
async function homeAndResume(store: GameStore, storage: Storage): Promise<void> {
  const saved = storage.getItem(SNAPSHOT_KEY);
  expect(saved).not.toBeNull();
  const before = capture(store);
  const resting = store.curtain.kind === 'none' || store.curtain.kind === 'ack';

  store.goHome();
  expect(store.screen).toBe('home');
  expect(store.envelope).toBeNull();
  expect(store.viewer).toBeNull();
  expect(store.history).toEqual([]);
  expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);

  await store.restore();
  expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);
  if (resting) {
    expect(store.curtain).toMatchObject({ kind: 'handoff', reason: 'resume' });
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    await passResumeGate(store);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);
  }
  expect(capture(store)).toEqual(before);
}

describe('Home -> Resume round-trips the save at every curtain kind (real engine)', () => {
  it('opening curtain, board, turn handoff, recap, response handoff and a real counter window all come back identically and play on', async () => {
    await createWasmEngine();
    const storage = fakeStorage();
    const store = new GameStore({ storage, session: new SessionStore() });
    const visited = new Set<string>();

    async function roundTripAndAdvanceTo(target: 'none' | 'ack'): Promise<void> {
      for (let i = 0; i < 6 && store.curtain.kind !== target; i++) {
        visited.add(store.curtain.kind);
        await homeAndResume(store, storage);
        await store.advanceCurtain();
      }
      expect(store.curtain.kind).toBe(target);
      visited.add(store.curtain.kind);
      await homeAndResume(store, storage);
    }

    function moveIndex(kind: number, rank?: number): number {
      const env = store.envelope!;
      const i = env.legalMoves.findIndex((m) => m.Kind === kind && (rank === undefined || m.Card?.Rank === rank));
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    }

    await store.newGame({ seed: '42', dealer: 1 });
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'turn' });
    await roundTripAndAdvanceTo('none');
    expect(store.viewer).toBe(0 as PlayerId);

    // Alice draws; the phone goes to Blake.
    await store.apply(moveIndex(Kind.Draw));
    await roundTripAndAdvanceTo('none');
    expect(store.viewer).toBe(1 as PlayerId);

    // Blake: 5 as a one-off. Alice holds 2♥: a real counter window.
    await store.apply(moveIndex(Kind.OneOff, 5));
    await roundTripAndAdvanceTo('ack');
    expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: false });
    expect(store.envelope!.legalMoves.some((m) => m.Kind === Kind.Counter)).toBe(true);

    // The restored window still plays: Alice lets it resolve.
    await store.apply(moveIndex(Kind.Decline));
    for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    expect(store.curtain.kind).toBe('none');
    await homeAndResume(store, storage);

    expect([...visited].sort()).toEqual(['ack', 'handoff', 'none', 'recap', 'reveal']);
  }, 20_000);
});

/** A save with its write timestamp blanked, for comparing two runs of the same game. */
function saveWithoutTime(storage: Storage): unknown {
  const raw = storage.getItem(SNAPSHOT_KEY);
  return raw === null ? null : { ...JSON.parse(raw), savedAt: '' };
}

/**
 * Plays `script` through the real engine on a fresh store. With `roundTrip`,
 * every resting state on the way (each curtain step, each board) goes
 * through Home -> Resume first. Returns the end state and save.
 */
async function walk(
  script: (step: { store: GameStore; settle: (target: 'none' | 'ack' | 'result') => Promise<void>; move: (kind: number, rank?: number) => number }) => Promise<void>,
  roundTrip: boolean,
): Promise<{ end: unknown; save: unknown; visited: string[] }> {
  const storage = fakeStorage();
  const store = new GameStore({ storage, session: new SessionStore() });
  const visited: string[] = [];
  async function here(): Promise<void> {
    visited.push(store.curtain.kind + ('synthetic' in store.curtain ? `:${store.curtain.synthetic ? 'synthetic' : 'real'}` : ''));
    if (roundTrip) await homeAndResume(store, storage);
  }
  async function settle(target: 'none' | 'ack' | 'result'): Promise<void> {
    for (let i = 0; i < 6 && store.curtain.kind !== target; i++) {
      await here();
      await store.advanceCurtain();
    }
    expect(store.curtain.kind).toBe(target);
    await here();
  }
  function move(kind: number, rank?: number): number {
    const i = store.envelope!.legalMoves.findIndex((m) => m.Kind === kind && (rank === undefined || m.Card?.Rank === rank));
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  }
  await script({ store, settle, move });
  return { end: capture(store), save: saveWithoutTime(storage), visited };
}

describe('Home -> Resume at a synthetic ack and at result (real engine)', () => {
  it('synthetic ack: every step round-trips, and the resumed game ends exactly where the uninterrupted one does', async () => {
    await createWasmEngine();
    // Alice plays 2♥ for points; Blake plays 5♥ as a one-off; Alice holds no 2.
    const script: Parameters<typeof walk>[0] = async ({ store, settle, move }) => {
      await store.newGame({ seed: '42', dealer: 1 });
      await settle('none');
      await store.apply(move(Kind.PlayPoint, 2));
      await settle('none');
      await store.apply(move(Kind.OneOff, 5));
      await settle('ack');
      expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: true });
      await store.advanceCurtain(); // "Let it resolve": no bridge call on the synthetic path
      await settle('none');
      await store.apply(move(Kind.Draw));
      await settle('none');
    };
    const resumed = await walk(script, true);
    const continued = await walk(script, false);
    expect(resumed.visited).toContain('ack:synthetic');
    expect(resumed.visited).toEqual(continued.visited);
    expect(resumed.end).toEqual(continued.end);
    expect(resumed.save).toEqual(continued.save);
  }, 20_000);

  it('result: Home at a finished game and Resume bring back the result, save byte-identical', async () => {
    await createWasmEngine();
    const storage = fakeStorage();
    const store = new GameStore({ storage, session: new SessionStore() });
    await store.newGame({ seed: '42', dealer: 1 });
    // Play to the end: draw while the engine offers it, else its first move;
    // every curtain is walked; a counter window is let resolve.
    for (let ply = 0; ply < 400 && store.curtain.kind !== 'result'; ply++) {
      if (store.curtain.kind !== 'none' && !(store.curtain.kind === 'ack' && !store.curtain.synthetic)) {
        await store.advanceCurtain();
        continue;
      }
      const moves = store.envelope!.legalMoves;
      const decline = moves.findIndex((m) => m.Kind === Kind.Decline);
      const draw = moves.findIndex((m) => m.Kind === Kind.Draw);
      await store.apply(decline >= 0 ? decline : draw >= 0 ? draw : 0);
    }
    expect(store.curtain.kind).toBe('result');
    await homeAndResume(store, storage);
    expect(store.curtain.kind).toBe('result');
    expect(store.view).not.toBeNull();
    expect(store.view!.winner !== null || store.view!.stalemate).toBe(true);
  }, 20_000);
});

describe('goHome contract (SPEC §5.3, amended for the in-game menu)', () => {
  it('is allowed at a withheld curtain, holds no view, and never calls the engine or writes the save', async () => {
    const storage = fakeStorage();
    const deal = envelope({ state: playerView({ viewer: 0, active: 0 }) });
    const engine = createFakeEngine({ newGame: () => deal });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '7' });
    expect(store.curtain.kind).toBe('handoff');
    const saved = storage.getItem(SNAPSHOT_KEY);
    const setItem = storage.setItem.bind(storage);
    let writes = 0;
    storage.setItem = (k: string, v: string) => {
      writes++;
      setItem(k, v);
    };

    store.goHome();

    expect(writes).toBe(0);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);
    expect(store.screen).toBe('home');
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    // No pending curtain context survives Home: there is nothing to advance.
    await expect(store.advanceCurtain()).rejects.toThrow(/no pending curtain context/);
    expect(engine.view).not.toHaveBeenCalled();
    expect(engine.apply).not.toHaveBeenCalled();
    expect(engine.restore).not.toHaveBeenCalled();
  });

  it('at the live board, drops the viewer\'s envelope and mover-only history from memory', async () => {
    const storage = fakeStorage();
    const deal = envelope({ state: playerView({ viewer: 0, active: 0 }) });
    const engine = createFakeEngine({ newGame: () => deal, view: () => deal });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '7' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    expect(store.envelope).not.toBeNull();

    store.goHome();

    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    expect(store.history).toEqual([]);
    expect(store.seq).toBe(0);
  });
});
