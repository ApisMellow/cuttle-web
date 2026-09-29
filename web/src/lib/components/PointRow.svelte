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
  // W18 (round-4, product-owner revision 2026-09-28, superseding the W17
  // cascade below and the design.md §6/§7 text as currently written — see
  // this item's hand-back for the SPEC tension): only the TOP (newest,
  // `JackStack[JackStack.length - 1]`) Jack ever renders, full card size,
  // offset downward exactly as the old cascade's first layer — never
  // narrowed, never fanned, never shifted sideways. Only the top Jack is
  // ever a legal target and steals alternate owners, so showing one layer
  // loses no information the engine's view didn't already collapse. A
  // 2-or-more stack gets a thin "deck thickness" edge (two plain card-back
  // slivers peeking past the shown Jack's own right/bottom edge) instead of
  // a count badge — no digits on the board — and the count survives only
  // as the stack's `aria-label` ("stolen, N Jacks") for screen readers.
  //
  // §3.3 rule 2: `pointTotal` is the caller's `scoreboard.you.points` /
  // `scoreboard.opponent.points` verbatim — this component never sums
  // `entries` itself.
  //
  // r16 (playtest friction 3): the board still shows no count (owner
  // ruling, 2026-09-29: extra Jacks are only the thin edge). The card's
  // button carries one accessible
  // name for the whole stack, with player names, never raw ids ("10 of
  // Hearts, stolen from Alice, 3 Jacks on it, top Jack of Spades").
  import type { Card, PlayerId, PointEntry } from '../bridge/schema';
  import { inPlayBadge } from '../cardText';
  import '../styles/card-geometry.css';
  import { cardSpokenName } from '../theme';
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
    /** Player names by id, for the stolen-card name ("stolen from Alice"). */
    names?: readonly [string, string];
  }

  let {
    rowId,
    entries,
    pointTotal,
    label,
    dropZoneKey,
    dropZoneLabel,
    highlighted,
    staged,
    ontap,
    theme,
    names,
  }: PointRowProps = $props();

  /**
   * The point card's button name: the card, who it was stolen from, and the
   * whole Jack stack. Every card named here is face up on the table.
   */
  function accessibleName(entry: PointEntry): string {
    const parts = [cardSpokenName(entry.Card)];
    const stolen = entry.Controller !== entry.Owner;
    if (stolen) {
      const owner = names?.[entry.Owner];
      parts.push(owner !== undefined && owner.trim() !== '' ? `stolen from ${owner}` : 'stolen');
    }
    const count = entry.JackStack.length;
    if (count > 0) {
      const top: Card = entry.JackStack[count - 1];
      parts.push(count === 1 ? `${cardSpokenName(top)} on it` : `${count} Jacks on it, top ${cardSpokenName(top)}`);
    }
    return parts.join(', ');
  }

  function keyFor(index: number): string {
    return `point:${rowId}:${index}`;
  }

  function stateFor(key: string): CardVisualState {
    if (staged.has(key)) return 'staged';
    if (highlighted.has(key)) return 'highlighted';
    return 'normal';
  }

  // W18: the row's fixed height (`--cu-zone-points`, below) only leaves
  // room for a bare point card, not a full-size Jack sitting below its
  // corner index. Grow the row — never shrink the Jack below the corner-
  // index floor — only when this side actually holds one; an empty or
  // Jack-free row stays at the design budget.
  const rowHasJack = $derived(entries.some((entry) => entry.JackStack.length > 0));
</script>

