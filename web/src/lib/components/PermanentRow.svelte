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
  import { inPlayBadge } from '../cardText';
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
    /**
     * Card labels: the points this row's player now needs to win, read
     * verbatim from the bridge's `scoreboard.*.threshold` for that side
     * (engine/win.go `Threshold`). Each King wears it as its badge. Never
     * recomputed here from the Kings in the row (SPEC §3.3 rule 2).
     */
    goal?: number;
  }

  let { rowId, cards, label, dropZoneKey, dropZoneLabel, highlighted, staged, ontap, theme, goal }: PermanentRowProps =
    $props();

  function keyFor(index: number): string {
    return `perm:${rowId}:${index}`;
  }

  // W24: the permanents row holds only Queens, Kings and glasses-8s (SPEC
  // §3.2, `engine/state.go`), so every 8 here is glasses. It lies on its
  // side (the traditional Cuttle cue: a sideways 8 is a pair of glasses)
  // and draws the theme's glasses face. Same element, same testid, same
  // `perm:` key: only the box's orientation changes.
  function isGlasses(card: Card): boolean {
    return card.Rank === 8;
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
      {@const sideways = isGlasses(card)}
      {@const badge = inPlayBadge(card, 'permanent', { goal })}
      <button
        type="button"
        class={['permanent-row__card', { 'permanent-row__card--sideways': sideways }]}
        data-testid={`perm-${rowId}-${index}`}
        data-orientation={sideways ? 'sideways' : 'upright'}
        onclick={() => ontap(key)}
      >
        <theme.Face {card} size="field" state={stateFor(key)} variant={sideways ? 'glasses' : 'standard'} />
        {#if badge !== null}
          <!-- Card labels: what this permanent is doing right now, at the
               card's foot, clear of the upper-left corner index. Part of
               the button's accessible name, after the face's own text
               (the vector face reads "K♥", so the name is "K♥ Goal 14"). -->
          <span class="permanent-row__badge" data-card-label="badge">{badge}</span>
        {/if}
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
    background: var(--cu-row-well, var(--cu-ink-raised, #30263a));
  }

  /* Reserve one field card's height so an empty row and a full row are the
     same size (staging and first plays never reflow the board). W18
     (round-4, item 2): derived from the shared aspect-ratio token
     (card-geometry.css) instead of a hard-coded `* 1.4` — that literal was
     the pre-W17 ratio and had drifted from the card's real (now ~1.3)
     shape. */
  /* R10: the row wraps rather than scrolling. A hidden scrollbar let a
     sixth permanent (K K Q Q plus two sideways glasses at 393 wide) sit
     off the end of the row with nothing to say it was there; wrapping puts
     it on a second line, so every permanent is always on the table. The
     common rows (up to Q + K + two glasses) still hold one line. */
  .permanent-row__cards {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    min-height: calc(
      var(--cu-row-card-width, var(--cuttle-card-width-field)) * var(--cuttle-card-aspect-ratio, 1.3) + 2 *
        var(--cu-row-pad, 3px)
    );
    padding-block: var(--cu-row-pad, 3px);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .permanent-row__card {
    position: relative;
    display: block;
    flex: none;
    width: var(--cu-row-card-width, var(--cuttle-card-width-field));
    aspect-ratio: var(--cuttle-card-aspect);
    box-sizing: border-box;
    overflow: hidden;
    padding: 0;
    border: none;
    border-radius: 7%;
    box-shadow: 0 1px 2px rgb(0 0 0 / 35%);
    background: none;
    cursor: pointer;
    /* Opt back in under a DropZones content layer (pointer events off). */
    pointer-events: auto;
  }

  /* W24: a glasses 8 lies sideways. The box is the card turned 90°:
     one card-height wide and one card-width tall, so it sits inside the
     row's reserved one-card height with room to spare and takes a little
     more of the row's width. No transform: the box itself is landscape, so
     layout, clipping and hit-testing all see the same rectangle. */
  .permanent-row__card--sideways {
    width: calc(var(--cu-row-card-width, var(--cuttle-card-width-field)) * var(--cuttle-card-aspect-ratio, 1.3));
    aspect-ratio: var(--cuttle-card-aspect-ratio, 1.3);
  }

  /* Card labels: a small ink pill at the card's foot, centred, clear of
     the upper-left corner index (design.md §7) and of the glasses pip.
     Decorative for taps: the whole card stays the button. */
  .permanent-row__badge {
    position: absolute;
    left: 50%;
    bottom: 3px;
    z-index: 3;
    transform: translateX(-50%);
    max-width: calc(100% - 4px);
    box-sizing: border-box;
    padding: 1px 3px;
    border-radius: 999px;
    background: var(--cu-ink, #241c2b);
    box-shadow: 0 0 0 1px rgb(250 248 244 / 0.55);
    color: var(--cu-pearl, #eee8f1);
    font-family: var(--cu-font-ui, sans-serif);
    font-size: calc(var(--cu-text-badge, 10px) * var(--cu-badge-scale, 1));
    font-weight: var(--cu-weight-bold, 700);
    line-height: 1.2;
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  .permanent-row__empty {
    padding-inline: 4px;
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
  }

  /* W25 (desktop keyboard): a visible focus ring on every target, drawn
     inset so a clipping row or well can't hide it. */
  .permanent-row__card:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: -3px;
  }
</style>
