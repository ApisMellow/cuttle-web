// R3 tally survives a reload (SPEC §5.3 session.svelte.ts, §5.7; ruling
// 2026-09-29, superseding "memory only"). Playtest finding: a 0–2 tally read
// 1–0 after a reload.
//
// Ruling: the tally is kept in sessionStorage (`cuttle-web:tally`), keyed to
// the ordered name pair. It lives as long as the browser tab (PRD §4's
// "browser session"), survives a reload, and never enters the game snapshot.
// Changing the names starts a fresh tally; there is no other "new match".

import { describe, expect, it } from 'vitest';

import { SessionStore, TALLY_KEY } from '../../src/lib/stores/session.svelte';
import { fakeStorage } from './game-test-support';

/** A reload: a fresh store over the same storage. */
function reload(storage: Storage): SessionStore {
  return new SessionStore({ storage });
}

describe('the tally survives a reload for the same players', () => {
  it('0–2 before the reload is 0–2 after it, once the saved game puts the names back', () => {
    const storage = fakeStorage();
    const before = new SessionStore({ storage });
    before.setNames('Alice', 'Blake');
    before.recordResult(1);
    before.recordResult(1);
    expect(before.tally).toEqual({ 0: 0, 1: 2 });

    const after = reload(storage);
    // Restore (or Home's New game) sets the names; the pair's tally comes back.
    after.setNames('Alice', 'Blake');
    expect(after.tally).toEqual({ 0: 0, 1: 2 });

    after.recordResult(0);
    expect(reload(storage).tally).toEqual({ 0: 0, 1: 0 }); // default names: not this pair
    const third = reload(storage);
    third.setNames('Alice', 'Blake');
    expect(third.tally).toEqual({ 0: 1, 1: 2 });
  });

  it('players who never set names keep their tally too (the default pair)', () => {
    const storage = fakeStorage();
    const before = new SessionStore({ storage });
    before.recordResult(0);
    expect(reload(storage).tally).toEqual({ 0: 1, 1: 0 });
  });

  it('setting the same names again keeps the tally (a rematch or New game with the same players)', () => {
    const storage = fakeStorage();
    const store = new SessionStore({ storage });
    store.setNames('Alice', 'Blake');
    store.recordResult(0);
    store.setNames(' Alice ', 'Blake');
    expect(store.tally).toEqual({ 0: 1, 1: 0 });
  });
});

describe('changing the names starts a fresh tally', () => {
  it('a different pair reads 0–0, in memory and after a reload', () => {
    const storage = fakeStorage();
    const store = new SessionStore({ storage });
    store.setNames('Alice', 'Blake');
    store.recordResult(0);
    store.setNames('Alice', 'Casey');
    expect(store.tally).toEqual({ 0: 0, 1: 0 });

    const after = reload(storage);
    after.setNames('Alice', 'Casey');
    expect(after.tally).toEqual({ 0: 0, 1: 0 });
    after.setNames('Alice', 'Blake');
    expect(after.tally).toEqual({ 0: 0, 1: 0 });
  });

  it('swapping seats is a different pair (the tally is per seat)', () => {
    const storage = fakeStorage();
    const store = new SessionStore({ storage });
    store.setNames('Alice', 'Blake');
    store.recordResult(0);
    store.setNames('Blake', 'Alice');
    expect(store.tally).toEqual({ 0: 0, 1: 0 });
  });
});

describe('storage hygiene', () => {
  it('writes only its own key, as the names and the tally', () => {
    const storage = fakeStorage();
    const store = new SessionStore({ storage });
    store.setNames('Alice', 'Blake');
    store.recordResult(1);
    expect(storage.length).toBe(1);
    expect(JSON.parse(storage.getItem(TALLY_KEY) as string)).toEqual({ names: ['Alice', 'Blake'], tally: { 0: 0, 1: 1 } });
  });

  it('a corrupt or foreign value is ignored: 0–0, no throw', () => {
    for (const raw of ['not json', '{"names":["Alice"],"tally":{"0":1,"1":0}}', '{"names":["Alice","Blake"],"tally":{"0":"x","1":0}}', '{"names":["Alice","Blake"],"tally":{"0":-1,"1":0}}', 'null']) {
      const storage = fakeStorage();
      storage.setItem(TALLY_KEY, raw);
      const store = new SessionStore({ storage });
      store.setNames('Alice', 'Blake');
      expect(store.tally, raw).toEqual({ 0: 0, 1: 0 });
    }
  });

  it('a storage that throws never breaks play', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = new SessionStore({ storage: throwing });
    store.setNames('Alice', 'Blake');
    store.recordResult(0);
    expect(store.tally).toEqual({ 0: 1, 1: 0 });
  });

  it('a store built without storage touches none and keeps the tally in memory only', () => {
    const store = new SessionStore();
    store.setNames('Alice', 'Blake');
    store.recordResult(0);
    expect(store.tally).toEqual({ 0: 1, 1: 0 });
    expect(new SessionStore().tally).toEqual({ 0: 0, 1: 0 });
  });
});
