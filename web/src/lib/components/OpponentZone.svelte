<script lang="ts">
  // P2 W9 (Board props contract, docs/SPEC.md §5.2) — opponent hand,
  // permanents, points, top to bottom toward the center (docs/design.md §6).
  // The opponent's rows never carry a drop-zone key: only the viewer plays
  // into their own zones (Board brief, "the viewer's drop zones").
  import type { PlayerId, PlayerView } from '../bridge/schema';
  import type { CardTheme } from '../theme/types';
  import OpponentHand from './OpponentHand.svelte';
  import PermanentRow from './PermanentRow.svelte';
  import PointRow from './PointRow.svelte';

  interface OpponentZoneProps {
    opponent: PlayerView['opponent'];
    opponentId: PlayerId;
    pointTotal: number;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    ontap: (key: string) => void;
    theme: CardTheme;
  }

  let { opponent, opponentId, pointTotal, highlighted, staged, ontap, theme }: OpponentZoneProps = $props();
</script>

<div class="opponent-zone" data-testid="opponent-zone">
  <OpponentHand handCount={opponent.handCount} hand={opponent.hand} {theme} />
  <PermanentRow rowId={opponentId} cards={opponent.permanents} label="Permanents" {highlighted} {staged} {ontap} {theme} />
  <PointRow
    rowId={opponentId}
    entries={opponent.points}
    {pointTotal}
    label="Points"
    {highlighted}
    {staged}
    {ontap}
    {theme}
  />
</div>

<style>
  /* W22: the far side of the table. Its field cards are one step
     smaller (--cuttle-card-width-field-far) and its wells one step quieter
     (--cu-ink-far), so your own half reads as nearer and more important.
     Both are inherited custom properties the shared rows read. */
  .opponent-zone {
    --cu-row-card-width: var(--cuttle-card-width-field-far);
    --cu-row-well: var(--cu-ink-far, #2c2334);
    display: flex;
    flex-direction: column;
    gap: var(--cu-gap-zone, 4px);
    padding-inline: var(--cu-gutter-board, 10px);
  }
</style>
