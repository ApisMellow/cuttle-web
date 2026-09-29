<script lang="ts">
  // SPEC §5.2 — the app shell: ensureEngine(), the global error boundary,
  // and the route switch between HomeScreen / GameScreen / ResultScreen.
  //
  // This replaces the P1b walking-skeleton status page (§1.2) now that the
  // routed shell exists (AGENTS.md "SPEC text superseded by rulings": there
  // is no `web/src/routes/`, the shell IS this file and main.ts).
  //
  // Routing precedence, most urgent first:
  //   1. still booting the WASM bridge -> a loading screen.
  //   2. ensureEngine() rejected -> a boot-failure screen (nothing else
  //      can work without the engine).
  //   3. `game.error` is set (a real EngineError from a failed newGame/
  //      apply/restore call, SPEC §2.9) -> the global error boundary, with
  //      a "New game" action. Checked BEFORE `game.screen`, because
  //      `GameStore.newGame()` can set `error` and return before ever
  //      flipping `screen` away from 'home' (game.svelte.ts `newGame()`:
  //      the `!result.ok` branch returns early).
  //   4. `game.screen === 'home'` -> HomeScreen.
  //   5. `game.curtain.kind === 'result'` -> ResultScreen (game.svelte.ts
  //      keeps `envelope` populated at 'result': it is a resting,
  //      non-withheld curtain state, SPEC §5.7).
  //   6. otherwise -> GameScreen (the board host; its board is a later
  //      round's work — this round ships a skeleton, per the brief).
  import { onMount, untrack } from 'svelte';

  import GameScreen from './lib/components/GameScreen.svelte';
  import HomeScreen from './lib/components/HomeScreen.svelte';
  import ResultScreen from './lib/components/ResultScreen.svelte';
  import { ensureEngine } from './lib/bridge/wasm';
  import { reportScreen } from './lib/pwa/register';
  import { winningMoveLine } from './lib/recap';
  import { game } from './lib/stores/game.svelte';
  import { session } from './lib/stores/session.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import { ensureThemeLoaded, loadThemeCatalog } from './lib/theme';
  import { SNAPSHOT_KEY, decodeSnapshot } from './lib/stores/snapshot';
  import './lib/styles/tokens.css';

  type EngineStatus = 'loading' | 'ready' | 'failed';

  let engineStatus = $state<EngineStatus>('loading');
  let engineError = $state<string | null>(null);

  // PRD §10 A-6: bitmap themes load lazily. The catalog is read after
  // first paint; a theme's manifest only once it is the chosen one (on a
  // reload with a saved choice, that is right away). Until then every card
  // renders the vector baseline (SPEC §5.6 rule 4). Neither call throws.
  onMount(() => {
    void loadThemeCatalog();
  });

  $effect(() => {
    const id = settings.themeId;
    untrack(() => void ensureThemeLoaded(id));
  });

  onMount(() => {
    ensureEngine()
      .then(() => {
        engineStatus = 'ready';
      })
      .catch((err: unknown) => {
        engineStatus = 'failed';
        engineError = err instanceof Error ? err.message : String(err);
      });
  });

  type Screen = 'loading' | 'boot-failed' | 'error' | 'home' | 'result' | 'game';

  const screen = $derived<Screen>(
    engineStatus === 'loading'
      ? 'loading'
      : engineStatus === 'failed'
        ? 'boot-failed'
        : game.error !== null
          ? 'error'
          : game.screen === 'home'
            ? 'home'
            : game.curtain.kind === 'result'
              ? 'result'
              : 'game',
  );

  // R18 (SPEC §5.8): a new build waits for a safe screen (home, loading,
  // boot failure) before it takes over. Never mid-game.
  $effect(() => {
    reportScreen(screen);
  });

  // R2.3/R3: the app layer's job, not ResultScreen's (which is a pure
  // presentational component; see its own file doc). Stalemates are never
  // tallied (SPEC §5.3 session.svelte.ts / R3).
  //
  // B2: only a LIVE transition into 'result' records, i.e. one from a game
  // this App instance has watched being played (`game.apply()` taking the
  // curtain from none / a real ack to result). `game.restore()` into a
  // finished game flips `screen` from 'home' to 'game' and the curtain to
  // 'result' in one synchronous block, so this effect never sees an
  // in-game, non-result state first, and the win already recorded before
  // the reload (or in another session) is not recorded again.
  //
  // `taliedThisResult` therefore starts true (nothing to tally yet), is set
  // true again whenever the home screen shows, and is cleared only by an
  // observed in-game, non-result state. A plain `let`, not `$state`: it is
  // bookkeeping for this effect alone and must not re-trigger it.
  let taliedThisResult = true;

  $effect(() => {
    if (game.screen !== 'game') {
      taliedThisResult = true;
      return;
    }
    if (game.curtain.kind !== 'result') {
      taliedThisResult = false;
      return;
    }
    if (taliedThisResult) return;
    const view = game.view;
    if (view && view.winner !== null) {
      const winner = view.winner;
      // untrack: recordResult reads the tally it writes; that read must not
      // become a dependency of this effect.
      untrack(() => session.recordResult(winner));
    }
    taliedThisResult = true;
  });

  // N5: the error boundary's "New game" goes through the same R4.3 abandon
  // confirm HomeScreen uses when the saved game is still in progress, so a
  // possibly recoverable game is never silently discarded. A snapshot
  // resting at 'result' is a finished game: R4.3 covers "an in-progress
  // game" only, so that case starts immediately (orchestrator ruling).
  let errorAbandonNames = $state<[string, string] | null>(null);

  function inProgressSnapshotNames(): [string, string] | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY);
    } catch {
      return null;
    }
    const decoded = decodeSnapshot(raw);
    if (!decoded.ok || decoded.snapshot.curtain.kind === 'result') return null;
    return decoded.snapshot.names;
  }

  function handleErrorNewGame(): void {
    const names = inProgressSnapshotNames();
    if (names !== null) {
      errorAbandonNames = names;
      return;
    }
    void game.newGame();
  }

  function confirmErrorAbandon(): void {
    errorAbandonNames = null;
    void game.newGame();
  }

  function cancelErrorAbandon(): void {
    errorAbandonNames = null;
  }

  // SPEC §8 OQ-12: `game.newGame()` already reads `session.nextDealer`
  // itself (game.svelte.ts `newGame()`), so a rematch needs no dealer
  // argument here — the alternation is entirely the store's existing
  // responsibility.
  function handleRematch(): void {
    void game.newGame();
  }

  // W25: the final points per player, read verbatim off the viewer-relative
  // scoreboard (SPEC §3.3 rule 2: mapped to seats, never recomputed).
  function finalScores(view: NonNullable<typeof game.view>): Record<0 | 1, number> {
    const you = view.scoreboard.you.points;
    const opp = view.scoreboard.opponent.points;
    return view.viewer === 0 ? { 0: you, 1: opp } : { 0: opp, 1: you };
  }

  // Amended 2026-09-28: the result screen's winning-move line. Public data
  // only: the history's last visible entry (cards played face up) and the
  // winner's final points and goal, read verbatim off the scoreboard.
  function winningMove(view: NonNullable<typeof game.view>): string {
    if (view.winner === null) return '';
    const side = view.winner === view.viewer ? view.scoreboard.you : view.scoreboard.opponent;
    return winningMoveLine(game.history, view.winner, session.names, side.points, side.threshold);
  }
