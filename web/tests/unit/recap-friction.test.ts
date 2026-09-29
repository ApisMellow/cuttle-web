// Playtest friction round (2026-09-28): plain player-facing wording for every
// engine string that reaches the UI, the 5's draw count, and the result
// screen's winning-move line. SPEC §4.6 (amended 2026-09-28), §6.4.
//
// Privacy is strict tier here. The two guarantees this file proves:
//   - The recap and the counter prompt never read `drawn`, so a 5 that
//     resolved at once (`drawn` set) and one still in a counter window
//     (`drawn` null) read identically. Only the board's last-move line,
//     which renders after resolution, reports the count, and it reads the
//     same however the 5 resolved.
//   - No line ever names a drawn card: history carries a count, never the
//     cards, and the only card tokens in a line are cards that were played.

import { describe, expect, it } from 'vitest';

import type { AppliedMove, Move, PlayerId } from '../../src/lib/bridge/schema';
import {
  formatRecapLine,
  isRecapVisible,
  lastMoveLine,
  nineReturn,
  plainMoveText,
  recapCards,
  winningMoveLine,
} from '../../src/lib/recap';
import { Kind, appliedMove, playerView } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Blake'];
const CARD_TOKEN = /(?:10|[2-9]|[AJQK])[♣♦♥♠]/g;

