<script lang="ts">
  // P2 W9 (Board props contract, docs/SPEC.md §5.2, docs/design.md §6) —
  // shared between OpponentZone and PlayerZone. Presentational: renders the
  // `cards` it is given, reports taps by key.
  //
  // Target key: `perm:<rowId>:<index>`, `rowId` = whichever of
  // `view.you`/`view.opponent` this row renders (permanents carry no owner
  // field of their own, unlike `PointEntry`), `index` = position in that
  // array (same reading as PointRow's key — see its comment for the
  // reported ambiguity).
  import type { Card, PlayerId } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import type { CardTheme, CardVisualState } from '../theme/types';
  import DropZones from './DropZones.svelte';

  interface PermanentRowProps {
    rowId: PlayerId;
    cards: Card[];
    /** Shown when the row is empty. */
    label: string;
    /** Present only for the viewer's own row (Board brief: "the viewer's drop zones"). */
    dropZoneKey?: 'zone:permanents';
    dropZoneLabel?: string;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    ontap: (key: string) => void;
    theme: CardTheme;
  }

  let { rowId, cards, label, dropZoneKey, dropZoneLabel, highlighted, staged, ontap, theme }: PermanentRowProps =
    $props();

  function keyFor(index: number): string {
    return `perm:${rowId}:${index}`;
  }

  function stateFor(key: string): CardVisualState {
    if (staged.has(key)) return 'staged';
    if (highlighted.has(key)) return 'highlighted';
    return 'normal';
  }
</script>

{#snippet rowBody()}
  <div class="permanent-row__cards">
    {#each cards as card, index (index)}
      {@const key = keyFor(index)}
      <button
        type="button"
        class="permanent-row__card"
        data-testid={`perm-${rowId}-${index}`}
        onclick={() => ontap(key)}
      >
        <theme.Face {card} size="field" state={stateFor(key)} />
      </button>
    {/each}
    {#if cards.length === 0}
      <span class="permanent-row__empty">{label}</span>
    {/if}
  </div>
{/snippet}

{#if dropZoneKey}
  <DropZones
    targetKey={dropZoneKey}
    label={dropZoneLabel ?? 'Play as a permanent'}
    highlighted={highlighted.has(dropZoneKey)}
    staged={staged.has(dropZoneKey)}
    ontap={() => ontap(dropZoneKey)}
  >
    {@render rowBody()}
  </DropZones>
{:else}
  <div class="permanent-row">
    {@render rowBody()}
  </div>
{/if}

<style>
  .permanent-row {
    display: flex;
    align-items: center;
    min-width: 0;
    padding-inline: 8px;
    border-radius: var(--cu-radius-well, 10px);
    background: var(--cu-ink-raised, #30263a);
  }

  /* Reserve one field card's height so an empty row and a full row are the
     same size (staging and first plays never reflow the board). W18
     (round-4, item 2): derived from the shared aspect-ratio token
     (card-geometry.css) instead of a hard-coded `* 1.4` — that literal was
     the pre-W17 ratio and had drifted from the card's real (now ~1.3)
     shape. */
  .permanent-row__cards {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    min-height: calc(var(--cuttle-card-width-field) * var(--cuttle-card-aspect-ratio, 1.3));
    overflow-x: auto;
  }

  .permanent-row__card {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-field);
    aspect-ratio: var(--cuttle-card-aspect);
    box-sizing: border-box;
    overflow: hidden;
    padding: 0;
    border: none;
    border-radius: 6%;
    background: none;
    cursor: pointer;
    /* Opt back in under a DropZones content layer (pointer events off). */
    pointer-events: auto;
  }

  .permanent-row__empty {
    font-size: var(--cu-text-xs, 12px);
    color: var(--cu-muted, #b4a8be);
  }
</style>
