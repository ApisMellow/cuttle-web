// SPEC §4.6 — the R20 "while you were away" recap formatter. Every row of
// the §4.6 table is proven here from the exact `Move.Describe` strings the
// pinned engine (github.com/ApisMellow/cuttle v0.2.0, engine/moves.go:36-70
// and card/card.go:14-47) actually emits, not from guessed text.
//
// Test names are prefixed with the requirement ID they prove, matching
// tests/unit/schema.test.ts's convention.

import { describe, expect, it } from 'vitest';

import { formatRecapLine, isRecapVisible } from '../../src/lib/recap';
import type { AppliedMove, PlayerId } from '../../src/lib/bridge/schema';

const NAMES: [string, string] = ['Alice', 'Bob'];

function move(partial: {
  by: PlayerId;
  kind: AppliedMove['kind'];
  description: string;
  subKind?: AppliedMove['subKind'];
  card?: AppliedMove['card'];
  targetCard?: AppliedMove['targetCard'];
  seq?: number;
}): AppliedMove {
  return {
    by: partial.by,
    kind: partial.kind,
    card: partial.card ?? null,
    description: partial.description,
    seq: partial.seq ?? 1,
    subKind: partial.subKind ?? null,
    targetCard: partial.targetCard ?? null,
  };
}

const SUIT_GLYPH = /[♣♦♥♠]/;