</script>

<main data-testid="app-shell">
  {#if screen === 'loading'}
    <p data-testid="engine-status" class="status-screen">Loading the game…</p>
  {:else if screen === 'boot-failed'}
    <!-- Amended 2026-09-28 (playtest friction): plain wording first; the
         technical reason stays, small and muted, for a bug report. -->
    <div data-testid="engine-status" class="status-screen status-screen--error">
      <p>The game couldn’t start. Reload the page to try again.</p>
      {#if engineError}
        <p class="status-screen__code">Details: {engineError}</p>
      {/if}
    </div>
  {:else if screen === 'error'}
    <!-- N4: the error CODE and generic copy only. A bridge `message` can
         embed a move description (card identities), so it never renders.
         Stand-in until the §2.10 stuck-state screen lands. -->
    <div data-testid="error-screen" class="status-screen status-screen--error">
      <p>Something went wrong. The game hit an error it could not recover from.</p>
      <p class="status-screen__code">Error code: {game.error?.code}</p>
      <button type="button" data-testid="error-new-game" class="status-screen__button" onclick={handleErrorNewGame}>
        New game
      </button>
      {#if errorAbandonNames}
        <div class="status-screen__confirm" role="alertdialog" aria-modal="true">
          <p>Abandon {errorAbandonNames[0]} vs {errorAbandonNames[1]}?</p>
          <div class="status-screen__confirm-actions">
            <button type="button" data-testid="cancel-abandon" class="status-screen__button" onclick={cancelErrorAbandon}>
              Cancel
            </button>
            <button type="button" data-testid="confirm-abandon" class="status-screen__button" onclick={confirmErrorAbandon}>
              Abandon
            </button>
          </div>
        </div>
      {/if}
    </div>
  {:else if screen === 'home'}
    <HomeScreen />
  {:else if screen === 'result' && game.view}
    <ResultScreen
      state={{ winner: game.view.winner, stalemate: game.view.stalemate }}
      names={session.names}
      tally={session.tally}
      scores={finalScores(game.view)}
      onRematch={handleRematch}
      onHome={() => game.goHome()}
      winningMove={winningMove(game.view)}
    />
  {:else}
    <GameScreen />
  {/if}
</main>

<style>
  .status-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-4);
    min-height: 100dvh;
    box-sizing: border-box;
    padding: calc(var(--cu-gutter-sheet) + var(--cu-safe-top)) var(--cu-gutter-sheet)
      calc(var(--cu-gutter-sheet) + var(--cu-safe-bottom));
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
    text-align: center;
  }

  .status-screen--error {
    color: var(--cu-pearl);
  }

  .status-screen__code {
    margin: 0;
    color: var(--cu-muted);
    font-size: var(--cu-text-sm);
    font-variant-numeric: tabular-nums;
  }

  .status-screen__confirm {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3);
    padding: var(--cu-gutter-sheet);
    border-radius: var(--cu-radius-sheet);
    background: var(--cu-ink-raised);
  }

  .status-screen__confirm-actions {
    display: flex;
    justify-content: center;
    gap: var(--cu-space-3);
  }

  .status-screen__button {
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    min-width: var(--cu-tap-min);
    padding: 0 var(--cu-space-5);
    border-radius: var(--cu-radius-control);
    border: none;
    background: var(--cu-ochre);
    color: var(--cu-on-accent);
    font-size: var(--cu-text-md);
    font-weight: var(--cu-weight-bold);
  }
</style>
