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
    /** Card labels: this side's win threshold, from the scoreboard (the Kings' badge). */
    goal?: number;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    ontap: (key: string) => void;
    theme: CardTheme;
    /** Player names by id (the stolen-card screen-reader name). */
    names?: readonly [string, string];
  }

  let { opponent, opponentId, pointTotal, goal, highlighted, staged, ontap, theme, names }: OpponentZoneProps = $props();
</script>

<div class="opponent-zone" data-testid="opponent-zone">
  <OpponentHand handCount={opponent.handCount} hand={opponent.hand} {theme} />
  <PermanentRow rowId={opponentId} cards={opponent.permanents} label="Permanents" {goal} {highlighted} {staged} {ontap} {theme} />
  <PointRow
    rowId={opponentId}
    entries={opponent.points}
    {pointTotal}
    label="Points"
    {highlighted}
    {staged}
    {ontap}
    {theme}
    {names}
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
    /* Card labels: the far side's badges step down with its cards, so
       "Protects" keeps clear room on the narrower far-row Queen. */
    --cu-badge-scale: 0.95;
    display: flex;
    flex-direction: column;
    gap: var(--cu-gap-zone, 4px);
    padding-inline: var(--cu-gutter-board, 10px);
  }
</style>
