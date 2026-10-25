// Issue #53 (SPEC §4.8): which cards a global wipe took off the rows.

import { describe, expect, it } from 'vitest';

import type { AppliedMove, Card, PlayerId, PointEntry } from '../../src/lib/bridge/schema';
import { MoveKind } from '../../src/lib/enums';
import { globalWipe, isGlobalWipeMove, wipedCards } from '../../src/lib/globalEffect';

const card = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });

function point(c: Card, owner: PlayerId, jacks: Card[] = []): PointEntry {
  return { Card: c, Owner: owner, JackStack: jacks, JackOwners: jacks.map(() => owner), Controller: owner };
}

interface Side {
  points: PointEntry[];
  permanents: Card[];
}

function rows(viewer: PlayerId, you: Side, opponent: Side) {
  return { viewer, you, opponent };
}

function entry(kind: number, rank: Card['Rank'], subKind: number | null = null): AppliedMove {
  return {
    by: 0,
    kind: kind as AppliedMove['kind'],
    card: card(rank, 2),
    description: '',
    seq: 9,
    subKind: subKind as AppliedMove['subKind'],
    targetCard: null,
    drawn: null,
  };
}

const empty: Side = { points: [], permanents: [] };
const queen = card(12, 0);
const glasses = card(8, 3);

const before = rows(
  0,
  { points: [point(card(7, 0), 0), point(card(9, 1), 0, [card(11, 2)])], permanents: [queen] },
  { points: [point(card(10, 3), 1)], permanents: [glasses] },
);

describe('wipedCards', () => {
  it('an Ace one-off: every point card on both sides, with the Jack on one', () => {
    const after = rows(0, { points: [], permanents: [queen] }, { points: [], permanents: [glasses] });
    expect(wipedCards(entry(MoveKind.OneOff, 1), before, after)).toEqual([
      { card: card(7, 0), seat: 0, row: 'points', slot: 0, jack: -1 },
      { card: card(9, 1), seat: 0, row: 'points', slot: 1, jack: -1 },
      { card: card(11, 2), seat: 0, row: 'points', slot: 1, jack: 0 },
      { card: card(10, 3), seat: 1, row: 'points', slot: 0, jack: -1 },
    ]);
  });

  it('a 6 one-off: every permanent on both sides', () => {
    const after = rows(0, { points: before.you.points, permanents: [] }, { points: before.opponent.points, permanents: [] });
    expect(wipedCards(entry(MoveKind.OneOff, 6), before, after)).toEqual([
      { card: queen, seat: 0, row: 'permanents', slot: 0, jack: -1 },
      { card: glasses, seat: 1, row: 'permanents', slot: 0, jack: -1 },
    ]);
  });

  it('a 7 picking an Ace: the same wipe', () => {
    const after = rows(0, { points: [], permanents: [queen] }, { points: [], permanents: [glasses] });
    const cards = wipedCards(entry(MoveKind.SevenPick, 1, MoveKind.OneOff), before, after);
    expect(cards.map((w) => w.card)).toEqual([card(7, 0), card(9, 1), card(11, 2), card(10, 3)]);
  });

  it('reads seats from each view, so the before and after views may be different viewers', () => {
    const after = rows(1, { points: [], permanents: [glasses] }, { points: [], permanents: [queen] });
    expect(wipedCards(entry(MoveKind.OneOff, 1), before, after).map((w) => w.seat)).toEqual([0, 0, 0, 1]);
  });

  it('a non-global one-off gives none, even when rows changed', () => {
    const after = rows(0, { points: [], permanents: [] }, empty);
    expect(wipedCards(entry(MoveKind.OneOff, 2), before, after)).toEqual([]);
    expect(wipedCards(entry(MoveKind.PlayPoint, 1), before, after)).toEqual([]);
    expect(wipedCards(entry(MoveKind.SevenPick, 1, MoveKind.PlayPoint), before, after)).toEqual([]);
  });

  it('a wipe of nothing gives none', () => {
    const bare = rows(0, empty, empty);
    expect(wipedCards(entry(MoveKind.OneOff, 1), bare, bare)).toEqual([]);
    expect(globalWipe(entry(MoveKind.OneOff, 6), bare, bare)).toBeNull();
  });

  it('globalWipe keys the list to the entry seq and mover', () => {
    const after = rows(0, { points: [], permanents: [queen] }, { points: [], permanents: [glasses] });
    const wipe = globalWipe(entry(MoveKind.OneOff, 1), before, after);
    expect(wipe?.seq).toBe(9);
    expect(wipe?.by).toBe(0);
    expect(wipe?.cards).toHaveLength(4);
  });

  it('isGlobalWipeMove: Ace or 6, as a one-off or a 7 pick only', () => {
    expect(isGlobalWipeMove(entry(MoveKind.OneOff, 1))).toBe(true);
    expect(isGlobalWipeMove(entry(MoveKind.OneOff, 6))).toBe(true);
    expect(isGlobalWipeMove(entry(MoveKind.SevenPick, 6, MoveKind.OneOff))).toBe(true);
    expect(isGlobalWipeMove(entry(MoveKind.OneOff, 5))).toBe(false);
    expect(isGlobalWipeMove(entry(MoveKind.Scuttle, 1))).toBe(false);
    expect(isGlobalWipeMove(entry(MoveKind.SevenPick, 6, MoveKind.PlayPermanent))).toBe(false);
  });
});
