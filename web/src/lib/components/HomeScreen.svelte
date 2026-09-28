<script lang="ts">
  // SPEC §5.2 HomeScreen — R1: names, New game, Resume (if snapshot), Rules.
  //
  // This component calls only public store methods (`session.setNames`,
  // `game.newGame`, `game.restore`) and reads the store's own `notice`
  // field (R4.4). It never reads inside `Snapshot.engineState` and never
  // calls the bridge directly (SPEC §5.3, §5.7).
  //
  // Peeking at a snapshot's presence/validity without starting a resume
  // uses `decodeSnapshot` — a pure function already exported by
  // `lib/stores/snapshot.ts` for exactly this kind of structural check
  // (SPEC §5.7). When the peek finds an INVALID snapshot (version mismatch
  // or malformed), calling `game.restore()` is safe here even before the
  // engine has necessarily been touched: `GameStore.restore()`'s decode-
  // failure branch returns after `#discardSnapshot(...)` without ever
  // calling the bridge (see game.svelte.ts `restore()` — the
  // `this.#engine.restore(...)` call sits strictly after the `decoded.ok`
  // check). That is what turns the store-level R4.4 discard-and-notice
  // behaviour into something this screen can surface without accidentally
  // triggering a real resume for a VALID snapshot (which must wait for an
  // explicit tap on Resume, per this round's brief).
  import { game } from '../stores/game.svelte';
  import { session } from '../stores/session.svelte';
  import { SNAPSHOT_KEY, decodeSnapshot } from '../stores/snapshot';

  let name0 = $state('');
  let name1 = $state('');
  let hasSnapshot = $state(false);
  /** The snapshot rests at 'result': a finished game, still resumable (to see the result), but not "in progress" for R4.3. */
  let snapshotFinished = $state(false);
  let existingNames = $state<[string, string] | null>(null);
  let showAbandonConfirm = $state(false);

  function readRawSnapshot(): string | null {
    try {
      return localStorage.getItem(SNAPSHOT_KEY);
    } catch {
      return null;
    }
  }

  function peekSnapshot(): void {
    const decoded = decodeSnapshot(readRawSnapshot());
    if (decoded.ok) {
      hasSnapshot = true;
      snapshotFinished = decoded.snapshot.curtain.kind === 'result';
      existingNames = decoded.snapshot.names;
      return;
    }
    hasSnapshot = false;
    snapshotFinished = false;
    existingNames = null;
    if (decoded.reason !== 'empty') {
      // See the module doc: this branch never reaches the bridge.
      void game.restore();
    }
  }

  // Runs once, at component creation — HomeScreen only mounts while
  // `game.screen === 'home'` (SPEC §5.2's App.svelte route switch), so a
  // fresh instance means a fresh boot or a return to the home screen.
  peekSnapshot();

  function startNewGame(): void {
    session.setNames(name0, name1);
    void game.newGame();
  }

  // R4.3 asks for a confirm before abandoning "an in-progress game" only. A
  // snapshot resting at 'result' is a finished game, so New game starts
  // immediately (orchestrator ruling, round 3 W12 revise 1); the new game's
  // own snapshot overwrites it.
  function handleNewGameClick(): void {
    if (hasSnapshot && !snapshotFinished) {
      showAbandonConfirm = true;
      return;
    }
    startNewGame();
  }

  function confirmAbandon(): void {
    showAbandonConfirm = false;
    hasSnapshot = false;
    existingNames = null;
    // R4.3: confirming clears the snapshot. `game.newGame()` immediately
    // writes a fresh snapshot for the new game, which overwrites the
    // abandoned one — there is no separate "just discard" store API to
    // call instead (SPEC §5.7 exposes newGame/restore, not a bare clear).
    startNewGame();
  }

  function cancelAbandon(): void {
    showAbandonConfirm = false;
  }

  function handleResume(): void {
    void game.restore();
  }
</script>

<div data-testid="home-screen" class="home-screen">
  <h1 class="home-screen__title">Cuttle</h1>

  {#if game.notice}
    <p class="home-screen__notice" role="status">{game.notice}</p>
  {/if}

  <div class="home-screen__names">
    <label class="home-screen__field">
      <span>Player 1 name</span>
      <input data-testid="name-input-0" type="text" placeholder="Player 1" bind:value={name0} />
    </label>
    <label class="home-screen__field">
      <span>Player 2 name</span>
      <input data-testid="name-input-1" type="text" placeholder="Player 2" bind:value={name1} />
    </label>
  </div>

  <div class="home-screen__actions">
    {#if hasSnapshot}
      <button type="button" data-testid="resume" class="home-screen__button" onclick={handleResume}>
        Resume
      </button>
    {/if}
    <button type="button" data-testid="new-game" class="home-screen__button" onclick={handleNewGameClick}>
      New game
    </button>
    <button type="button" class="home-screen__button" disabled>Rules</button>
  </div>

  {#if showAbandonConfirm}
    <div class="home-screen__confirm" role="alertdialog" aria-modal="true">
      <p>Abandon {existingNames?.[0] ?? 'Player 1'} vs {existingNames?.[1] ?? 'Player 2'}?</p>
      <div class="home-screen__confirm-actions">
        <button type="button" data-testid="cancel-abandon" class="home-screen__button" onclick={cancelAbandon}>
          Cancel
        </button>
        <button type="button" data-testid="confirm-abandon" class="home-screen__button" onclick={confirmAbandon}>
          Abandon
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .home-screen {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-4);
    min-height: 100dvh;
    box-sizing: border-box;
    padding: calc(var(--cu-space-5) + var(--cu-safe-top)) var(--cu-gutter-sheet)
      calc(var(--cu-space-5) + var(--cu-safe-bottom));
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
  }

  .home-screen__title {
    font-size: var(--cu-text-xl);
    margin: 0;
  }

  .home-screen__notice {
    color: var(--cu-muted);
    font-size: var(--cu-text-sm);
    margin: 0;
  }

  .home-screen__names {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
  }

  .home-screen__field {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-1);
    font-size: var(--cu-text-sm);
    color: var(--cu-muted);
  }

  .home-screen__field input {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min);
    padding: 0 var(--cu-space-3);
    border-radius: var(--cu-radius-well);
    border: 1px solid var(--cu-ink-line);
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
  }

  .home-screen__actions {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
  }

  .home-screen__button {
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    min-width: var(--cu-tap-min);
    padding: 0 var(--cu-space-4);
    border-radius: var(--cu-radius-control);
    border: none;
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
  }

  .home-screen__button:disabled {
    color: var(--cu-muted);
    opacity: 0.6;
  }

  .home-screen__confirm {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
    padding: var(--cu-gutter-sheet);
    border-radius: var(--cu-radius-sheet);
    background: var(--cu-ink-raised);
  }

  .home-screen__confirm-actions {
    display: flex;
    gap: var(--cu-space-3);
  }
</style>