describe('formatRecapLine — SPEC §4.6 table, opponent-of-actor viewpoint', () => {
  it('R20.2: Draw — "NAME drew a card."', () => {
    const entry = move({ by: 1, kind: 0, description: 'draw a card' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob drew a card.');
  });

  it('R20.2: PlayPoint — "NAME played CARD for points."', () => {
    const entry = move({ by: 1, kind: 1, description: 'play 7♥ as point card' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob played 7♥ for points.');
  });

  it('R20.2: PlayPoint covers the full rank alphabet — 10 and non-numeric A/J/K (card/card.go:36-38)', () => {
    // card.Rank.String() has two shapes: two-digit "10" and single-glyph
    // letters (A, J, Q, K) versus single digits (2-9) — the CARD regex's
    // `(?:10|[2-9]|[AJQK])` alternation must match all of them.
    expect(formatRecapLine(move({ by: 1, kind: 1, description: 'play 10♠ as point card' }), 0, NAMES)).toBe(
      'Bob played 10♠ for points.',
    );
    expect(formatRecapLine(move({ by: 1, kind: 1, description: 'play A♣ as point card' }), 0, NAMES)).toBe(
      'Bob played A♣ for points.',
    );
    expect(formatRecapLine(move({ by: 1, kind: 1, description: 'play J♦ as point card' }), 0, NAMES)).toBe(
      'Bob played J♦ for points.',
    );
    expect(formatRecapLine(move({ by: 1, kind: 1, description: 'play K♥ as point card' }), 0, NAMES)).toBe(
      'Bob played K♥ for points.',
    );
  });

  it('R20.2: PlayPermanent non-Jack — "NAME played CARD as a permanent."', () => {
    const entry = move({ by: 1, kind: 2, description: 'play Q♦ as permanent' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob played Q♦ as a permanent.');
  });

  it('R20.2: PlayPermanent Jack — names the actual stolen card, per SPEC §4.6\'s literal example', () => {
    // engine/moves.go's Describe for a Jack steal —
    // `"play %s (steal opponent point)"` — never embeds the stolen card's
    // identity, unlike Scuttle's Describe. `entry.targetCard` (§2.7,
    // amended 2026-09-27) supplies it instead: the JackTarget read from the
    // pre-state.
    const entry = move({
      by: 1,
      kind: 2,
      description: 'play J♣ (steal opponent point)',
      targetCard: { Rank: 10, Suit: 2 },
    });
    const line = formatRecapLine(entry, 0, NAMES);
    expect(line).toBe('Bob stole your 10♥ with J♣.');
    // Exactly two card glyphs: the stolen card and the Jack — no third.
    expect(line.match(/[♣♦♥♠]/g)).toHaveLength(2);
  });

  it('R20.2: PlayPermanent Jack fails loudly if targetCard is missing — SPEC §2.7 guarantees it is always set', () => {
    const entry = move({ by: 1, kind: 2, description: 'play J♣ (steal opponent point)', targetCard: null });
    expect(() => formatRecapLine(entry, 0, NAMES)).toThrow();
  });

  it('R20.2: Scuttle — "NAME scuttled your CARD with CARD."', () => {
    const entry = move({ by: 1, kind: 3, description: "scuttle opponent's 7♥ with 9♠" });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob scuttled your 7♥ with 9♠.');
  });

  it('R20.2: OneOff without a target — "NAME played CARD as a one-off."', () => {
    const entry = move({ by: 1, kind: 4, description: 'play 9♥ as one-off', targetCard: null });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob played 9♥ as a one-off.');
  });

  it('R20.2 (amended 2026-09-27): OneOff with a target — appends a target clause naming no owner', () => {
    // engine/moves.go's Describe for MoveOneOff — `"play %s as one-off"` —
    // is identical whether or not `Move.Target` was set. `entry.targetCard`
    // (§2.7, amended 2026-09-27) now supplies the §4.6 "+ target clause
    // when Target is set". Wording assumption (docs/assumptions.md): the clause names
    // only the targeted card, never whose it is — true regardless of
    // ownership, since a rank-2 can target either side.
    const withTarget = move({ by: 1, kind: 4, description: 'play 9♥ as one-off', targetCard: { Rank: 10, Suit: 1 } });
    const withoutTarget = move({ by: 1, kind: 4, description: 'play 9♥ as one-off', targetCard: null });
    expect(formatRecapLine(withTarget, 0, NAMES)).toBe('Bob played 9♥ as a one-off, targeting 10♦.');
    expect(formatRecapLine(withoutTarget, 0, NAMES)).toBe('Bob played 9♥ as a one-off.');
    expect(formatRecapLine(withTarget, 0, NAMES)).not.toBe(formatRecapLine(withoutTarget, 0, NAMES));
  });

  it('R20.2: Counter — "NAME countered with CARD."', () => {
    const entry = move({ by: 0, kind: 5, description: 'counter with 2♠' });
    expect(formatRecapLine(entry, 1, NAMES)).toBe('Alice countered with 2♠.');
  });

  it('R20.2: Decline is never shown in the recap (R14)', () => {
    // David, 2026-09-27: a real decline writes a `Decline` history entry;
    // the synthetic R14 acknowledgment writes none. Recapping a `Decline`
    // would tell the acting player the opponent actually held a
    // counter-2, and would change whether a recap screen appears at all.
    const entry = move({ by: 0, kind: 6, description: 'decline to counter' });
    expect(isRecapVisible(entry)).toBe(false);
    expect(() => formatRecapLine(entry, 1, NAMES)).toThrow();
  });

  it('R20.2: every other MoveKind is recap-visible', () => {
    const visibleKinds: Array<AppliedMove['kind']> = [0, 1, 2, 3, 4, 5, 7, 8, 9];
    for (const kind of visibleKinds) {
      expect(isRecapVisible(move({ by: 0, kind, description: 'draw a card' }))).toBe(true);
    }
  });

  it('R20.2: a history differing only by a Decline entry yields an identical visible recap', () => {
    const withoutDecline: AppliedMove[] = [
      move({ by: 1, kind: 0, description: 'draw a card', seq: 1 }),
      move({ by: 0, kind: 9, description: 'pass', seq: 2 }),
    ];
    const withDecline: AppliedMove[] = [
      move({ by: 1, kind: 0, description: 'draw a card', seq: 1 }),
      move({ by: 0, kind: 6, description: 'decline to counter', seq: 2 }),
      move({ by: 0, kind: 9, description: 'pass', seq: 3 }),
    ];
    const visibleLines = (history: AppliedMove[]): string[] =>
      history.filter(isRecapVisible).map((entry) => formatRecapLine(entry, 0, NAMES));
    expect(visibleLines(withDecline)).toEqual(visibleLines(withoutDecline));
  });

  it('R20.2: SevenPick — "NAME revealed the top of the deck and played CARD for points."', () => {
    // Wording amended by David, 2026-09-27: "revealed two cards" →
    // "revealed the top of the deck" (SPEC §4.6).
    const entry = move({ by: 1, kind: 7, subKind: 1, description: '7: play 5♥ as point card' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob revealed the top of the deck and played 5♥ for points.');
  });

  it('R20.2: SevenPick wrapping a PlayPermanent Jack — "revealed the top of the deck and stole your CARD with CARD."', () => {
    const entry = move({
      by: 1,
      kind: 7,
      subKind: 2,
      description: '7: play J♣ (steal opponent point)',
      targetCard: { Rank: 10, Suit: 2 },
    });
    expect(formatRecapLine(entry, 0, NAMES)).toBe(
      'Bob revealed the top of the deck and stole your 10♥ with J♣.',
    );
  });

  it('R20.2: SevenPick wrapping a Scuttle — "revealed the top of the deck and scuttled your CARD with CARD."', () => {
    const entry = move({ by: 1, kind: 7, subKind: 3, description: "7: scuttle opponent's 7♥ with 9♠" });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob revealed the top of the deck and scuttled your 7♥ with 9♠.');
  });

  it('R20.2: SevenPick wrapping a OneOff — "revealed the top of the deck and played CARD as a one-off."', () => {
    const entry = move({ by: 1, kind: 7, subKind: 4, description: '7: play 9♥ as one-off', targetCard: null });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob revealed the top of the deck and played 9♥ as a one-off.');
  });

  it('R20.2 (amended 2026-09-27): SevenPick wrapping a targeted OneOff — appends the target clause', () => {
    const entry = move({
      by: 1,
      kind: 7,
      subKind: 4,
      description: '7: play 9♥ as one-off',
      targetCard: { Rank: 10, Suit: 1 },
    });
    expect(formatRecapLine(entry, 0, NAMES)).toBe(
      'Bob revealed the top of the deck and played 9♥ as a one-off, targeting 10♦.',
    );
  });

  it('R20.2: SevenPick whitelists subKind — fails loudly on a subKind that can never be a Seven sub-move', () => {
    // Draw, Pass, Decline, DiscardPair, and SevenPick itself can never be a
    // Seven's SubMove (engine/apply.go:405-407, 521-544).
    for (const badSubKind of [0, 5, 6, 7, 8, 9] as const) {
      const entry = move({ by: 1, kind: 7, subKind: badSubKind, description: '7: play 5♥ as point card' });
      expect(() => formatRecapLine(entry, 0, NAMES)).toThrow();
    }
  });

  it('R20.2: Pass — "NAME passed."', () => {
    const entry = move({ by: 1, kind: 9, description: 'pass' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob passed.');
  });

  it('R20.2: DiscardPair names no identities — never the hand indices, never a card', () => {
    const entryA = move({ by: 1, kind: 8, description: 'discard hand[0] and hand[3]' });
    const lineA = formatRecapLine(entryA, 0, NAMES);
    expect(lineA).toBe('Bob discarded 2 cards.');
    expect(lineA).not.toMatch(SUIT_GLYPH);
    // The fixed word "2" (the count) is expected; the actual DiscardA/B
    // index values (0 and 3) must never surface. Vary the indices and
    // confirm the output is byte-identical regardless — proof the
    // formatter never parses them out of the description at all.
    const entryB = move({ by: 1, kind: 8, description: 'discard hand[5] and hand[9]' });
    const lineB = formatRecapLine(entryB, 0, NAMES);
    expect(lineB).toBe(lineA);
    expect(lineB).not.toContain('5');
    expect(lineB).not.toContain('9');
  });

  it('R20.2 (assumption): one-card DiscardPair — "NAME discarded 1 card." — engine apply.go:509-511', () => {
    // §4.6 has no one-card row (the table only shows the 2-card case).
    // Assumption: singular wording when the engine's DiscardB sentinel
    // (-1, meaning "hand had only one card") is present. Still never reads
    // or echoes the index values themselves — only whether the second one
    // is literally -1. The fixed word "1" (the count) is expected — same
    // as "2" in the two-card case above — but DiscardA's actual value
    // (always 0 for this shape per apply.go:510) must never surface.
    const entry = move({ by: 1, kind: 8, description: 'discard hand[0] and hand[-1]' });
    const line = formatRecapLine(entry, 0, NAMES);
    expect(line).toBe('Bob discarded 1 card.');
    expect(line).not.toMatch(SUIT_GLYPH);
    expect(line).not.toContain('-1');
    expect(line).not.toContain('0');
  });

  it('R20.2 (assumption): one-card DiscardPair, own move — "You discarded 1 card."', () => {
    const entry = move({ by: 0, kind: 8, description: 'discard hand[0] and hand[-1]' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You discarded 1 card.');
  });
});

describe('formatRecapLine — SPEC §4.6, viewer-is-the-actor (own moves)', () => {
  // No table row covers this (SPEC §4.6 is written entirely from "viewer is
  // the opponent of the actor"). Assumption (docs/assumptions.md): second-person
  // "You ..." phrasing, symmetric with the opponent-viewpoint table.

  it('SPEC §4.6 (assumption): Draw, own move — "You drew a card."', () => {
    const entry = move({ by: 0, kind: 0, description: 'draw a card' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You drew a card.');
  });

  it('SPEC §4.6 (assumption): PlayPermanent Jack, own move — names the opponent, not "your"', () => {
    const entry = move({ by: 0, kind: 2, description: 'play J♣ (steal opponent point)', targetCard: { Rank: 10, Suit: 2 } });
    expect(formatRecapLine(entry, 0, NAMES)).toBe("You stole Bob's 10♥ with J♣.");
  });

  it('SPEC §4.6 (assumption): Scuttle, own move — names the opponent, not "your"', () => {
    const entry = move({ by: 0, kind: 3, description: "scuttle opponent's 7♥ with 9♠" });
    expect(formatRecapLine(entry, 0, NAMES)).toBe("You scuttled Bob's 7♥ with 9♠.");
  });

  it('SPEC §4.6 (assumption): SevenPick, own move', () => {
    const entry = move({ by: 0, kind: 7, subKind: 1, description: '7: play 5♥ as point card' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You revealed the top of the deck and played 5♥ for points.');
  });

  it('SPEC §4.6 (assumption): DiscardPair, own move', () => {
    const entry = move({ by: 0, kind: 8, description: 'discard hand[0] and hand[1]' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You discarded 2 cards.');
  });

  it('SPEC §4.6 (assumption): Pass, own move', () => {
    const entry = move({ by: 0, kind: 9, description: 'pass' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You passed.');
  });

  it('R20.2: Counter, own move — "You countered with CARD." (Counter from both viewpoints)', () => {
    const entry = move({ by: 0, kind: 5, description: 'counter with 2♠' });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('You countered with 2♠.');
  });
});

describe('formatRecapLine — R16.2: SevenPick never names the unchosen revealed card', () => {
  it('R16.2: played branch names only the played card, audited against SPEC §4.6\'s SevenPick row', () => {
    const entry = move({ by: 1, kind: 7, subKind: 1, description: '7: play 5♥ as point card' });
    const line = formatRecapLine(entry, 0, NAMES);
    expect(line).toBe('Bob revealed the top of the deck and played 5♥ for points.');
    // In this hypothetical deal the OTHER revealed-but-unchosen card was
    // K♠ — per engine/apply.go:445-456 it returns face-down to the top of
    // the deck and never appears anywhere in `AppliedMove` at all. Assert
    // it cannot leak into the recap line.
    expect(line).not.toContain('K♠');
  });

  it('R16.2: dead-end (no legal play) names the scrapped card — that one is public (R6) — never the hidden one', () => {
    const entry = move({ by: 1, kind: 7, subKind: null, description: '7: no legal play — scrap 5♥' });
    const line = formatRecapLine(entry, 0, NAMES);
    expect(line).toBe('Bob revealed the top of the deck and scrapped 5♥ (no legal play).');
    // Per engine/apply.go:419-437, the OTHER revealed card returns hidden
    // to the deck top in this branch too — same non-leak guarantee.
    expect(line).not.toContain('K♠');
  });

  it('R16.2: fails loudly rather than silently accept a description that smuggles a second card', () => {
    // Adversarial input: not a real engine output (Describe never emits
    // two cards for a played SevenPick), but if it ever did, the formatter
    // must reject it outright rather than risk echoing an unchosen card.
    const entry = move({
      by: 1,
      kind: 7,
      subKind: 1,
      description: '7: play 5♥ as point card (K♠ also revealed)',
    });
    expect(() => formatRecapLine(entry, 0, NAMES)).toThrow();
  });
});

describe('formatRecapLine — robustness', () => {
  it('derives card identity solely from entry.description, ignoring entry.card entirely', () => {
    const entry = move({
      by: 1,
      kind: 1,
      description: 'play 7♥ as point card',
      card: { Rank: 2, Suit: 0 }, // deliberately mismatched — must be ignored
    });
    expect(formatRecapLine(entry, 0, NAMES)).toBe('Bob played 7♥ for points.');
  });

  it('throws on an unrecognized MoveKind rather than guessing at phrasing', () => {
    const entry = move({ by: 1, kind: 1, description: 'play 7♥ as point card' });
    (entry as { kind: number }).kind = 42;
    expect(() => formatRecapLine(entry, 0, NAMES)).toThrow();
  });

  it('throws when a description does not match the engine\'s pinned Describe format', () => {
    const entry = move({ by: 1, kind: 1, description: 'plays a seven of hearts for points' });
    expect(() => formatRecapLine(entry, 0, NAMES)).toThrow();
  });
});
