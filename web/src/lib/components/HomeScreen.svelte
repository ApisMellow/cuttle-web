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
  import { untrack } from 'svelte';

  import type { OnlineActions } from '../online/actions';
  import { browserEnvironment, type ConnectionEnvironment } from '../online/connection';
  import { getOnlineActions, onlineAvailable } from '../online/provider';
  import { GALLERY_LABEL, galleryHref } from '../gallery';
  import { game } from '../stores/game.svelte';
  import { online } from '../stores/online.svelte';
  import { session } from '../stores/session.svelte';
  import { settings } from '../stores/settings.svelte';
  import { SNAPSHOT_KEY, decodeSnapshot } from '../stores/snapshot';
  import { listThemeChoices, vectorTheme } from '../theme';
  import RulesButton from './RulesButton.svelte';

  interface Props {
    /** Two-phone play. Defaults to the app's actions; tests pass a fake. */
    actions?: OnlineActions;
    /** Whether Play on two phones is offered at all (no server configured: hidden). */
    onlineEnabled?: boolean;
    /** W13b: where "is the network up" comes from (the browser by default; tests pass a fake). */
    network?: Pick<ConnectionEnvironment, 'isOnline' | 'listen'>;
  }
  let { actions = getOnlineActions(), onlineEnabled = onlineAvailable(), network = browserEnvironment() }: Props = $props();

  // R24.14 (plan §10): offline, Play on two phones stays on Home and says it
  // needs a connection; Start a room and Join wait for the network (both
  // would only fail). Resume stays: the game screen shows the offline line
  // and reconnects on its own when the network returns.
  let networkOnline = $state(untrack(() => network.isOnline()));
  $effect(() => {
    const source = network;
    networkOnline = source.isOnline();
    const update = () => {
      networkOnline = source.isOnline();
    };
    const offOnline = source.listen('online', update);
    const offOffline = source.listen('offline', update);
    return () => {
      offOnline();
      offOffline();
    };
  });

  // One online game per phone: a stored seat replaces Create and Join with Resume.
  const savedSeat = untrack(() => actions.savedSeat());

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

  // W25 (live playtest): keep the name fields filled. After a reload the
  // in-memory session is fresh, so the saved game's names (the snapshot
  // carries them, SPEC §5.7) fill the fields; otherwise the session's own
  // names do, when someone has set them this session. R10: with neither,
  // the last-used names from settings do (they survive a reload with no
  // saved game). A default ("Player 1"/"Player 2") or a blank stays blank
  // so the placeholder shows.
  function prefill(names: readonly [string, string]): void {
    name0 = names[0] === 'Player 1' ? '' : names[0];
    name1 = names[1] === 'Player 2' ? '' : names[1];
  }
  function namesToShow(): readonly [string, string] {
    if (existingNames) return existingNames;
    const setThisSession = session.names[0] !== 'Player 1' || session.names[1] !== 'Player 2';
    return setThisSession ? session.names : (settings.lastNames ?? session.names);
  }
  // Once, at mount, like peekSnapshot() above; the fields are the user's after that.
  prefill(untrack(namesToShow));

  function startNewGame(): void {
    session.setNames(name0, name1);
    // R10: remembered in settings (its own key), never in the game snapshot.
    settings.setLastNames(name0, name1);
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

  // PRD §10 A-6: the card-style picker. A look preference only: it lives in
  // the settings store (its own storage key), never in the game snapshot.
  // Catalog themes appear once the tiny catalog has loaded; a saved choice
  // that isn't listed (offline, removed theme) shows as Classic, which is
  // what the board falls back to anyway (SPEC §5.6 rule 4).
  const themeChoices = $derived(listThemeChoices());
  const selectedTheme = $derived(
    themeChoices.some((choice) => choice.id === settings.themeId) ? settings.themeId : vectorTheme.id,
  );
</script>

<div data-testid="home-screen" class="home-screen">
  <h1 class="home-screen__title">Cuttle</h1>

  {#if game.notice}
    <p class="home-screen__notice" role="status">{game.notice}</p>
  {/if}
  {#if online.notice}
    <!-- W12: why an online game ended (fixed text from the online store). -->
    <p class="home-screen__notice" role="status">{online.notice}</p>
  {/if}

  <!-- Mode 1 and 2: one phone. Table mode stays a switch under Pass and play,
       because it only changes how that one phone is held. -->
  <section class="home-screen__mode" aria-labelledby="mode-pass-play" data-testid="mode-pass-play">
    <h2 id="mode-pass-play" class="home-screen__mode-title">Pass and play</h2>
    <p class="home-screen__mode-note">Two players, one phone.</p>

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

    <!-- Issue #37, SPEC §5.10: a settings-store preference, never saved in the
         game snapshot. A game in progress picks it up at its next curtain. -->
    <label class="home-screen__toggle" data-testid="table-mode-toggle">
      <input
        type="checkbox"
        checked={settings.tableMode}
        onchange={(event) => settings.setTableMode(event.currentTarget.checked)}
      />
      <span>Table mode: phone lies flat between you</span>
    </label>

    <div class="home-screen__actions">
      {#if hasSnapshot}
        <button type="button" data-testid="resume" class="home-screen__button" onclick={handleResume}>
          Resume
        </button>
      {/if}
      <button type="button" data-testid="new-game" class="home-screen__button home-screen__button--primary" onclick={handleNewGameClick}>
        New game
      </button>
    </div>
  </section>

  {#if onlineEnabled}
    <section class="home-screen__mode" aria-labelledby="mode-online" data-testid="mode-online">
      <h2 id="mode-online" class="home-screen__mode-title">Play on two phones</h2>
      {#if !networkOnline}
        <p class="home-screen__offline" data-testid="online-offline" role="status">
          You’re offline. Online games need a connection.
        </p>
      {/if}
      {#if savedSeat}
        <p class="home-screen__mode-note">You have a game in progress.</p>
        <div class="home-screen__actions">
          <button type="button" data-testid="resume-online" class="home-screen__button home-screen__button--primary" onclick={() => actions.resume()}>
            {savedSeat.opponentName ? `Resume online game with ${savedSeat.opponentName}` : 'Resume online game'}
          </button>
        </div>
      {:else}
        <p class="home-screen__mode-note">Each player uses their own phone.</p>
        <div class="home-screen__actions home-screen__actions--row">
          <button type="button" data-testid="online-create" class="home-screen__button" disabled={!networkOnline} onclick={() => online.openCreate()}>
            Start a room
          </button>
          <button type="button" data-testid="online-join" class="home-screen__button" disabled={!networkOnline} onclick={() => online.openJoin()}>
            Join with a code
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if themeChoices.length > 1}
    <fieldset class="home-screen__themes">
      <legend>Card style</legend>
      <div class="home-screen__theme-options">
        {#each themeChoices as choice (choice.id)}
          <label class="home-screen__theme-option" data-testid={`theme-option-${choice.id}`}>
            <input
              type="radio"
              name="card-style"
              value={choice.id}
              checked={selectedTheme === choice.id}
              onchange={() => settings.setThemeId(choice.id)}
            />
            <span>{choice.label}</span>
          </label>
        {/each}
      </div>
    </fieldset>
    <a class="home-screen__gallery" data-testid="home-gallery" href={galleryHref()}>{GALLERY_LABEL}</a>
  {/if}

  <div class="home-screen__actions">
    <RulesButton />
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

  .home-screen__mode {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
    padding: var(--cu-space-4);
    border: 1px solid var(--cu-ink-line);
    border-radius: var(--cu-radius-sheet);
  }

  .home-screen__mode-title {
    margin: 0;
    font-size: var(--cu-text-lg);
  }

  .home-screen__mode-note {
    margin: 0;
    color: var(--cu-muted);
    font-size: var(--cu-text-sm);
  }

  /* W13b: the offline line in Play on two phones (44 px: it carries a testid). */
  .home-screen__offline {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2);
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    margin: 0;
    padding: var(--cu-space-1) var(--cu-space-3);
    border: 1px solid var(--cu-ink-line);
    border-left: 4px solid var(--cu-ochre);
    border-radius: var(--cu-radius-well);
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-sm);
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

  .home-screen__themes {
    margin: 0;
    padding: 0;
    border: none;
    min-width: 0;
  }

  .home-screen__themes legend {
    padding: 0;
    margin-bottom: var(--cu-space-1);
    font-size: var(--cu-text-sm);
    color: var(--cu-muted);
  }

  .home-screen__theme-options {
    display: flex;
    gap: var(--cu-space-2);
  }

  .home-screen__theme-option {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-2);
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    padding: 0 var(--cu-space-3);
    border: 1px solid var(--cu-ink-line);
    border-radius: var(--cu-radius-control);
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
    cursor: pointer;
  }

  .home-screen__theme-option:has(input:checked) {
    border-color: var(--cu-ochre);
    box-shadow: inset 0 0 0 1px var(--cu-ochre);
  }

  .home-screen__theme-option:has(input:focus-visible) {
    outline: 2px solid var(--cu-iris);
    outline-offset: 2px;
  }

  .home-screen__theme-option input {
    accent-color: var(--cu-ochre);
    margin: 0;
  }

  /* A quiet text link under the picker, padded to a 44 px tap target. */
  .home-screen__gallery {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    margin-top: calc(-1 * var(--cu-space-2));
    padding: 0 var(--cu-space-1);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .home-screen__gallery:focus-visible {
    outline: 2px solid var(--cu-iris);
    outline-offset: 2px;
  }

  .home-screen__toggle {
    display: flex;
    align-items: center;
    gap: var(--cu-space-3);
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    padding: 0 var(--cu-space-3);
    border: 1px solid var(--cu-ink-line);
    border-radius: var(--cu-radius-control);
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
    cursor: pointer;
  }

  .home-screen__toggle:has(input:checked) {
    border-color: var(--cu-ochre);
    box-shadow: inset 0 0 0 1px var(--cu-ochre);
  }

  .home-screen__toggle:has(input:focus-visible) {
    outline: 2px solid var(--cu-iris);
    outline-offset: 2px;
  }

  .home-screen__toggle input {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--cu-ochre);
  }

  .home-screen__actions {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
  }

  .home-screen__actions--row {
    flex-direction: row;
  }

  .home-screen__actions--row .home-screen__button {
    flex: 1 1 0;
  }

  .home-screen__button--primary {
    background: var(--cu-ochre);
    color: var(--cu-on-accent);
    font-weight: var(--cu-weight-bold);
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
