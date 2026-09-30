<script lang="ts">
  // Two-phone play, host side, step 2: the code, and a way to send it.
  import { onMount } from 'svelte';

  import type { OnlineActions } from '../online/actions';
  import { joinLink } from '../online/code';
  import { browserShareEnv, copyLink, shareInvite, type ShareEnv } from '../online/share';

  interface Props {
    actions: OnlineActions;
    code: string;
    onJoined: (opponentName: string) => void;
    onCancel: () => void;
    /** Overridable for tests. */
    shareEnv?: ShareEnv;
    /** Page URL the invite link is built on. */
    base?: string;
  }
  let {
    actions,
    code,
    onJoined,
    onCancel,
    shareEnv = browserShareEnv(),
    base = `${location.origin}${location.pathname}`,
  }: Props = $props();

  const link = $derived(joinLink(code, base));
  let status = $state('');

  onMount(() =>
    actions.onRoomEvent((event) => {
      if (event.kind === 'opponent-joined') onJoined(event.opponentName);
    }),
  );

  async function share(): Promise<void> {
    const outcome = await shareInvite(link, shareEnv);
    status =
      outcome === 'copied'
        ? 'Link copied. Paste it into a message.'
        : outcome === 'failed'
          ? 'Couldn’t share. Tell your friend the code instead.'
          : '';
  }

  async function copy(): Promise<void> {
    status = (await copyLink(link, shareEnv))
      ? 'Link copied. Paste it into a message.'
      : 'Couldn’t copy. Tell your friend the code instead.';
  }

  async function cancel(): Promise<void> {
    await actions.cancelRoom();
    onCancel();
  }
</script>

<div class="ol-screen" data-testid="waiting-screen">
  <h1>Your room is ready</h1>
  <p>Send your friend the code or the link.</p>

  <p class="ol-code" data-testid="room-code" role="img" aria-label={`Room code ${code.split('').join(' ')}`}>
    {code}
  </p>

  <p class="ol-muted" role="status" data-testid="waiting-status">Waiting for someone to join…</p>

  <div class="ol-actions">
    <button type="button" class="ol-button ol-button--primary" data-testid="share-invite" onclick={share}>
      Share
    </button>
    <button type="button" class="ol-button" data-testid="copy-link" onclick={copy}>Copy link</button>
    <button type="button" class="ol-button" data-testid="cancel-room" onclick={cancel}>Cancel</button>
  </div>

  <p class="ol-muted" role="status" data-testid="share-status">{status}</p>
  <p class="ol-link" data-testid="invite-link">{link}</p>
</div>
