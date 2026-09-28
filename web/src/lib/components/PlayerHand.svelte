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
  import type { Card } from '../bridge/schema';
  import type { CardTheme } from '../theme/types';
  import HandCard from './HandCard.svelte';

  interface PlayerHandProps {
    cards: Card[];
    frozenHandIndices: number[];
    selectedHandIndex: number | null;
    onselect: (handIndex: number) => void;
    /** Injectable for testing / future theme wiring; HandCard supplies the default. */
    theme?: CardTheme;
  }

  let { cards, frozenHandIndices, selectedHandIndex, onselect, theme }: PlayerHandProps = $props();
</script>

<div class="player-hand" data-testid="player-hand">
  {#each cards as card, handIndex (handIndex)}
    <HandCard
      {card}
      {handIndex}
      {frozenHandIndices}
      selected={selectedHandIndex === handIndex}
      {onselect}
      {theme}
    />
  {/each}
</div>

<style>
  .player-hand {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
