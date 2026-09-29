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
  aria-label={`Deck, ${count} ${count === 1 ? 'card' : 'cards'}`}
  onclick={ontap}
>
  <span class="deck-pile__card"><theme.Back size="hand" /></span>
  <span class="deck-pile__count">{count}</span>
</button>

<style>
  .deck-pile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0 0 6px;
    border: none;
    background: none;
    cursor: pointer;
  }

  .deck-pile__card {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    border-radius: 7%;
    overflow: hidden;
    /* Two offset edges read as a pile, not a single card. */
    box-shadow:
      2px 2px 0 -1px var(--cu-back-a, #3b2f4a),
      2px 2px 0 0 rgb(0 0 0 / 0.35),
      4px 4px 0 -1px var(--cu-back-a, #3b2f4a),
      4px 4px 0 0 rgb(0 0 0 / 0.35);
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

  /* W22: the count is a tab on the pile's bottom edge (design.md §6 keeps
     it centred beneath the card; it now overlaps that edge by half). */
  .deck-pile__count {
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    min-width: 16px;
    padding: 1px 6px;
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ink, #241c2b);
    font-size: var(--cu-text-xs, 12px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 14px;
    color: var(--cu-pearl, #eee8f1);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  /* W25 (desktop keyboard): a visible focus ring on every target, drawn
     inset so a clipping row or well can't hide it. */
  .deck-pile:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: -3px;
  }
</style>
