<script lang="ts">
  // SPEC §6.1, §6.3 — the action bar's staged state: the engine-authored
  // description shown verbatim, plus Confirm and Cancel (design.md §6
  // "Action bar"). Presentational only: no store import, no move logic —
  // the integrator reads `StagingStore.stagedDescription`/`inert` and calls
  // `confirm()`/`cancel()` from the callback props.
  //
  // R12 — this component never calls `apply` itself; it only forwards taps
  // to whatever the integrator wired to `onconfirm`/`oncancel`. Disabled
  // while `disabled` is true (SPEC §6.1: "the whole board is inert" during
  // `applying" — the integrator passes `staging.inert` through here so a
  // second tap on Confirm during that window never fires `onconfirm`).

  interface StagingBarProps {
    /** `StagingStore.stagedDescription`, shown verbatim (SPEC §6.1). */
    description: string;
    /** `StagingStore.inert` — true while `applying` (SPEC §6.1). */
    disabled?: boolean;
    onconfirm?: () => void;
    oncancel?: () => void;
  }

  let { description, disabled = false, onconfirm, oncancel }: StagingBarProps = $props();
</script>

<div class="staging-bar" data-testid="staging-bar">
  <p class="staging-bar__description">{description}</p>
  <div class="staging-bar__actions">
    <button
      type="button"
      class="staging-bar__button staging-bar__button--cancel"
      data-testid="staging-cancel"
      {disabled}
      onclick={() => oncancel?.()}
    >
      Cancel
    </button>
    <button
      type="button"
      class="staging-bar__button staging-bar__button--confirm"
      data-testid="staging-confirm"
      {disabled}
      onclick={() => onconfirm?.()}
    >
      Confirm
    </button>
  </div>
</div>

<style>
  /* design.md §6 "Action bar": always reserved, description on the left,
     Cancel (ghost pill) + Confirm (ochre pill) on the right, both >= 44px
     tall (SPEC §5.9 / design.md §10.2). Token names follow design.md §11's
     component-to-token map; a fallback keeps this correct before
     tokens.css exists (out of this round's scope — App shell/theme). */
  .staging-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cu-space-3, 12px);
    min-height: 44px;
    padding: var(--cu-space-2, 8px) var(--cu-gutter-board, 12px);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
  }

  .staging-bar__description {
    margin: 0;
    font-size: var(--cu-text-md, 16px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staging-bar__actions {
    display: flex;
    flex: none;
    gap: var(--cu-space-2, 8px);
  }

  .staging-bar__button {
    box-sizing: border-box;
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--cu-space-4, 16px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  .staging-bar__button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .staging-bar__button--cancel {
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    border: 1px solid var(--cu-ink-line, #4a3d57);
  }

  .staging-bar__button--confirm {
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
  }
</style>
