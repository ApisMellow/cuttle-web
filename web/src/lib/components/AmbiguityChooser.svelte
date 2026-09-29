<script lang="ts">
  // SPEC §6.4 — the R11 ambiguity backstop: the candidate moves for the
  // chosen target, each tappable, plus Cancel. Selecting one goes straight
  // to staged — the chooser does not skip the confirm step. Presentational
  // only: the integrator reads `StagingStore.chooser` and calls
  // `choose(index)`/`cancel()` from the callback props — this component
  // never touches the store or the bridge.
  //
  // Amended 2026-09-28 (playtest friction, SPEC §6.4, design.md §6):
  //   - Each option is one plain line saying what it does ("Scuttle their
  //     4♣ with 9♣: both cards go to the scrap."), from `plainMoveText` in
  //     lib/recap.ts. The raw engine description never renders; this
  //     component builds no card text itself.
  //   - The sheet overlays the bottom of the screen (the hand and the
  //     action bar) instead of taking a slot in GameScreen's column, so the
  //     board never shrinks under it and the player's own Permanents row,
  //     just above the hand, stays in view. Cancel sits beside the options,
  //     which keeps a two-option sheet inside the hand + action-bar band.

  import { plainMoveText } from '../recap';
  import type { ChooserCandidate } from '../stores/staging.svelte';

  interface AmbiguityChooserProps {
    /** `StagingStore.chooser.candidates` (SPEC §6.4). */
    candidates: ChooserCandidate[];
    onchoose?: (index: number) => void;
    oncancel?: () => void;
    /**
     * The option's text. Default: `plainMoveText(description)`. GameScreen
     * passes one that also knows which way a 9 sends its target (review B2).
     */
    describe?: (candidate: ChooserCandidate) => string;
  }

  let {
    candidates,
    onchoose,
    oncancel,
    describe = (candidate: ChooserCandidate) => plainMoveText(candidate.description),
  }: AmbiguityChooserProps = $props();
</script>

<div class="ambiguity-chooser" data-testid="ambiguity-chooser" role="dialog" aria-modal="true" aria-label="Choose a move">
  <ul class="ambiguity-chooser__list">
    {#each candidates as candidate (candidate.index)}
      <li>
        <button
          type="button"
          class="ambiguity-chooser__option"
          data-testid={`ambiguity-chooser-option-${candidate.index}`}
          onclick={() => onchoose?.(candidate.index)}
        >
          {describe(candidate)}
        </button>
      </li>
    {/each}
  </ul>
  <button
    type="button"
    class="ambiguity-chooser__cancel"
    data-testid="ambiguity-chooser-cancel"
    onclick={() => oncancel?.()}
  >
    Cancel
  </button>
</div>

<style>
  /* A bottom sheet over the hand and the action bar, capped to the board
     column (design.md §6 "Tablet and desktop"). Its height is its content;
     two options fit inside the ~140 px hand + action-bar band at 393x852. */
  .ambiguity-chooser {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    align-items: stretch;
    gap: var(--cu-space-2, 8px);
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    padding: var(--cu-space-2, 8px) var(--cu-gutter-board, 10px) calc(var(--cu-space-2, 8px) + var(--cu-safe-bottom, 0px));
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-top: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px) 0 0;
    box-shadow: 0 -6px 18px rgb(0 0 0 / 35%);
  }

  .ambiguity-chooser__list {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ambiguity-chooser__option,
  .ambiguity-chooser__cancel {
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    color: var(--cu-pearl, #eee8f1);
    font-family: inherit;
    cursor: pointer;
  }

  .ambiguity-chooser__option {
    width: 100%;
    padding: 5px var(--cu-space-3, 12px);
    border-color: var(--cu-iris, #5ccfc4);
    border-radius: 14px;
    background: transparent;
    font-size: var(--cu-text-sm, 14px);
    line-height: 1.3;
    text-align: left;
  }

  .ambiguity-chooser__cancel {
    flex: none;
    align-self: center;
    min-width: 72px;
    padding: 0 var(--cu-space-3, 12px);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    font-size: var(--cu-text-md, 16px);
  }
</style>
