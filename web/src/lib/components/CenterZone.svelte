<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — the three-slot center
  // strip: DeckPile, the one-off drop zone, ScrapPile.
  //
  // The middle slot (revise 1 ruling, design §6): when idle it shows the
  // last move as ONE line of `--cu-text-sm` muted text, clamped with an
  // ellipsis, at a fixed height. The line is not interactive and carries no
  // testid (every testid must be a 44 px target). When the one-off zone is
  // highlighted or staged, the line gives way to the zone's own label. The
  // line's box is always present, so the strip's height never depends on
  // `lastMoveText`; the strip's height comes from the Deck and Scrap slots.
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
</div>

<style>
  .center-zone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-inline: var(--cu-gutter-board, 12px);
  }

  /* The flex middle slot: it stretches to the strip's height (set by the
     Deck and Scrap slots), so the one-off target is as tall as a hand card
     and always clears 44 px. */
  .center-zone__middle {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    align-self: stretch;
  }

  .center-zone__last-move {
    flex: 1;
    min-width: 0;
    height: 20px;
    margin: 0;
    overflow: hidden;
    font-size: var(--cu-text-sm, 14px);
    line-height: 20px;
    color: var(--cu-muted, #b4a8be);
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
