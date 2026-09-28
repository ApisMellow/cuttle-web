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
    /* W17 (round-4, product owner direction 2026-09-28): identity moves to
       the upper-left CORNER, at every size — this replaces the W14 centred
       top strip. `align-items`/`justify-content: flex-start` anchor the
       rank+suit block to the top-left; the small padding insets it off the
       edge. Because this is the BASE rule (no `data-size` selector), it
       applies to hand and mini too, not just field — the size overrides
       below only change glyph scale, never position, matching rule 2. A
       Jack stacked on a stolen point card is offset DOWNWARD ONLY (never
       narrowed, never shifted sideways — see PointRow's `.point-row__jack`)
       so this corner block stays clear of every Jack's top edge. */
    align-items: flex-start;
    justify-content: flex-start;
    gap: 0.1em;
    width: 100%;
    height: 100%;
    padding: 3px 0 0 4px;
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

  /* `size` is a rendering hint: glyph scale only, never the box or the
     corner position (both set on the base rule above). */
  .cuttle-card-face[data-size='field'] {
    font-size: 1.1rem;
  }

  .cuttle-card-face[data-size='mini'] {
    font-size: 0.55rem;
    /* A mini box is small enough (32px wide phone / 36 tablet) that the
       base 3px/4px inset would eat a visible fraction of it; scale it down
       with the glyphs so the corner index still reads as a corner, not a
       near-fill. */
    padding: 2px 0 0 2px;
  }

  .cuttle-card-face__rank {
    font-size: 1.4em;
  }

  .cuttle-card-face__suit {
    font-size: 1.1em;
  }

  .cuttle-card-face[data-size='field'] .cuttle-card-face__rank {
    font-size: 1em;
  }

  .cuttle-card-face[data-size='field'] .cuttle-card-face__suit {
    font-size: 0.75em;
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
