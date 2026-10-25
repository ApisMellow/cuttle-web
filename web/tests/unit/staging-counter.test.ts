// Issue #93 (SPEC §4.3): the counter is a board play. A selected 2 lights
// the centre last-turn marker (`counter-link`); a tap there stages "Counter
// with 2♣: undo NAME's last turn." for Confirm, and a drop there applies at
// once through the same tap (GameScreen, #51). A pending win's "Let it
// happen" (`let-it-happen`) is one tap. An owed discard offers the Counter
// alongside the discard picks.

import { describe, expect, it, vi } from 'vitest';

import type { Card, Move } from '../../src/lib/bridge/schema';
import { dropTarget, targetKeyFromTestId, testIdForKey } from '../../src/lib/dragDrop';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';
import { parseTargetKey } from '../../src/lib/targetKey';

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

const TWO_CLUBS: Card = { Rank: 2, Suit: 0 };
const SEVEN_DIAMONDS: Card = { Rank: 7, Suit: 1 };
const KING_CLUBS: Card = { Rank: 13, Suit: 0 };

async function neverApply(): Promise<void> {
  throw new Error('apply() should not have been called by this test');
}

function env(legalMoves: Move[], hand: Card[], extra: Partial<StagingEnv> = {}): () => StagingEnv {
  const descriptions = legalMoves.map((m) =>
    m.Kind === 5 ? 'counter with 2♣' : m.Kind === 6 ? 'Let it happen' : m.Kind === 8 ? `discard hand[${m.DiscardA}] and hand[${m.DiscardB}]` : 'other',
  );
  return () => ({ legalMoves, descriptions, handSize: hand.length, hand, opponentName: 'Blake', ...extra });
}

// Phase 0 after Blake's counterable turn: Alice holds 2♣ (0) and 7♦ (1).
const PHASE0: Move[] = [
  move({ Kind: 0 }),
  move({ Kind: 1, HandIndex: 0, Card: TWO_CLUBS }),
  move({ Kind: 1, HandIndex: 1, Card: SEVEN_DIAMONDS }),
  move({ Kind: 5, HandIndex: 0, Card: TWO_CLUBS }),
];
const PHASE0_HAND = [TWO_CLUBS, SEVEN_DIAMONDS];

describe('issue #93: the counter-link and let-it-happen keys', () => {
  it('both keys parse, and each is its own testid both ways', () => {
    expect(parseTargetKey('counter-link')).toBe('counter-link');
    expect(parseTargetKey('let-it-happen')).toBe('let-it-happen');
    expect(testIdForKey('counter-link')).toBe('counter-link');
    expect(testIdForKey('let-it-happen')).toBe('let-it-happen');
    expect(targetKeyFromTestId('counter-link')).toBe('counter-link');
    expect(targetKeyFromTestId('let-it-happen')).toBe('let-it-happen');
  });

  it('a drop on a lit counter-link is a tap on it; a drop on let-it-happen is never a drop target', () => {
    expect(dropTarget('counter-link', new Set(['counter-link']), 0)).toBe('counter-link');
    expect(dropTarget('counter-link', new Set(['zone:points']), 0)).toBeNull();
    expect(dropTarget('let-it-happen', new Set(['counter-link']), 0)).toBeNull();
  });
});

describe('issue #93: countering from the board (phase 0)', () => {
  it('nothing is lit before a 2 is selected; selecting it lights counter-link with its other targets', () => {
    const store = new StagingStore(env(PHASE0, PHASE0_HAND), neverApply);
    expect(store.highlighted).toEqual(new Set());
    expect(store.dimmedHand).toEqual(new Set());
    store.tap('hand:0');
    expect(store.highlighted).toEqual(new Set(['zone:points', 'counter-link']));
    store.tap('hand:1');
    expect(store.highlighted).toEqual(new Set(['zone:points']));
  });

  it('a tap on the 2, then the marker, stages the Counter with its line and waits for Confirm', async () => {
    const apply = vi.fn(async (_i: number) => {});
    const store = new StagingStore(env(PHASE0, PHASE0_HAND), apply);
    store.tap('hand:0');
    store.tap('counter-link');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(3);
    expect(store.stagedDescription).toBe("Counter with 2♣: undo Blake's last turn.");
    expect(store.staged).toEqual(new Set(['hand:0', 'counter-link']));
    expect(apply).not.toHaveBeenCalled();
    await store.confirm();
    expect(apply).toHaveBeenCalledExactlyOnceWith(3);
    expect(store.state).toBe('idle');
  });

  it("without the opponent's name the staged line is the engine's description", () => {
    const store = new StagingStore(env(PHASE0, PHASE0_HAND, { opponentName: undefined }), neverApply);
    store.tap('hand:0');
    store.tap('counter-link');
    expect(store.stagedDescription).toBe('counter with 2♣');
  });

  it('counter-link does nothing until a 2 that can counter is selected', () => {
    const store = new StagingStore(env(PHASE0, PHASE0_HAND), neverApply);
    store.tap('counter-link');
    expect(store.state).toBe('idle');
    store.tap('hand:1');
    store.tap('counter-link');
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });
});

