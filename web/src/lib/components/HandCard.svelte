<script lang="ts">
  // SPEC §5.2, §5.6, §8 OQ-13 — a single card in the owning player's hand.
  // Presentational only: no store import, no legal-move logic. Renders
  // strictly through the active theme's <Face> (SPEC §5.6 rule 1); this
  // component never draws a rank or suit glyph.
  //
  // SPEC §5.6 rule 2: HandCard is the CONTAINER, so it owns the card box —
  // width and aspect ratio come from the app-owned geometry tokens, and the
  // box clips, so whatever a theme's Face paints cannot resize or reflow
  // the hand. The Face fills this box.
  //
  // R8.2 / carry-over 4: frozen state is driven SOLELY by membership of
  // `handIndex` in `frozenHandIndices` — no other prop, no condition, no
  // remembered state participates. This also covers OQ-13 (a card that
  // freezes and clears before the owner's next turn): the marker tracks
  // whatever `frozenHandIndices` says on every render.
  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme, CardVisualState } from '../theme/types';

  interface HandCardProps {
    card: Card;
    handIndex: number;
    frozenHandIndices: number[];
    /** Whether this card is the one currently selected in the R9 pipeline. */
    selected?: boolean;
    onselect?: (handIndex: number) => void;
    /** Injectable for testing / future theme wiring; defaults to the app default (rule 4). */
    theme?: CardTheme;
  }

  let {
    card,
    handIndex,
    frozenHandIndices,
    selected = false,
    onselect,
    theme = getTheme(DEFAULT_THEME_ID),
  }: HandCardProps = $props();

  // R8.2: solely a membership check. Nothing else feeds this value.
  const isFrozen = $derived(frozenHandIndices.includes(handIndex));

  // Assumption (reported): frozen takes precedence over selection in the
  // single `state` slot CardFaceProps has. R9 dimmed/staged precedence is a
  // later round's call.
  const visualState: CardVisualState = $derived(isFrozen ? 'frozen' : selected ? 'highlighted' : 'normal');

  function handleClick(): void {
    onselect?.(handIndex);
  }
</script>

<!-- The button is the only [data-testid] element: SPEC §5.9/§7.4 sweep every
     testid for a 44px box, and `hand-card-` is the per-card prefix. Frozen
     state is exposed as `data-frozen` on the button itself. -->
<button
  type="button"
  class="hand-card"
  data-testid={`hand-card-${handIndex}`}
  data-frozen={isFrozen ? 'true' : 'false'}
  aria-pressed={selected}
  onclick={handleClick}
>
  <theme.Face {card} size="hand" state={visualState} />
  {#if isFrozen}
    <span class="hand-card__frozen-marker" data-frozen-marker>
      <span aria-hidden="true">❄</span>
      <span class="hand-card__sr-only">frozen</span>
    </span>
  {/if}
</button>

<style>
  /* SPEC §5.6 rule 2: the app-owned box. At 2.5:3.5 the hand width token
     (56px) gives a 78.4px height, clearing the SPEC §5.9 44px floor on both
     axes; the min-* guards keep the tap target if the token ever shrinks. */
  .hand-card {
    position: relative;
    display: inline-block;
    flex: none;
    box-sizing: border-box;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    min-width: 44px;
    min-height: 44px;
    overflow: hidden;
    padding: 0;
    border: none;
    border-radius: 6%;
    background: none;
    cursor: pointer;
  }

  /* SPEC §5.2 FrozenBadge (R8): visible to the owner, drawn by the app over
     the theme's own `frozen` state styling, inside the clipped box. */
  .hand-card__frozen-marker {
    position: absolute;
    top: 2px;
    right: 3px;
    font-size: 0.8rem;
    line-height: 1;
    color: #3b6ea8;
    pointer-events: none;
  }

  .hand-card__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
