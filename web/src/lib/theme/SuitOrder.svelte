<script lang="ts">
  // Issue #106: a passive reference strip of the suit ranking, highest first
  // (spades beat hearts beat diamonds beat clubs). Icons only; the words live
  // in the aria-label for screen readers. Lives in lib/theme/ because it draws
  // suit glyphs (SPEC §5.6 rule 1). Suit enum: 0 clubs, 1 diamonds, 2 hearts, 3 spades.
  import type { Suit } from '../bridge/schema';
  import { suitGlyph, suitIsRed } from './glyphs';

  const ORDER: Suit[] = [3, 2, 1, 0];
</script>

<span class="suit-order" data-suit-order role="img" aria-label="Suit order: spades, hearts, diamonds, clubs">
  {#each ORDER as suit (suit)}
    <span class={['suit-order__suit', suitIsRed(suit) && 'suit-order__suit--red']} aria-hidden="true">{suitGlyph(suit)}</span>
  {/each}
</span>

<style>
  .suit-order {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 3px;
    font-size: var(--cu-text-sm, 14px);
    line-height: 1;
    opacity: 0.75;
    pointer-events: none;
  }

  .suit-order__suit {
    color: var(--cu-pearl, #eee8f1);
  }

  .suit-order__suit--red {
    color: var(--cu-suit-red-on-dark, #e5566d);
  }
</style>
