<script lang="ts">
  // SPEC §5.6 — the default ('vector') theme's Face. Draws a rank + suit
  // glyph with CSS only (no bitmap assets, no <canvas>, A4). Glyph helpers
  // are private to lib/theme/ (rule 1).
  //
  // Rule 2: this component fills 100% x 100% of the box its container gives
  // it and never sizes that box. `size` only scales the glyphs. The root is
  // a <span> (phrasing content) because HandCard renders it inside <button>.
  import { rankLabel, suitGlyph, suitIsRed } from './glyphs';
  import type { CardFaceProps } from './types';

  let { card, size, state = 'normal' }: CardFaceProps = $props();

  const label = $derived(rankLabel(card.Rank));
  const glyph = $derived(suitGlyph(card.Suit));
  const isRed = $derived(suitIsRed(card.Suit));
</script>

<span class={['cuttle-card-face', { 'cuttle-card-face--red': isRed }]} data-size={size} data-state={state}>
  <span class="cuttle-card-face__rank">{label}</span>
  <span class="cuttle-card-face__suit">{glyph}</span>
</span>

<style>
  .cuttle-card-face {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15em;
    width: 100%;
    height: 100%;
    border: 1px solid #333;
    border-radius: 6%;
    background: #fff;
    color: #111;
    font-family: system-ui, sans-serif;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }

  /* `size` is a rendering hint: glyph scale only, never the box. */
  .cuttle-card-face[data-size='field'] {
    font-size: 1.1rem;
  }

  .cuttle-card-face[data-size='mini'] {
    font-size: 0.55rem;
  }

  .cuttle-card-face__rank {
    font-size: 1.4em;
  }

  .cuttle-card-face__suit {
    font-size: 1.1em;
  }

  .cuttle-card-face--red {
    color: #b00020;
  }

  /* Functional state styling only (carry-over 7) — legibility, not
     decoration. Outlines are inset so they stay inside the clipped box. */
  .cuttle-card-face[data-state='dimmed'] {
    opacity: 0.45;
  }

  .cuttle-card-face[data-state='highlighted'] {
    outline: 3px solid #1a73e8;
    outline-offset: -3px;
  }

  .cuttle-card-face[data-state='staged'] {
    outline: 3px solid #1a9e6b;
    outline-offset: -3px;
  }

  .cuttle-card-face[data-state='frozen'] {
    outline: 3px dashed #7a7a7a;
    outline-offset: -3px;
  }
</style>
