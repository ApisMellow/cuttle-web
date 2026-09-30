<script lang="ts">
  // Two-phone play, host side, step 1: your name, then a room.
  import { onMount } from 'svelte';

  import { ERROR_TEXT, type OnlineActions, type OnlineErrorCode } from '../online/actions';
  import { settings } from '../stores/settings.svelte';

  interface Props {
    actions: OnlineActions;
    onCreated: (code: string) => void;
    onBack: () => void;
  }
  let { actions, onCreated, onBack }: Props = $props();

  const remembered = settings.lastNames?.[0] ?? '';
  let name = $state(remembered === 'Player 1' ? '' : remembered);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let nameInput: HTMLInputElement | undefined;

  onMount(() => nameInput?.focus());

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      error = 'Enter your name first.';
      return;
    }
    busy = true;
    error = null;
    const result = await actions.createRoom(trimmed);
    busy = false;
    if (result.ok) onCreated(result.value.code);
    else error = ERROR_TEXT[result.error as OnlineErrorCode];
  }
</script>

<form class="ol-screen" data-testid="create-screen" onsubmit={submit}>
  <h1>Play on two phones</h1>
  <p class="ol-muted">You start a room and share its code. Your friend joins from their own phone.</p>

  <label class="ol-field">
    <span>Your name</span>
    <input
      data-testid="online-name-input"
      type="text"
      maxlength="20"
      autocomplete="off"
      placeholder="Alice"
      bind:this={nameInput}
      bind:value={name}
    />
  </label>

  {#if error}
    <p class="ol-error" role="alert" data-testid="online-error">{error}</p>
  {/if}

  <div class="ol-actions">
    <button type="submit" class="ol-button ol-button--primary" data-testid="create-room" disabled={busy}>
      {busy ? 'Creating…' : 'Create room'}
    </button>
    <button type="button" class="ol-button" data-testid="online-back" onclick={onBack}>Back</button>
  </div>
</form>
