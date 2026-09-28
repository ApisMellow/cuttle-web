<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6, §5.2) — the scrap pile.
  // Tap = R6 browser, wired by a later round; here it just reports `scrap`.
  //
  // "Shows the top card plus a count" — scrap is fully public (SPEC §2.7:
  // "scrap: Card[]; index 0 = bottom"), so the top of the pile is the LAST
  // element. An empty scrap renders no face, count 0.
  //
  // The last-move line is not here: it lives in CenterZone's middle slot
  // (docs/design.md §6; revise 1 ruling).
  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface ScrapPileProps {
    cards: Card[];
    highlighted: boolean;
    staged: boolean;
    ontap: () => void;
    theme?: CardTheme;
  }

  let { cards, highlighted, staged, ontap, theme = getTheme(DEFAULT_THEME_ID) }: ScrapPileProps = $props();

  const topCard = $derived(cards.length > 0 ? cards[cards.length - 1] : null);
  const state = $derived(staged ? 'staged' : highlighted ? 'highlighted' : 'normal');
</script>

<div class="scrap-pile">
  <button type="button" class="scrap-pile__well" data-testid="scrap-pile" data-state={state} onclick={ontap}>
    {#if topCard}
      <theme.Face card={topCard} size="hand" state={state} />
    {:else}
      <span class="scrap-pile__empty-card"></span>
    {/if}
  </button>
  <span class="scrap-pile__count">{cards.length}</span>
</div>

<style>
  .scrap-pile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 44px;
  }

  .scrap-pile__well {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    overflow: hidden;
    border-radius: 8%;
  }

  .scrap-pile__empty-card {
    display: block;
    width: 100%;
    height: 100%;
    border: 1px dashed var(--cu-ink-line, #4a3d57);
    border-radius: 6%;
    box-sizing: border-box;
  }

  .scrap-pile__count {
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
    font-variant-numeric: tabular-nums;
  }
</style>
