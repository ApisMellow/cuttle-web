<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §7) — the shared wrapper for
  // the three drop-zone targets: `zone:points`, `zone:permanents`,
  // `zone:oneoff`. Presentational only: reports a tap on the ZONE ITSELF
  // via `ontap`; the caller (PointRow, PermanentRow, CenterZone) decides the
  // target key and whether legality (`highlighted`)/staging (`staged`) apply.
  //
  // "Visible as targets only when highlighted" (Board brief): the ring and
  // label render only when `highlighted` or `staged` is true. The hit button
  // and its testid are always in the DOM regardless — legality never changes
  // testid presence (playbook "Testids and tap targets").
  //
  // Structure (revise 1 a11y ruling): a NON-interactive well holds two
  // siblings. The hit <button> fills the well behind everything and carries
  // the `zone-*` testid; the content layer sits above it with pointer events
  // off, so a tap on empty well space falls through to the hit button while
  // a card button inside the content (which opts back in) takes its own tap.
  // No button ever wraps a button. The hit button joins the tab order only
  // while the zone is highlighted or staged; keyboard activation is the
  // native <button> Enter/Space path, so there is no custom key handler.
  import type { Snippet } from 'svelte';

  interface DropZonesProps {
    /** e.g. `zone:points`; the testid is derived from it (`zone-points`). */
    targetKey: string;
    /** Shown only while the zone is highlighted or staged (docs/design.md §6). */
    label: string;
    highlighted: boolean;
    staged: boolean;
    ontap: () => void;
    children?: Snippet;
  }

  let { targetKey, label, highlighted, staged, ontap, children }: DropZonesProps = $props();

  const testId = $derived(targetKey.replace(/:/g, '-'));
  const state = $derived(staged ? 'staged' : highlighted ? 'highlighted' : 'normal');
  const active = $derived(highlighted || staged);
</script>

<div class="drop-zone" data-state={state}>
  <button
    type="button"
    class="drop-zone__hit"
    data-testid={testId}
    data-state={state}
    aria-label={label}
    tabindex={active ? 0 : -1}
    onclick={ontap}
  >
    {#if active}
      <span class="drop-zone__label" data-drop-label>{label}</span>
    {/if}
  </button>
  <div class="drop-zone__content">
    {@render children?.()}
  </div>
</div>

<style>
  .drop-zone {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 44px;
    border-radius: var(--cu-radius-well, 10px);
    background: var(--cu-ink-raised, #30263a);
  }

  .drop-zone[data-state='highlighted'] {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: -2px;
  }

  .drop-zone[data-state='staged'] {
    outline: 2px solid var(--cu-ochre, #f0b54a);
    outline-offset: -2px;
  }

  .drop-zone__hit {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    box-sizing: border-box;
    min-height: 44px;
    margin: 0;
    padding: 4px 10px;
    border: none;
    border-radius: inherit;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .drop-zone__hit:focus-visible {
    outline: 2px solid var(--cu-pearl, #eee8f1);
    outline-offset: 2px;
  }

  .drop-zone__label {
    font-size: var(--cu-text-xs, 12px);
    line-height: 16px;
    color: var(--cu-pearl, #eee8f1);
  }

  .drop-zone__content {
    position: relative;
    z-index: 1;
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 6px;
    padding-inline: 8px;
    pointer-events: none;
  }
</style>
