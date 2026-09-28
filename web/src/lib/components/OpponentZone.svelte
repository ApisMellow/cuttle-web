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
  .opponent-zone {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-inline: var(--cu-gutter-board, 12px);
  }
</style>
