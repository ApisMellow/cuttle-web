<script lang="ts">
  // SPEC §5.5 (R17), amended 2026-09-28: the home screen's Rules button and
  // the cheat-sheet it opens. Self-contained so the home screen mounts it
  // with one line. Its look matches HomeScreen's own action buttons.
  import RulesSheet from './RulesSheet.svelte';

  let open = $state(false);
</script>

<button type="button" class="rules-button" data-testid="home-rules" onclick={() => (open = true)}>Rules</button>

{#if open}
  <RulesSheet onclose={() => (open = false)} />
{/if}

<style>
  .rules-button {
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    min-width: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-4, 16px);
    border-radius: var(--cu-radius-control, 999px);
    border: none;
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }
</style>
