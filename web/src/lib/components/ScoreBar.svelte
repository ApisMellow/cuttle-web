<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — both totals and
  // thresholds, always visible (SPEC §5.2 R5). SPEC §3.3 rule 2: every
  // number here is read straight off `view.scoreboard`, never recomputed
  // from points/permanents arrays.
  //
  // "The menu button is out of scope; leave a slot" (Board brief): `menu` is
  // an optional Snippet; when absent, the reserved area renders empty.
  import type { Snippet } from 'svelte';

  import type { PlayerView } from '../bridge/schema';

  interface ScoreBarProps {
    scoreboard: PlayerView['scoreboard'];
    opponentName: string;
    menu?: Snippet;
  }

  let { scoreboard, opponentName, menu }: ScoreBarProps = $props();

  // W22: design.md §6's 4px progress meter under each side. Display only:
  // both numbers are the scoreboard's own values, never recomputed.
  function fill(side: { points: number; threshold: number }): number {
    return side.threshold > 0 ? Math.min(1, Math.max(0, side.points / side.threshold)) : 0;
  }
</script>

<div class="score-bar" data-testid="score-bar">
  <div class="score-bar__side" data-side="you">
    <span class="score-bar__label">You</span>
    <span class="score-bar__points">{scoreboard.you.points}</span>
    <span class="score-bar__threshold">of {scoreboard.you.threshold}</span>
    {#if scoreboard.you.kings > 0}
      <span class="score-bar__kings" data-kings={scoreboard.you.kings}>{'K'.repeat(scoreboard.you.kings)}</span>
    {/if}
    <span class="score-bar__meter" aria-hidden="true"><span style={`--fill: ${fill(scoreboard.you)}`}></span></span>
  </div>
  <div class="score-bar__side" data-side="opponent">
    <span class="score-bar__label">{opponentName}</span>
    <span class="score-bar__points">{scoreboard.opponent.points}</span>
    <span class="score-bar__threshold">of {scoreboard.opponent.threshold}</span>
    {#if scoreboard.opponent.kings > 0}
      <span class="score-bar__kings" data-kings={scoreboard.opponent.kings}>{'K'.repeat(scoreboard.opponent.kings)}</span>
    {/if}
    <span class="score-bar__meter" aria-hidden="true"><span style={`--fill: ${fill(scoreboard.opponent)}`}></span></span>
  </div>
  <div class="score-bar__menu">
    {@render menu?.()}
  </div>
</div>

<style>
  /* W22 (iPhone 15 pass): a quiet header, pinned to the top of the
     scrolling board. You on the left, the opponent on the right, each a
     bold tabular score over a thin meter toward that side's threshold
     (design.md §6). */
  .score-bar {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    min-height: var(--cu-zone-score, 44px);
    box-sizing: border-box;
    gap: var(--cu-space-4, 16px);
    padding: 0 var(--cu-gutter-board, 10px) 0 calc(var(--cu-gutter-board, 10px) + 4px);
    background: var(--cu-ink-raised, #30263a);
  }

  .score-bar__side {
    display: flex;
    flex: 1 1 0;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 6px;
    row-gap: 3px;
    min-width: 0;
    color: var(--cu-pearl, #eee8f1);
    font-variant-numeric: tabular-nums;
  }

  .score-bar__side[data-side='opponent'] {
    justify-content: flex-end;
  }

  .score-bar__label {
    overflow: hidden;
    max-width: 9em;
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .score-bar__points {
    font-size: var(--cu-text-lg, 20px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 1;
  }

  .score-bar__threshold {
    font-size: var(--cu-text-xs, 12px);
    color: var(--cu-muted, #b4a8be);
  }

  .score-bar__kings {
    font-size: var(--cu-text-xs, 12px);
    font-weight: var(--cu-weight-bold, 700);
    color: var(--cu-frost, #a9d2f5);
    letter-spacing: 1px;
  }

  .score-bar__meter {
    display: block;
    flex: 0 0 100%;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--cu-ink-line, #4a3d57);
  }

  .score-bar__meter > span {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--cu-pearl, #eee8f1);
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .score-bar__side[data-side='opponent'] .score-bar__meter > span {
    transform-origin: right center;
  }

  .score-bar__menu {
    flex: none;
    min-width: 44px;
    min-height: 44px;
  }
</style>
