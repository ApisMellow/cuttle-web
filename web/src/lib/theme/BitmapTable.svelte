<script lang="ts">
  // A-6 — a bitmap theme's playmat: one decorative image behind the board.
  // Per-slot fallback: no playmat in the manifest, or a failed load, renders
  // nothing, so the vector table (the plain ink background) shows through.
  // It never holds game state and is hidden from assistive tech.
  import type { BitmapAssets } from './catalog';
  import { imageAttempt, imageFailed, recordImageError } from './failed-images';

  let { assets }: { assets: BitmapAssets } = $props();

  const image = $derived(assets.table);
  const usable = $derived(image !== null && !imageFailed(image.src));
</script>

{#if image !== null && usable}
  <span class="bitmap-table" data-theme={assets.themeId} aria-hidden="true">
    <!-- A new attempt count remounts the <img>: the one retry. -->
    {#key imageAttempt(image.src)}
      <img
        class="bitmap-table__img"
        src={image.src}
        srcset={image.srcset}
        sizes="100vw"
        alt=""
        draggable="false"
        decoding="async"
        onerror={() => {
          if (image) recordImageError(image.src);
        }}
      />
    {/key}
  </span>
{/if}

<style>
  .bitmap-table {
    position: absolute;
    inset: 0;
    z-index: -1;
    display: block;
    overflow: hidden;
    pointer-events: none;
  }

  .bitmap-table__img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.55;
  }
</style>
