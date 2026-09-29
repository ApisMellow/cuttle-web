// W25 item 3 — deck tap with a card selected, and clearing a selection from
// empty board space (live playtest fixes). SPEC §6.1: a single tap never
// applies; the deck tap stages Draw, and only Confirm applies it.
import { describe, expect, it } from 'vitest';

import type { Move } from '../../src/lib/bridge/schema';
import { MoveKind } from '../../src/lib/enums';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';

function move(overrides: Partial<Move>): Move {
  return { Kind: 0, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

async function neverApply(): Promise<void> {
  throw new Error('apply() should not have been called by this test');
}

const MOVES: Move[] = [
  move({ Kind: MoveKind.Draw }),
  move({ Kind: MoveKind.PlayPoint, HandIndex: 0, Card: { Rank: 3, Suit: 0 } }),
];
const env = (legalMoves: Move[]) => (): StagingEnv => ({ legalMoves, descriptions: legalMoves.map((_, i) => ['draw a card', 'play 3♣ as point card'][i]) });

describe('W25: deck tap while a card is selected', () => {
  it('stages Draw in one tap when Draw is legal (and never applies)', () => {
    const store = new StagingStore(env(MOVES), neverApply);
    store.tap('hand:0');
    expect(store.state).toBe('selected');
    store.tap('deck');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('draw a card');
    expect(store.selectedHand).toBeNull();
    expect(store.staged).toEqual(new Set(['deck']));
  });

  it('only deselects when Draw is not legal', () => {
    const store = new StagingStore(env(MOVES.slice(1)), neverApply);
    store.tap('hand:0');
    store.tap('deck');
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });
});

describe('W25: clearSelection (empty board space, score bar)', () => {
  it('clears a selected card to idle', () => {
    const store = new StagingStore(env(MOVES), neverApply);
    store.tap('hand:0');
    store.clearSelection();
    expect(store.state).toBe('idle');
    expect(store.selectedHand).toBeNull();
    expect(store.highlighted.size).toBe(0);
  });

  it('leaves a staged move alone (Cancel is the control once staged)', () => {
    const store = new StagingStore(env(MOVES), neverApply);
    store.tap('deck');
    store.clearSelection();
    expect(store.state).toBe('staged');
  });
});
