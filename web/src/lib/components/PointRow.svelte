<script lang="ts">
  // P2 W9 (Board props contract, docs/SPEC.md §5.2, docs/design.md §6) —
  // shared between OpponentZone and PlayerZone (SPEC §5.2 component tree).
  // Presentational: renders the `entries` it is given, reports taps by key,
  // no legal-move derivation.
  //
  // Target key: `point:<rowId>:<index>` — `rowId` is whichever of
  // `view.you`/`view.opponent` this row renders (the array the entry lives
  // in, i.e. the CONTROLLER's side per SPEC §5.2's "a stolen point renders
  // in the controller's row"), and `index` is the position in that array.
  // This is the Board brief's "index in that player's points array as the
  // view gives it" read literally: the row's own player id, not
  // `entry.Owner` (which can differ from the row after a Jack steal — see
  // the ownership marker below). Confirmed by the round-3 review against
  // engine key semantics; a stolen-entry test pins it.
  //
  // SPEC §5.2: "the point card with each Jack fanned above it and an
  // ownership badge driven by `Controller`... a marker indicating the
  // original `Owner`" — the "fanned above it" placement is superseded by
  // the docs/design.md §6/§7 Jack-stacking ruling (confirmed 2026-09-28):
  // Jacks stack ON the point card, shifted down, leaving its top strip
  // (rank + suit) visible. The marker shows only when `entry.Controller !==
  // entry.Owner` (a Jack-stolen point) and never otherwise. No indices from
  // `history` are used — `Owner`/`Controller` come straight off the
  // `PointEntry` the view already gave us (SPEC §3.3 rule 2: no
  // recomputation).
  //
  // §3.3 rule 2: `pointTotal` is the caller's `scoreboard.you.points` /
  // `scoreboard.opponent.points` verbatim — this component never sums
  // `entries` itself.
  import type { PlayerId, PointEntry } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import type { CardTheme, CardVisualState } from '../theme/types';
  import DropZones from './DropZones.svelte';

  interface PointRowProps {
    rowId: PlayerId;
    entries: PointEntry[];
    pointTotal: number;
    /** Shown when the row is empty. */
    label: string;
    /** Present only for the viewer's own row (Board brief: "the viewer's drop zones"). */
    dropZoneKey?: 'zone:points';
    dropZoneLabel?: string;
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    ontap: (key: string) => void;
    theme: CardTheme;
  }

  let { rowId, entries, pointTotal, label, dropZoneKey, dropZoneLabel, highlighted, staged, ontap, theme }: PointRowProps =
    $props();

  function keyFor(index: number): string {
    return `point:${rowId}:${index}`;
  }

  function stateFor(key: string): CardVisualState {
    if (staged.has(key)) return 'staged';
    if (highlighted.has(key)) return 'highlighted';
    return 'normal';
  }
</script>

