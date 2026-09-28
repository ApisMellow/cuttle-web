<script lang="ts">
  // SPEC §5.2, §5.6, §3 (redaction) — the owning player's own hand.
  // Presentational only: props in, `onselect` out, no store or bridge
  // import, no legal-move derivation (that is `lib/affordances.ts`'s job,
  // wired in by a later, app-level round).
  //
  // Redaction (carry-over 8): this component renders exactly the `cards`
  // it is given and nothing else. There is no prop, no fallback, and no
  // code path here that can source or display an opponent's hand — the
  // type below has no such field. A component that needs to show hidden
  // cards renders `<CardBack>` from `lib/theme`, which this component
  // never imports, because it never needs to: `you.hand` (SPEC §2.7) is
  // never redacted from its own owner.
  //
  // P2 W9 (Board props contract): `highlighted` and `staged` are the
  // round-4 integrator's target-key sets, checked here against this
  // component's own `hand:<index>` key format — the same format the Board
  // brief fixes for every other target. `dimmedHandIndices` is index-based,
  // matching the Board brief's `dimmedHand: ReadonlySet<number>` directly.
  import type { Card } from '../bridge/schema';
  import type { CardTheme } from '../theme/types';
  import HandCard from './HandCard.svelte';

  interface PlayerHandProps {
    cards: Card[];
    frozenHandIndices: number[];
    selectedHandIndex: number | null;
    /** Legal-target keys, e.g. `hand:2`. Optional so callers pre-dating this round need no change. */
    highlighted?: ReadonlySet<string>;
    /** Staged-target keys, e.g. `hand:2`. */
    staged?: ReadonlySet<string>;
    /** Hand indices to render dimmed; dimmed cards stay tappable (Board brief). */
    dimmedHandIndices?: ReadonlySet<number>;
    onselect: (handIndex: number) => void;
    /** Injectable for testing / future theme wiring; HandCard supplies the default. */
    theme?: CardTheme;
  }

  let {
    cards,
    frozenHandIndices,
    selectedHandIndex,
    highlighted = new Set<string>(),
    staged = new Set<string>(),
    dimmedHandIndices = new Set<number>(),
    onselect,
    theme,
  }: PlayerHandProps = $props();
</script>

<!-- design §6 fan: `--hand-count` feeds the overlap calc below. -->
<div class="player-hand" data-testid="player-hand" style={`--hand-count: ${cards.length}`}>
  {#each cards as card, handIndex (handIndex)}
    <span class="player-hand__slot">
    <HandCard
      {card}
      {handIndex}
      {frozenHandIndices}
      selected={selectedHandIndex === handIndex}
      highlighted={highlighted.has(`hand:${handIndex}`)}
      staged={staged.has(`hand:${handIndex}`)}
      dimmed={dimmedHandIndices.has(handIndex)}
      {onselect}
      {theme}
    />
    </span>
  {/each}
</div>

<style>
  /* docs/design.md §6 "Your hand": 56-wide faces, 4 px gaps, centred. When
     the row can't fit, the cards fan with equal overlap so the whole hand
     spans the row; the visible slice of each card never drops below 44 px.
     If the slice would, the overlap stops at 44 px and flex-wrap takes the
     rest onto a second row. W22: 8 cards hold one row at 393 (60px cards,
     44.6px slices in a 373px row) and at 430 (66px, ~47.8px slices).

     The slot margin is  max(44px - w, min(4px, (100cqi - w - 1px) / (n - 1) - w)):
     `100cqi` is this container's content width, `w` the hand card width,
     `n` the card count. The 1 px guards against subpixel rounding tipping a
     just-fitting row into a wrap. */
  .player-hand {
    container-type: inline-size;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 4px;
  }

  .player-hand__slot {
    display: flex;
    flex: none;
  }

  .player-hand__slot + .player-hand__slot {
    margin-left: max(
      calc(44px - var(--cuttle-card-width-hand)),
      min(
        4px,
        calc(
          (100cqi - var(--cuttle-card-width-hand) - 1px) / (var(--hand-count) - 1) -
            var(--cuttle-card-width-hand)
        )
      )
    );
  }
</style>
