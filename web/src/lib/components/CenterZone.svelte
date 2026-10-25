<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — the three-slot center
  // strip: DeckPile, the one-off drop zone, ScrapPile.
  //
  // The middle slot (revise 1 ruling, design §6): when idle it shows the
  // last move in `--cu-text-sm` muted text, clamped to three lines (amended
  // 2026-09-28; was one line), at a fixed height. The line is not interactive and carries no
  // testid (every testid must be a 44 px target). When the one-off zone is
  // highlighted or staged, the line gives way to the zone's own label. The
  // line's box is always present, so the strip's height never depends on
  // `lastMoveText`; the strip's height comes from the Deck and Scrap slots.
  //
  // Issue #93 (SPEC §4.3): the last-turn marker, `counter-link`, sits over
  // the line, filling the middle slot's content layer. It is always in the
  // DOM with the same markup, whatever the hands or the move list say, so
  // nothing shows that a Counter is legal until a 2 is selected. Only then
  // (`counterHighlighted`) does it light, join the tab order and take
  // pointer events; until then a tap or a drop on it falls through to the
  // one-off zone's hit button underneath, exactly as before.
  import type { Snippet } from 'svelte';

  import type { Card } from '../bridge/schema';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';
  import DeckPile from './DeckPile.svelte';
  import DropZones from './DropZones.svelte';
  import ScrapPile from './ScrapPile.svelte';

  interface CenterZoneProps {
    deckCount: number;
    deckEnabled: boolean;
    deckHighlighted: boolean;
    deckStaged: boolean;
    scrap: Card[];
    scrapHighlighted: boolean;
    scrapStaged: boolean;
    oneOffHighlighted: boolean;
    oneOffStaged: boolean;
    /** Issue #93: a selected 2 can counter; the last-turn marker is a lit target. */
    counterHighlighted?: boolean;
    /** Issue #93: a Counter is staged on the marker. */
    counterStaged?: boolean;
    lastMoveText?: string;
    ontap: (key: string) => void;
    theme?: CardTheme;
    /**
     * r16: drawn over the strip, centred on it (GameScreen's ambiguity
     * chooser). The strip keeps its own size underneath, so nothing moves.
     */
    overlay?: Snippet;
  }

  let {
    deckCount,
    deckEnabled,
    deckHighlighted,
    deckStaged,
    scrap,
    scrapHighlighted,
    scrapStaged,
    oneOffHighlighted,
    oneOffStaged,
    counterHighlighted = false,
    counterStaged = false,
    lastMoveText,
    ontap,
    theme = getTheme(DEFAULT_THEME_ID),
    overlay,
  }: CenterZoneProps = $props();

  const lineText = $derived(oneOffHighlighted || oneOffStaged ? '' : (lastMoveText ?? ''));
  const counterState = $derived(counterStaged ? 'staged' : counterHighlighted ? 'highlighted' : 'normal');
  const counterActive = $derived(counterHighlighted || counterStaged);
</script>

<div class="center-zone" data-testid="center-zone">
  <DeckPile
    count={deckCount}
    enabled={deckEnabled}
    highlighted={deckHighlighted}
    staged={deckStaged}
    ontap={() => ontap('deck')}
    {theme}
  />
  <div class="center-zone__middle">
    <DropZones
      targetKey="zone:oneoff"
      label="Play as one-off"
      highlighted={oneOffHighlighted}
      staged={oneOffStaged}
      ontap={() => ontap('zone:oneoff')}
    >
      <div class="center-zone__line">
        <p class="center-zone__last-move">{lineText}</p>
        <button
          type="button"
          class="center-zone__counter-link"
          data-testid="counter-link"
          data-state={counterState}
          aria-label="Last turn"
          tabindex={counterActive ? 0 : -1}
          onclick={() => ontap('counter-link')}
        ></button>
      </div>
    </DropZones>
  </div>
  <ScrapPile cards={scrap} highlighted={scrapHighlighted} staged={scrapStaged} ontap={() => ontap('scrap')} {theme} />
  {#if overlay}
    <div class="center-zone__overlay">{@render overlay()}</div>
  {/if}
</div>

<style>
  /* W22 (iPhone 15 pass): the strip is the table's middle. Its own height
     is the `--cu-zone-center` budget; `margin-block: auto` hands it any
     spare board height, split evenly above and below (design.md §6), and
     `--cu-gap-center` guarantees a little more air around it than between
     one player's own rows, even when there is no spare height at all.
     Deck and Scrap counts sit on the piles' bottom edges as small tabs
     (DeckPile, ScrapPile), so the strip no longer pays a text line under
     each hand-size card. */
  .center-zone {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--cu-space-3, 12px);
    box-sizing: content-box;
    height: var(--cu-zone-center, 88px);
    margin-block: auto;
    padding: var(--cu-gap-center, 10px) var(--cu-gutter-board, 10px);
    overflow: visible;
  }

  /* r16 (playtest friction 5): the chooser sits on the middle of the
     table, between the two sides, over the deck / one-off / scrap strip.
     The card it plays (in the hand) and the card it targets (the other
     side's points) both stay in view, and so do your own rows. Centred on
     the strip, board gutters either side, above the sticky hand's layer;
     if it is a little taller than the strip it spills evenly into the air
     around it (design.md §6), never into the page. */
  .center-zone__overlay {
    position: absolute;
    top: 50%;
    right: var(--cu-gutter-board, 10px);
    left: var(--cu-gutter-board, 10px);
    z-index: 3;
    transform: translateY(-50%);
  }

  /* The flex middle slot: it stretches to the strip's height, so the
     one-off target is as tall as a hand card and always clears 44 px. */
  .center-zone__middle {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    align-self: stretch;
  }

  /* Amended 2026-09-28 (playtest friction): up to three lines, clamped,
     in a fixed-height box, so "Blake played 5♣ as a one-off and drew 2
     cards." isn't cut off at 393 wide. The line box grows only up to three
     lines, inside the strip's fixed-height middle slot (which centres it),
     so the strip's height never depends on the text. */
  /* Issue #93: the line and the last-turn marker over it. The box fills the
     one-off zone's content layer (at least 44 px each way), so the marker
     is a full-size target without changing the strip's height. */
  .center-zone__line {
    position: relative;
    display: flex;
    flex: 1;
    align-self: stretch;
    align-items: center;
    min-width: 44px;
    min-height: 44px;
  }

  /* Pointer events stay off (the content layer's default) until a 2 lights
     it, so an unlit marker never takes a tap or a drop from the zone. */
  .center-zone__counter-link {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    min-width: 44px;
    min-height: 44px;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: var(--cu-radius-well, 10px);
    background: none;
    color: inherit;
    font: inherit;
    pointer-events: none;
    cursor: pointer;
  }

  .center-zone__counter-link[data-state='highlighted'] {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: -2px;
    pointer-events: auto;
  }

  .center-zone__counter-link[data-state='staged'] {
    outline: 2px solid var(--cu-ochre, #f0b54a);
    outline-offset: -2px;
  }

  .center-zone__counter-link:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: -3px;
  }

  .center-zone__last-move {
    display: -webkit-box;
    flex: 1;
    min-width: 0;
    max-height: calc(3 * 1.3em);
    margin: 0;
    padding-inline: var(--cu-space-2, 8px);
    overflow: hidden;
    font-size: var(--cu-text-sm, 14px);
    line-height: 1.3;
    color: var(--cu-muted, #b4a8be);
    text-align: center;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow-wrap: anywhere;
  }
</style>
