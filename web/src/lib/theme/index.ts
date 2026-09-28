// SPEC §5.6 — the theme registry and the theme seam's public surface.
//
// Code outside `lib/theme/` may import only this module, `./types` and
// `./default` (enforced by tests/unit/theme-glyph-boundary.test.ts). This
// module deliberately exports NO glyph helper: the only way to draw a card
// anywhere in the app is a theme's `<Face>` / `<Back>` (rule 1).
//
// `vector` is the only theme registered in this round; P-ART registers
// bitmap themes later via `registerTheme`.

import { DEFAULT_THEME_ID } from './default';
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

/** SPEC §5.6 rule 4: zero external assets, always available, the fallback. */
export const vectorTheme: CardTheme = {
  id: 'vector',
  label: 'Vector',
  Face: VectorCardFace,
  Back: VectorCardBack,
  assetBytes: 0,
  available: () => true,
};

const registry = new Map<string, CardTheme>([[vectorTheme.id, vectorTheme]]);

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
