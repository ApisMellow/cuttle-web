<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — the opponent's hand.
  // Presentational, not tappable (no target key in the Board contract's
  // table): reports nothing, just renders.
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

  interface OpponentHandProps {
    handCount: number;
    hand: Card[] | null;
    theme?: CardTheme;
  }

  let { handCount, hand, theme = getTheme(DEFAULT_THEME_ID) }: OpponentHandProps = $props();

  const backSlots = $derived(Array.from({ length: handCount }, (_, i) => i));
</script>

<div class="opponent-hand" data-testid="opp-hand" data-revealed={hand !== null ? 'true' : 'false'}>
  <div class="opponent-hand__cards">
    {#if hand === null}
      {#each backSlots as slot (slot)}
        <span class="opponent-hand__card" style={`--i: ${slot}`}>
          <theme.Back size="mini" />
        </span>
      {/each}
    {:else}
      {#each hand as card, index (index)}
        <!-- r16 (a11y): face up under glasses, so the viewer may see (and
             hear) each card. The hidden branch above stays unnamed. -->
        <span class="opponent-hand__card" style={`--i: ${index}`} role="img" aria-label={cardSpokenName(card)}>
          <theme.Face {card} size="mini" />
        </span>
      {/each}
    {/if}
  </div>
  <span class="opponent-hand__count">{handCount} {handCount === 1 ? 'card' : 'cards'}</span>
</div>

<style>
  .opponent-hand {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2, 8px);
    min-height: var(--cu-zone-opp-hand, 40px);
    padding-inline: 4px;
  }

  .opponent-hand__cards {
    display: flex;
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

  .opponent-hand__count {
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
    font-variant-numeric: tabular-nums;
  }
</style>
