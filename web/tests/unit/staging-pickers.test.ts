// P2 W15 — the StagingStore paths behind DiscardPicker (R15), SevenRevealPanel
// (R16) and ScrapBrowser's pick mode (R6, the 3). Strict tier: rules wiring.
// Every staged index must be the exact `legalMoves` index the engine offered
// for what was tapped, and nothing may stage without the tap sequence
// SPEC §6.1 requires (R12).

import { describe, expect, it } from 'vitest';

import type { Card, Move } from '../../src/lib/bridge/schema';
import { MoveKind } from '../../src/lib/enums';
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
  throw new Error('apply() should not have been called by this test');
}

function fixed(env: StagingEnv): () => StagingEnv {
  return () => env;
}

const FOUR_D: Card = { Rank: 4, Suit: 1 };
const FIVE_S: Card = { Rank: 5, Suit: 3 };
const NINE_C: Card = { Rank: 9, Suit: 0 };
const EIGHT_D: Card = { Rank: 8, Suit: 1 };
const JACK_C: Card = { Rank: 11, Suit: 0 };
const THREE_C: Card = { Rank: 3, Suit: 0 };
const KING_H: Card = { Rank: 13, Suit: 2 };

// ---------------------------------------------------------------------------
// DiscardPicker (R15, SPEC §6.3 DiscardPair row)
// ---------------------------------------------------------------------------

/** Three cards in hand: the engine offers every unordered pair (apply.go:512-518). */
function discardEnv(): StagingEnv {
  const legalMoves = [
    move({ Kind: MoveKind.DiscardPair, DiscardA: 0, DiscardB: 1 }),
    move({ Kind: MoveKind.DiscardPair, DiscardA: 0, DiscardB: 2 }),
    move({ Kind: MoveKind.DiscardPair, DiscardA: 1, DiscardB: 2 }),
  ];
  return {
    legalMoves,
    descriptions: ['discard hand[0] and hand[1]', 'discard hand[0] and hand[2]', 'discard hand[1] and hand[2]'],
    handSize: 3,
    hand: [FOUR_D, FIVE_S, NINE_C],
  };
}

