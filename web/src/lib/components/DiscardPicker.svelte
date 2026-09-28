<script lang="ts">
  // SPEC §5.2, §6.3 DiscardPair row (R15) — the discard prompt. The cards
  // themselves are picked on the viewer's own hand, on the real board: the
  // StagingStore lights every hand card as pickable, marks a chosen one
  // staged, and stages the DiscardPair the engine offered for the chosen
  // pair (or pre-stages the one-card hand's {0,-1} move, R15.2). This strip
  // sits in the reserved action bar (design.md §6) until the pair is staged,
  // when the StagingBar takes the slot with "Discard 4♦ and 5♠" + Confirm.
  //
  // Presentational only: no store import, no rule. `need` comes from the
  // engine's move shapes, never from a hand-size rule of its own.

  interface DiscardPickerProps {
    /** 2, or 1 for a one-card hand (DiscardB === -1). */
    need: 1 | 2;
    /** How many cards are chosen so far. */
    picked: number;
  }

  let { need, picked }: DiscardPickerProps = $props();
</script>

<div class="discard-picker" data-testid="discard-picker" role="status">
  <p class="discard-picker__prompt">{need === 2 ? 'Choose 2 cards to discard' : 'Tap your card to discard it'}</p>
  <p class="discard-picker__count">{picked} of {need}</p>
</div>

<style>
  .discard-picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cu-space-3, 12px);
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-gutter-board, 10px) 0 var(--cu-space-4, 16px);
  }

  .discard-picker__prompt {
    margin: 0;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
  }

  .discard-picker__count {
    margin: 0;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-sm, 14px);
    font-variant-numeric: tabular-nums;
  }
</style>
