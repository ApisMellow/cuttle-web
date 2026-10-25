// Tutorial T5, S5 (R25.4 first criterion; docs/tutorial-design.md §6.5,
// §10): the tutorial never touches the real game. With a real GameStore
// saved mid-game and a session tally stored, run all five lessons through
// TutorialTable on the real wasm; nothing is written or removed anywhere,
// the save and the tally are byte-identical, the session's names are
// unchanged, and a fresh GameStore's restore() (Resume) lands at the same
// seq and curtain and the same board the live game had.
//
// The bridge holds one game (SPEC §2.4): each lesson's restore replaces it.
// That is safe only because the saved snapshot, not the bridge, is the real
// game's source of truth on Home (design §6.5); this test proves it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameStore } from '../../src/lib/stores/game.svelte';
import { session as appSession, SessionStore, TALLY_KEY } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { TutorialTable } from '../../src/lib/tutorial/table.svelte';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, fakeStorage, passResumeGate } from './game-test-support';
import { driveLesson } from './tutorial-driver';

beforeAll(async () => {
  await createWasmEngine();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function toBoard(store: GameStore): Promise<void> {
  for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}

describe('S5 the tutorial never touches the real game', () => {
  let storage: Storage;
  let tallyStorage: Storage;
  let session: SessionStore;
  let live: GameStore;

  beforeEach(async () => {
    storage = fakeStorage();
    tallyStorage = fakeStorage();
    session = new SessionStore({ storage: tallyStorage });
    session.setNames('Alice', 'Blake');
    session.recordResult(1);
    live = new GameStore({ storage, session });
    await live.newGame({ seed: '42' });
    await toBoard(live);
    // Two real moves, so the save is mid-game (not a fresh deal).
    for (let n = 0; n < 2; n++) {
      const env = live.envelope!;
      const draw = env.legalMoves.findIndex((m) => m.Kind === Kind.Draw);
      await live.apply(draw >= 0 ? draw : 0);
      await toBoard(live);
    }
    expect(live.seq).toBeGreaterThanOrEqual(2);
    expect(storage.getItem(SNAPSHOT_KEY)).not.toBeNull();
    expect(tallyStorage.getItem(TALLY_KEY)).not.toBeNull();
  });

  it('runs all five lessons with no storage write, then Resume lands where the game was', async () => {
    const savedGame = storage.getItem(SNAPSHOT_KEY);
    const savedTally = tallyStorage.getItem(TALLY_KEY);
    const names = [...session.names];
    const appNames = [...appSession.names];
    const tally = { ...session.tally };
    const liveSeq = live.seq;
    const liveView = live.view;

    // Every storage the page has: the injected ones and the real globals.
    const spies = [
      vi.spyOn(storage, 'setItem'),
      vi.spyOn(storage, 'removeItem'),
      vi.spyOn(tallyStorage, 'setItem'),
      vi.spyOn(tallyStorage, 'removeItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const localBefore = JSON.stringify({ ...localStorage });
    const sessionBefore = JSON.stringify({ ...sessionStorage });

    vi.useFakeTimers();
    for (const lesson of LESSONS) {
      for (const seed of [1, 2]) {
        const table = new TutorialTable(lesson, { learnerName: 'Alice', reducedMotion: () => false, onHome: () => {} });
        driveLesson(table, { seed, wrongFirst: 3 });
        expect(table.phase, `lesson ${lesson.id}`).toBe('finished');
        table.goHome();
      }
    }
    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).toBe(localBefore);
    expect(JSON.stringify({ ...sessionStorage })).toBe(sessionBefore);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(savedGame);
    expect(tallyStorage.getItem(TALLY_KEY)).toBe(savedTally);
    expect(session.names).toEqual(names);
    expect(appSession.names).toEqual(appNames);
    expect(session.tally).toEqual(tally);
    for (const spy of spies) spy.mockRestore();

    // Resume through the real wasm from the untouched save.
    const resumed = new GameStore({ storage, session: new SessionStore() });
    await resumed.restore();
    expect(resumed.screen).toBe('game');
    expect(resumed.seq).toBe(liveSeq);
    await passResumeGate(resumed);
    expect(resumed.curtain).toEqual(live.curtain);
    expect(resumed.viewer).toBe(live.viewer);
    expect(resumed.view).toEqual(liveView);
  }, 30_000);
});
