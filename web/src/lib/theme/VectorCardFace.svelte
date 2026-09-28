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
  {#if size === 'field'}
    <!-- W22: a quiet echo of the suit in the lower right of a field card.
         Decoration only: identity stays in the upper-left index (design.md
         §7). Not on hand cards, where a fan would cut it into fragments. -->
    <span class="cuttle-card-face__pip" aria-hidden="true">{glyph}</span>
  {/if}
</span>

<style>
  /* W22 (iPhone 15 design pass): the face now reads the design tokens
     (docs/design.md §3, §4, §7) instead of placeholder greys. Cuttlebone
     stock, ink and deep-red suits, a bold corner index sized for arm's
     length. Geometry is still the container's (rule 2): this root fills
     whatever box it is given. */
  .cuttle-card-face {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    /* Identity lives in the upper-left corner index at every size, rank
       above suit (design.md §7). A stacked Jack is offset downward only,
       so this block stays clear of it. */
    align-items: flex-start;
    justify-content: flex-start;
    width: 100%;
    height: 100%;
    padding: 2px 0 0 3px;
    border: 1px solid rgb(36 28 43 / 0.22);
    border-radius: 7%;
    background: linear-gradient(170deg, #fffdf9 0%, var(--cu-paper, #faf8f4) 55%, #f1ece4 100%);
    color: var(--cu-suit-black, #1f1824);
    font-family: var(--cu-font-index, system-ui, sans-serif);
    line-height: 1;
    font-variant-emoji: text;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
  }

  .cuttle-card-face__rank,
  .cuttle-card-face__suit {
    display: block;
  }

  .cuttle-card-face__rank {
    font-size: var(--cu-index-rank-hand, 24px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 0.9;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
  }

  .cuttle-card-face__suit {
    font-size: var(--cu-index-suit-hand, 19px);
    line-height: 0.9;
  }

  .cuttle-card-face[data-size='field'] .cuttle-card-face__rank {
    font-size: var(--cu-index-rank-field, 20px);
  }

  .cuttle-card-face[data-size='field'] .cuttle-card-face__suit {
    font-size: var(--cu-index-suit-field, 16px);
  }

  .cuttle-card-face[data-size='mini'] {
    padding: 2px 0 0 2px;
  }

  .cuttle-card-face[data-size='mini'] .cuttle-card-face__rank {
    font-size: var(--cu-index-rank-mini, 14px);
  }

  .cuttle-card-face[data-size='mini'] .cuttle-card-face__suit {
    font-size: var(--cu-index-suit-mini, 11px);
  }

  .cuttle-card-face__pip {
    position: absolute;
    right: 5%;
    bottom: 3%;
    font-size: 26px;
    line-height: 1;
    opacity: 0.2;
    pointer-events: none;
  }

  .cuttle-card-face--red {
    color: var(--cu-suit-red, #b0172e);
  }

  /* State recipes (design.md §7). Rings are drawn inside the box, because
     the container clips; the table-coloured gap is the inner hairline. */
  .cuttle-card-face[data-state='highlighted'] {
    outline: 3px solid var(--cu-iris, #5ccfc4);
    outline-offset: -3px;
    box-shadow: inset 0 0 0 4px rgb(36 28 43 / 0.55);
  }

  .cuttle-card-face[data-state='staged'] {
    outline: 3px solid var(--cu-ochre, #f0b54a);
    outline-offset: -3px;
    box-shadow: inset 0 0 0 4px rgb(36 28 43 / 0.55);
  }

  .cuttle-card-face[data-state='dimmed']::after,
  .cuttle-card-face[data-state='frozen']::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--cu-dim-scrim, rgb(36 28 43 / 0.42));
    pointer-events: none;
  }

  .cuttle-card-face[data-state='frozen'] {
    outline: 2px dashed var(--cu-frost, #a9d2f5);
    outline-offset: -3px;
  }
</style>