describe('StagingStore — discard picking (R15)', () => {
  it('on entry every hand card is lit as pickable and nothing is staged', () => {
    const store = new StagingStore(fixed(discardEnv()), neverApply);
    store.reset();
    expect(store.discard).toEqual({ need: 2, picked: [] });
    expect(store.highlighted).toEqual(new Set(['hand:0', 'hand:1', 'hand:2']));
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });

  it('one tap marks the card chosen and stages nothing; a second tap stages the matching pair', () => {
    const store = new StagingStore(fixed(discardEnv()), neverApply);
    store.reset();
    store.tap('hand:2');
    expect(store.stagedIndex).toBeNull();
    expect(store.discard?.picked).toEqual([2]);
    expect(store.staged).toEqual(new Set(['hand:2']));
    expect(store.highlighted).toEqual(new Set(['hand:0', 'hand:1']));

    store.tap('hand:0');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1); // {DiscardA:0, DiscardB:2}, whatever the tap order
    expect(store.staged).toEqual(new Set(['hand:0', 'hand:2']));
    expect(store.stagedDescription).toBe('Discard 4♦ and 9♣');
  });

  it('tapping a chosen card again un-chooses it', () => {
    const store = new StagingStore(fixed(discardEnv()), neverApply);
    store.reset();
    store.tap('hand:1');
    store.tap('hand:1');
    expect(store.discard?.picked).toEqual([]);
    expect(store.staged).toEqual(new Set());
    store.tap('hand:1');
    store.tap('hand:2');
    expect(store.stagedIndex).toBe(2);
  });

  it('while staged, further hand taps change nothing; Cancel clears both picks', () => {
    const store = new StagingStore(fixed(discardEnv()), neverApply);
    store.reset();
    store.tap('hand:0');
    store.tap('hand:1');
    expect(store.stagedIndex).toBe(0);
    store.tap('hand:2');
    expect(store.stagedIndex).toBe(0);
    store.cancel();
    expect(store.state).toBe('idle');
    expect(store.discard?.picked).toEqual([]);
    expect(store.highlighted).toEqual(new Set(['hand:0', 'hand:1', 'hand:2']));
  });

  it('only Confirm applies, with the staged pair index', async () => {
    const applied: number[] = [];
    const store = new StagingStore(fixed(discardEnv()), async (i) => {
      applied.push(i);
    });
    store.reset();
    store.tap('hand:1');
    store.tap('hand:2');
    expect(applied).toEqual([]);
    await store.confirm();
    expect(applied).toEqual([2]);
  });

  it('R15.2: a one-card hand pre-stages the single {DiscardA:0, DiscardB:-1} move on entry', () => {
    const env: StagingEnv = {
      legalMoves: [move({ Kind: MoveKind.DiscardPair, DiscardA: 0, DiscardB: -1 })],
      descriptions: ['discard hand[0] and hand[-1]'],
      handSize: 1,
      hand: [KING_H],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.reset();
    expect(store.discard?.need).toBe(1);
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.staged).toEqual(new Set(['hand:0']));
    expect(store.stagedDescription).toBe('Discard K♥');
  });

  it('R15.2: after Cancel on the one-card hand, one tap on the card stages it again (not auto-restaged)', () => {
    const env: StagingEnv = {
      legalMoves: [move({ Kind: MoveKind.DiscardPair, DiscardA: 0, DiscardB: -1 })],
      descriptions: ['discard hand[0] and hand[-1]'],
      handSize: 1,
      hand: [KING_H],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.reset();
    store.cancel();
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
    store.tap('hand:0');
    expect(store.stagedIndex).toBe(0);
  });

  it('outside a discard position there is no discard model and hand taps behave as before', () => {
    const env: StagingEnv = {
      legalMoves: [move({ Kind: MoveKind.PlayPoint, HandIndex: 0, Card: FOUR_D })],
      descriptions: ['play 4♦ as point card'],
      handSize: 1,
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.reset();
    expect(store.discard).toBeNull();
    store.tap('hand:0');
    expect(store.state).toBe('selected');
  });
});

// ---------------------------------------------------------------------------
// SevenRevealPanel (R16, SPEC §6.3 SevenPick row)
// ---------------------------------------------------------------------------

/** Revealed [8♦, J♣]. The 8 can go to points or permanents; the J steals Blake's point 0. */
function sevenEnv(): StagingEnv {
  const legalMoves = [
    move({ Kind: MoveKind.SevenPick, Card: EIGHT_D, SubMove: move({ Kind: MoveKind.PlayPoint, Card: EIGHT_D }) }),
    move({ Kind: MoveKind.SevenPick, Card: EIGHT_D, SubMove: move({ Kind: MoveKind.PlayPermanent, Card: EIGHT_D }) }),
    move({
      Kind: MoveKind.SevenPick,
      Card: JACK_C,
      SubMove: move({ Kind: MoveKind.PlayPermanent, Card: JACK_C, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }),
    }),
  ];
  return {
    legalMoves,
    descriptions: ['7: play 8♦ as point card', '7: play 8♦ as permanent', '7: play J♣ (steal opponent point)'],
    handSize: 2,
    revealed: [EIGHT_D, JACK_C],
  };
}

describe('StagingStore — seven reveal (R16)', () => {
  it('tapping a revealed card lights exactly its sub-moves\' board targets', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:0');
    expect(store.state).toBe('selected');
    expect(store.selectedReveal).toBe(0);
    expect(store.selectedHand).toBeNull();
    expect(store.highlighted).toEqual(new Set(['zone:points', 'zone:permanents']));

    store.tap('seven:1');
    expect(store.selectedReveal).toBe(1);
    expect(store.highlighted).toEqual(new Set(['point:1:0']));
  });

  it('tapping the selected revealed card again unselects it back to idle (issue #25)', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:0');
    store.tap('seven:0');
    expect(store.state).toBe('idle');
    expect(store.selectedReveal).toBeNull();
    expect(store.highlighted).toEqual(new Set());
    store.tap('seven:0');
    expect(store.state).toBe('selected');
    expect(store.selectedReveal).toBe(0);
  });

  it('the target tap stages that SevenPick index and marks the revealed card staged', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:0');
    store.tap('zone:permanents');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1);
    expect(store.stagedDescription).toBe('7: play 8♦ as permanent');
    expect(store.staged).toEqual(new Set(['seven:0', 'zone:permanents']));
  });

  it('a revealed card is matched by identity, not by position in legalMoves', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:1');
    store.tap('point:1:0');
    expect(store.stagedIndex).toBe(2);
  });

  it('an unlit target clears the reveal selection and stages nothing (R9.4)', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:1');
    store.tap('zone:points');
    expect(store.state).toBe('idle');
    expect(store.selectedReveal).toBeNull();
    expect(store.stagedIndex).toBeNull();
  });

  it('hand cards in the seven phase have no play: all dimmed, a tap selects nothing', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    expect(store.dimmedHand).toEqual(new Set([0, 1]));
    store.tap('hand:0');
    expect(store.state).toBe('idle');
  });

  it('an out-of-range reveal key is a no-op', () => {
    const store = new StagingStore(fixed(sevenEnv()), neverApply);
    store.tap('seven:5');
    expect(store.state).toBe('idle');
  });

  it('a dead-end SevenPick (SubMove null) lights the scrap pile, and a scrap tap stages that card\'s scrap', () => {
    const env: StagingEnv = {
      legalMoves: [
        move({ Kind: MoveKind.SevenPick, Card: EIGHT_D }),
        move({ Kind: MoveKind.SevenPick, Card: JACK_C }),
      ],
      descriptions: ['7: no legal play — scrap 8♦', '7: no legal play — scrap J♣'],
      revealed: [EIGHT_D, JACK_C],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.tap('seven:1');
    expect(store.highlighted).toEqual(new Set(['scrap']));
    store.tap('scrap');
    expect(store.stagedIndex).toBe(1);
    expect(store.staged).toEqual(new Set(['seven:1', 'scrap']));
  });
});

