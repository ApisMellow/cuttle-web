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

<style>
  .player-zone {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-inline: var(--cu-gutter-board, 12px);
  }
</style>
