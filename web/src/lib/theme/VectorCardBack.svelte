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
  /* W22: the back borrows the curtain's chromatophore dots (design.md §1)
     on --cu-back-a, framed by a thin iridophore line. No identity, no
     geometry: it fills its container's box (rule 2). */
  .cuttle-card-back {
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid rgb(0 0 0 / 0.35);
    border-radius: 7%;
    background:
      radial-gradient(circle, rgb(92 207 196 / 0.34) 0 1.1px, transparent 1.5px) 0 0 / 6px 6px,
      radial-gradient(circle, rgb(240 181 74 / 0.22) 0 1px, transparent 1.4px) 3px 3px / 6px 6px,
      var(--cu-back-a, #3b2f4a);
    box-shadow:
      inset 0 0 0 3px var(--cu-back-a, #3b2f4a),
      inset 0 0 0 4px rgb(92 207 196 / 0.45);
  }

  .cuttle-card-back[data-size='mini'] {
    box-shadow:
      inset 0 0 0 2px var(--cu-back-a, #3b2f4a),
      inset 0 0 0 3px rgb(92 207 196 / 0.45);
  }
</style>
