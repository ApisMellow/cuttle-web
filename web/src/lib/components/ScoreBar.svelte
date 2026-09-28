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
</script>

<div class="score-bar" data-testid="score-bar">
  <div class="score-bar__side" data-side="you">
    <span class="score-bar__label">You</span>
    <span class="score-bar__points">{scoreboard.you.points}</span>
    <span class="score-bar__threshold">of {scoreboard.you.threshold}</span>
    {#if scoreboard.you.kings > 0}
      <span class="score-bar__kings" data-kings={scoreboard.you.kings}>{'K'.repeat(scoreboard.you.kings)}</span>
    {/if}
  </div>
  <div class="score-bar__side" data-side="opponent">
    <span class="score-bar__label">{opponentName}</span>
    <span class="score-bar__points">{scoreboard.opponent.points}</span>
    <span class="score-bar__threshold">of {scoreboard.opponent.threshold}</span>
    {#if scoreboard.opponent.kings > 0}
      <span class="score-bar__kings" data-kings={scoreboard.opponent.kings}>{'K'.repeat(scoreboard.opponent.kings)}</span>
    {/if}
  </div>
  <div class="score-bar__menu">
    {@render menu?.()}
  </div>
</div>

<style>
  .score-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    gap: 8px;
    padding: 0 var(--cu-gutter-board, 12px);
    background: var(--cu-ink-raised, #30263a);
  }

  .score-bar__side {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-lg, 20px);
    font-variant-numeric: tabular-nums;
  }

  .score-bar__threshold {
    font-size: var(--cu-text-xs, 12px);
    color: var(--cu-muted, #b4a8be);
  }

  .score-bar__kings {
    font-size: var(--cu-text-xs, 12px);
    color: var(--cu-frost, #a9d2f5);
    letter-spacing: 1px;
  }

  .score-bar__menu {
    min-width: 44px;
    min-height: 44px;
  }
</style>
