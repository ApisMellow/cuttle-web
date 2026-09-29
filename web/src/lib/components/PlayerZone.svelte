<script lang="ts">
  // P2 W9 (Board props contract, docs/SPEC.md §5.2) — the viewer's own
  // points, permanents, hand, closest to center to farthest (docs/design.md
  // §6). This is the only zone whose PointRow/PermanentRow carry a
  // drop-zone key (Board brief: "the viewer's drop zones").
  import type { Snippet } from 'svelte';

  import type { PlayerId, PlayerView } from '../bridge/schema';
  import type { HandDrag } from '../dragDrop';
  import type { CardTheme } from '../theme/types';
  import PermanentRow from './PermanentRow.svelte';
  import PlayerHand from './PlayerHand.svelte';
  import PointRow from './PointRow.svelte';

  interface PlayerZoneProps {
    you: PlayerView['you'];
    viewerId: PlayerId;
    pointTotal: number;
    /** Card labels: this side's win threshold, from the scoreboard (the Kings' badge). */
    goal?: number;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    dimmedHand: ReadonlySet<number>;
    selectedHand: number | null;
    ontap: (key: string) => void;
    theme: CardTheme;
    /** P2 W15: rendered in the hand's slot instead of the hand (the 7's SevenRevealPanel). */
    handTray?: Snippet;
    /** W24: the opponent's name while they have glasses in play (Board reads the bridge's `you.watched`); else null. */
    watchedBy?: string | null;
    /** Player names by id (the stolen-card screen-reader name). */
    names?: readonly [string, string];
    /** Issue #26: the hand card being dragged, passed straight to the hand. */
    drag?: HandDrag | null;
  }

  let {
    you,
    viewerId,
    pointTotal,
    goal,
    highlighted,
    staged,
    dimmedHand,
    selectedHand,
    ontap,
    theme,
    handTray,
    watchedBy = null,
    names,
    drag = null,
  }: PlayerZoneProps = $props();

  // R10: the marker's text is the hand group's description, so a screen
  // reader hears it with the hand every time focus enters it. A live region
  // mounted together with its text (the board remounts after every curtain)
  // is not reliably announced.
  const markerId = $props.id();
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
    {names}
  />
  <PermanentRow
    rowId={viewerId}
    cards={you.permanents}
    label="Permanents"
    {goal}
    dropZoneKey="zone:permanents"
    dropZoneLabel="Play as a permanent"
    {highlighted}
    {staged}
    {ontap}
    {theme}
  />
  <!-- W22: the hand's slot, pinned to the bottom of the scrolling board
       (sticky), so a short viewport scrolls the field, never the hand. -->
  <div
    class="player-zone__hand"
    role="group"
    aria-label="Your hand"
    aria-describedby={watchedBy !== null ? `${markerId}-watched` : undefined}
  >
    {#if watchedBy !== null}
      <!-- W24: the being-watched marker. It rides the seam between the
           permanents row and the hand (half in the hand slot's 12px lift
           headroom), so it costs the board no height; painted before the
           hand, so a lifted card passes over it rather than under. -->
      <span class="watched-marker">
        <svg class="watched-marker__icon" viewBox="0 0 24 14" aria-hidden="true">
          <path d="M1 5 H23" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <circle cx="6.5" cy="7.5" r="5" fill="none" stroke="currentColor" stroke-width="2.2" />
          <circle cx="17.5" cy="7.5" r="5" fill="none" stroke="currentColor" stroke-width="2.2" />
          <circle cx="8" cy="8.5" r="1.8" fill="currentColor" />
          <circle cx="19" cy="8.5" r="1.8" fill="currentColor" />
        </svg>
        <span class="watched-marker__label" id={`${markerId}-watched`}>{watchedBy} can see your hand</span>
      </span>
    {/if}
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
        {drag}
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

  /* W24: a small ochre-edged pill, right-aligned, centred on the hand
     slot's top edge. 22px tall: 11px over the seam into the permanents
     row's bottom margin, 11px into the slot's 12px lift headroom, so a
     resting card never meets it. Not a tap target, so no testid. */
  .watched-marker {
    position: absolute;
    top: 0;
    right: var(--cu-gutter-board, 10px);
    z-index: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 22px;
    padding: 0 9px 0 7px;
    transform: translateY(-50%);
    border: 1px solid var(--cu-ochre, #f0b54a);
    border-radius: 999px;
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-ochre, #f0b54a);
    font-size: var(--cu-text-xs, 12px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
  }

  .watched-marker__icon {
    display: block;
    width: 20px;
    height: 12px;
    flex: none;
  }

  .watched-marker__label {
    color: var(--cu-pearl, #eee8f1);
  }
</style>
