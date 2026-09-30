// Two-phone W12 (docs/two-phone-plan.md §7, "Staging survives a failed
// send"): when the online store's apply sends nothing (the socket is down)
// it rejects with MoveNotSent, and the staged move stays staged so the
// player can confirm it again. Any other rejection still clears to idle.
import { describe, expect, it } from 'vitest';

import type { Move } from '../../src/lib/bridge/schema';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';
import { MoveNotSent } from '../../src/lib/stores/tableSource';

const ACE = { Rank: 1, Suit: 2 } as const;

function move(overrides: Partial<Move>): Move {
  return { Kind: 0, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

const legalMoves = [move({ Kind: 0 }), move({ Kind: 1, HandIndex: 0, Card: ACE })];
const env = (): StagingEnv => ({ legalMoves, descriptions: ['draw a card', 'play ace as point card'] });

function stagedAce(apply: (i: number) => Promise<void>): StagingStore {
  const store = new StagingStore(env, apply);
  store.tap('hand:0');
  store.tap('zone:points');
  expect(store.state).toBe('staged');
  return store;
}

describe('StagingStore: a move that was not sent', () => {
  it('stays staged after MoveNotSent, and confirm() sends it again', async () => {
    const calls: number[] = [];
    let fail = true;
    const store = stagedAce(async (i) => {
      calls.push(i);
      if (fail) throw new MoveNotSent();
    });
    await expect(store.confirm()).resolves.toBeUndefined();
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1);
    expect(store.stagedDescription).toBe('play ace as point card');
    expect(store.staged.has('hand:0')).toBe(true);

    fail = false;
    await store.confirm();
    expect(calls).toEqual([1, 1]);
    expect(store.state).toBe('idle');
  });

  it('any other rejection still clears to idle and is rethrown', async () => {
    const store = stagedAce(async () => {
      throw new Error('boom');
    });
    await expect(store.confirm()).rejects.toThrow('boom');
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });
});
