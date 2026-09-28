import { describe, expect, it, vi } from 'vitest';

import { SessionStore, session } from '../../src/lib/stores/session.svelte';

describe('session store (SPEC §5.3, §8 OQ-12)', () => {
  it('defaults to "Player 1"/"Player 2" when both names are blank', () => {
    const store = new SessionStore();
    store.setNames('', '   ');
    expect(store.names).toEqual(['Player 1', 'Player 2']);
  });

  it('keeps trimmed non-blank names', () => {
    const store = new SessionStore();
    store.setNames('  Alice ', 'Bob');
    expect(store.names).toEqual(['Alice', 'Bob']);
  });

  it('R1.2: the first game of a session passes no dealer (SPEC §2.6, §8 OQ-12)', () => {
    const store = new SessionStore();
    expect(store.lastDealer).toBeNull();
    expect(store.nextDealer).toBeUndefined();
  });

  it('R1.2: computes dealer = 1 - lastDealer on rematch (SPEC §2.6, §8 OQ-12)', () => {
    const store = new SessionStore();
    store.recordDealer(1);
    expect(store.nextDealer).toBe(0);

    store.recordDealer(0);
    expect(store.nextDealer).toBe(1);
  });

  it('records the current seed for display (SPEC §8 OQ-12: "surface the current seed... and nowhere else")', () => {
    const store = new SessionStore();
    expect(store.lastSeed).toBeNull();
    store.recordSeed('42');
    expect(store.lastSeed).toBe('42');
  });

  it('R3.2 groundwork: records a game result into the per-player tally', () => {
    const store = new SessionStore();
    expect(store.tally).toEqual({ 0: 0, 1: 0 });

    store.recordResult(0);
    expect(store.tally).toEqual({ 0: 1, 1: 0 });

    store.recordResult(0);
    store.recordResult(1);
    expect(store.tally).toEqual({ 0: 2, 1: 1 });
  });

  it('groundwork for R3.3: session module never touches storage (SPEC §5.3 "memory only; never persisted")', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');

    const store = new SessionStore();
    store.setNames('Carol', 'Dave');
    store.recordDealer(0);
    store.recordSeed('7');
    store.recordResult(0);
    store.recordResult(1);

    expect(getItemSpy).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });

  it('exports a ready-to-use singleton', () => {
    expect(session).toBeInstanceOf(SessionStore);
  });
});
