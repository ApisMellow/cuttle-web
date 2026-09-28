// SPEC §5.6 — the card art theme seam. This is the fixed contract P-ART
// generates against; it is written now, in P1a/P2, so the loop can verify
// R1-R20 with zero art present (PRD A-1, R21-R23).
//
// ─── Contract for theme authors ─────────────────────────────────────────
//
// PAINT INSIDE THE BOX YOU'RE GIVEN; NEVER SIZE IT.
//
// Rule 1 (§5.6): nothing outside `lib/theme/` renders a rank or suit glyph.
//   Every card pixel in the app comes from a theme's `Face`/`Back`. Code
//   outside this directory may import only `lib/theme` (index), `./types`
//   and `./default`; glyph helpers stay private to the theme.
//
// Rule 2: geometry belongs to the APP. The 2.5:3.5 aspect ratio and the
//   three size tokens live in an app-owned stylesheet outside this
//   directory, and the CONTAINER that places a card (e.g. HandCard's
//   button) sets the box's width and aspect ratio from them and clips it.
//   A `Face` or `Back`:
//     - fills 100% x 100% of its container (`display: block; width: 100%;
//       height: 100%`);
//     - never sets its own width, height, aspect-ratio, min-/max- size, or
//       presentational width/height attributes other than 100%;
//     - never reads the `--cuttle-card-*` geometry tokens.
//   So swapping themes, or falling back to `vector` for a single card
//   (rule 4), can never reflow the board.
//
// Rule 3: `state` is passed in; the theme renders it, it does not invent it.
//
// Markup: a Face/Back is rendered inside a `<button>` (HandCard), so its
//   root element and everything in it must be PHRASING content — a
//   `<span>` styled `display: block`, an inline `<svg>`, or an `<img>` —
//   never a `<div>`, `<p>`, `<canvas>` (A4) or another interactive element.
//   Exactly one root element.
//
// Observable contract (asserted for every registry entry by
//   tests/unit/theme.test.ts): the root element carries
//   `data-size={size}`, and for a Face `data-state={state}` (defaulting to
//   'normal' when `state` is omitted). The root carries no `data-testid`:
//   SPEC §5.9/§7.4 sweep every `[data-testid]` for a 44px box, and small
//   non-interactive faces (field/mini) would fail it; the interactive
//   container owns the testid.

import type { Component } from 'svelte';

import type { Card } from '../bridge/schema';

/**
 * The three fixed geometry tokens (SPEC §5.6 rule 2). The container sizes
 * the box from the matching `--cuttle-card-width-*` token; for a theme,
 * `size` is a RENDERING HINT only (e.g. glyph scale, level of detail, which
 * atlas resolution to sample) — never a reason to change the box.
 */
export type CardSize = 'hand' | 'field' | 'mini';

/** Visual states a theme must honour (SPEC §5.6 rule 3). */
export type CardVisualState = 'normal' | 'dimmed' | 'highlighted' | 'staged' | 'frozen';

export interface CardFaceProps {
  card: Card;
  /** Rendering hint only; the container owns the box (rule 2). */
  size: CardSize;
  /** Defaults to 'normal'. Reflect it on the root as `data-state`. */
  state?: CardVisualState;
}

export interface CardBackProps {
  /** Rendering hint only; the container owns the box (rule 2). */
  size: CardSize;
}

/** Optional background skin (SPEC §5.6). No fields are mandated yet. */
export type TableProps = Record<string, never>;

export interface CardTheme {
  id: string;
  label: string;
  /** Any Svelte component honouring CardFaceProps. */
  Face: Component<CardFaceProps>;
  Back: Component<CardBackProps>;
  Table?: Component<TableProps>;
  /** Declared precache cost in bytes (SPEC §5.8, R22). Zero for `vector`. */
  assetBytes: number;
  /** False until this theme's assets are cached (SPEC §5.6 rule 4). */
  available: () => boolean;
}
