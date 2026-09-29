<script lang="ts">
  // A-6 — a bitmap theme's Face. One component serves every bitmap theme;
  // `assets` is bound per theme by `bitmapTheme()` in `./bitmap.ts`, so the
  // app still renders it through the plain CardFaceProps contract.
  //
  // Per-slot fallback (SPEC §5.6 rule 4): a card whose slot is missing from
  // the manifest, or whose image failed to load, renders the vector face
  // instead — same box, same props, so nothing reflows.
  //
  // Rule 2: fills 100% x 100% of the container's box and never sizes it.
  // Phrasing root (<span>) because HandCard renders a face inside <button>.
  //
  // Identity: the art carries its own painted upper-left corner index
  // (rank above suit; the glasses face carries only a suit pip, R7). At
  // `mini` the image zooms to the manifest's index box so the index stays
  // readable at 32 px (design.md §7).
  import type { BitmapAssets } from './catalog';
  import { faceKey, suitName } from './catalog';
  import { imageAttempt, imageFailed, recordImageError } from './failed-images';
  import type { CardFaceProps } from './types';
  import VectorCardFace from './VectorCardFace.svelte';

  let {
    card,
    size,
    state = 'normal',
    variant = 'standard',
    assets,
  }: CardFaceProps & { assets: BitmapAssets } = $props();

  const image = $derived(variant === 'glasses' ? assets.glasses.get(suitName(card.Suit)) : assets.faces.get(faceKey(card)));
  const usable = $derived(image !== undefined && !imageFailed(image.src));

  // `mini` zooms to the painted index. Glasses art has no rank plaque, so
  // it is never zoomed.
  const zoom = $derived.by(() => {
    const box = assets.index;
    if (size !== 'mini' || variant === 'glasses' || box === null) return null;
    // A little margin around the plaque, and never past the image edge.
    const w = Math.min(1, box.w * 1.12);
    const h = Math.min(1, box.h * 1.12);
    const scale = Math.max(1, Math.min(1 / w, 1 / h));
    return { scale, x: box.x, y: box.y };
  });

  // Rendered CSS width hint for `srcset` selection. The container owns the
  // box; these match the design.md §5 tokens closely enough for the browser
  // to pick a source. The widest source covers the detail popover and
  // high-density screens.
  const sizes = $derived.by(() => {
    const base = variant === 'glasses' ? 86 : size === 'mini' ? 34 : size === 'field' ? 66 : 72;
    return `${Math.round(base * (zoom?.scale ?? 1))}px`;
  });
</script>

{#if image === undefined || !usable}
  <VectorCardFace {card} {size} {state} {variant} />
{:else}
  <span
    class={['bitmap-card-face', { 'bitmap-card-face--glasses': variant === 'glasses' }]}
    data-size={size}
    data-state={state}
    data-variant={variant}
    data-theme={assets.themeId}
  >
    <!-- A new attempt count remounts the <img>: the one retry. -->
    {#key imageAttempt(image.src)}
      <img
        class="bitmap-card-face__img"
        src={image.src}
        srcset={image.srcset}
        {sizes}
        alt=""
        draggable="false"
        decoding="async"
        style:transform={zoom ? `scale(${zoom.scale})` : undefined}
        style:transform-origin={zoom ? `${zoom.x * 100}% ${zoom.y * 100}%` : undefined}
        onerror={() => {
          if (image) recordImageError(image.src);
        }}
      />
    {/key}
  </span>
{/if}

<style>
  .bitmap-card-face {
    position: relative;
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 7%;
    overflow: hidden;
    /* Shown only while the image decodes: the same stock as the vector face. */
    background: var(--cu-paper, #faf8f4);
    user-select: none;
    -webkit-user-select: none;
  }

  .bitmap-card-face__img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 0 0;
  }

  /* The card edge and the state recipes (design.md §7) sit ABOVE the art,
     drawn inside the box because the container clips. */
  .bitmap-card-face::before,
  .bitmap-card-face::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
  }

  .bitmap-card-face::before {
    z-index: 1;
    box-shadow: inset 0 0 0 1px rgb(36 28 43 / 0.45);
  }

  .bitmap-card-face[data-state='highlighted']::before {
    box-shadow:
      inset 0 0 0 3px var(--cu-iris, #5ccfc4),
      inset 0 0 0 5px rgb(36 28 43 / 0.55);
  }

  .bitmap-card-face[data-state='staged']::before {
    box-shadow:
      inset 0 0 0 3px var(--cu-ochre, #f0b54a),
      inset 0 0 0 5px rgb(36 28 43 / 0.55);
  }

  .bitmap-card-face[data-state='dimmed']::after,
  .bitmap-card-face[data-state='frozen']::after {
    z-index: 2;
    background: var(--cu-dim-scrim, rgb(36 28 43 / 0.42));
  }

  .bitmap-card-face[data-state='frozen'] {
    outline: 2px dashed var(--cu-frost, #a9d2f5);
    outline-offset: -3px;
  }
</style>
