// SPEC §5.6 — the theme registry and the theme seam's public surface.
//
// Code outside `lib/theme/` may import only this module, `./types` and
// `./default` (enforced by tests/unit/theme-glyph-boundary.test.ts). This
// module deliberately exports NO glyph helper: the only way to draw a card
// anywhere in the app is a theme's `<Face>` / `<Back>` (rule 1).
//
// `vector` (shown to players as "Classic") is built in. Bitmap themes are
// data (PRD §10 A-6): `loadThemeCatalog()` reads `static/themes/index.json`
// after first paint, and `ensureThemeLoaded(id)` fetches one theme's
// manifest only when that theme is chosen. Until it has loaded, `getTheme`
// returns `vector` (rule 4), so first paint never waits on art.

import { SvelteMap } from 'svelte/reactivity';

import { bitmapTheme } from './bitmap';
import { parseCatalog, parseManifest, resolveAssets, type ThemeCatalogEntry } from './catalog';
import { DEFAULT_THEME_ID } from './default';
import { clearImageFailures } from './failed-images';
import type { CardTheme } from './types';
import VectorCardBack from './VectorCardBack.svelte';
import VectorCardFace from './VectorCardFace.svelte';

export type {
  CardTheme,
  CardFaceProps,
  CardFaceVariant,
  CardBackProps,
  TableProps,
  CardSize,
  CardVisualState,
} from './types';

/**
 * The single constant naming the ship-time default (SPEC §5.6 rule 5).
 * Defined in `./default` (component-free, so the settings store can import
 * it cheaply) and re-exported here as the app-facing name.
 */
export { DEFAULT_THEME_ID };

/**
 * Forgets every bitmap image load error so each image gets tried again.
 * GameScreen calls it at each handoff: a transient failure doesn't stick
 * for the session, and one hot-seat player's failures never carry over to
 * what the other sees.
 */
export { clearImageFailures };

/** SPEC §5.6 rule 4: zero external assets, always available, the fallback. */
export const vectorTheme: CardTheme = {
  id: 'vector',
  label: 'Classic',
  Face: VectorCardFace,
  Back: VectorCardBack,
  assetBytes: 0,
  available: () => true,
};

// Reactive, so a theme whose manifest finishes loading swaps in wherever
// `getTheme(settings.themeId)` is derived.
const registry = new SvelteMap<string, CardTheme>([[vectorTheme.id, vectorTheme]]);

/** Adds or replaces a theme in the registry. P-ART's entry point. */
export function registerTheme(theme: CardTheme): void {
  registry.set(theme.id, theme);
}

/**
 * Looks up a theme by id. SPEC §5.6 rule 4: an unknown id, or a theme whose
 * `available()` currently returns false, falls back to `vector` silently.
 */
export function getTheme(id: string): CardTheme {
  const theme = registry.get(id);
  if (!theme || !theme.available()) return vectorTheme;
  return theme;
}

export function listThemes(): CardTheme[] {
  return [...registry.values()];
}

// ─── Bitmap theme catalog (A-6) ───────────────────────────────────────────

/** A theme a player can pick, whether or not its assets have loaded yet. */
export interface ThemeChoice {
  id: string;
  label: string;
}

const catalog = new SvelteMap<string, ThemeCatalogEntry>();
let catalogRequest: Promise<void> | null = null;
const manifestRequests = new Map<string, Promise<void>>();

export interface ThemeLoadOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Absolute URL of the `themes/` directory, ending in `/`. */
  themesUrl?: string;
}

function defaultThemesUrl(): string {
  const base = import.meta.env.BASE_URL ?? '/';
  const origin = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  return new URL(`${base}themes/`, origin).href;
}

async function fetchJson(url: string, doFetch: typeof fetch): Promise<unknown> {
  const response = await doFetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

/**
 * Reads the theme catalog once. Never throws: a missing or malformed
 * catalog just leaves Classic as the only choice for now. A failed read is
 * not cached, so the next call (for example choosing a theme) tries again.
 */
export function loadThemeCatalog(options: ThemeLoadOptions = {}): Promise<void> {
  if (catalogRequest) return catalogRequest;
  const doFetch = options.fetch ?? globalThis.fetch;
  const themesUrl = options.themesUrl ?? defaultThemesUrl();
  catalogRequest = (async () => {
    try {
      for (const entry of parseCatalog(await fetchJson(new URL('index.json', themesUrl).href, doFetch))) {
        catalog.set(entry.id, { ...entry, manifest: new URL(entry.manifest, themesUrl).href });
      }
    } catch {
      // No catalog: Classic only, until a later call retries.
      catalogRequest = null;
    }
  })();
  return catalogRequest;
}

/**
 * Loads one bitmap theme's manifest and registers the theme. Idempotent;
 * never throws. An unknown id, or a manifest that can't be read, leaves
 * `getTheme(id)` on the vector fallback.
 */
export function ensureThemeLoaded(id: string, options: ThemeLoadOptions = {}): Promise<void> {
  if (id === vectorTheme.id) return Promise.resolve();
  const existing = manifestRequests.get(id);
  if (existing) return existing;
  const doFetch = options.fetch ?? globalThis.fetch;
  const request = (async () => {
    await loadThemeCatalog(options);
    const entry = catalog.get(id);
    if (!entry) {
      manifestRequests.delete(id);
      return;
    }
    try {
      const manifest = parseManifest(await fetchJson(entry.manifest, doFetch), entry);
      registerTheme(bitmapTheme(manifest, resolveAssets(manifest, entry.manifest)));
    } catch {
      manifestRequests.delete(id);
    }
  })();
  manifestRequests.set(id, request);
  return request;
}

/** Classic first, then every catalog theme, in catalog order. */
export function listThemeChoices(): ThemeChoice[] {
  return [
    { id: vectorTheme.id, label: vectorTheme.label },
    ...[...catalog.values()].map((entry) => ({ id: entry.id, label: entry.label })),
  ];
}

/** Test seam: forget the catalog, every loaded bitmap theme and every image error. */
export function resetThemeCatalogForTests(): void {
  catalogRequest = null;
  clearImageFailures();
  manifestRequests.clear();
  for (const id of catalog.keys()) registry.delete(id);
  catalog.clear();
}