{#snippet rowBody()}
  <div class="point-row__cards">
    {#each entries as entry, index (index)}
      {@const key = keyFor(index)}
      <div class="point-row__slot">
        <!-- The Jacks and the owner badge live INSIDE the tap target, after the
             face, so they paint over it and a tap anywhere on the stack is a
             tap on the point. Only the face box clips (container geometry
             rule); the button does not, so the Jacks can sit on top of it
             (docs/design.md §6/§7, confirmed 2026-09-28 — supersedes the
             SPEC §5.2 "fanned above it" quote above and the earlier
             fan-above treatment). -->
        <button
          type="button"
          class="point-row__card"
          data-testid={`point-${rowId}-${index}`}
          onclick={() => ontap(key)}
        >
          <span class="point-row__face"><theme.Face card={entry.Card} size="field" state={stateFor(key)} /></span>
          {#if entry.JackStack.length > 0}
            <span class="point-row__jacks" data-jack-count={entry.JackStack.length}>
              {#each entry.JackStack as jackCard, jackIndex (jackIndex)}
                <!-- W17 (round-4, product owner direction 2026-09-28): a Jack
                     is the same size as the card it sits on — `size="field"`,
                     matching the point card's own Face, not `mini`. -->
                <span class="point-row__jack" style={`--jack-i: ${jackIndex}`}
                  ><theme.Face card={jackCard} size="field" /></span
                >
              {/each}
            </span>
          {/if}
          {#if entry.Controller !== entry.Owner}
            <span class="point-row__owner-marker" data-owner-marker data-owner={entry.Owner}>
              <span class="point-row__sr-only">on loan from player {entry.Owner}</span>
            </span>
          {/if}
        </button>
      </div>
    {/each}
    {#if entries.length === 0}
      <span class="point-row__empty">{label}</span>
    {/if}
  </div>
  {#if entries.length > 0}
    <span class="point-row__tally">{pointTotal}</span>
  {/if}
{/snippet}

{#if dropZoneKey}
  <DropZones
    targetKey={dropZoneKey}
    label={dropZoneLabel ?? 'Play for points'}
    highlighted={highlighted.has(dropZoneKey)}
    staged={staged.has(dropZoneKey)}
    ontap={() => ontap(dropZoneKey)}
  >
    {@render rowBody()}
  </DropZones>
{:else}
  <div class="point-row">
    {@render rowBody()}
  </div>
{/if}

<style>
  /* docs/design.md §6, the Jack-stacking ruling (confirmed 2026-09-28): the
     row's height is the `--cu-zone-points` budget (96 phone / 84 compact),
     fixed and reserved even when the row is empty, so a Jack or a first
     point never reflows the board. */
  /* P2 W14 (board polish, item C): matches DropZones' `.drop-zone__content`
     padding/gap (the viewer's own row goes through that wrapper instead of
     this one) so the opponent's row — which renders this plain div, no
     drop zone — reserves the same tally clearance at the row's right end. */
  .point-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding-inline: 4px;
    border-radius: var(--cu-radius-well, 10px);
    background: var(--cu-ink-raised, #30263a);
  }

  /* Height is the zone budget, not content-derived: Jacks now stack ON the
     point card (never above it), so nothing needs extra top padding. The
     explicit `overflow-y: hidden` is deliberate (not `overflow-x: auto`'s
     usual side effect of forcing `overflow-y: auto`): it caps the row at
     its budget even if a rare 3rd/4th Jack's downward shift would otherwise
     push past it (criterion 6). `overflow-x: auto` still lets a wide row of
     point cards scroll horizontally. */
  .point-row__cards {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    height: var(--cu-zone-points, 96px);
    overflow-x: auto;
    overflow-y: hidden;
  }

  .point-row__slot {
    position: relative;
    flex: none;
    width: var(--cuttle-card-width-field);
    aspect-ratio: var(--cuttle-card-aspect);
  }

  .point-row__card {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    /* A DropZones parent turns pointer events off on its content so taps on
       empty well space reach its hit button; the cards opt back in. */
    pointer-events: auto;
  }

  /* SPEC §5.6 rule 2: the container owns and clips the card box. */
  .point-row__face {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 6%;
  }

  .point-row__jacks {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: block;
    /* W17: the per-Jack downward increment shrinks as the stack grows, so
       three or four Jacks still cascade inside the row's fixed height
       budget (--cu-zone-points, 96/84) instead of stacking so far down that
       only the row's `overflow-y: hidden` is left to save the layout. It
       never needs to drop below the corner index height — `--jack-strip`
       (below) is the floor for every Jack's position, not something this
       shrinks. */
    --jack-strip: 40px;
    --jack-shift: 18px;
  }

  .point-row__jacks[data-jack-count='3'] {
    --jack-shift: 12px;
  }

  .point-row__jacks[data-jack-count='4'] {
    --jack-shift: 8px;
  }

  /* Jack stacking ruling, W17 revision (round-4, product owner direction
     2026-09-28 — supersedes the W14 centred-top-strip / narrowed-mini
     treatment): a Jack is the SAME SIZE as the card it sits on (100% x 100%
     of the slot — no narrowing to `mini`), offset DOWNWARD ONLY (`left: 0`,
     no `transform`, no sideways shift) from the one before it, so the
     card's upper-left corner index (drawn by the theme — see
     VectorCardFace's base rule) stays visible above the stack. `--jack-strip`
     is the floor: it clears the theme's corner index block with margin, and
     is never shrunk by the count-based `--jack-shift` rules above. Later
     Jacks paint over earlier ones by DOM order alone (no z-index needed):
     the newest Jack is last in `JackStack`, so it renders last and sits on
     top. Jacks may extend past the slot's own bottom edge — the row
     (`.point-row__cards`)'s fixed height and `overflow-y: hidden` are what
     actually cap the row at its budget (criterion 6), not this offset. */
  .point-row__jack {
    position: absolute;
    top: calc(var(--jack-strip, 40px) + var(--jack-i, 0) * var(--jack-shift, 18px));
    left: 0;
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 6%;
    box-shadow: 0 1px 2px rgb(0 0 0 / 45%);
  }

  /* Owner badge (SPEC §5.2, design §6 "a small ownership mark"): an ink
     disc on the paper face. --cu-ink on --cu-paper is 15.52:1 (design §3),
     well above the 3:1 non-text floor. A pearl ring keeps its edge when it
     overlaps the face border. Bottom-right, clear of the Jack stack. */
  .point-row__owner-marker {
    position: absolute;
    right: 4px;
    bottom: 4px;
    z-index: 2;
    width: 12px;
    height: 12px;
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--cu-ink, #241c2b);
    box-shadow: 0 0 0 1.5px var(--cu-paper, #faf8f4);
    pointer-events: none;
  }

  .point-row__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .point-row__empty {
    font-size: var(--cu-text-xs, 12px);
    color: var(--cu-muted, #b4a8be);
  }

  /* The tally chip keeps its own box at the row's right end; the cards
     scroll, the chip never does and never clips. */
  .point-row__tally {
    flex: none;
    align-self: flex-start;
    margin-top: 4px;
    padding: 1px 4px;
    border-radius: 999px;
    background: var(--cu-ink, #241c2b);
    font-variant-numeric: tabular-nums;
    font-size: var(--cu-text-xs, 12px);
    line-height: 16px;
    color: var(--cu-pearl, #eee8f1);
  }
</style>
