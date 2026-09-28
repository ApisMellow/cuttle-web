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
  //
  // P2 W9 (docs/design.md §7): `staged` and `dimmed` are now explicit
  // booleans, resolved by the caller (Board/PlayerHand) from the round-4
  // integrator's target-key sets — this component does no set membership
  // logic of its own beyond `frozenHandIndices`. Precedence in the single
  // `state` slot is frozen > staged > highlighted > dimmed > normal
  // (docs/design.md §7); `selected` (the round-2 R9 pipeline flag) maps to
  // `highlighted`, same as an explicit `highlighted` prop — both mean "the
  // ring belongs on this card" and neither outranks the other.
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
    /** SPEC §5.6 rule 3 / docs/design.md §7: a legal-target ring, same visual as `selected`. */
    highlighted?: boolean;
    /** docs/design.md §7: the ochre ring + ✓ tab. */
    staged?: boolean;
    /** docs/design.md §7: luminance drop; still tappable to inspect (Board brief). */
    dimmed?: boolean;
    onselect?: (handIndex: number) => void;
    /** Injectable for testing / future theme wiring; defaults to the app default (rule 4). */
    theme?: CardTheme;
  }

  let {
    card,
    handIndex,
    frozenHandIndices,
    selected = false,
    highlighted = false,
    staged = false,
    dimmed = false,
    onselect,
    theme = getTheme(DEFAULT_THEME_ID),
  }: HandCardProps = $props();

  // R8.2: solely a membership check. Nothing else feeds this value.
  const isFrozen = $derived(frozenHandIndices.includes(handIndex));

  // docs/design.md §7 precedence: frozen > staged > highlighted > dimmed >
  // normal. `selected` and `highlighted` are two names for the same ring;
  // either being true is enough.
  const visualState: CardVisualState = $derived(
    isFrozen
      ? 'frozen'
      : staged
        ? 'staged'
        : selected || highlighted
          ? 'highlighted'
          : dimmed
            ? 'dimmed'
            : 'normal',
  );

  function handleClick(): void {
    onselect?.(handIndex);
  }
</script>

<!-- The button is the only [data-testid] element: SPEC §5.9/§7.4 sweep every
     testid for a 44px box, and `hand-card-` is the per-card prefix. Frozen,
     staged and dimmed state are each exposed as their own `data-*` attribute
     on the button itself, independent of the single theme `state` slot, so a
     test can assert each guarantee without inferring it from `data-state`. -->
<button
  type="button"
  class="hand-card"
  data-testid={`hand-card-${handIndex}`}
  data-frozen={isFrozen ? 'true' : 'false'}
  data-staged={staged ? 'true' : 'false'}
  data-dimmed={dimmed ? 'true' : 'false'}
  aria-pressed={selected}
  onclick={handleClick}
>
  <theme.Face {card} size="hand" state={visualState} />
  {#if isFrozen}
    <span class="hand-card__frozen-marker" data-frozen-marker>
      <span aria-hidden="true">❄</span>
      <span class="hand-card__sr-only">frozen</span>
    </span>
  {:else if staged}
    <span class="hand-card__staged-tab" data-staged-tab>
      <span aria-hidden="true">✓</span>
      <span class="hand-card__sr-only">staged</span>
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

  /* docs/design.md §7 staged recipe: "a small ochre tab at the top centre
     with a ✓", drawn by the app over the theme's `staged` ring, inside the
     clipped box — same pattern as the frozen marker above. */
  .hand-card__staged-tab {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translate(-50%, -35%);
    font-size: 0.7rem;
    line-height: 1;
    color: var(--cu-on-accent, #241c2b);
    background: var(--cu-ochre, #f0b54a);
    border-radius: 50%;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
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
