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
  //   - r16 (2026-09-29 playtest, friction 5): the bottom sheet covered the
  //     hand, and so the very card being played. It is now a panel over
  //     the centre strip (GameScreen passes it to Board's `centerOverlay`):
  //     the board never shrinks under it, and the hand, your own rows and
  //     the target on the other side all stay in view. Cancel sits beside
  //     the options, which keeps a two-option panel about the strip's
  //     height.

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
  /* r16 (playtest friction 5): a panel on the centre strip (GameScreen
     hands it to Board's `centerOverlay`), no longer a bottom sheet over the
     hand. The hand card it plays, the card it targets on the other side and
     your own rows all stay in view. Its height is its content: two
     two-line options fit about the strip's own ~104 px box at 393x852. */
  .ambiguity-chooser {
    display: flex;
    align-items: stretch;
    gap: var(--cu-space-2, 8px);
    box-sizing: border-box;
    width: 100%;
    padding: 4px var(--cu-space-2, 8px);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-well, 10px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 45%);
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
    padding: 4px var(--cu-space-2, 8px);
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
