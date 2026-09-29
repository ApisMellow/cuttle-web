<script lang="ts">
  // SPEC §5.2 (R6), §6.3 rank-3 row — the scrap pile, as a bottom sheet.
  //
  // browse: every card in `view.scrap`, top of the pile first. The scrap is
  //   public to both players at all times (SPEC §3.2), so this reads only
  //   the current view's scrap. Close dismisses it.
  // pick:   a 3's choice. Lists exactly the scrap cards the engine offered
  //   (one move per ScrapIndex, apply.go:98-111), each a button; a tap hands
  //   the move index back for staging. Cancel abandons the 3.
  //
  // Presentational only: the integrator owns open/closed and staging.
  //
  // r16 (2026-09-29 playtest, friction 5): the sheet drops from the TOP of
  // the column, no taller than about half the screen, so your own Points
  // and Permanents rows and your hand (the 3 you are playing) stay in view
  // below it. The card grid scrolls inside the sheet; its button stays put.
  // Every scrap card is named for a screen reader ("King of Hearts"): the
  // scrap is public (SPEC §3.2).
  import type { Card } from '../bridge/schema';
  import type { ScrapPickCandidate } from '../stores/staging.svelte';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, cardSpokenName, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface ScrapBrowserProps {
    mode: 'browse' | 'pick';
    /** `view.scrap`; index 0 is the bottom of the pile. */
    cards: Card[];
    /** pick mode: `StagingStore.scrapPick.candidates`. */
    picks?: ScrapPickCandidate[];
    onpick?: (moveIndex: number) => void;
    /** Close (browse) or Cancel (pick). */
    onclose: () => void;
    theme?: CardTheme;
  }

  let { mode, cards, picks = [], onpick, onclose, theme = getTheme(DEFAULT_THEME_ID) }: ScrapBrowserProps = $props();

  /** Top of the pile first. */
  const browseOrder = $derived(cards.map((card, scrapIndex) => ({ card, scrapIndex })).reverse());
  const pickList = $derived(
    picks
      .map((p) => ({ ...p, card: cards[p.scrapIndex] }))
      .filter((p): p is ScrapPickCandidate & { card: Card } => p.card !== undefined),
  );
</script>

<div class="scrap-browser__scrim" aria-hidden="true"></div>
<div
  class="scrap-browser"
  data-testid="scrap-browser"
  data-mode={mode}
  role="dialog"
  aria-modal="true"
  aria-labelledby="scrap-browser-title"
>
  {#if mode === 'browse'}
    <h2 id="scrap-browser-title" class="scrap-browser__title">Scrap pile · {cards.length}</h2>
    {#if cards.length === 0}
      <p class="scrap-browser__empty">The scrap pile is empty.</p>
    {:else}
      <p class="scrap-browser__hint">Top of the pile first.</p>
      <ul class="scrap-browser__grid">
        {#each browseOrder as item (item.scrapIndex)}
          <li class="scrap-browser__card">
            <span class="scrap-browser__face" role="img" aria-label={cardSpokenName(item.card)}>
              <theme.Face card={item.card} size="field" />
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    <button type="button" class="scrap-browser__close" data-testid="scrap-browser-close" onclick={onclose}>
      Close
    </button>
  {:else}
    <h2 id="scrap-browser-title" class="scrap-browser__title">Take a card from the scrap</h2>
    <ul class="scrap-browser__grid">
      {#each pickList as item (item.index)}
        <li>
          <button
            type="button"
            class="scrap-browser__card scrap-browser__card--pick"
            data-testid={`scrap-pick-${item.scrapIndex}`}
            aria-label={cardSpokenName(item.card)}
            onclick={() => onpick?.(item.index)}
          >
            <theme.Face card={item.card} size="field" state="highlighted" />
          </button>
        </li>
      {/each}
    </ul>
    <button type="button" class="scrap-browser__close" data-testid="scrap-browser-cancel" onclick={onclose}>
      Cancel
    </button>
  {/if}
</div>

<style>
  .scrap-browser__scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    /* r16: lighter than before, so the rows it leaves uncovered still read. */
    background: rgb(26 20 32 / 0.45);
  }

  /* design.md §5, §11, amended r16: a sheet dropping from the TOP of the
     board column (it was a bottom sheet and hid your own Points row) —
     ink-raised, bottom corners only at --cu-radius-sheet, --cu-gutter-sheet
     padding. At most 48% of the visible height, which ends above your own
     Points row at 393x852 and 430x932 (a Jack on your side included); the
     card grid scrolls inside it. */
  .scrap-browser {
    position: fixed;
    inset-inline: 0;
    top: 0;
    z-index: 21;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3, 12px);
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    max-height: calc(48dvh + var(--cu-safe-top, 0px));
    margin: 0 auto;
    padding: calc(var(--cu-gutter-sheet, 16px) + var(--cu-safe-top, 0px)) var(--cu-gutter-sheet, 16px)
      var(--cu-gutter-sheet, 16px);
    overflow: hidden;
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-radius: 0 0 var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 40%);
  }

  .scrap-browser__title {
    margin: 0;
    font-size: var(--cu-text-xl, 25px);
    font-weight: 700;
  }

  .scrap-browser__hint,
  .scrap-browser__empty {
    margin: 0;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-sm, 14px);
  }

  .scrap-browser__grid {
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: var(--cu-space-2, 8px);
    min-height: 0;
    margin: 0;
    /* Room for a highlighted card's ring and a focus outline. */
    padding: 4px;
    overflow-x: hidden;
    overflow-y: auto;
    list-style: none;
  }

  .scrap-browser__title,
  .scrap-browser__hint,
  .scrap-browser__empty,
  .scrap-browser__close {
    flex: none;
  }

  /* SPEC §5.6 rule 2: the container owns the box. */
  .scrap-browser__card {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-field);
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
    border-radius: 8%;
  }

  .scrap-browser__face {
    display: block;
    width: 100%;
    height: 100%;
  }

  .scrap-browser__card--pick {
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .scrap-browser__close {
    align-self: stretch;
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }
</style>