{#snippet rowBody()}
  <div class="point-row__cards" data-has-jack={rowHasJack ? 'true' : undefined}>
    {#each entries as entry, index (index)}
      {@const key = keyFor(index)}
      {@const jackCount = entry.JackStack.length}
      {@const topJack = jackCount > 0 ? entry.JackStack[jackCount - 1] : null}
      {@const jackBadge = topJack === null ? null : inPlayBadge(topJack, 'jack', { stolen: entry.Controller !== entry.Owner })}
      <div class="point-row__slot" data-has-jack={jackCount > 0 ? 'true' : undefined}>
        <!-- The Jack and the owner badge live INSIDE the tap target, after the
             face, so they paint over it and a tap anywhere on the stack is a
             tap on the point. Only the face box clips (container geometry
             rule); the button does not, so the Jack can sit on top of it
             (docs/design.md §6/§7, confirmed 2026-09-28 — supersedes the
             SPEC §5.2 "fanned above it" quote above and the earlier
             fan-above treatment). -->
        <button
          type="button"
          class="point-row__card"
          data-testid={`point-${rowId}-${index}`}
          aria-label={accessibleName(entry)}
          onclick={() => ontap(key)}
        >
          <span class="point-row__face"><theme.Face card={entry.Card} size="field" state={stateFor(key)} /></span>
          {#if topJack !== null}
            <!-- W18 (round-4, product-owner revision 2026-09-28): only the
                 top (newest) Jack renders, full card size — `size="field"`,
                 matching the point card's own Face, not `mini` — offset
                 downward only, same as the W17 cascade's first layer. A
                 2-or-more stack adds two plain card-back slivers ("deck
                 thickness") peeking past the shown Jack's own right/bottom
                 edge; no count digits render anywhere. `aria-label` carries
                 the count for screen readers, since the sliver cue alone
                 doesn't. r16: the button's own aria-label names the whole
                 stack now, so this wrapper carries none. -->
            <span class="point-row__jack-stack" data-jack-count={jackCount}>
              {#if jackCount > 1}
                <span class="point-row__jack-edge point-row__jack-edge--2" aria-hidden="true"></span>
                <span class="point-row__jack-edge point-row__jack-edge--1" aria-hidden="true"></span>
              {/if}
              <span class="point-row__jack"
                ><theme.Face card={topJack} size="field" />{#if jackBadge !== null}
                  <!-- Card labels: the top Jack says it stole this card, at
                       the Jack's own foot, clear of both corner indices. -->
                  <span class="point-row__badge" data-card-label="badge">{jackBadge}</span>
                {/if}</span
              >
            </span>
          {/if}
          {#if entry.Controller !== entry.Owner}
            <span class="point-row__owner-marker" data-owner-marker data-owner={entry.Owner} aria-hidden="true"></span>
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
     row's height is one card plus the well padding (W22: sized from the
     row's card width, see `.point-row__cards`)
     when no entry holds a Jack — fixed and reserved even when the row is
     empty, so a first point never reflows the board. W18 (round-4, item 1):
     that budget only ever had room for a bare point card, not a full-size
     Jack sitting below its own corner index — the reported bug. `[data-
     has-jack]` (below) grows the row exactly when this side needs it. */
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
    background: var(--cu-row-well, var(--cu-ink-raised, #30263a));
  }

  /* `overflow-y: hidden` stays as a hard safety valve (never actually
     clips at the sizes below — see the `[data-has-jack]` rule), so a future
     regression clips instead of silently pushing the board taller.
     `overflow-x: auto` still lets a wide row of point cards scroll
     horizontally. */
  .point-row__cards {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    /* W22: one card of whichever field width this side uses (the
       opponent's rows are a step smaller, set by OpponentZone) plus the
       well's 4px padding top and bottom. */
    height: calc(
      var(--cu-row-card-width, var(--cuttle-card-width-field)) * var(--cuttle-card-aspect-ratio, 1.3) + 2 *
        var(--cu-row-pad, 3px)
    );
    padding-block: var(--cu-row-pad, 3px);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  /* W18 (round-4, item 1): grows the row to exactly fit one full-size Jack
     below the point card's corner index (`--jack-offset`, matching
     `.point-row__jack`'s own offset below) plus a few px of slack for the
     "deck thickness" edge (`.point-row__jack-edge`, up to 4px past the
     Jack's own box). Reads the shared aspect-ratio token
     (card-geometry.css) instead of a literal, so a card-height change (or
     `--jack-offset`) can't silently reopen the clip. Only a row that
     actually holds a Jack grows — a Jack-free row (the common case,
     including an entirely empty row) stays at the design budget. */
  .point-row__cards[data-has-jack='true'] {
    /* Declared here, once, and inherited by every descendant below
       (`.point-row__jack`, `.point-row__jack-edge`) instead of repeating
       the literal — the row-growth math and the Jack's own offset must
       always agree on this number. */
    /* W22: the token clears the new field index per tier (tokens.css). */
    --jack-offset: var(--cu-jack-offset, 37px);
    /* W22: the deck-thickness edge (up to 4px past the Jack) lives in
       the row's bottom padding. */
    height: calc(
      var(--cu-row-card-width, var(--cuttle-card-width-field)) * var(--cuttle-card-aspect-ratio, 1.3) +
        var(--jack-offset) + 2 * var(--cu-row-pad, 3px)
    );
  }

  .point-row__slot {
    position: relative;
    flex: none;
    width: var(--cu-row-card-width, var(--cuttle-card-width-field));
    aspect-ratio: var(--cuttle-card-aspect);
  }

  /* The row centers a bare card, but a Jack-holding slot anchors to the
     row's own top instead: centering would split the grown row's extra
     height above AND below the card, wasting half of it, when the Jack
     only ever needs room below. */
  .point-row__slot[data-has-jack='true'] {
    align-self: flex-start;
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
    border-radius: 7%;
    box-shadow: 0 1px 2px rgb(0 0 0 / 35%);
  }

  /* W18 (round-4, product-owner revision 2026-09-28 — supersedes the W17
     cascade this replaces): the stack wrapper positions the single shown
     Jack plus its optional "deck thickness" edges. No clip and no pointer
     events of its own — `.point-row__jack` below owns the clip, and every
     child stays reachable through the same button. */
  .point-row__jack-stack {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: block;
  }

  /* W18: identical look at 2, 3 or 4 Jacks (the product owner: "fewer
     numbers on screen" — no per-count variation, no digits). Two plain
     card-back-coloured slivers sit BEHIND the shown Jack, offset a further
     2px and 4px down-right of it by `transform` (not `top`/`left`, so they
     never affect layout or the row's grown height beyond the fixed 6px
     slack already reserved above). Because the Jack is the same size and
     sits exactly on top, only each edge's own bottom-right sliver — never
     its top-left, where either corner index lives — ever paints. */
  .point-row__jack-edge {
    position: absolute;
    top: var(--jack-offset, 40px);
    left: 0;
    z-index: 0;
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    border-radius: 7%;
    background: var(--cu-paper, #faf8f4);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    pointer-events: none;
  }

  .point-row__jack-edge--2 {
    z-index: 0;
    transform: translate(4px, 4px);
  }

  .point-row__jack-edge--1 {
    z-index: 1;
    transform: translate(2px, 2px);
  }

  /* Jack placement, W18 revision (round-4, product owner direction
     2026-09-28 — supersedes the W17 per-count shrinking `--jack-shift`
     this replaces): the shown (top/newest) Jack is the SAME SIZE as the
     card it sits on (100% x 100% of the slot — no narrowing to `mini`),
     offset DOWNWARD ONLY (`left: 0`, no sideways `transform`) from the
     point card's own top, so the card's upper-left corner index (drawn by
     the theme — see VectorCardFace's base rule) stays visible above it, and
     the Jack's own corner index stays visible above the deck-thickness
     edges (z-index 2, above both `.point-row__jack-edge` layers).
     `--jack-offset` clears the theme's corner index block with margin and
     is the same value the row-growth calc above reserves room for — the
     two must move together. */
  .point-row__jack {
    position: absolute;
    top: var(--jack-offset, 40px);
    left: 0;
    z-index: 2;
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 -2px 6px rgb(0 0 0 / 30%), 0 1px 2px rgb(0 0 0 / 45%);
  }

  /* Card labels: the stolen stack's "Stole" pill, inside the top Jack's
     own clipped box, at its foot and centred. */
  .point-row__badge {
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

  .point-row__empty {
    padding-inline: 4px;
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
  }

  /* The tally chip keeps its own box at the row's right end; the cards
     scroll, the chip never does and never clips. */
  .point-row__tally {
    flex: none;
    align-self: flex-start;
    min-width: 14px;
    margin-top: 6px;
    padding: 2px 5px;
    border-radius: 999px;
    background: var(--cu-ink, #241c2b);
    font-variant-numeric: tabular-nums;
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 16px;
    text-align: center;
    color: var(--cu-pearl, #eee8f1);
  }

  /* W25 (desktop keyboard): a visible focus ring on every target, drawn
     inset so a clipping row or well can't hide it. */
  .point-row__card:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: -3px;
  }
</style>
