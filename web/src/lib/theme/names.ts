// Accessible card names ("King of Hearts"), for screen readers only. Lives
// in lib/theme/ with the glyph mapping (SPEC §5.6 rule 1): outside the
// theme, a card's rank and suit reach the page only through <Face>, and
// through this name on the container's aria-label. The name is the same
// for every theme, so a bitmap face (whose <img> is alt="") and a vector
// face read the same.
//
// Privacy: call this only for a card the viewer may see. A card back never
// gets a name (it takes no `card` at all).

import type { Card, Rank, Suit } from '../bridge/schema';

const RANK_NAMES: Record<Rank, string> = {
  1: 'Ace',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'Jack',
  12: 'Queen',
  13: 'King',
};

/** Suit 0..3 = Clubs, Diamonds, Hearts, Spades (SPEC §2.5). */
const SUIT_NAMES: Record<Suit, string> = {
  0: 'Clubs',
  1: 'Diamonds',
  2: 'Hearts',
  3: 'Spades',
};

/** "King of Hearts", "10 of Spades". */
export function cardSpokenName(card: Card): string {
  return `${RANK_NAMES[card.Rank]} of ${SUIT_NAMES[card.Suit]}`;
}
