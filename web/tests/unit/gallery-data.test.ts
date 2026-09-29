// @vitest-environment node
// Card gallery (gallery/, ROADMAP "Card gallery"): the standalone gallery
// carries its own copy of each card's name and effect (gallery/build.py
// writes gallery/site/cards.json). These checks keep that copy in step with
// the game's wording and keep the gallery free of game code and local paths.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Rank, Suit } from '../../src/lib/bridge/schema';
import { CLASSIC_NAMES, cardEffectLine } from '../../src/lib/cardText';

const SITE = fileURLToPath(new URL('../../../gallery/site/', import.meta.url));

interface GalleryCard {
  id: string;
  kind: 'back' | 'face' | 'glasses';
  title: string;
  subtitle: string;
  effect: string;
  alt: string;
  img: string;
  thumb: string;
  imgW: number;
  imgH: number;
}

const { cards } = JSON.parse(readFileSync(`${SITE}cards.json`, 'utf8')) as { cards: GalleryCard[] };

const RANK_IDS: Record<string, Rank> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};
// Integer-like object keys sort first, so the order is spelled out.
const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// schema.ts Suit: 0 Clubs, 1 Diamonds, 2 Hearts, 3 Spades.
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];

describe('gallery cards.json', () => {
  it('holds the back, 52 faces and 4 glasses faces, in rank then suit order', () => {
    expect(cards).toHaveLength(57);
    const expected = ['back'];
    for (const rank of RANK_ORDER) {
      for (const suit of SUITS) expected.push(`${rank}-${suit}`);
      if (rank === '8') for (const suit of SUITS) expected.push(`glasses-${suit}`);
    }
    expect(cards.map((c) => c.id)).toEqual(expected);
  });

  it("uses the game's Classic name and effect line for every card", () => {
    for (const c of cards) {
      if (c.kind === 'back') continue;
      const [rankId, suit] = c.id.split('-');
      const rank = c.kind === 'glasses' ? 8 : RANK_IDS[rankId];
      const card = { Rank: rank, Suit: SUITS.indexOf(suit) as Suit };
      expect(c.title, c.id).toBe(CLASSIC_NAMES[rank]);
      expect(c.effect, c.id).toBe(cardEffectLine(card));
    }
  });

  it('shows the full 2:3 painting (3:2 for glasses) and every image exists', () => {
    for (const c of cards) {
      expect(c.alt.length, c.id).toBeGreaterThan(10);
      for (const path of [c.img, c.thumb]) {
        expect(path, c.id).toMatch(/\.webp$/);
        expect(existsSync(`${SITE}${path}`), path).toBe(true);
      }
      if (c.kind === 'face') expect(c.imgW / c.imgH, c.id).toBeCloseTo(2 / 3, 2);
      if (c.kind === 'glasses') expect(c.imgW / c.imgH, c.id).toBeCloseTo(3 / 2, 2);
    }
  });

  it('imports no game code and names no local paths', () => {
    for (const name of readdirSync(SITE).filter((f) => /\.(html|css|js|json)$/.test(f))) {
      const text = readFileSync(`${SITE}${name}`, 'utf8');
      expect(text, name).not.toMatch(/\bimport\b|\/src\/lib\/|\/Users\/|\/home\//);
    }
  });
});
