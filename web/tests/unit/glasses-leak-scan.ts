// Test-only support for the glasses-8 privacy suites (R7, SPEC §3.2).
//
// `leakForms(card)` lists every spelling of one card identity the app, the
// theme or a serializer could plausibly write into the DOM: the glyph label
// the vector face draws ("8" + heart glyph), the rank/suit id the tests use
// ("8/2"), the wire JSON ("Rank":8,"Suit":2, with or without spaces), and
// the word forms a screen-reader label or an image key would use ("eight of
// hearts", "8 of hearts", "8-hearts", as in the bitmap manifest's face key).
// All comparisons are lowercase.
//
// `expectNoLeak(root, cards)` fails if any form of any card appears in the
// serialized DOM, its text, any attribute value (decoded), or any
// accessible-name attribute.
import { expect } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';

export const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const GLYPHS = [0x2663, 0x2666, 0x2665, 0x2660].map((cp) => String.fromCodePoint(cp));
const RANK_WORDS = ['', 'ace', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king'];
const SUIT_WORDS = ['clubs', 'diamonds', 'hearts', 'spades'];

/** "8" + heart glyph, etc. — how the vector face and the engine's descriptions name a card. */
export function label(c: Card): string {
  return `${RANKS[c.Rank]}${GLYPHS[c.Suit]}`;
}

/** The rank/suit id the privacy tests compare faces by. */
export function id(c: Card): string {
  return `${c.Rank}/${c.Suit}`;
}

export function leakForms(c: Card): string[] {
  const rank = RANKS[c.Rank].toLowerCase();
  const word = RANK_WORDS[c.Rank];
  const suit = SUIT_WORDS[c.Suit];
  return [
    label(c).toLowerCase(),
    id(c),
    `"rank":${c.Rank},"suit":${c.Suit}`,
    `"rank": ${c.Rank}, "suit": ${c.Suit}`,
    `${word} of ${suit}`,
    `${rank} of ${suit}`,
    `${rank}-${suit}`,
  ];
}

/** Every attribute a screen reader or an image could speak a card name through. */
function accessibleNames(root: HTMLElement): string[] {
  const names: string[] = [];
  const attrs = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'alt', 'title'];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v !== null) names.push(v.toLowerCase());
    }
  }
  return names;
}

/** Every attribute value, decoded (innerHTML escapes quotes, so wire JSON in an attribute only shows up here). */
function attributeValues(root: HTMLElement): string[] {
  const values: string[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of el.attributes) values.push(attr.value.toLowerCase());
  }
  return values;
}

export function expectNoLeak(root: HTMLElement, cards: readonly Card[], where: string): void {
  const html = root.innerHTML.toLowerCase();
  const text = (root.textContent ?? '').toLowerCase();
  const names = accessibleNames(root);
  const attrs = attributeValues(root);
  for (const c of cards) {
    for (const form of leakForms(c)) {
      expect(html.includes(form), `${where}: "${form}" in the DOM`).toBe(false);
      expect(text.includes(form), `${where}: "${form}" in the text`).toBe(false);
      expect(names.filter((n) => n.includes(form)), `${where}: "${form}" in an accessible name`).toEqual([]);
      expect(attrs.filter((v) => v.includes(form)), `${where}: "${form}" in an attribute`).toEqual([]);
    }
  }
}