function five(by: PlayerId, seq: number, drawn: number | null = null): AppliedMove {
  return appliedMove({ by, kind: Kind.OneOff, seq, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off', drawn });
}

function decline(by: PlayerId, seq: number, drawn: number | null = null): AppliedMove {
  return appliedMove({ by, kind: Kind.Decline, seq, description: 'decline to counter', drawn });
}

function counter(by: PlayerId, seq: number, suit: 0 | 1 | 2 | 3, drawn: number | null = null): AppliedMove {
  const glyph = ['♣', '♦', '♥', '♠'][suit];
  return appliedMove({ by, kind: Kind.Counter, seq, card: { Rank: 2, Suit: suit }, description: `counter with 2${glyph}`, drawn });
}

describe('5 recap line: says what the 5 does (SPEC §4.6, amended 2026-09-28)', () => {
  it('the opponent reads "NAME played 5♥ as a one-off to draw 2 cards."', () => {
    expect(formatRecapLine(five(0, 1), 1, NAMES)).toBe('Alice played 5♥ as a one-off to draw 2 cards.');
  });

  it('own move reads in the second person', () => {
    expect(formatRecapLine(five(0, 1), 0, NAMES)).toBe('You played 5♥ as a one-off to draw 2 cards.');
  });

  it('a 5 revealed by a 7 says it too', () => {
    const seven = appliedMove({
      by: 1,
      kind: Kind.SevenPick,
      subKind: Kind.OneOff,
      card: { Rank: 5, Suit: 0 },
      description: '7: play 5♣ as one-off',
    });
    expect(formatRecapLine(seven, 0, NAMES)).toBe('Blake revealed the top of the deck and played 5♣ as a one-off to draw 2 cards.');
  });

  it('other one-offs keep their wording', () => {
    const nine = appliedMove({ by: 1, kind: Kind.OneOff, card: { Rank: 9, Suit: 2 }, description: 'play 9♥ as one-off', targetCard: { Rank: 10, Suit: 1 } });
    expect(formatRecapLine(nine, 0, NAMES)).toBe('Blake played 9♥ as a one-off, targeting 10♦.');
  });
});

describe('R14 (strict): the recap and counter prompt never read drawn', () => {
  it('a resolved 5 (drawn set) and an unresolved one (drawn null) format identically, for both viewers', () => {
    for (const viewer of [0, 1] as const) {
      for (const n of [0, 1, 2]) {
        expect(formatRecapLine(five(0, 1, n), viewer, NAMES)).toBe(formatRecapLine(five(0, 1, null), viewer, NAMES));
      }
      expect(formatRecapLine(counter(1, 2, 3, 2), viewer, NAMES)).toBe(formatRecapLine(counter(1, 2, 3, null), viewer, NAMES));
    }
    expect(recapCards(five(0, 1, 2))).toEqual(recapCards(five(0, 1, null)));
  });

  it('no recap line mentions a draw count', () => {
    const line = formatRecapLine(five(0, 1, 1), 1, NAMES);
    expect(line).not.toMatch(/drew/);
    expect(line).not.toMatch(/\b1 card\b/);
  });
});

describe('lastMoveLine: the board centre line (SPEC §4.6 idle line, amended 2026-09-28)', () => {
  it('empty or Decline-only history gives no line', () => {
    expect(lastMoveLine([], 0, NAMES)).toBe('');
    expect(lastMoveLine([decline(0, 1)], 0, NAMES)).toBe('');
  });

  it('the viewer\'s own move reads as a sentence, never raw engine text', () => {
    const h = [appliedMove({ by: 0, kind: Kind.PlayPoint, card: { Rank: 7, Suit: 2 }, description: 'play 7♥ as point card' })];
    expect(lastMoveLine(h, 0, NAMES)).toBe('You played 7♥ for points.');
    expect(lastMoveLine(h, 1, NAMES)).toBe('Alice played 7♥ for points.');
  });

  it('a 5 that resolved at once: "and drew N cards", for either viewer', () => {
    expect(lastMoveLine([five(0, 1, 2)], 1, NAMES)).toBe('Alice played 5♥ as a one-off and drew 2 cards.');
    expect(lastMoveLine([five(0, 1, 2)], 0, NAMES)).toBe('You played 5♥ as a one-off and drew 2 cards.');
    expect(lastMoveLine([five(0, 1, 1)], 1, NAMES)).toBe('Alice played 5♥ as a one-off and drew 1 card.');
    expect(lastMoveLine([five(0, 1, 0)], 1, NAMES)).toBe('Alice played 5♥ as a one-off and drew no cards.');
  });

  it('a 5 resolved by a Decline reads exactly like one that resolved at once', () => {
    const real = [five(0, 1, null), decline(1, 2, 2)];
    const atOnce = [five(0, 1, 2)];
    for (const viewer of [0, 1] as const) {
      expect(lastMoveLine(real, viewer, NAMES)).toBe(lastMoveLine(atOnce, viewer, NAMES));
    }
    expect(lastMoveLine(real, 1, NAMES)).toBe('Alice played 5♥ as a one-off and drew 2 cards.');
  });

  it('a 5 whose counter was countered back: the closing counter, then who drew', () => {
    const h = [five(0, 1), counter(1, 2, 0), counter(0, 3, 2, 2)];
    expect(lastMoveLine(h, 1, NAMES)).toBe('Alice countered with 2♥ to stop your 2♣. Alice drew 2 cards.');
    expect(lastMoveLine(h, 0, NAMES)).toBe("You countered with 2♥ to stop Blake's 2♣. You drew 2 cards.");
  });

  it('R14 (strict, review B1): a two-counter chain closed by a Decline reads like one closed by the counter, naming the 5\'s player', () => {
    const byDecline = [five(0, 1), counter(1, 2, 0), counter(0, 3, 2), decline(1, 4, 2)];
    const byCounter = [five(0, 1), counter(1, 2, 0), counter(0, 3, 2, 2)];
    for (const viewer of [0, 1] as const) {
      expect(lastMoveLine(byDecline, viewer, NAMES)).toBe(lastMoveLine(byCounter, viewer, NAMES));
    }
    expect(lastMoveLine(byDecline, 1, NAMES)).toBe('Alice countered with 2♥ to stop your 2♣. Alice drew 2 cards.');
    expect(lastMoveLine(byDecline, 0, NAMES)).toBe("You countered with 2♥ to stop Blake's 2♣. You drew 2 cards.");
  });

  it('(review B1) a four-counter chain names the 5\'s player as the drawer, whoever closed it', () => {
    const blakeFive = five(1, 1);
    const h = [blakeFive, counter(0, 2, 0), counter(1, 3, 1), counter(0, 4, 2), counter(1, 5, 3, 2)];
    expect(lastMoveLine(h, 0, NAMES)).toBe('Blake countered with 2♠ to stop your 2♥. Blake drew 2 cards.');
    const closedByDecline = [blakeFive, counter(0, 2, 0), counter(1, 3, 1), counter(0, 4, 2), counter(1, 5, 3), decline(0, 6, 2)];
    expect(lastMoveLine(closedByDecline, 0, NAMES)).toBe('Blake countered with 2♠ to stop your 2♥. Blake drew 2 cards.');
    expect(lastMoveLine(closedByDecline, 1, NAMES)).toBe("You countered with 2♠ to stop Alice's 2♥. You drew 2 cards.");
  });

  it('a cancelled 5 draws nothing and says nothing about a draw (playtest 2026-09-29: it says the 5 was stopped)', () => {
    const h = [five(0, 1), counter(1, 2, 0)];
    expect(lastMoveLine(h, 0, NAMES)).toBe('Blake countered with 2♣: your 5♥ was stopped.');
    expect(lastMoveLine(h, 0, NAMES)).not.toMatch(/drew/);
  });

  it('a draw count on an older entry never leaks onto a later move', () => {
    const h = [five(0, 1, 2), appliedMove({ by: 1, kind: Kind.Draw, seq: 2, description: 'draw a card' })];
    expect(lastMoveLine(h, 0, NAMES)).toBe('Blake drew a card.');
  });

  it('(strict) never names a drawn card: the only card tokens are the played ones', () => {
    const lines = [
      lastMoveLine([five(0, 1, 2)], 1, NAMES),
      lastMoveLine([five(0, 1, null), decline(1, 2, 2)], 1, NAMES),
      lastMoveLine([five(0, 1), counter(1, 2, 0), counter(0, 3, 2, 2)], 1, NAMES),
    ];
    expect(lines[0].match(CARD_TOKEN)).toEqual(['5♥']);
    expect(lines[1].match(CARD_TOKEN)).toEqual(['5♥']);
    // The closing 2 and the 2 it stopped, both played face up; never a drawn card.
    expect(lines[2].match(CARD_TOKEN)).toEqual(['2♥', '2♣']);
  });
});

describe('plainMoveText: player-facing wording for engine descriptions (SPEC §6.4, amended 2026-09-28)', () => {
  const cases: Array<[string, string]> = [
    ['draw a card', 'Draw a card.'],
    ['pass', 'Pass.'],
    ['play 7♥ as point card', 'Play 7♥ for points.'],
    ['play 10♠ as point card', 'Play 10♠ for points.'],
    ['play J♣ (steal opponent point)', 'Play J♣ to steal that point card.'],
    ['play Q♦ as permanent', 'Play Q♦: their 2s, 9s and Jacks can’t target your other cards.'],
    ['play K♠ as permanent', 'Play K♠ as a permanent: you need fewer points to win.'],
    ['play 8♥ as permanent', 'Play 8♥ as glasses: you see their hand.'],
    ["scuttle opponent's 4♣ with 9♣", 'Scuttle their 4♣ with 9♣: both cards go to the scrap.'],
    ['play A♥ as one-off', 'Play A♥ as a one-off: scrap every point card.'],
    ['play 2♠ as one-off', 'Play 2♠ as a one-off: scrap one royal or glasses 8.'],
    ['play 3♣ as one-off', 'Play 3♣ as a one-off: take a card from the scrap.'],
    ['play 4♦ as one-off', 'Play 4♦ as a one-off: they discard 2 cards.'],
    ['play 5♥ as one-off', 'Play 5♥ as a one-off: draw 2 cards.'],
    ['play 6♣ as one-off', 'Play 6♣ as a one-off: scrap every royal and glasses 8.'],
    ['play 7♦ as one-off', 'Play 7♦ as a one-off: see the top 2 cards (or the last one), play one.'],
    ['play 9♣ as one-off', 'Play 9♣ as a one-off: send a card back to its owner’s hand.'],
    ['counter with 2♦', 'Counter with 2♦: stop their card.'],
    ['decline to counter', 'Let it resolve.'],
    ['7: play 5♥ as point card', 'Play 5♥ for points.'],
    ["7: scuttle opponent's 4♣ with 9♣", 'Scuttle their 4♣ with 9♣: both cards go to the scrap.'],
    ['7: no legal play — scrap 5♥', 'Scrap 5♥: no revealed card can be played.'],
    ['play 3♣ as one-off — take 5♠ from the scrap', 'Play 3♣ as a one-off: take 5♠ from the scrap.'],
    ['play 3♣ as one-off, taking 7♥', 'Play 3♣ as a one-off: take 7♥ from the scrap.'],
    ['7: play 3♣ as one-off — take 5♠ from the scrap', 'Play 3♣ as a one-off: take 5♠ from the scrap.'],
    ['Discard 4♦ and 5♠', 'Discard 4♦ and 5♠.'],
    ['Discard 4♦', 'Discard 4♦.'],
    ['discard hand[0] and hand[3]', 'Discard 2 cards.'],
    ['discard hand[0] and hand[-1]', 'Discard 1 card.'],
  ];
  for (const [raw, plain] of cases) {
    it(`${JSON.stringify(raw)} -> ${JSON.stringify(plain)}`, () => {
      expect(plainMoveText(raw)).toBe(plain);
    });
  }

  it('no mapped line keeps engine phrasing', () => {
    for (const [raw] of cases) {
      const out = plainMoveText(raw);
      expect(out).not.toMatch(/as point card|opponent's|steal opponent point|as one-off\b|hand\[|decline to counter|^[a-z]/);
    }
  });

  it('review B2: a 9 names the specific case when it is known', () => {
    expect(plainMoveText('play 9♣ as one-off', 'theirs')).toBe(
      'Play 9♣ as a one-off: back to their hand; they can’t play it next turn.',
    );
    expect(plainMoveText('play 9♣ as one-off', 'yours')).toBe('Play 9♣ as a one-off: your stolen card comes back to your hand.');
    expect(plainMoveText('7: play 9♣ as one-off', 'yours')).toBe('Play 9♣ as a one-off: your stolen card comes back to your hand.');
    // The case never changes any other move's text.
    expect(plainMoveText("scuttle opponent's 4♣ with 9♣", 'yours')).toBe('Scuttle their 4♣ with 9♣: both cards go to the scrap.');
  });

  it('an unknown string passes through sentence-cased rather than throwing', () => {
    expect(plainMoveText('something new')).toBe('Something new');
  });
});

describe('winningMoveLine: the result screen names the winning move (R2, amended 2026-09-28)', () => {
  const points = (by: PlayerId, seq: number): AppliedMove =>
    appliedMove({ by, kind: Kind.PlayPoint, seq, card: { Rank: 10, Suit: 2 }, description: 'play 10♥ as point card' });

  it('a point card: "NAME won by reaching N with the 10♥."', () => {
    expect(winningMoveLine([points(0, 1)], 0, NAMES, 21)).toBe('Alice won by reaching 21 with the 10♥.');
  });

  it('a Jack steal names both cards', () => {
    const jack = appliedMove({
      by: 1,
      kind: Kind.PlayPermanent,
      card: { Rank: 11, Suit: 0 },
      targetCard: { Rank: 9, Suit: 2 },
      description: 'play J♣ (steal opponent point)',
    });
    expect(winningMoveLine([jack], 1, NAMES, 22)).toBe('Blake won by reaching 22, stealing the 9♥ with the J♣.');
  });

  it('a King names the lowered goal', () => {
    const king = appliedMove({ by: 0, kind: Kind.PlayPermanent, card: { Rank: 13, Suit: 3 }, description: 'play K♠ as permanent' });
    expect(winningMoveLine([king], 0, NAMES, 15, 14)).toBe('Alice won by playing the K♠, which lowered the goal to 14.');
  });

  it('a 7 reveal wraps its sub-move', () => {
    const seven = appliedMove({ by: 0, kind: Kind.SevenPick, subKind: Kind.PlayPoint, card: { Rank: 9, Suit: 0 }, description: '7: play 9♣ as point card' });
    expect(winningMoveLine([seven], 0, NAMES, 21)).toBe('Alice won by reaching 21 with the 9♣, from the top of the deck.');
  });

  it('any other last move: points plus the move, third person for everyone', () => {
    const ace = appliedMove({ by: 1, kind: Kind.OneOff, card: { Rank: 1, Suit: 0 }, description: 'play A♣ as one-off' });
    expect(winningMoveLine([ace], 0, NAMES, 21)).toMatch(/^Alice won with 21 points\. Last move: Blake played A♣ as a one-off/);
  });

  it('the winner did not move: a 2 that scrapped a Jack says the win came at the start of their turn', () => {
    const two = appliedMove({
      by: 0,
      kind: Kind.OneOff,
      card: { Rank: 2, Suit: 2 },
      targetCard: { Rank: 11, Suit: 3 },
      description: 'play 2♥ as one-off',
    });
    const expected = 'Blake reached 15 of 14 when Alice\u2019s 2\u2665 scrapped the J\u2660, and won at the start of their turn.';
    expect(winningMoveLine([two], 1, NAMES, 15, 14)).toBe(expected);
    // A trailing Decline changes nothing.
    expect(winningMoveLine([two, decline(1, 2)], 1, NAMES, 15, 14)).toBe(expected);
    expect(winningMoveLine([two], 1, NAMES, 15)).toBe(
      'Blake reached 15 when Alice\u2019s 2\u2665 scrapped the J\u2660, and won at the start of their turn.',
    );
  });

  it('the winner did not move: a 6 says every permanent was scrapped, naming no other card', () => {
    const six = appliedMove({ by: 1, kind: Kind.OneOff, card: { Rank: 6, Suit: 0 }, description: 'play 6♣ as one-off' });
    const line = winningMoveLine([six], 0, NAMES, 15, 14);
    expect(line).toBe('Alice reached 15 of 14 when Blake\u2019s 6\u2663 scrapped every permanent, and won at the start of their turn.');
    expect(line.match(CARD_TOKEN)).toEqual(['6♣']);
  });

  it('the winner did not move, but the last move is not a 2 or a 6: the generic line stays', () => {
    const nine = appliedMove({ by: 1, kind: Kind.OneOff, card: { Rank: 9, Suit: 0 }, description: 'play 9♣ as one-off' });
    expect(winningMoveLine([nine], 0, NAMES, 21)).toMatch(/^Alice won with 21 points\. Last move: Blake played 9♣ as a one-off/);
  });

  it('skips a trailing Decline to find the move, and gives no line for a stalemate or empty history', () => {
    expect(winningMoveLine([points(0, 1), decline(1, 2)], 0, NAMES, 21)).toBe('Alice won by reaching 21 with the 10♥.');
    expect(winningMoveLine([points(0, 1)], null, NAMES, 0)).toBe('');
    expect(winningMoveLine([], 0, NAMES, 21)).toBe('');
  });

  it('(strict) names only cards that were played face up', () => {
    const line = winningMoveLine([five(1, 1, 2), points(0, 2)], 0, NAMES, 21);
    expect(line.match(CARD_TOKEN)).toEqual(['10♥']);
    expect(isRecapVisible(points(0, 2))).toBe(true);
  });
});

describe('nineReturn (review B2): where a 9 sends its target, per engine/apply.go v0.2.0 case Nine', () => {
  const move = (zone: 0 | 1, index: number, sevenWrapped = false): Move => {
    const oneOff: Move = {
      Kind: Kind.OneOff,
      Card: { Rank: 9, Suit: 0 },
      HandIndex: 0,
      Target: { Owner: 1, Zone: zone, Index: index },
      JackTarget: null,
      ScrapIndex: 0,
      DiscardA: 0,
      DiscardB: 0,
      SubMove: null,
    };
    return sevenWrapped ? { ...oneOff, Kind: Kind.SevenPick, SubMove: { ...oneOff, Card: null } } : oneOff;
  };
  const view = playerView({
    viewer: 0,
    opponent: {
      handCount: 0,
      hand: null,
      permanents: [{ Rank: 12, Suit: 1 }],
      points: [
        { Card: { Rank: 4, Suit: 0 }, Owner: 1, JackStack: [], JackOwners: [], Controller: 1 },
        { Card: { Rank: 7, Suit: 2 }, Owner: 0, JackStack: [{ Rank: 11, Suit: 3 }], JackOwners: [1], Controller: 1 },
      ],
    },
  });

  it('their own point card or permanent goes back to them', () => {
    expect(nineReturn(move(0, 0), view)).toBe('theirs');
    expect(nineReturn(move(1, 0), view)).toBe('theirs');
  });

  it('a point card they stole from you (Owner is you) comes back to you, also through a 7', () => {
    expect(nineReturn(move(0, 1), view)).toBe('yours');
    expect(nineReturn(move(0, 1, true), view)).toBe('yours');
  });

  it('undefined for anything that is not a targeted 9, or a stale target', () => {
    expect(nineReturn({ ...move(0, 0), Card: { Rank: 2, Suit: 0 } }, view)).toBeUndefined();
    expect(nineReturn({ ...move(0, 0), Target: null }, view)).toBeUndefined();
    expect(nineReturn(move(0, 5), view)).toBeUndefined();
  });
});
