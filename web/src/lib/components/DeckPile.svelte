<script lang="ts">
  // P2 W9 (Board props contract, docs/design.md §6) — the deck. Tap = R10
  // MoveDraw, wired by a later round; here it just reports `deck`.
  //
  // "Shows the count only": no card identity ever renders for the deck — a
  // `CardBack` carries none by construction (VectorCardBack has no `card`
  // prop), so this component has no redaction to get wrong here.
  //
  // Disabled state (revise 1 ruling): `enabled` is the integrator's "Draw
  // is legal" signal, passed straight through from Board's `deckEnabled`.
  // This component does no rule logic and never re-derives the 8-card or
  // empty-deck rule. Disabled is styling only (`data-disabled`,
  // `aria-disabled`); the button keeps its element and testid and still
  // calls `ontap` (playbook "dim or disable, keep the element and testid").
  // Only Board's `inert` blocks a tap. The iris ring is separate: it shows
  // only when staging highlights the `deck` key.
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface DeckPileProps {
    count: number;
    /** Whether Draw is legal right now (the integrator's call, from the move list). */
    enabled: boolean;
    highlighted: boolean;
    staged: boolean;
    ontap: () => void;
    theme?: CardTheme;
  }

  let { count, enabled, highlighted, staged, ontap, theme = getTheme(DEFAULT_THEME_ID) }: DeckPileProps = $props();

  const state = $derived(staged ? 'staged' : highlighted ? 'highlighted' : 'normal');
  const disabled = $derived(!enabled);
</script>

<button
  type="button"
  class="deck-pile"
  data-testid="deck-pile"
  data-state={state}
  data-disabled={disabled ? 'true' : 'false'}
  aria-disabled={disabled ? 'true' : 'false'}
  onclick={ontap}
>
  <span class="deck-pile__card"><theme.Back size="hand" /></span>
  <span class="deck-pile__count">{count}</span>
</button>

<style>
  .deck-pile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .deck-pile__card {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    border-radius: 8%;
    overflow: hidden;
  }

  .deck-pile[data-state='highlighted'] .deck-pile__card {
    outline: 3px solid var(--cu-iris, #5ccfc4);
    outline-offset: -3px;
  }

  .deck-pile[data-state='staged'] .deck-pile__card {
    outline: 3px solid var(--cu-ochre, #f0b54a);
    outline-offset: -3px;
  }

  .deck-pile[data-disabled='true'] {
    opacity: 0.55;
  }

  .deck-pile__count {
    font-size: var(--cu-text-sm, 14px);
    line-height: 14px;
    color: var(--cu-muted, #b4a8be);
    font-variant-numeric: tabular-nums;
  }
</style>
