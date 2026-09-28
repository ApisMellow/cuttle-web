<script lang="ts">
  // P1b Batch 3 walking-skeleton status page (SPEC §1.2, §5.1). This is
  // deliberately NOT the routed app shell of §5.2 — no curtain, no board,
  // no stores. It exists only to prove the bridge boundary end to end:
  // ensureEngine() boots the real compiled WASM, and the golden-deal smoke
  // check runs newGame() through engine.ts and renders the result.
  //
  // SPEC §3.3 rule 4: this page renders only the envelope for the viewer
  // holding the phone. newGame() returns the first actor's own envelope
  // (§2.4) — there is no second viewer's data anywhere in this component.
  import { onMount } from 'svelte';

  import { newGame } from './lib/bridge/engine';
  import { ensureEngine } from './lib/bridge/wasm';

  type EngineStatus = 'loading' | 'ready' | 'failed';

  let engineStatus = $state<EngineStatus>('loading');
  let engineError = $state<string | null>(null);
  let goldenResult = $state<string | null>(null);

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

  function runGoldenSmoke(): void {
    // SPEC §2.6 golden scenario: seed "42", dealer 1 (P2 deals, so P1 is
    // non-dealer and goes first) — 7 legal moves, including "play A♥ as
    // one-off" at index 3.
    const result = newGame({ seed: '42', dealer: 1 });
    if (!result.ok) {
      goldenResult = `${result.code}: ${result.message}`;
      return;
    }
    const lines = result.descriptions.map((description, index) => `[${index}] ${description}`);
    goldenResult = `${result.legalMoves.length} legal moves\n${lines.join('\n')}`;
  }
</script>

<main data-testid="app-shell">
  <h1>Cuttle</h1>

  {#if engineStatus === 'loading'}
    <p data-testid="engine-status">Loading engine…</p>
  {:else if engineStatus === 'failed'}
    <p data-testid="engine-status">Engine failed: {engineError}</p>
  {:else}
    <p data-testid="engine-status">Engine ready</p>
    <button data-testid="golden-smoke" onclick={runGoldenSmoke}>Run golden-deal check</button>
    {#if goldenResult}
      <pre data-testid="golden-result">{goldenResult}</pre>
    {/if}
  {/if}
</main>
