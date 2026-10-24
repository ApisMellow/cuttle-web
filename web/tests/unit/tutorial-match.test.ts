// R25.2 / R25.3 (docs/tutorial-plan.md T3): the lesson move predicate.
// Pure: fixtures are wire-true Move shapes (engine v0.2.1):
//   - a Jack steal is PlayPermanent with JackTarget set and Target null
//     (engine/apply.go:88-97);
//   - Scuttle and a targeted OneOff carry Target, JackTarget null
//     (engine/apply.go:44-87, :112-123);
//   - an untargeted OneOff, PlayPoint, a non-Jack PlayPermanent and Draw carry
//     neither (engine/apply.go:34-35, :41-42, :113, :124-129);
//   - Target.Owner is an absolute seat (engine/state.go:78-82), so a viewer of
//     1 reads Owner 1 as "you";
//   - a SevenPick wraps its SubMove; a dead-end one has SubMove null
//     (engine/apply.go:524-544).
import { describe, expect, it } from 'vitest';

import type { Card, Envelope, Move, PlayerView, PointEntry, Target } from '../../src/lib/bridge/schema';
import { matchingIndices, moveMatches, nudgeFor, targetCardOf } from '../../src/lib/tutorial/match';
import type { MovePredicate, MoveStep } from '../../src/lib/tutorial/types';
import { Kind, envelope, playerView } from './game-test-support';

const card = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });
const C = 0, D = 1, H = 2, S = 3;

function move(over: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return {
    Card: null,
    HandIndex: 0,
    Target: null,
    JackTarget: null,
    ScrapIndex: 0,
    DiscardA: 0,
    DiscardB: 0,
    SubMove: null,
    ...over,
  };
}

function point(c: Card, owner: 0 | 1): PointEntry {
  return { Card: c, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const tgt = (Owner: 0 | 1, Zone: 0 | 1, Index: number): Target => ({ Owner, Zone, Index });

// Seat 0 owns 7H, 5C in points and a KS permanent; seat 1 owns 10C, 9D in
// points and KC, 8H permanents. No Queen anywhere, so every 9 and 2 target
// below is one the engine can emit (engine/apply.go:44-87).
const SEAT0_POINTS = [point(card(7, H), 0), point(card(5, C), 0)];
const SEAT0_PERMS = [card(13, S)];
const SEAT1_POINTS = [point(card(10, C), 1), point(card(9, D), 1)];
const SEAT1_PERMS = [card(13, C), card(8, H)];

function viewFor(viewer: 0 | 1): PlayerView {
  const mine = viewer === 0;
  return playerView({
    viewer,
    active: viewer,
    you: {
      hand: [],
      frozenHandIndices: [],
      points: mine ? SEAT0_POINTS : SEAT1_POINTS,
      permanents: mine ? SEAT0_PERMS : SEAT1_PERMS,
      watched: false,
    },
    opponent: {
      handCount: 3,
      hand: null,
      points: mine ? SEAT1_POINTS : SEAT0_POINTS,
      permanents: mine ? SEAT1_PERMS : SEAT0_PERMS,
    },
  });
}

const V0 = viewFor(0);
const V1 = viewFor(1);

describe('targetCardOf', () => {
  it('maps Owner/Zone/Index against you and opponent for a viewer of 0', () => {
    // 9 one-off at the opponent's second point card.
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(9, C), Target: tgt(1, 0, 1) }), V0)).toEqual(card(9, D));
    // 9 one-off at the opponent's second permanent.
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(9, C), Target: tgt(1, 1, 1) }), V0)).toEqual(card(8, H));
    // A 2 can aim at the mover's own permanent (engine/apply.go:47-56).
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(2, C), Target: tgt(0, 1, 0) }), V0)).toEqual(card(13, S));
    // Scuttle at the opponent's first point card.
    expect(targetCardOf(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 0) }), V0)).toEqual(card(10, C));
  });

  it('maps Owner/Zone/Index against you and opponent for a viewer of 1', () => {
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(9, C), Target: tgt(0, 0, 1) }), V1)).toEqual(card(5, C));
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(9, C), Target: tgt(0, 1, 0) }), V1)).toEqual(card(13, S));
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(2, C), Target: tgt(1, 1, 1) }), V1)).toEqual(card(8, H));
    expect(targetCardOf(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(0, 0, 0) }), V1)).toEqual(card(7, H));
  });

  it('reads JackTarget for a Jack and Target otherwise', () => {
    const steal = move({ Kind: Kind.PlayPermanent, Card: card(11, D), JackTarget: tgt(1, 0, 1) });
    expect(targetCardOf(steal, V0)).toEqual(card(9, D));
    const scuttle = move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 1) });
    expect(targetCardOf(scuttle, V0)).toEqual(card(9, D));
  });

  it('is null for untargeted moves', () => {
    expect(targetCardOf(move({ Kind: Kind.Draw }), V0)).toBeNull();
    expect(targetCardOf(move({ Kind: Kind.PlayPoint, Card: card(9, D) }), V0)).toBeNull();
    expect(targetCardOf(move({ Kind: Kind.PlayPermanent, Card: card(8, C) }), V0)).toBeNull();
    expect(targetCardOf(move({ Kind: Kind.OneOff, Card: card(1, S) }), V0)).toBeNull();
    expect(targetCardOf(move({ Kind: Kind.Decline }), V0)).toBeNull();
  });

  it('recurses into a SevenPick SubMove; a dead-end SevenPick has no target', () => {
    const sub = move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 0) });
    expect(targetCardOf(move({ Kind: Kind.SevenPick, Card: card(10, H), SubMove: sub }), V0)).toEqual(card(10, C));
    expect(targetCardOf(move({ Kind: Kind.SevenPick, Card: card(10, H), SubMove: null }), V0)).toBeNull();
  });

  it('is null for an index the view does not have', () => {
    expect(targetCardOf(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 5) }), V0)).toBeNull();
  });
});