describe('issue #93: a pending win (phase 5)', () => {
  const PHASE5: Move[] = [move({ Kind: 5, HandIndex: 1, Card: TWO_CLUBS }), move({ Kind: 6 })];
  const HAND = [KING_CLUBS, TWO_CLUBS];

  it('only the 2 is playable; "Let it happen" is offered', () => {
    const store = new StagingStore(env(PHASE5, HAND), neverApply);
    expect(store.dimmedHand).toEqual(new Set([0]));
    expect(store.letItHappen).toBe(true);
    store.tap('hand:1');
    expect(store.highlighted).toEqual(new Set(['counter-link']));
  });

  it('one tap on let-it-happen applies the Decline, through confirm(), exactly once', async () => {
    const apply = vi.fn(async (_i: number) => {});
    const store = new StagingStore(env(PHASE5, HAND), apply);
    const done = store.tap('let-it-happen');
    expect(done).toBeInstanceOf(Promise);
    await done;
    expect(apply).toHaveBeenCalledExactlyOnceWith(1);
    expect(store.state).toBe('idle');
  });

  it('a selected 2 does not stop the one tap; a staged Counter does (Confirm/Cancel own it)', async () => {
    const apply = vi.fn(async (_i: number) => {});
    const store = new StagingStore(env(PHASE5, HAND), apply);
    store.tap('hand:1');
    store.tap('counter-link');
    expect(store.state).toBe('staged');
    expect(store.tap('let-it-happen')).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    store.cancel();
    store.tap('hand:1');
    await store.tap('let-it-happen');
    expect(apply).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('let-it-happen is absent and inert where no Decline is offered', () => {
    const store = new StagingStore(env(PHASE0, PHASE0_HAND), neverApply);
    expect(store.letItHappen).toBe(false);
    expect(store.tap('let-it-happen')).toBeUndefined();
    expect(store.state).toBe('idle');
  });
});

describe('issue #93: an owed discard (phase 3 with no pending)', () => {
  // Blake owes 2: hand 7♦ (0), 2♣ (1), K♣ (2). Pairs, then the Counter.
  const HAND = [SEVEN_DIAMONDS, TWO_CLUBS, KING_CLUBS];
  const OWED: Move[] = [
    move({ Kind: 8, DiscardA: 0, DiscardB: 1 }),
    move({ Kind: 8, DiscardA: 0, DiscardB: 2 }),
    move({ Kind: 8, DiscardA: 1, DiscardB: 2 }),
    move({ Kind: 5, HandIndex: 1, Card: TWO_CLUBS }),
  ];

  it('is a discard position; picking the 2 also lights counter-link, which stages the Counter', () => {
    const store = new StagingStore(env(OWED, HAND), neverApply);
    store.reset();
    expect(store.discard).toEqual({ need: 2, picked: [] });
    expect(store.highlighted).toEqual(new Set(['hand:0', 'hand:1', 'hand:2']));
    store.tap('hand:1');
    expect(store.state).toBe('selected');
    expect(store.selectedHand).toBe(1);
    expect(store.highlighted).toEqual(new Set(['hand:0', 'hand:2', 'counter-link']));
    store.tap('counter-link');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(3);
    expect(store.stagedDescription).toBe("Counter with 2♣: undo Blake's last turn.");
  });

  it('picking the 2 and another card discards both instead', () => {
    const store = new StagingStore(env(OWED, HAND), neverApply);
    store.reset();
    store.tap('hand:1');
    store.tap('hand:2');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(2);
    expect(store.stagedDescription).toBe('Discard 2♣ and K♣');
  });

  it('a lone pick that cannot counter lights only the other cards', () => {
    const store = new StagingStore(env(OWED, HAND), neverApply);
    store.reset();
    store.tap('hand:0');
    expect(store.selectedHand).toBeNull();
    expect(store.highlighted).toEqual(new Set(['hand:1', 'hand:2']));
    store.tap('counter-link');
    expect(store.state).toBe('selected');
  });

  it('a one-card hand holding a 2 is not pre-staged; its pick lights counter-link and the scrap', () => {
    const one: Move[] = [move({ Kind: 8, DiscardA: 0, DiscardB: -1 }), move({ Kind: 5, HandIndex: 0, Card: TWO_CLUBS })];
    const store = new StagingStore(env(one, [TWO_CLUBS]), neverApply);
    store.reset();
    expect(store.state).toBe('idle');
    expect(store.discard).toEqual({ need: 1, picked: [] });
    store.tap('hand:0');
    expect(store.state).toBe('selected');
    expect(store.highlighted).toEqual(new Set(['counter-link', 'scrap']));
    store.tap('scrap');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('Discard 2♣');
  });

  it('a one-card hand with no Counter still arrives pre-staged (R15.2)', () => {
    const one: Move[] = [move({ Kind: 8, DiscardA: 0, DiscardB: -1 })];
    const store = new StagingStore(env(one, [KING_CLUBS]), neverApply);
    store.reset();
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
  });
});
