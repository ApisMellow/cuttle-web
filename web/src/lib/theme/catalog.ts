// A-6 (PRD §10) — bitmap themes as data. A theme is a folder under
// `static/themes/<id>/` holding its images and a `manifest.json`, plus one
// entry in `static/themes/index.json`. Adding a theme needs no code change.
//
// Private to lib/theme/ (only `index.ts` re-exports what the app needs).
//
// Loading is lazy (R22, SPEC §5.6): the app fetches the tiny catalog after
// first paint, and a theme's manifest only when that theme is chosen. The
// images themselves load on demand, per card, from plain <img> tags.
//
// Every slot (each face, each glasses face, the back, the playmat) is
// optional. A theme may be partial: a missing slot, or an image that fails
// to load, renders the vector baseline for that one slot (SPEC §5.6 rule 4).

import type { Card, Suit } from '../bridge/schema';
import { rankLabel } from './glyphs';

/** One entry of `themes/index.json`. */
export interface ThemeCatalogEntry {
  id: string;
  label: string;
  /** Path to the theme's manifest, relative to `themes/`. */
  manifest: string;
}

/** One encoded image at a given pixel width (for `srcset` `w` descriptors). */
export interface ImageSource {
  src: string;
  w: number;
}

/**
 * Where the painted corner index sits inside a face image, as fractions of
 * the image (0..1). The `mini` size zooms to this box so the index stays
 * readable at 32 px.
 */
export interface IndexBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A slot resolved to absolute URLs, ready for an <img>. */
export interface ResolvedImage {
  /** Smallest source, the `src` fallback. */
  src: string;
  /** `srcset` with `w` descriptors, smallest first. */
  srcset: string;
  /** Widest source width in px, used to scale `sizes`. */
  maxWidth: number;
}

/** A loaded bitmap theme's slots. Absent keys fall back to vector. */
export interface BitmapAssets {
  themeId: string;
  /** Keyed by `faceKey(card)`, e.g. "A-spades". */
  faces: ReadonlyMap<string, ResolvedImage>;
  /** Keyed by suit name, e.g. "spades". Landscape art for a glasses 8. */
  glasses: ReadonlyMap<string, ResolvedImage>;
  back: ResolvedImage | null;
  table: ResolvedImage | null;
  index: IndexBox | null;
}

export interface BitmapThemeManifest {
  id: string;
  label: string;
  /** Total bytes of every image the manifest names (R22 budget). */
  assetBytes: number;
  faces: Record<string, ImageSource[]>;
  glasses: Record<string, ImageSource[]>;
  back: ImageSource[] | null;
  table: ImageSource[] | null;
  index: IndexBox | null;
}

/** Suit 0..3 = Clubs, Diamonds, Hearts, Spades (SPEC §2.5). */
const SUIT_NAMES: Record<Suit, string> = { 0: 'clubs', 1: 'diamonds', 2: 'hearts', 3: 'spades' };

export function suitName(suit: Suit): string {
  return SUIT_NAMES[suit];
}

/** The manifest key for a card's face: rank label, dash, suit name ("10-hearts"). */
export function faceKey(card: Card): string {
  return `${rankLabel(card.Rank)}-${SUIT_NAMES[card.Suit]}`;
}

// ─── Parsing (a bad entry drops that slot, never the whole theme) ─────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSources(value: unknown): ImageSource[] | null {
  if (!Array.isArray(value)) return null;
  const out: ImageSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { src, w } = item;
    if (typeof src !== 'string' || src === '' || typeof w !== 'number' || !(w > 0)) continue;
    out.push({ src, w });
  }
  return out.length > 0 ? out.sort((a, b) => a.w - b.w) : null;
}

function parseSlots(value: unknown): Record<string, ImageSource[]> {
  const out: Record<string, ImageSource[]> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const sources = parseSources(raw);
    if (sources) out[key] = sources;
  }
  return out;
}

function parseIndex(value: unknown): IndexBox | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  const nums = [x, y, w, h];
  if (!nums.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) return null;
  if ((w as number) <= 0 || (h as number) <= 0) return null;
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

export function parseCatalog(value: unknown): ThemeCatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.themes)) return [];
  const out: ThemeCatalogEntry[] = [];
  const seen = new Set<string>(['vector']);
  for (const item of value.themes) {
    if (!isRecord(item)) continue;
    const { id, label, manifest } = item;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
    if (typeof label !== 'string' || label === '') continue;
    if (typeof manifest !== 'string' || manifest === '') continue;
    seen.add(id);
    out.push({ id, label, manifest });
  }
  return out;
}

export function parseManifest(value: unknown, entry: ThemeCatalogEntry): BitmapThemeManifest {
  const obj = isRecord(value) ? value : {};
  return {
    id: entry.id,
    label: entry.label,
    assetBytes: typeof obj.assetBytes === 'number' && obj.assetBytes >= 0 ? obj.assetBytes : 0,
    faces: parseSlots(obj.faces),
    glasses: parseSlots(obj.glasses),
    back: parseSources(obj.back),
    table: parseSources(obj.table),
    index: parseIndex(obj.index),
  };
}

// ─── Resolving to URLs ────────────────────────────────────────────────────

function resolveImage(sources: ImageSource[] | null | undefined, baseUrl: string): ResolvedImage | null {
  if (!sources || sources.length === 0) return null;
  const abs = sources.map((s) => ({ url: new URL(s.src, baseUrl).href, w: s.w }));
  return {
    src: abs[0].url,
    srcset: abs.map((s) => `${s.url} ${s.w}w`).join(', '),
    maxWidth: abs[abs.length - 1].w,
  };
}

function resolveSlots(slots: Record<string, ImageSource[]>, baseUrl: string): Map<string, ResolvedImage> {
  const out = new Map<string, ResolvedImage>();
  for (const [key, sources] of Object.entries(slots)) {
    const image = resolveImage(sources, baseUrl);
    if (image) out.set(key, image);
  }
  return out;
}

/** `baseUrl` is the manifest's own URL; slot paths resolve relative to it. */
export function resolveAssets(manifest: BitmapThemeManifest, baseUrl: string): BitmapAssets {
  return {
    themeId: manifest.id,
    faces: resolveSlots(manifest.faces, baseUrl),
    glasses: resolveSlots(manifest.glasses, baseUrl),
    back: resolveImage(manifest.back, baseUrl),
    table: resolveImage(manifest.table, baseUrl),
    index: manifest.index,
  };
}
