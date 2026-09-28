// Rank/Suit -> glyph mapping, pinned to SPEC §2.5. This is the ONLY place
// in the app allowed to hold this mapping (SPEC §5.6 rule 1) — every other
// file that needs a rank label or a suit glyph must render a theme `<Face>`.
// Not exported from `index.ts`; importing it from outside lib/theme/ fails
// tests/unit/theme-glyph-boundary.test.ts.

import type { Rank, Suit } from '../bridge/schema';

/** Suit 0..3 = Clubs, Diamonds, Hearts, Spades (SPEC §2.5). */
const SUIT_GLYPHS: Record<Suit, string> = {
  0: String.fromCodePoint(0x2663), // clubs
  1: String.fromCodePoint(0x2666), // diamonds
  2: String.fromCodePoint(0x2665), // hearts
  3: String.fromCodePoint(0x2660), // spades
};

/** Diamonds and hearts render red; clubs and spades render black. */
const SUIT_IS_RED: Record<Suit, boolean> = {
  0: false,
  1: true,
  2: true,
  3: false,
};

/** Rank 1 = Ace, 11 = Jack, 12 = Queen, 13 = King (SPEC §2.5). */
const RANK_LABELS: Record<Rank, string> = {
  1: 'A',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
};

export function suitGlyph(suit: Suit): string {
  return SUIT_GLYPHS[suit];
}

export function suitIsRed(suit: Suit): boolean {
  return SUIT_IS_RED[suit];
}

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}
