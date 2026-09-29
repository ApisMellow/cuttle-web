// Issue #27 — the 5's draw reveal, pure half (lib/drawReveal.ts, SPEC §4.7).
//
// `fiveDrawer` names who drew for an entry that resolved a 5 (the chain
// origin's `by`, SPEC §2.7), `unseenDrawFor` finds a draw a player has not
// been shown yet, and `drawnHandIndices` picks the drawn cards out of that
// player's own hand. None of them reads a card identity from history.

import { describe, expect, it } from 'vitest';

import type { AppliedMove, Card } from '../../src/lib/bridge/schema';
import { DRAW_REVEAL_MS, drawnHandIndices, unseenDrawFor } from '../../src/lib/drawReveal';
import { fiveDrawer } from '../../src/lib/recap';
import { Kind, appliedMove } from './game-test-support';

const FIVE: Card = { Rank: 5, Suit: 2 };
const TWO_C: Card = { Rank: 2, Suit: 0 };
const TWO_D: Card = { Rank: 2, Suit: 1 };

function fiveOneOff(seq: number, by: 0 | 1, drawn: number | null): AppliedMove {
  return appliedMove({ by, kind: Kind.OneOff, seq, card: FIVE, description: 'play 5♥ as one-off', drawn });
}

describe('fiveDrawer: who drew, read from kinds and `by` only (SPEC §2.7)', () => {
  it('a 5 that resolved in its own apply: the 5 player', () => {
    const history = [fiveOneOff(1, 0, 2)];
    expect(fiveDrawer(history, 0)).toBe(0);
  });

  it('a 5 played through a 7 (SevenPick, subKind OneOff): the 7 player', () => {
    const history = [appliedMove({ by: 1, kind: Kind.SevenPick, subKind: Kind.OneOff, seq: 3, card: FIVE, drawn: 2 })];
    expect(fiveDrawer(history, 0)).toBe(1);
  });

  it('a Decline that closed the window: the 5 player, not the decliner', () => {
    const history = [fiveOneOff(1, 0, null), appliedMove({ by: 1, kind: Kind.Decline, seq: 2, drawn: 2 })];
    expect(fiveDrawer(history, 1)).toBe(0);
  });

  it('a Counter that closed an even chain: the chain origin, walking back over Counters', () => {
    const history = [
      fiveOneOff(1, 0, null),
      appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: TWO_C }),
      appliedMove({ by: 0, kind: Kind.Counter, seq: 3, card: TWO_D, drawn: 2 }),
    ];
    expect(fiveDrawer(history, 2)).toBe(0);
  });

  it('null for an entry that resolved no 5', () => {
    const history = [fiveOneOff(1, 0, null), appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: TWO_C })];
    expect(fiveDrawer(history, 0)).toBeNull();
    expect(fiveDrawer(history, 1)).toBeNull();
  });
});

describe('unseenDrawFor: a draw the viewer has not been shown yet', () => {
  it('finds the viewer\'s own draw after `seenSeq`', () => {
    const history = [fiveOneOff(1, 0, 2), appliedMove({ by: 1, kind: Kind.Draw, seq: 2 })];
    expect(unseenDrawFor(history, 0, 0)).toEqual({ seq: 1, count: 2 });
  });

  it('never returns the opponent\'s draw', () => {
    const history = [fiveOneOff(1, 0, 2)];
    expect(unseenDrawFor(history, 1, 0)).toBeNull();
  });

  it('a draw at or before `seenSeq` is already seen', () => {
    const history = [fiveOneOff(1, 0, 2)];
    expect(unseenDrawFor(history, 0, 1)).toBeNull();
  });

  it('a 5 that drew nothing (empty deck or full hand) has nothing to show', () => {
    expect(unseenDrawFor([fiveOneOff(1, 0, 0)], 0, 0)).toBeNull();
  });

  it('a one-card draw (the deck held one card) shows one card', () => {
    expect(unseenDrawFor([fiveOneOff(4, 1, 1)], 1, 0)).toEqual({ seq: 4, count: 1 });
  });

  it('a cancelled 5 (drawn stays null everywhere) shows nothing', () => {
    const history = [fiveOneOff(1, 0, null), appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: TWO_C })];
    expect(unseenDrawFor(history, 0, 0)).toBeNull();
  });

  it('the Decline-resolved draw belongs to the 5 player', () => {
    const history = [fiveOneOff(1, 0, null), appliedMove({ by: 1, kind: Kind.Decline, seq: 2, drawn: 2 })];
    expect(unseenDrawFor(history, 0, 1)).toEqual({ seq: 2, count: 2 });
    expect(unseenDrawFor(history, 1, 0)).toBeNull();
  });
});

describe('drawnHandIndices: the drawn cards are the end of the drawer\'s own hand', () => {
  const hand: Card[] = [
    { Rank: 1, Suit: 0 },
    { Rank: 13, Suit: 1 },
    { Rank: 8, Suit: 2 },
    { Rank: 6, Suit: 3 },
  ];

  it('the last `count` cards (engine/apply.go v0.2.0 case Five appends)', () => {
    expect(drawnHandIndices({ hand, frozenHandIndices: [] }, 2, false)).toEqual([2, 3]);
    expect(drawnHandIndices({ hand, frozenHandIndices: [] }, 1, false)).toEqual([3]);
  });

  it('skips a frozen tail when asked (an opponent 9 appended a returned card after the draw)', () => {
    expect(drawnHandIndices({ hand, frozenHandIndices: [3] }, 2, true)).toEqual([1, 2]);
  });

  it('keeps a frozen tail when not asked (a stale freeze on the mover\'s own apply)', () => {
    expect(drawnHandIndices({ hand, frozenHandIndices: [3] }, 2, false)).toEqual([2, 3]);
  });

  it('never returns more indices than the hand holds, and none for a zero count', () => {
    expect(drawnHandIndices({ hand: hand.slice(0, 1), frozenHandIndices: [] }, 2, false)).toEqual([0]);
    expect(drawnHandIndices({ hand, frozenHandIndices: [] }, 0, false)).toEqual([]);
  });
});

describe('timing', () => {
  it('the reveal waits 3 seconds before continuing on its own (issue #27)', () => {
    expect(DRAW_REVEAL_MS).toBe(3000);
  });
});
