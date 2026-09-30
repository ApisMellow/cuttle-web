<script lang="ts">
  // SPEC §5.2 ResultScreen — R2/R3: win or stalemate, tally, Rematch.
  //
  // Pure presentational component, deliberately store-free (AGENTS.md
  // "Redaction rules": "ResultScreen renders neither hand"; there is no
  // hand data anywhere in this component's props to begin with). App.svelte
  // is the wiring layer (SPEC §5.3's "one-way data flow" + this round's
  // brief): it reads `game.view` for `winner`/`stalemate`, `session.names`
  // and `session.tally`, records the result into the session tally exactly
  // once per finished game, and passes `onRematch` as a closure over
  // `game.newGame()` (which already threads `session.nextDealer` itself —
  // SPEC §8 OQ-12 — so this component needs no dealer knowledge at all).
  //
  // `state` is intentionally the minimal slice this screen needs, read
  // verbatim and never recomputed (SPEC §3.3 rule 1: no GameState type, no
  // recomputing engine-derived values) — shaped so a test can hand it
  // store-shaped props without constructing a real envelope.
  import type { PlayerId, PlayerView } from '../bridge/schema';

  interface ResultScreenProps {
    state: Pick<PlayerView, 'winner' | 'stalemate'>;
    names: [string, string];
    tally: Record<PlayerId, number>;
    /** W25: each player's final points, read verbatim off the final scoreboard by the app layer. */
    scores?: Record<PlayerId, number>;
    onRematch: () => void;
    /** W25: back to the home screen. */
    onHome?: () => void;
    /**
     * Amended 2026-09-28: one line naming the winning move, built by the app
     * layer with `winningMoveLine` (lib/recap.ts) from public history and the
     * final scoreboard. '' or omitted: no line (a stalemate).
     */
    winningMove?: string;
    /**
     * Two-phone W13b (plan §7): the rematch line, "Waiting for Blake…" or
     * "Blake wants a rematch.", built by the app layer from the online
     * store's rematch frames. '' or omitted: no line (pass-and-play).
     */
    rematchStatus?: string;
    /** W13b: this seat's rematch request is out; Rematch is spent until the new game. */
    rematchWaiting?: boolean;
  }

  let {
    state,
    names,
    tally,
    scores,
    onRematch,
    onHome,
    winningMove = '',
    rematchStatus = '',
    rematchWaiting = false,
  }: ResultScreenProps = $props();

  const headline = $derived(
    state.winner !== null
      ? `${names[state.winner]} wins!`
      : state.stalemate
        ? 'Stalemate — nobody wins this one.'
        : '',
  );
</script>

<div data-testid="result-screen" class="result-screen">
  <h1 class="result-screen__headline">{headline}</h1>
  {#if winningMove !== ''}
    <p class="result-screen__move">{winningMove}</p>
  {/if}
  <p data-testid="tally" class="result-screen__tally">
    Match: {names[0]} {tally[0]} – {names[1]} {tally[1]}
  </p>
  {#if scores}
    <p data-testid="final-scores" class="result-screen__scores">
      Final score: {names[0]} {scores[0]} – {names[1]} {scores[1]}
    </p>
  {/if}
  <div class="result-screen__actions">
    <button type="button" data-testid="rematch" class="result-screen__button" disabled={rematchWaiting} onclick={onRematch}>
      Rematch
    </button>
    {#if onHome}
      <button type="button" data-testid="result-home" class="result-screen__button result-screen__button--quiet" onclick={onHome}>
        Home
      </button>
    {/if}
  </div>
  {#if rematchStatus !== ''}
    <p
      class={['result-screen__rematch', rematchWaiting && 'result-screen__rematch--waiting']}
      data-testid="online-rematch-status"
      role="status"
    >
      {rematchStatus}
    </p>
  {/if}
</div>

<style>
  .result-screen {
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

  .result-screen__headline {
    font-size: var(--cu-text-xl);
    margin: 0;
  }

  .result-screen__move {
    max-width: 32em;
    margin: 0;
    font-size: var(--cu-text-md);
    line-height: var(--cu-leading-body);
    color: var(--cu-pearl);
    overflow-wrap: anywhere;
  }

  .result-screen__tally {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--cu-tap-min);
    box-sizing: border-box;
    font-size: var(--cu-text-lg);
    font-variant-numeric: tabular-nums;
    color: var(--cu-muted);
    margin: 0;
  }

  .result-screen__scores {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--cu-tap-min);
    box-sizing: border-box;
    margin: 0;
    font-size: var(--cu-text-md);
    font-variant-numeric: tabular-nums;
    color: var(--cu-pearl);
  }

  .result-screen__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--cu-space-3);
  }

  .result-screen__button--quiet {
    border: 1px solid var(--cu-ink-line);
    background: transparent;
    color: var(--cu-pearl);
  }

  .result-screen__button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* W13b: the online rematch line, under the buttons. Iris edge when Blake
     has asked (your move), muted while waiting on Blake. */
  .result-screen__rematch {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    max-width: 32em;
    margin: 0;
    padding: var(--cu-space-2) var(--cu-space-4);
    border: 1px solid var(--cu-ink-line);
    border-left: 4px solid var(--cu-iris);
    border-radius: var(--cu-radius-well);
    background: var(--cu-ink-raised);
    color: var(--cu-pearl);
    font-size: var(--cu-text-md);
  }

  .result-screen__rematch--waiting {
    border-left-color: var(--cu-ink-line);
    color: var(--cu-muted);
  }

  .result-screen__button {
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
