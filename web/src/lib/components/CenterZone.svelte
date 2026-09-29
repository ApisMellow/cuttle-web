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
    lastMoveText,
    ontap,
    theme = getTheme(DEFAULT_THEME_ID),
    overlay,
  }: CenterZoneProps = $props();

  const lineText = $derived(oneOffHighlighted || oneOffStaged ? '' : (lastMoveText ?? ''));
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
      <p class="center-zone__last-move">{lineText}</p>
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