describe('moveMatches', () => {
  const scuttle9D = move({ Kind: Kind.Scuttle, Card: card(10, H), HandIndex: 0, Target: tgt(1, 0, 1) });

  it('accepts kind, card and target all matching', () => {
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle, card: card(10, H), target: card(9, D) }, V0)).toBe(true);
  });

  it('refuses a kind mismatch', () => {
    expect(moveMatches(scuttle9D, { kind: Kind.OneOff, card: card(10, H), target: card(9, D) }, V0)).toBe(false);
    expect(moveMatches(move({ Kind: Kind.Draw }), { kind: Kind.Pass }, V0)).toBe(false);
  });

  it('refuses a card mismatch', () => {
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle, card: card(10, D), target: card(9, D) }, V0)).toBe(false);
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle, card: card(9, H), target: card(9, D) }, V0)).toBe(false);
  });

  it('refuses a target mismatch', () => {
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle, card: card(10, H), target: card(10, C) }, V0)).toBe(false);
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle, card: card(10, H), target: card(9, C) }, V0)).toBe(false);
  });

  it('a present target refuses an untargeted move; a present card refuses a cardless one', () => {
    expect(moveMatches(move({ Kind: Kind.OneOff, Card: card(1, S) }), { kind: Kind.OneOff, target: card(9, D) }, V0)).toBe(false);
    expect(moveMatches(move({ Kind: Kind.Draw }), { kind: Kind.Draw, card: card(9, D) }, V0)).toBe(false);
  });

  it('accepts either card of a card array', () => {
    const pred: MovePredicate = { kind: Kind.PlayPermanent, card: [card(11, D), card(11, S)], target: card(9, D) };
    const jd = move({ Kind: Kind.PlayPermanent, Card: card(11, D), HandIndex: 0, JackTarget: tgt(1, 0, 1) });
    const js = move({ Kind: Kind.PlayPermanent, Card: card(11, S), HandIndex: 1, JackTarget: tgt(1, 0, 1) });
    const jh = move({ Kind: Kind.PlayPermanent, Card: card(11, H), HandIndex: 2, JackTarget: tgt(1, 0, 1) });
    expect(moveMatches(jd, pred, V0)).toBe(true);
    expect(moveMatches(js, pred, V0)).toBe(true);
    expect(moveMatches(jh, pred, V0)).toBe(false);
  });

  it('accepts either target of a target array', () => {
    const pred: MovePredicate = { kind: Kind.Scuttle, card: card(10, H), target: [card(9, D), card(10, C)] };
    expect(moveMatches(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 0) }), pred, V0)).toBe(true);
    expect(moveMatches(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 1) }), pred, V0)).toBe(true);
    // The same index from the other seat's view is a different card.
    expect(moveMatches(move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(0, 0, 1) }), pred, V1)).toBe(false);
  });

  it('reads the Jack steal target through JackTarget', () => {
    const steal = move({ Kind: Kind.PlayPermanent, Card: card(11, D), JackTarget: tgt(1, 0, 0) });
    expect(moveMatches(steal, { kind: Kind.PlayPermanent, card: card(11, D), target: card(10, C) }, V0)).toBe(true);
    expect(moveMatches(steal, { kind: Kind.PlayPermanent, card: card(11, D), target: card(9, D) }, V0)).toBe(false);
  });

  it('omitted card and target match any', () => {
    expect(moveMatches(scuttle9D, { kind: Kind.Scuttle }, V0)).toBe(true);
    expect(moveMatches(move({ Kind: Kind.Decline }), { kind: Kind.Decline }, V0)).toBe(true);
  });
});

