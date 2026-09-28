<script lang="ts">
  // P2 W9 (Board props contract, docs/SPEC.md §5.2) — the viewer's own
  // points, permanents, hand, closest to center to farthest (docs/design.md
  // §6). This is the only zone whose PointRow/PermanentRow carry a
  // drop-zone key (Board brief: "the viewer's drop zones").
  import type { Snippet } from 'svelte';

  import type { PlayerId, PlayerView } from '../bridge/schema';
  import type { CardTheme } from '../theme/types';
  import PermanentRow from './PermanentRow.svelte';
  import PlayerHand from './PlayerHand.svelte';
  import PointRow from './PointRow.svelte';

  interface PlayerZoneProps {
    you: PlayerView['you'];
    viewerId: PlayerId;
    pointTotal: number;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    dimmedHand: ReadonlySet<number>;
    selectedHand: number | null;
    ontap: (key: string) => void;
    theme: CardTheme;
    /** P2 W15: rendered in the hand's slot instead of the hand (the 7's SevenRevealPanel). */
    handTray?: Snippet;
  }

  let {
    you,
    viewerId,
    pointTotal,
    highlighted,
    staged,
    dimmedHand,
    selectedHand,
    ontap,
    theme,
    handTray,
  }: PlayerZoneProps = $props();
</script>

<div class="player-zone" data-testid="player-zone">
  <PointRow
    rowId={viewerId}
    entries={you.points}
    {pointTotal}
    label="Points"
    dropZoneKey="zone:points"
    dropZoneLabel="Play for points"
    {highlighted}
    {staged}
    {ontap}
    {theme}
  />
  <PermanentRow
    rowId={viewerId}
    cards={you.permanents}
    label="Permanents"
    dropZoneKey="zone:permanents"
    dropZoneLabel="Play as a permanent"
    {highlighted}
    {staged}
    {ontap}
    {theme}
  />
  <!-- W22: the hand's slot, pinned to the bottom of the scrolling board
       (sticky), so a short viewport scrolls the field, never the hand. -->
  <div class="player-zone__hand">
    {#if handTray}
      {@render handTray()}
    {:else}
      <PlayerHand
        cards={you.hand}
        frozenHandIndices={you.frozenHandIndices}
        selectedHandIndex={selectedHand}
        {highlighted}
        {staged}
        dimmedHandIndices={dimmedHand}
        onselect={(handIndex) => ontap(`hand:${handIndex}`)}
        {theme}
      />
    {/if}
  </div>
</div>

<style>
  .player-zone {
    display: flex;
    flex-direction: column;
    gap: var(--cu-gap-zone, 4px);
    padding-inline: var(--cu-gutter-board, 10px);
  }

  /* Sticky against the board's scrollport. Opaque ink so the field slides
     under it, with a short fade on the top edge so the cut reads as the
     table continuing, not a hard bar. The 12px top padding is the room a
     lifted or staged card rises into. */
  .player-zone__hand {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: var(--cu-zone-hand, 96px);
    box-sizing: border-box;
    margin-inline: calc(-1 * var(--cu-gutter-board, 10px));
    padding: 12px var(--cu-gutter-board, 10px) 4px;
    background: var(--cu-ink, #241c2b);
    box-shadow: 0 -10px 10px -6px var(--cu-ink, #241c2b);
  }
</style>
