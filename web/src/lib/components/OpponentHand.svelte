<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — the opponent's hand.
  // Reports no target key (none in the Board contract's table). Under
  // glasses the exposed hand opens an info-only sheet (#94).
  //
  // Redaction (SPEC §3.2, §5.6): `hand === null` means hidden — render
  // `handCount` CardBacks, which carry no card identity at all (VectorCardBack
  // has no `card` prop). `hand === []` means visible-but-empty (glasses-8,
  // R7.2) — render zero CardFaces, not zero CardBacks. `hand` non-null and
  // non-empty (also glasses-8) renders those cards face up, same slot, same
  // offsets as the hidden-back layout (docs/design.md §6). `handCount` is
  // always the numeral shown, straight from the view — never `hand?.length`,
  // so the two counts must actually agree with each other only by the
  // caller's contract (SPEC §2.7), not by anything this component enforces.
  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, cardSpokenName, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';
  import OpponentHandSheet from './OpponentHandSheet.svelte';

  interface OpponentHandProps {
    handCount: number;
    hand: Card[] | null;
    theme?: CardTheme;
  }

  let { handCount, hand, theme = getTheme(DEFAULT_THEME_ID) }: OpponentHandProps = $props();

  // Open state lives here: this component renders only at curtain `none`, so
  // a curtain or viewer change unmounts it and the sheet with it (#94).
  let sheetOpen = $state(false);

  const backSlots =$derived(Array.from({ length: handCount }, (_, i) => i));
</script>

<div class="opponent-hand" data-testid="opp-hand" data-revealed={hand !== null ? 'true' : 'false'}>
  {#if hand === null}
    <div class="opponent-hand__cards">
      {#each backSlots as slot (slot)}
        <span class="opponent-hand__card" style={`--i: ${slot}`}>
          <theme.Back size="mini" />
        </span>
      {/each}
    </div>
  {:else if hand.length > 0}
    <!-- #94: the exposed hand is one tap target (the minis are too small for
         one each) that opens the name-and-effect sheet. Informational only. -->
    <button
      type="button"
      class="opponent-hand__cards opponent-hand__inspect"
      data-testid="opp-hand-inspect"
      aria-label="What their cards do"
      aria-haspopup="dialog"
      onclick={() => (sheetOpen = true)}
    >
      {#each hand as card, index (index)}
        <!-- r16 (a11y): face up under glasses, so the viewer may see (and
             hear) each card. -->
        <span class="opponent-hand__card" style={`--i: ${index}`} role="img" aria-label={cardSpokenName(card)}>
          <theme.Face {card} size="mini" />
        </span>
      {/each}
    </button>
  {:else}
    <div class="opponent-hand__cards"></div>
  {/if}
  <span class="opponent-hand__count">{handCount} {handCount === 1 ? 'card' : 'cards'}</span>
</div>
{#if sheetOpen && hand !== null && hand.length > 0}
  <OpponentHandSheet cards={hand} {theme} onclose={() => (sheetOpen = false)} />
{/if}

<style>
  .opponent-hand {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--cu-zone-opp-hand, 40px);
    padding-inline: 4px;
  }

  .opponent-hand__cards {
    display: flex;
  }

  /* 44 px tap target inside the 40 px row: the negative margin keeps the
     row's height, so the opponent zone doesn't grow (board-fit). */
  .opponent-hand__inspect {
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    margin-block: -4px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .opponent-hand__card {
    display: block;
    flex: none;
    overflow: hidden;
    border-radius: 7%;
    width: var(--cuttle-card-width-mini);
    aspect-ratio: var(--cuttle-card-aspect);
    margin-left: -18px;
    box-shadow: -1px 0 2px rgb(0 0 0 / 35%);
  }

  .opponent-hand__card:first-child {
    margin-left: 0;
  }

  .opponent-hand[data-revealed='true'] .opponent-hand__card {
    margin-left: -12px;
  }

  .opponent-hand[data-revealed='true'] .opponent-hand__card:first-child {
    margin-left: 0;
  }

  /* Pinned to the right edge so the fan itself stays centered. */
  .opponent-hand__count {
    position: absolute;
    inset-inline-end: 4px;
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
    font-variant-numeric: tabular-nums;
  }
</style>
