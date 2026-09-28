<script lang="ts">
  // SPEC §4, §4.5, §4.6, §5.2 (W10) — the full-viewport curtain host.
  //
  // Presentational only: no game rule, no bridge or store call. For the
  // withheld kinds it mounts exactly one screen (SPEC §8: the board is
  // unmounted behind the curtain); for 'none', 'ack' and 'result' it renders
  // NOTHING, so the board owner decides what shows.
  //
  // Ruling A1 ("same screen, armed", design.md §8): `handoff` and `reveal`
  // share ONE HandoffPanel instance. Both kinds sit in the same `{#if}`
  // branch, so the component stays mounted across handoff -> reveal and a
  // ring press can carry over into the hold.
  //
  // Label: `handoffLabel(reason)` is the only thing derived from the reason
  // ("Your turn" / "Your response"). `reveal` carries no reason, so the label
  // shown during the preceding handoff is remembered, for the same player
  // only. A reveal with no handoff before it (a restore) gets an empty,
  // fixed-height slot rather than a guess. The raw HandoffReason never goes
  // further than `handoffLabel` (SPEC §4.5).
  //
  // Epoch: a counter bumped every time the curtain state changes. It keys
  // RevealGate's once-only latch (one onadvance() per machine transition).
  //
  // `recapEntries` arrives already filtered by the store (`isRecapVisible`,
  // SPEC §4.6); Curtain never filters it.
  import type { AppliedMove, PlayerId } from '../bridge/schema';
  import { handoffLabel, type CurtainState } from '../stores/curtain.svelte';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';
  import HandoffPanel from './HandoffPanel.svelte';
  import RecapPanel from './RecapPanel.svelte';

  interface CurtainProps {
    curtain: CurtainState;
    names: readonly [string, string];
    revealPreference: 'hold' | 'two-step';
    /** Already filtered by the store (SPEC §4.6); Curtain never filters. */
    recapEntries: AppliedMove[];
    viewer: PlayerId | null;
    onadvance: () => void;
    theme?: CardTheme;
  }

  let {
    curtain,
    names,
    revealPreference,
    recapEntries,
    viewer,
    onadvance,
    theme = getTheme(DEFAULT_THEME_ID),
  }: CurtainProps = $props();

  interface GateScreen {
    stage: 'handoff' | 'reveal';
    to: PlayerId;
    label: string;
    epoch: number;
  }

  // Plain (non-reactive) memory, written only inside the derivation below.
  let remembered: { to: PlayerId; label: string } | null = null;
  let epochCounter = 0;

  // Read unconditionally by the template, so it re-derives on every curtain
  // change and `remembered` is cleared as soon as the gate screen goes away.
  const screen: GateScreen | null = $derived.by(() => {
    epochCounter += 1;
    switch (curtain.kind) {
      case 'handoff':
        remembered = { to: curtain.to, label: handoffLabel(curtain.reason) };
        return { stage: 'handoff', to: curtain.to, label: remembered.label, epoch: epochCounter };
      case 'reveal': {
        const label = remembered !== null && remembered.to === curtain.to ? remembered.label : '';
        return { stage: 'reveal', to: curtain.to, label, epoch: epochCounter };
      }
      default:
        remembered = null;
        return null;
    }
  });
</script>

{#if screen !== null || curtain.kind === 'recap'}
  <div class="curtain" data-testid="curtain">
    {#if screen !== null}
      <HandoffPanel
        name={names[screen.to]}
        player={screen.to}
        label={screen.label}
        stage={screen.stage}
        epoch={screen.epoch}
        {revealPreference}
        {onadvance}
      />
    {:else}
      <RecapPanel entries={recapEntries} {viewer} {names} {onadvance} {theme} />
    {/if}
  </div>
{/if}

<style>
  /* SPEC §8: full-viewport, opaque, no board underneath, hard cut (§9). */
  .curtain {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    /* W22: the ink fills the whole glass, under the Dynamic Island and the
       home indicator; the content box stays inside the safe area. */
    box-sizing: border-box;
    padding: var(--cu-safe-top, 0px) 0 var(--cu-safe-bottom, 0px);
    background: var(--cu-curtain, #1a1420);
    color: var(--cu-pearl, #eee8f1);
    overflow: hidden;
  }
</style>
