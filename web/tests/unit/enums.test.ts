// SPEC §2.5 — pins every enum this module exports against the exact table
// in the spec. This is the module round 1's assumptions.md promised
// ("Enum constants are private copies in each round-1 module, pinned to
// §2.5; round 2 consolidates them") — `curtain.svelte.ts` and
// `affordances.ts` migrate onto these constants with no behavior change.
//
// `Rank` and its "Rank === 0 is the no-card sentinel" rule (§2.5) are not
// included: neither migrating module names Rank constants today (they only
// ever compare `Card.Rank` to a literal), so there is nothing to
// consolidate for it yet.

import { describe, expect, it } from 'vitest';

import { MoveKind, Phase, PlayerID, Suit, TargetZone } from '../../src/lib/enums';

describe('enums — SPEC §2.5, pinned from source', () => {
  it('Phase — engine/state.go:60-68', () => {
    expect(Phase).toEqual({
      Normal: 0,
      AwaitingCounter: 1,
      SevenChoosing: 2,
      AwaitingDiscard: 3,
      GameOver: 4,
    });
  });

  it('MoveKind — engine/moves.go:9-22', () => {
    expect(MoveKind).toEqual({
      Draw: 0,
      PlayPoint: 1,
      PlayPermanent: 2,
      Scuttle: 3,
      OneOff: 4,
      Counter: 5,
      Decline: 6,
      SevenPick: 7,
      DiscardPair: 8,
      Pass: 9,
    });
  });

  it('PlayerID — engine/state.go:26-31 (P1=0, P2=1)', () => {
    expect(PlayerID).toEqual({ P1: 0, P2: 1 });
  });

  it('TargetZone — engine/state.go:70-75', () => {
    expect(TargetZone).toEqual({ Points: 0, Permanents: 1 });
  });

  it('Suit — card/card.go:5-12, also the scuttle tiebreak order', () => {
    expect(Suit).toEqual({ Clubs: 0, Diamonds: 1, Hearts: 2, Spades: 3 });
  });
});
