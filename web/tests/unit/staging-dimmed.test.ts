// P2 W13 — "dim hand cards that have no legal moves" (R9.3, SPEC §6.1).
// W11's `dimmedHand` could only dim an index the engine mentioned in SOME
// move, because `StagingEnv` carried no hand size. With `handSize`, every
// hand index that no stageable move names dims — including the common case:
// a card the engine offered nothing for at all.
import { describe, expect, it } from 'vitest';

import type { Move } from '../../src/lib/bridge/schema';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';

function move(overrides: Partial<Move>): Move {
  return {
    Kind: 0,
    Card: null,
    HandIndex: 0,
    Target: null,
    JackTarget: null,
    ScrapIndex: 0,
    DiscardA: 0,
    DiscardB: 0,
    SubMove: null,
    ...overrides,
  };
}

async function neverApply(): Promise<void> {
  throw new Error('apply() should not have been called');
}

function storeFor(env: StagingEnv): StagingStore {
  return new StagingStore(() => env, neverApply);
}

describe('StagingStore.dimmedHand with handSize (R9.3)', () => {
  it('dims every hand index no stageable move names', () => {
    const legalMoves = [move({ Kind: 0 }), move({ Kind: 1, HandIndex: 1 }), move({ Kind: 4, HandIndex: 3 })];
    const store = storeFor({ legalMoves, descriptions: legalMoves.map(() => 'd'), handSize: 5 });
    expect(store.dimmedHand).toEqual(new Set([0, 2, 4]));
  });

  it('dims the whole hand when only Draw is legal', () => {
    const legalMoves = [move({ Kind: 0 })];
    const store = storeFor({ legalMoves, descriptions: ['draw'], handSize: 3 });
    expect(store.dimmedHand).toEqual(new Set([0, 1, 2]));
  });

  it('issue #93: at a pending win only the 2 with a Counter stays lit; every other card dims', () => {
    const legalMoves = [move({ Kind: 5, HandIndex: 1 }), move({ Kind: 6 })];
    const store = storeFor({ legalMoves, descriptions: ['counter', 'Let it happen'], handSize: 2 });
    expect(store.dimmedHand).toEqual(new Set([0]));
  });

  it('dims nothing when every card has a stageable move', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0 }), move({ Kind: 2, HandIndex: 1 })];
    const store = storeFor({ legalMoves, descriptions: ['a', 'b'], handSize: 2 });
    expect(store.dimmedHand).toEqual(new Set());
  });
});
