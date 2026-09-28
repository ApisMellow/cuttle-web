<script lang="ts">
  // SPEC §6.4 — the R11 ambiguity backstop: "a modal list of the candidate
  // descriptions[i] strings (engine-authored, §2.7), each tappable, plus
  // Cancel. Selecting one goes straight to staged — the chooser does not
  // skip the confirm step." Presentational only: the integrator reads
  // `StagingStore.chooser` and calls `choose(index)`/`cancel()` from the
  // callback props — this component never touches the store or the bridge.

  import type { ChooserCandidate } from '../stores/staging.svelte';

  interface AmbiguityChooserProps {
    /** `StagingStore.chooser.candidates` (SPEC §6.4). */
    candidates: ChooserCandidate[];
    onchoose?: (index: number) => void;
    oncancel?: () => void;
  }

  let { candidates, onchoose, oncancel }: AmbiguityChooserProps = $props();
</script>

<!-- design.md §11 lists this under the bottom-sheet family
     (`--cu-radius-sheet`, `--cu-tap-min`); §8's dismiss-pill position isn't
     specified for this sheet, so Cancel sits at the bottom, matching the
     Recap panel's "See the board" placement it borrows the sheet chrome
     from. -->
<div class="ambiguity-chooser" data-testid="ambiguity-chooser" role="dialog" aria-modal="true">
  <ul class="ambiguity-chooser__list">
    {#each candidates as candidate (candidate.index)}
      <li>
        <button
          type="button"
          class="ambiguity-chooser__option"
          data-testid={`ambiguity-chooser-option-${candidate.index}`}
          onclick={() => onchoose?.(candidate.index)}
        >
          {candidate.description}
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
  .ambiguity-chooser {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-2, 8px);
    padding: var(--cu-gutter-sheet, 16px);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-radius: var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px) 0 0;
  }

  .ambiguity-chooser__list {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-2, 8px);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ambiguity-chooser__option,
  .ambiguity-chooser__cancel {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min, 44px);
    padding: var(--cu-space-2, 8px) var(--cu-space-3, 12px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    text-align: left;
    cursor: pointer;
  }

  .ambiguity-chooser__cancel {
    text-align: center;
  }
</style>
