<script lang="ts">
  // Issue #94 — what the exposed cards do. Rendered only while the viewer
  // has a glasses 8 in play (`cards` is the face-up opponent hand), listing
  // each card: mini face, name and effect line, in hand order. Purely
  // informational: no store, no bridge, no staging. Its open state lives in
  // OpponentHand, which only exists at curtain `none`, so a curtain or a
  // viewer change unmounts it. Closes with the button, Escape or a tap on
  // the scrim, like CardDetailPopover.
  import type { Card } from '../bridge/schema';
  import { cardEffectLine, cardName } from '../cardText';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface OpponentHandSheetProps {
    cards: Card[];
    onclose: () => void;
    theme?: CardTheme;
  }

  let { cards, onclose, theme = getTheme(DEFAULT_THEME_ID) }: OpponentHandSheetProps = $props();

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose();
  }
</script>

<svelte:window {onkeydown} />

<div class="opp-sheet__scrim" data-testid="opp-hand-sheet-scrim" aria-hidden="true" onclick={onclose}></div>
<div class="opp-sheet" data-testid="opp-hand-sheet" role="dialog" aria-modal="true" aria-label="Their hand">
  <ul class="opp-sheet__list">
    {#each cards as card, index (index)}
      <li class="opp-sheet__item">
        <span class="opp-sheet__face"><theme.Face {card} size="mini" /></span>
        <span class="opp-sheet__label">
          <span class="opp-sheet__name" data-opp-sheet="name">{cardName(card, theme)}</span>
          <span class="opp-sheet__effect" data-opp-sheet="effect">{cardEffectLine(card)}</span>
        </span>
      </li>
    {/each}
  </ul>
  <button type="button" class="opp-sheet__close" data-testid="opp-hand-sheet-close" onclick={onclose}>Close</button>
</div>

<style>
  .opp-sheet__scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgb(26 20 32 / 0.72);
  }

  .opp-sheet {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 31;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3, 12px);
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    max-height: 80vh;
    margin: 0 auto;
    padding: var(--cu-gutter-sheet, 16px) var(--cu-gutter-sheet, 16px)
      calc(var(--cu-gutter-sheet, 16px) + env(safe-area-inset-bottom));
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-radius: var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px) 0 0;
  }

  .opp-sheet__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3, 12px);
    overflow-y: auto;
  }

  .opp-sheet__item {
    display: flex;
    align-items: center;
    gap: var(--cu-space-3, 12px);
  }

  .opp-sheet__face {
    display: block;
    flex: none;
    overflow: hidden;
    border-radius: 7%;
    width: var(--cuttle-card-width-mini);
    aspect-ratio: var(--cuttle-card-aspect);
  }

  .opp-sheet__label {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-1, 4px);
    min-width: 0;
  }

  .opp-sheet__name {
    color: var(--cu-ochre, #f0b54a);
    font-size: var(--cu-text-md, 16px);
    font-weight: var(--cu-weight-bold, 700);
  }

  .opp-sheet__effect {
    font-size: var(--cu-text-sm, 14px);
    line-height: var(--cu-leading-body, 1.4);
  }

  .opp-sheet__close {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min, 44px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }
</style>
