// W24 — the vector theme's glasses art (an 8 in play as a permanent, R7).
// Private to lib/theme/ like glyphs.ts. Geometry is a fixed 130 x 100
// viewBox: landscape at the app's ~1.3 card ratio, because the permanent
// row lays a glasses 8 on its side.

import type { Suit } from '../bridge/schema';

export const GLASSES_VIEWBOX = '0 0 130 100';

/** The came (lead) between panes, and the goggles' outlines. */
export const LEAD = '#1a1420';
/** The goggles' brass frame. */
export const BRASS = '#d9b25a';
/** Lens glass. */
export const GLASS = '#f2efe6';

export type GlassesTint = 'clubs' | 'diamonds' | 'hearts' | 'spades';

/** Suit 0..3 = Clubs, Diamonds, Hearts, Spades (SPEC §2.5). */
const TINTS: Record<Suit, GlassesTint> = { 0: 'clubs', 1: 'diamonds', 2: 'hearts', 3: 'spades' };

/**
 * Four pane shades per suit, mid / light / deep / bright: hearts red,
 * diamonds amber, clubs green, spades blue-black.
 */
const PALETTES: Record<GlassesTint, readonly [string, string, string, string]> = {
  clubs: ['#2f7d4a', '#3f9a5d', '#1f5c35', '#5aae74'],
  diamonds: ['#c98a12', '#e3a92a', '#a86c0a', '#f0c357'],
  hearts: ['#b0172e', '#cf2f48', '#8a0f22', '#e25a6d'],
  spades: ['#24314f', '#33466e', '#161e33', '#4a6090'],
};

export function glassesTint(suit: Suit): GlassesTint {
  return TINTS[suit];
}

export function glassesPalette(suit: Suit): readonly [string, string, string, string] {
  return PALETTES[TINTS[suit]];
}

// The pane grid: four rows of vertices, deliberately irregular so the
// leading reads as hand-cut glass rather than a table.
const V = {
  a: [0, 0], b: [36, 0], c: [66, 0], d: [98, 0], e: [130, 0],
  f: [0, 34], g: [30, 28], h: [64, 20], i: [100, 30], j: [130, 24],
  k: [0, 70], l: [26, 76], m: [62, 82], n: [104, 72], o: [130, 78],
  p: [0, 100], q: [40, 100], r: [70, 100], s: [96, 100], t: [130, 100],
} as const;

type VertexName = keyof typeof V;

const QUADS: ReadonlyArray<readonly [VertexName, VertexName, VertexName, VertexName, number]> = [
  ['a', 'b', 'g', 'f', 0],
  ['b', 'c', 'h', 'g', 1],
  ['c', 'd', 'i', 'h', 2],
  ['d', 'e', 'j', 'i', 3],
  ['f', 'g', 'l', 'k', 3],
  ['g', 'h', 'm', 'l', 0],
  ['h', 'i', 'n', 'm', 1],
  ['i', 'j', 'o', 'n', 2],
  ['k', 'l', 'q', 'p', 1],
  ['l', 'm', 'r', 'q', 2],
  ['m', 'n', 's', 'r', 3],
  ['n', 'o', 't', 's', 0],
];

export interface GlassesPane {
  points: string;
  shade: number;
}

export const GLASSES_PANES: readonly GlassesPane[] = QUADS.map(([w, x, y, z, shade]) => ({
  points: [w, x, y, z].map((name) => V[name].join(',')).join(' '),
  shade,
}));

export interface GlassesLens {
  cx: number;
  cy: number;
  /** The lid's lower edge, relative to cy: the right lens droops a touch lower (smug). */
  lid: number;
}

export const LENS_RIM = 23;
export const LENS_FRAME = 21;
export const LENS_GLASS = 17.5;

export const GLASSES_LENSES: readonly [GlassesLens, GlassesLens] = [
  { cx: 39, cy: 54, lid: -1 },
  { cx: 91, cy: 54, lid: 2 },
];

/** The half-closed lid over a lens: the part of the glass circle above `cy + lid`. */
export function lidPath({ cx, cy, lid }: GlassesLens): string {
  const r = LENS_GLASS;
  const dx = Math.sqrt(r * r - lid * lid);
  const large = lid > 0 ? 1 : 0;
  const y = cy + lid;
  return `M ${cx - dx} ${y} A ${r} ${r} 0 ${large} 1 ${cx + dx} ${y} Z`;
}
