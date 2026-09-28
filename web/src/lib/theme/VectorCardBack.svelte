<script lang="ts">
  // SPEC §5.6 / §3 (redaction) — the default ('vector') theme's Back.
  // Carries no card identity whatsoever: a card back is what the opponent's
  // hidden hand renders as (SPEC §3.2), so this component does not accept
  // or read a `card` prop at all.
  //
  // Rule 2: fills 100% x 100% of its container's box; `size` is a hint only
  // (the vector back's pattern does not vary with it). Phrasing-content
  // root (<span>) so it is valid inside a <button>.
  import type { CardBackProps } from './types';

  let { size }: CardBackProps = $props();
</script>

<span class="cuttle-card-back" data-size={size}></span>

<style>
  .cuttle-card-back {
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid #333;
    border-radius: 6%;
    background: repeating-linear-gradient(45deg, #2b4c7e, #2b4c7e 4px, #1d3457 4px, #1d3457 8px);
  }
</style>
