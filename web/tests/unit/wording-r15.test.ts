// Playtest 2026-09-29 wording round (loop r15): recaps and the counter
// prompt say what a card does, blocked cards say why, staging names its
// target, and the result screen labels the tally and goal.
//
// Strict tier here (R14): every recap / counter-prompt line must read the
// same before and after its one-off resolves, because on the real
// counter-window path it renders before resolution and on the synthetic
// path after. The tests pair the two history shapes the paths produce and
// assert identical text. The board's last-move line renders after
// resolution on both paths, and its tests pair the real history (a Decline
// at the end) with the synthetic one (none).

import { describe, expect, it } from 'vitest';

import type { AppliedMove, Card, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import { deckReason, handCardReason, targetReason } from '../../src/lib/blockedReason';
import { BLOCKED_REASON, NO_MOVES_REASON, inPlayBadge, rulesOneOffLines, rulesPermanentLines } from '../../src/lib/cardText';
import {
  discardPromptLine,
  formatRecapLine,
  formatRecapLines,
  lastMoveLine,
  optionContext,
  plainMoveText,
  stagedHeading,
  winningMoveLine,
} from '../../src/lib/recap';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';
import { Kind, appliedMove, playerView } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Blake'];

function oneOff(by: PlayerId, seq: number, token: string, drawn: number | null = null): AppliedMove {
  return appliedMove({ by, kind: Kind.OneOff, seq, description: `play ${token} as one-off`, drawn });
}

function counter(by: PlayerId, seq: number, token: string, drawn: number | null = null): AppliedMove {
  return appliedMove({ by, kind: Kind.Counter, seq, card: { Rank: 2, Suit: 0 }, description: `counter with ${token}`, drawn });
}

function decline(by: PlayerId, seq: number, drawn: number | null = null): AppliedMove {
  return appliedMove({ by, kind: Kind.Decline, seq, description: 'decline to counter', drawn });
}

function point(by: PlayerId, seq: number, token: string, c: Card): AppliedMove {
  return appliedMove({ by, kind: Kind.PlayPoint, seq, card: c, description: `play ${token} as point card` });
}

function steal(by: PlayerId, seq: number, jack: string, target: Card): AppliedMove {
  return appliedMove({ by, kind: Kind.PlayPermanent, seq, card: { Rank: 11, Suit: 1 }, description: `play ${jack} (steal opponent point)`, targetCard: target });
}

const A_SPADES: Card = { Rank: 1, Suit: 3 };

describe('recap: a 3 and a 4 say what they do (R14 strict: never the outcome)', () => {
  it('a 3 says it takes a card from the scrap, never which', () => {
    expect(formatRecapLine(oneOff(0, 1, '3♦'), 1, NAMES)).toBe('Alice played 3♦ as a one-off to take a card from the scrap.');
    expect(formatRecapLine(oneOff(0, 1, '3♦'), 0, NAMES)).toBe('You played 3♦ as a one-off to take a card from the scrap.');
  });

  it('a 4 tells the one who discards "you’ll discard 2 cards (or all you have, if fewer)"', () => {
    expect(formatRecapLine(oneOff(0, 1, '4♠'), 1, NAMES)).toBe('Alice played 4♠ as a one-off: you’ll discard 2 cards (or all you have, if fewer).');
    expect(formatRecapLine(oneOff(0, 1, '4♠'), 0, NAMES)).toBe('You played 4♠ as a one-off: Blake will discard 2 cards (or all they have, if fewer).');
  });

  it('R14: the 3, 4 and 5 lines are identical with drawn set or null, with or without history', () => {
    for (const token of ['3♦', '4♠', '5♥']) {
      for (const viewer of [0, 1] as const) {
        const before = formatRecapLine(oneOff(0, 1, token, null), viewer, NAMES);
        for (const n of [0, 1, 2]) {
          expect(formatRecapLine(oneOff(0, 1, token, n), viewer, NAMES)).toBe(before);
          expect(formatRecapLine(oneOff(0, 1, token, n), viewer, NAMES, { history: [oneOff(0, 1, token, n)] })).toBe(before);
        }
      }
    }
  });
});

describe('counter prompt / recap: a 2 names what it stops (R14 strict)', () => {
  it('each counter line names the card before it, from the run', () => {
    const run = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣'), counter(0, 3, '2♦')];
    expect(formatRecapLines(run, 0, NAMES)).toEqual([
      'You played 5♥ as a one-off to draw 2 cards.',
      'Blake countered with 2♣ to stop your 5♥.',
      "You countered with 2♦ to stop Blake's 2♣.",
    ]);
    expect(formatRecapLines(run, 1, NAMES)[1]).toBe("You countered with 2♣ to stop Alice's 5♥.");
  });

  it('with history the first counter of a recap slice still names its target', () => {
    const history = [oneOff(0, 1, '9♥'), counter(1, 2, '2♣')];
    expect(formatRecapLines([history[1]], 0, NAMES, history)).toEqual(['Blake countered with 2♣ to stop your 9♥.']);
    expect(formatRecapLines([history[1]], 0, NAMES)).toEqual(['Blake countered with 2♣.']);
  });

  it('R14: the real window and the synthetic ack read the same lines (drawn and a later Decline are never read)', () => {
    // Real: Alice holds a 2, the chain is still open. Synthetic: Alice held
    // none, the 5 was cancelled at once (drawn stays null on a cancel) — the
    // history is the same shape; only `drawn` can differ on an even chain.
    const real = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣')];
    const synthetic = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣')];
    expect(formatRecapLines(real, 0, NAMES, real)).toEqual(formatRecapLines(synthetic, 0, NAMES, synthetic));
    const evenOpen = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣'), counter(0, 3, '2♦')];
    const evenResolved = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣'), counter(0, 3, '2♦', 2)];
    for (const viewer of [0, 1] as const) {
      expect(formatRecapLines(evenResolved, viewer, NAMES, evenResolved)).toEqual(formatRecapLines(evenOpen, viewer, NAMES, evenOpen));
    }
  });
});

describe('board line after a counter: the original card was stopped (R14 strict)', () => {
  it('one 2: "Blake countered with 2♣: your 5♥ was stopped."', () => {
    const synthetic = [oneOff(0, 1, '5♥'), counter(1, 2, '2♣')];
    const real = [...synthetic, decline(0, 3)];
    expect(lastMoveLine(synthetic, 0, NAMES)).toBe('Blake countered with 2♣: your 5♥ was stopped.');
    expect(lastMoveLine(synthetic, 1, NAMES)).toBe("You countered with 2♣: Alice's 5♥ was stopped.");
    for (const viewer of [0, 1] as const) expect(lastMoveLine(real, viewer, NAMES)).toBe(lastMoveLine(synthetic, viewer, NAMES));
  });

  it('three 2s: the last line, then the one-off was stopped', () => {
    const h = [oneOff(0, 1, '9♥'), counter(1, 2, '2♣'), counter(0, 3, '2♦'), counter(1, 4, '2♠')];
    expect(lastMoveLine(h, 0, NAMES)).toBe('Blake countered with 2♠ to stop your 2♦. Your 9♥ was stopped.');
    expect(lastMoveLine([...h, decline(0, 5)], 0, NAMES)).toBe(lastMoveLine(h, 0, NAMES));
  });

  it('two 2s: the one-off went through, nothing says stopped', () => {
    const h = [oneOff(0, 1, '9♥'), counter(1, 2, '2♣'), counter(0, 3, '2♦')];
    expect(lastMoveLine(h, 1, NAMES)).toBe("Alice countered with 2♦ to stop your 2♣.");
    expect(lastMoveLine(h, 1, NAMES)).not.toMatch(/was stopped/);
  });

  it('a lone 4 on the board (their hand was empty) drops the "you’ll discard" intent', () => {
    expect(lastMoveLine([oneOff(0, 1, '4♠')], 1, NAMES)).toBe('Alice played 4♠ as a one-off.');
  });
});

describe('discard picker centre line', () => {
  it('"Alice’s 4♠: choose 2 to discard." straight after the 4, or after an even chain', () => {
    expect(discardPromptLine([oneOff(0, 1, '4♠')], NAMES, 2)).toBe("Alice's 4♠: choose 2 to discard.");
    expect(discardPromptLine([oneOff(0, 1, '4♠'), decline(1, 2)], NAMES, 1)).toBe("Alice's 4♠: discard your last card.");
    expect(discardPromptLine([oneOff(0, 1, '4♠'), counter(1, 2, '2♣'), counter(0, 3, '2♦')], NAMES, 2)).toBe("Alice's 4♠: choose 2 to discard.");
    expect(discardPromptLine([oneOff(0, 1, '5♠')], NAMES, 2)).toBe('');
  });
});

describe('recap wording list', () => {
  it('glasses read "as glasses", in the recap and through a 7', () => {
    const glasses = appliedMove({ by: 0, kind: Kind.PlayPermanent, card: { Rank: 8, Suit: 1 }, description: 'play 8♦ as permanent' });
    expect(formatRecapLine(glasses, 1, NAMES)).toBe('Alice played 8♦ as glasses.');
    const queen = appliedMove({ by: 0, kind: Kind.PlayPermanent, card: { Rank: 12, Suit: 1 }, description: 'play Q♦ as permanent' });
    expect(formatRecapLine(queen, 1, NAMES)).toBe('Alice played Q♦ as a permanent.');
  });

  it('a steal-back says she took back her own card; an ordinary steal still says stole', () => {
    const history = [point(0, 1, 'A♠', A_SPADES), steal(1, 2, 'J♣', A_SPADES), steal(0, 3, 'J♦', A_SPADES)];
    expect(formatRecapLine(history[2], 1, NAMES, { history })).toBe('Alice took back the A♠ you stole, with J♦.');
    expect(formatRecapLine(history[2], 0, NAMES, { history })).toBe('You took back your A♠ with J♦.');
    expect(formatRecapLine(history[1], 0, NAMES, { history })).toBe('Blake stole your A♠ with J♣.');
    expect(lastMoveLine(history, 1, NAMES)).toBe('Alice took back the A♠ you stole, with J♦.');
  });

  it('(review B3) a steal-back played through a 7 also says took back', () => {
    const sevenSteal = appliedMove({
      by: 0,
      kind: Kind.SevenPick,
      subKind: Kind.PlayPermanent,
      seq: 3,
      card: { Rank: 11, Suit: 1 },
      description: '7: play J♦ (steal opponent point)',
      targetCard: A_SPADES,
    });
    const history = [point(0, 1, 'A♠', A_SPADES), steal(1, 2, 'J♣', A_SPADES), sevenSteal];
    expect(formatRecapLine(sevenSteal, 1, NAMES, { history })).toBe('Alice revealed the top of the deck and took back the A♠ you stole, with J♦.');
  });

  it('(review B5) the owner is whoever played the card for points LAST', () => {
    // Alice put A♠ down first; later Blake (after a 3) put the same A♠ down.
    // Alice's Jack then steals Blake's card: an ordinary steal.
    const history = [point(0, 1, 'A♠', A_SPADES), point(1, 5, 'A♠', A_SPADES), steal(0, 6, 'J♦', A_SPADES)];
    expect(formatRecapLine(history[2], 1, NAMES, { history })).toBe('Alice stole your A♠ with J♦.');
    // And the other way round: Blake last put it down, Blake takes it back.
    const back = [point(0, 1, 'A♠', A_SPADES), point(1, 5, 'A♠', A_SPADES), steal(0, 6, 'J♦', A_SPADES), steal(1, 7, 'J♣', A_SPADES)];
    expect(formatRecapLine(back[3], 0, NAMES, { history: back })).toBe('Blake took back the A♠ you stole, with J♣.');
  });

  it('result: the goal beside the total', () => {
    const h = [point(0, 1, '10♥', { Rank: 10, Suit: 2 })];
    expect(winningMoveLine(h, 0, NAMES, 16, 14)).toBe('Alice won by reaching 16 of 14 with the 10♥.');
    expect(winningMoveLine(h, 0, NAMES, 21)).toBe('Alice won by reaching 21 with the 10♥.');
  });
});

// ---- Staging / chooser text with the target named ------------------------

const card = (Rank: Card['Rank'], Suit: Card['Suit'] = 0): Card => ({ Rank, Suit });

function entry(c: Card, owner: PlayerId, jacks: Card[] = [], controller: PlayerId = owner): PointEntry {
  return { Card: c, Owner: owner, JackStack: jacks, JackOwners: jacks.map(() => controller), Controller: controller };
}

function mv(o: Partial<Move>): Move {
  return { Kind: 0, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...o };
}

function view(o: {
  hand?: Card[];
  youPoints?: PointEntry[];
  youPerms?: Card[];
  oppPoints?: PointEntry[];
  oppPerms?: Card[];
  deckCount?: number;
  frozen?: number[];
  phase?: PlayerView['phase'];
  revealed?: Card[] | null;
}): PlayerView {
  const base = playerView({ viewer: 0, active: 0, phase: o.phase ?? 0 });
  return {
    ...base,
    deckCount: o.deckCount ?? 20,
    sevenRevealed: o.revealed ?? null,
    you: { ...base.you, hand: o.hand ?? [], frozenHandIndices: o.frozen ?? [], points: o.youPoints ?? [], permanents: o.youPerms ?? [] },
    opponent: { ...base.opponent, points: o.oppPoints ?? [], permanents: o.oppPerms ?? [] },
  };
}

describe('staging names the target (light)', () => {
  it('9 on their K♣: "Play 9♠: send K♣ back to their hand; …"', () => {
    const v = view({ oppPerms: [card(13, 0)] });
    const m = mv({ Kind: Kind.OneOff, Card: card(9, 3), Target: { Owner: 1, Zone: 1, Index: 0 } });
    expect(plainMoveText('play 9♠ as one-off', optionContext(m, v))).toBe('Play 9♠: send K♣ back to their hand; they can’t play it next turn.');
  });

  it('9 on a card they stole from you: "your stolen 7♦ comes back to your hand"', () => {
    const v = view({ oppPoints: [entry(card(7, 1), 0, [card(11, 0)], 1)] });
    const m = mv({ Kind: Kind.OneOff, Card: card(9, 3), Target: { Owner: 1, Zone: 0, Index: 0 } });
    expect(plainMoveText('play 9♠ as one-off', optionContext(m, v))).toBe('Play 9♠: your stolen 7♦ comes back to your hand.');
  });

  it('Jack: "Steal their 7♦ with J♣."; a steal-back: "Take back your 7♦ with J♣."', () => {
    const jack = mv({ Kind: Kind.PlayPermanent, Card: card(11, 0), JackTarget: { Owner: 1, Zone: 0, Index: 0 } });
    expect(plainMoveText('play J♣ (steal opponent point)', optionContext(jack, view({ oppPoints: [entry(card(7, 1), 1)] })))).toBe(
      'Steal their 7♦ with J♣.',
    );
    expect(
      plainMoveText('play J♣ (steal opponent point)', optionContext(jack, view({ oppPoints: [entry(card(7, 1), 0, [card(11, 2)], 1)] }))),
    ).toBe('Take back your 7♦ with J♣.');
  });

  it('a 2 aimed at a royal is headed "Scrap K♦", and on a stack names its top Jack', () => {
    const v = view({ oppPerms: [card(13, 1)], oppPoints: [entry(card(7, 1), 0, [card(11, 3)], 1)] });
    const onKing = mv({ Kind: Kind.OneOff, Card: card(2, 0), Target: { Owner: 1, Zone: 1, Index: 0 } });
    expect(stagedHeading(onKing, v)).toBe('Scrap K♦');
    expect(plainMoveText('play 2♣ as one-off', optionContext(onKing, v))).toBe('Play 2♣ as a one-off: scrap their K♦.');
    const onStack = mv({ Kind: Kind.OneOff, Card: card(2, 0), Target: { Owner: 1, Zone: 0, Index: 0 } });
    expect(stagedHeading(onStack, v)).toBe('Scrap J♠');
    // (review B2) a deeper stack names its TOP (last) Jack, the one the
    // engine scraps (engine/apply.go v0.2.0 case Two pops the last).
    const deep = view({ oppPoints: [entry(card(7, 1), 0, [card(11, 3), card(11, 2), card(11, 0)], 1)] });
    expect(stagedHeading(onStack, deep)).toBe('Scrap J♣');
    expect(plainMoveText('play 2♣ as one-off', optionContext(onStack, deep))).toBe('Play 2♣ as a one-off: scrap their J♣.');
    // Other one-offs and permanents keep the card's name.
    expect(stagedHeading(mv({ Kind: Kind.OneOff, Card: card(5, 0) }), v)).toBe('Draw Two');
    expect(stagedHeading(mv({ Kind: Kind.PlayPoint, Card: card(5, 0) }), v)).toBeUndefined();
  });

  it('a 5 stages the count it will draw: hand limit 8 and the deck', () => {
    const five = mv({ Kind: Kind.OneOff, Card: card(5, 2) });
    const hand = (n: number): Card[] => Array.from({ length: n }, () => card(10, 0));
    expect(plainMoveText('play 5♥ as one-off', optionContext(five, view({ hand: hand(7) })))).toBe('Play 5♥ as a one-off: draw 2 cards.');
    expect(plainMoveText('play 5♥ as one-off', optionContext(five, view({ hand: hand(8) })))).toBe('Play 5♥ as a one-off: draw 1 card.');
    expect(plainMoveText('play 5♥ as one-off', optionContext(five, view({ hand: hand(3), deckCount: 1 })))).toBe('Play 5♥ as a one-off: draw 1 card.');
    expect(plainMoveText('play 5♥ as one-off', optionContext(five, view({ hand: hand(3), deckCount: 0 })))).toBe(
      'Play 5♥ as a one-off: the deck is empty, so you draw nothing.',
    );
    // (review N1) a 9 can leave a hand at 9; the deck still has cards.
    expect(plainMoveText('play 5♥ as one-off', optionContext(five, view({ hand: hand(9) })))).toBe(
      'Play 5♥ as a one-off: your hand is full, so you draw nothing.',
    );
    // A 7's 5 never enters the hand; its other revealed card goes back on the deck.
    const seven = mv({ Kind: Kind.SevenPick, Card: card(5, 2), SubMove: five });
    expect(plainMoveText('7: play 5♥ as one-off', optionContext(seven, view({ hand: hand(7), deckCount: 0, revealed: [card(5, 2), card(9, 1)] })))).toBe(
      'Play 5♥ as a one-off: draw 1 card.',
    );
  });
});

describe('cardText wording list (light)', () => {
  it('Rules: the 9 comes back to your hand; the Queen line says a Queen itself can still be hit', () => {
    expect(rulesOneOffLines().find((l) => l.rank === '9')?.text).toContain('it comes back to your hand.');
    const queen = rulesPermanentLines().find((l) => l.rank === 'Queen')?.text ?? '';
    expect(queen).toContain('can’t target your other cards. A Queen itself can still be hit.');
  });

  it('the glasses badge names the 8', () => {
    expect(inPlayBadge(card(8, 1), 'permanent')).toBe('8 Sees hand');
  });
});

// ---- Blocked reasons (public state only) ---------------------------------

describe('blocked reasons', () => {
  it('a Jack facing their Queen, or no points to steal', () => {
    expect(handCardReason(0, view({ hand: [card(11)], oppPerms: [card(12)], oppPoints: [entry(card(7), 1)] }))).toBe(BLOCKED_REASON.jackQueen);
    expect(handCardReason(0, view({ hand: [card(11)] }))).toBe(BLOCKED_REASON.jackNoPoints);
  });

  it('a frozen card, the 7 reveal, and the generic fallback', () => {
    expect(handCardReason(0, view({ hand: [card(11)], frozen: [0] }))).toBe(BLOCKED_REASON.frozen);
    expect(handCardReason(0, view({ hand: [card(4)], phase: 2 }))).toBe(BLOCKED_REASON.sevenFirst);
    expect(handCardReason(0, view({ hand: [card(4)], phase: 1 }))).toBe(NO_MOVES_REASON);
    expect(handCardReason(3, view({ hand: [card(4)] }))).toBe(NO_MOVES_REASON);
  });

  it('the deck: empty, or a full hand of 8', () => {
    const eight = Array.from({ length: 8 }, () => card(10));
    expect(deckReason(view({ hand: eight }))).toBe('Your hand is full (8 cards).');
    expect(deckReason(view({ deckCount: 0 }))).toBe('The deck is empty.');
    expect(deckReason(view({ hand: [card(1)] }))).toBeNull();
  });

  it('a 9 tapped onto a card their Queen protects says so; the Queen itself is no refusal', () => {
    const v = view({ oppPerms: [card(12), card(13)], oppPoints: [entry(card(7), 1)] });
    expect(targetReason(card(9), 'perm:1:1', v)).toBe('Their Queen protects that card from your 9.');
    expect(targetReason(card(9), 'point:1:0', v)).toBe('Their Queen protects that card from your 9.');
    expect(targetReason(card(11), 'point:1:0', v)).toBe('Their Queen protects that card from your Jack.');
    expect(targetReason(card(9), 'perm:1:0', v)).toBeNull();
    expect(targetReason(card(7), 'point:1:0', v)).toBeNull();
    expect(targetReason(card(9), 'point:1:0', view({ oppPoints: [entry(card(7), 1)] }))).toBeNull();
    expect(targetReason(card(2), 'perm:0:1', view({ youPerms: [card(12), card(13)] }))).toBe(BLOCKED_REASON.ownQueen);
  });

  it('(review B4) the Queen is named only where she is the cause', () => {
    const theirs = view({ oppPerms: [card(12), card(13)], oppPoints: [entry(card(7), 1), entry(card(5), 1, [card(11, 2)], 1)] });
    // A 2 never targets a plain point card: not the Queen's doing.
    expect(targetReason(card(2), 'point:1:0', theirs)).toBeNull();
    // A 2 on a Jack-topped point or a permanent: the Queen is the cause.
    expect(targetReason(card(2), 'point:1:1', theirs)).toBe('Their Queen protects that card from your 2.');
    expect(targetReason(card(2), 'perm:1:1', theirs)).toBe('Their Queen protects that card from your 2.');
    // A 2 on your own plain point with your own Queen: not the Queen's doing.
    expect(targetReason(card(2), 'point:0:0', view({ youPerms: [card(12)], youPoints: [entry(card(7), 0)] }))).toBeNull();
    // A Jack only steals points: their King is never its target.
    expect(targetReason(card(11), 'perm:1:1', theirs)).toBeNull();
    // A 9 never targets your own cards.
    expect(targetReason(card(9), 'perm:0:1', view({ youPerms: [card(12), card(13)] }))).toBeNull();
  });

  it('(review N3) reasons never depend on hidden or irrelevant state: opponent hand, hand count, scrap', () => {
    const bases = [
      view({ hand: [card(11)], oppPerms: [card(12)], oppPoints: [entry(card(7), 1)] }),
      view({ hand: [card(11)], frozen: [0] }),
      view({ hand: Array.from({ length: 8 }, () => card(10)) }),
      view({ hand: [card(9)], oppPerms: [card(12), card(13)], oppPoints: [entry(card(7), 1)] }),
    ];
    const keys = ['perm:1:1', 'point:1:0', 'perm:0:0', 'point:0:0'] as const;
    for (const base of bases) {
      const variants: PlayerView[] = [
        { ...base, opponent: { ...base.opponent, hand: null, handCount: 0 } },
        { ...base, opponent: { ...base.opponent, hand: [card(2, 1), card(12, 2)], handCount: 2 } },
        { ...base, opponent: { ...base.opponent, hand: null, handCount: 7 }, scrap: [card(3), card(9, 2)] },
      ];
      const sig = (v: PlayerView): string =>
        JSON.stringify([
          handCardReason(0, v),
          deckReason(v),
          ...[card(2), card(9), card(11)].flatMap((sel) => keys.map((k) => targetReason(sel, k, v))),
        ]);
      const expected = sig(base);
      for (const v of variants) expect(sig(v)).toBe(expected);
    }
  });
});

describe('stale highlights: the no-moves popover clears a previous selection', () => {
  it('selecting a card, then tapping a dimmed one, clears the lit zones', () => {
    const legalMoves = [mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: card(7) })];
    const env: StagingEnv = { legalMoves, descriptions: ['play 7♣ as point card'] };
    const store = new StagingStore(() => env, async () => {});
    store.tap('hand:1');
    expect(store.highlighted.size).toBeGreaterThan(0);
    store.tap('hand:0');
    expect(store.inspect).toBe(0);
    expect(store.highlighted.size).toBe(0);
    expect(store.selectedHand).toBeNull();
    expect(store.state).toBe('idle');
  });
});
