<script lang="ts">
  // Two-phone play: routes between Create, Waiting, Join and Connected.
  // Mounted by App while `online.view` is not 'none' and no game is showing.
  import { getOnlineActions } from '../online/provider';
  import type { OnlineActions } from '../online/actions';
  import { online } from '../stores/online.svelte';
  import CreateRoomScreen from './CreateRoomScreen.svelte';
  import JoinRoomScreen from './JoinRoomScreen.svelte';
  import WaitingScreen from './WaitingScreen.svelte';

  interface Props {
    actions?: OnlineActions;
  }
  let { actions = getOnlineActions() }: Props = $props();
</script>

{#if online.view === 'create'}
  <CreateRoomScreen {actions} onCreated={(code) => online.waiting(code)} onBack={() => online.close()} />
{:else if online.view === 'waiting'}
  <WaitingScreen
    {actions}
    code={online.roomCode}
    onJoined={(name) => online.connected(name)}
    onCancel={() => online.close()}
  />
{:else if online.view === 'join'}
  <JoinRoomScreen
    {actions}
    initialCode={online.joinCode}
    badLink={online.badLink}
    onJoined={(name) => online.connected(name)}
    onBack={() => online.close()}
  />
{:else if online.view === 'connected'}
  <!-- W12: with the real actions the online store is attached by now, and
       App shows the table (GameScreen on `onlineGame`) instead of this flow.
       This placeholder is what the dev build's fake actions reach. -->
  <div class="ol-screen" data-testid="online-connected">
    <h1>Connected</h1>
    <p>You’re in a room with {online.opponentName}.</p>
    <button type="button" class="ol-button" data-testid="online-back" onclick={() => online.close()}>
      Back
    </button>
  </div>
{/if}
