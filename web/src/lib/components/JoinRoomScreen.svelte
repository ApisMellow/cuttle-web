<script lang="ts">
  // Two-phone play, guest side: a code (prefilled from a link, or typed) and a name.
  import { onMount, untrack } from 'svelte';

  import { ERROR_TEXT, type OnlineActions } from '../online/actions';
  import { CODE_LENGTH, isValidCode, normalizeCode } from '../online/code';
  import { settings } from '../stores/settings.svelte';

  interface Props {
    actions: OnlineActions;
    /** Normalized code from a link, or ''. */
    initialCode?: string;
    /** The link had no usable code. */
    badLink?: boolean;
    onJoined: (opponentName: string) => void;
    onBack: () => void;
  }
  let { actions, initialCode = '', badLink = false, onJoined, onBack }: Props = $props();

  const remembered = settings.lastNames?.[0] ?? '';
  let code = $state(untrack(() => initialCode));
  let name = $state(remembered === 'Player 1' ? '' : remembered);
  let busy = $state(false);
  let error = $state<string | null>(
    untrack(() => badLink) ? 'That link doesn’t look right. Type the 4-character code instead.' : null,
  );
  let codeInput: HTMLInputElement | undefined;
  let nameInput: HTMLInputElement | undefined;

  // A link arrives with the code filled in, so start on the name.
  onMount(() => (untrack(() => initialCode) ? nameInput : codeInput)?.focus());

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const normalized = normalizeCode(code);
    if (!isValidCode(normalized)) {
      error = `The code is ${CODE_LENGTH} letters and numbers. Check it and try again.`;
      return;
    }
    const trimmed = name.trim();
    if (trimmed === '') {
      error = 'Enter your name first.';
      return;
    }
    code = normalized;
    busy = true;
    error = null;
    const result = await actions.joinRoom(normalized, trimmed);
    busy = false;
    if (result.ok) onJoined(result.value.opponentName);
    else error = ERROR_TEXT[result.error];
  }
</script>

<form class="ol-screen" data-testid="join-screen" onsubmit={submit}>
  <h1>Join a game</h1>
  <p class="ol-muted">Enter the code your friend sent, or open their link.</p>

  <label class="ol-field">
    <span>Room code</span>
    <input
      class="ol-code-input"
      data-testid="join-code-input"
      type="text"
      maxlength="8"
      autocomplete="off"
      autocapitalize="characters"
      autocorrect="off"
      spellcheck="false"
      placeholder="K7QX"
      bind:this={codeInput}
      bind:value={code}
    />
  </label>

  <label class="ol-field">
    <span>Your name</span>
    <input
      data-testid="online-name-input"
      type="text"
      maxlength="20"
      autocomplete="off"
      placeholder="Blake"
      bind:this={nameInput}
      bind:value={name}
    />
  </label>

  {#if error}
    <p class="ol-error" role="alert" data-testid="online-error">{error}</p>
  {/if}

  <div class="ol-actions">
    <button type="submit" class="ol-button ol-button--primary" data-testid="join-room" disabled={busy}>
      {busy ? 'Joining…' : 'Join'}
    </button>
    <button type="button" class="ol-button" data-testid="online-back" onclick={onBack}>Back</button>
  </div>
</form>
