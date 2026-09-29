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
  import { DEFAULT_THEME_ID, cardSpokenName, getTheme } from '../theme';
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
  const label = $derived(
    `Scrap, ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}${topCard === null ? '' : `, ${cardSpokenName(topCard)} on top`}`,
  );
</script>

<div class="scrap-pile">
  <!-- r16 (a11y): "Scrap, 3 cards, King of Hearts on top". The scrap is
       public to both players (SPEC §3.2), so naming its top card is safe. -->
  <button type="button" class="scrap-pile__well" data-testid="scrap-pile" data-state={state} aria-label={label} onclick={ontap}>
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
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 44px;
    padding-bottom: 6px;
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
    border-radius: 7%;
    box-shadow: 0 1px 2px rgb(0 0 0 / 35%);
  }

  .scrap-pile__empty-card {
    display: block;
    width: 100%;
    height: 100%;
    border: 1px dashed var(--cu-ink-line, #4a3d57);
    border-radius: 7%;
    box-sizing: border-box;
  }

  /* W22: same bottom-edge tab as the deck count. */
  .scrap-pile__count {
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    min-width: 16px;
    padding: 1px 6px;
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ink, #241c2b);
    font-size: var(--cu-text-xs, 12px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 14px;
    color: var(--cu-pearl, #eee8f1);
    font-variant-numeric: tabular-nums;
    text-align: center;
    pointer-events: none;
  }

  /* W25 (desktop keyboard): a visible focus ring on every target, drawn
     inset so a clipping row or well can't hide it. */
  .scrap-pile__well:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: -3px;
  }
</style>
