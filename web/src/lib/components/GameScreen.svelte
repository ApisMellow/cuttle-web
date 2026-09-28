<script lang="ts">
  // SPEC §5.2 GameScreen — the board host; owns the curtain overlay.
  //
  // SKELETON ONLY for this round (W12): the board, curtain and staging
  // components are other work items this round. This component mounts
  // whenever `game.screen === 'game'` and the curtain is not `result`
  // (App.svelte's route switch), and renders a clearly marked placeholder.
  //
  // Redaction (SPEC §3.3 rule 4, AGENTS.md "Redaction rules"): this
  // component reads NOTHING from `game.envelope`/`game.view` — those can
  // be null behind a curtain, and even when non-null they are a full
  // `PlayerView` that must never surface before the real board exists.
  // The only display value here is `session.names`, which is public
  // session metadata (not engine-derived game state) and safe to show
  // regardless of curtain kind.
  import { session } from '../stores/session.svelte';
</script>

<div data-testid="game-screen" class="game-screen">
  <p class="game-screen__placeholder">Board coming soon</p>
  <p class="game-screen__names">{session.names[0]} vs {session.names[1]}</p>
</div>

<style>
  .game-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-3);
    min-height: 100dvh;
    box-sizing: border-box;
    padding: var(--cu-space-5) var(--cu-gutter-board);
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
    text-align: center;
  }

  .game-screen__placeholder {
    font-size: var(--cu-text-lg);
    margin: 0;
  }

  .game-screen__names {
    color: var(--cu-muted);
    font-size: var(--cu-text-md);
    margin: 0;
  }
</style>