// ---------------------------------------------------------------------------
// ScrapBrowser pick mode (R6, the 3; SPEC §6.2 last paragraph, §6.3)
// ---------------------------------------------------------------------------

const SCRAP: Card[] = [FOUR_D, FIVE_S, NINE_C];

function threeEnv(): StagingEnv {
  return {
    legalMoves: [
      move({ Kind: MoveKind.PlayPoint, HandIndex: 1, Card: THREE_C }),
      move({ Kind: MoveKind.OneOff, HandIndex: 1, Card: THREE_C, ScrapIndex: 0 }),
      move({ Kind: MoveKind.OneOff, HandIndex: 1, Card: THREE_C, ScrapIndex: 2 }),
    ],
    descriptions: ['play 3♣ as point card', 'play 3♣ as one-off', 'play 3♣ as one-off'],
    handSize: 2,
    scrap: SCRAP,
  };
}

describe('StagingStore — scrap pick for the 3 (R6)', () => {
  it('the one-off zone tap opens pick mode listing exactly the offered scrap cards, and stages nothing', () => {
    const store = new StagingStore(fixed(threeEnv()), neverApply);
    store.tap('hand:1');
    store.tap('zone:oneoff');
    expect(store.scrapPick).toEqual({
      candidates: [
        { index: 1, scrapIndex: 0 },
        { index: 2, scrapIndex: 2 },
      ],
    });
    expect(store.state).toBe('selected');
    expect(store.stagedIndex).toBeNull();
  });

  it('picking a scrap card stages that exact move, naming the card taken', () => {
    const store = new StagingStore(fixed(threeEnv()), neverApply);
    store.tap('hand:1');
    store.tap('zone:oneoff');
    store.pickScrap(2);
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(2);
    expect(store.stagedDescription).toBe('play 3♣ as one-off — take 9♣ from the scrap');
    expect(store.scrapPick).toBeNull();
    expect(store.staged).toEqual(new Set(['hand:1', 'zone:oneoff']));
  });

  it('pickScrap refuses an index the pick list did not offer', () => {
    const store = new StagingStore(fixed(threeEnv()), neverApply);
    store.tap('hand:1');
    store.tap('zone:oneoff');
    store.pickScrap(0); // a legal index, but the PlayPoint, not a scrap pick
    expect(store.stagedIndex).toBeNull();
    expect(store.scrapPick).not.toBeNull();
  });

  it('pickScrap outside pick mode does nothing', () => {
    const store = new StagingStore(fixed(threeEnv()), neverApply);
    store.pickScrap(1);
    expect(store.state).toBe('idle');
  });

  it('board taps are ignored while the pick sheet is open; Cancel closes it to idle', () => {
    const store = new StagingStore(fixed(threeEnv()), neverApply);
    store.tap('hand:1');
    store.tap('zone:oneoff');
    store.tap('zone:points');
    expect(store.scrapPick).not.toBeNull();
    store.cancel();
    expect(store.state).toBe('idle');
    expect(store.scrapPick).toBeNull();
  });

  it('a 3 revealed by a 7 opens pick mode too, and stages the SevenPick index', () => {
    const env: StagingEnv = {
      legalMoves: [
        move({
          Kind: MoveKind.SevenPick,
          Card: THREE_C,
          SubMove: move({ Kind: MoveKind.OneOff, Card: THREE_C, ScrapIndex: 0 }),
        }),
        move({
          Kind: MoveKind.SevenPick,
          Card: THREE_C,
          SubMove: move({ Kind: MoveKind.OneOff, Card: THREE_C, ScrapIndex: 1 }),
        }),
      ],
      descriptions: ['7: play 3♣ as one-off', '7: play 3♣ as one-off'],
      revealed: [THREE_C],
      scrap: SCRAP,
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.tap('seven:0');
    store.tap('zone:oneoff');
    expect(store.scrapPick?.candidates).toEqual([
      { index: 0, scrapIndex: 0 },
      { index: 1, scrapIndex: 1 },
    ]);
    store.pickScrap(1);
    expect(store.stagedIndex).toBe(1);
    expect(store.stagedDescription).toBe('7: play 3♣ as one-off — take 5♠ from the scrap');
  });

  it('single-card scrap: the lone 3 move stages straight from the zone tap, no pick sheet', () => {
    const env: StagingEnv = {
      legalMoves: [move({ Kind: MoveKind.OneOff, HandIndex: 0, Card: THREE_C, ScrapIndex: 0 })],
      descriptions: ['play 3♣ as one-off'],
      scrap: [FIVE_S],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.tap('hand:0');
    store.tap('zone:oneoff');
    expect(store.scrapPick).toBeNull();
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('play 3♣ as one-off, taking 5♠');
  });

  it('single-card scrap: a 3 revealed by a 7 names the card taken too', () => {
    const env: StagingEnv = {
      legalMoves: [
        move({ Kind: MoveKind.SevenPick, Card: THREE_C, SubMove: move({ Kind: MoveKind.OneOff, Card: THREE_C }) }),
      ],
      descriptions: ['7: play 3♣ as one-off'],
      revealed: [THREE_C],
      scrap: [NINE_C],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.tap('seven:0');
    store.tap('zone:oneoff');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('7: play 3♣ as one-off, taking 9♣');
  });

  it('an untargeted one-off that is not a 3 keeps the engine text, whatever the scrap holds', () => {
    const ACE_H: Card = { Rank: 1, Suit: 2 };
    const env: StagingEnv = {
      legalMoves: [move({ Kind: MoveKind.OneOff, HandIndex: 0, Card: ACE_H })],
      descriptions: ['play A♥ as one-off'],
      scrap: [FIVE_S],
    };
    const store = new StagingStore(fixed(env), neverApply);
    store.tap('hand:0');
    store.tap('zone:oneoff');
    expect(store.stagedDescription).toBe('play A♥ as one-off');
  });
});
