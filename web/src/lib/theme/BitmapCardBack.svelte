<script lang="ts">
  // A-6 — a bitmap theme's Back. Carries no card identity: it takes no
  // `card` prop (SPEC §3.2), and the only image it can show is the theme's
  // single back image, which is the same for every card.
  //
  // Per-slot fallback: no back in the manifest, or a failed load, renders
  // the vector back in the same box.
  import type { BitmapAssets } from './catalog';
  import { imageAttempt, imageFailed, recordImageError } from './failed-images';
  import type { CardBackProps } from './types';
  import VectorCardBack from './VectorCardBack.svelte';

  let { size, assets }: CardBackProps & { assets: BitmapAssets } = $props();

  const image = $derived(assets.back);
  const usable = $derived(image !== null && !imageFailed(image.src));
</script>

{#if image === null || !usable}
  <VectorCardBack {size} />
{:else}
  <span class="bitmap-card-back" data-size={size} data-theme={assets.themeId}>
    <!-- A new attempt count remounts the <img>: the one retry. -->
    {#key imageAttempt(image.src)}
      <img
        class="bitmap-card-back__img"
        src={image.src}
        srcset={image.srcset}
        sizes="72px"
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
  .bitmap-card-back {
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 7%;
    overflow: hidden;
    background: var(--cu-back-a, #3b2f4a);
  }

  .bitmap-card-back__img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