describe('matchingIndices', () => {
  it('returns every matching index, in order, reading targets from the envelope view', () => {
    const env: Envelope = envelope({
      state: V0,
      legalMoves: [
        move({ Kind: Kind.Draw }),
        move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 0) }),
        move({ Kind: Kind.PlayPoint, Card: card(10, H) }),
        move({ Kind: Kind.Scuttle, Card: card(10, H), Target: tgt(1, 0, 1) }),
      ],
      descriptions: ['a', 'b', 'c', 'd'],
    });
    expect(matchingIndices(env, { kind: Kind.Scuttle, card: card(10, H) })).toEqual([1, 3]);
    expect(matchingIndices(env, { kind: Kind.Scuttle, card: card(10, H), target: card(9, D) })).toEqual([3]);
    expect(matchingIndices(env, { kind: Kind.OneOff })).toEqual([]);
  });
});

describe('nudgeFor', () => {
  const step: MoveStep = {
    kind: 'move',
    id: 't',
    main: 'main',
    spot: [],
    expect: { kind: Kind.PlayPoint, card: card(9, D) },
    source: { kind: 'hand', card: card(9, D) },
    target: { kind: 'testid', id: 'zone-points' },
    staged: 'staged',
    tapRoute: 'route',
    nudges: [
      { when: { kind: Kind.OneOff, card: card(9, D), target: card(10, C) }, text: 'first' },
      { when: { kind: Kind.OneOff, card: card(9, D) }, text: 'second' },
    ],
    generic: 'generic',
    success: 'ok',
    demo: { kind: 'none' },
    blake: [],
  };

  it('the first matching rule wins', () => {
    expect(nudgeFor(move({ Kind: Kind.OneOff, Card: card(9, D), Target: tgt(1, 0, 0) }), step, V0)).toBe('first');
    expect(nudgeFor(move({ Kind: Kind.OneOff, Card: card(9, D), Target: tgt(1, 0, 1) }), step, V0)).toBe('second');
  });

  it('falls back to the generic line', () => {
    expect(nudgeFor(move({ Kind: Kind.Draw }), step, V0)).toBe('generic');
  });
});
