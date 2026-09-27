<script lang="ts">
  // Placeholder status page only (P1b scope, SPEC §1.2). No real UI, no
  // bridge wiring — Batch 3 owns `lib/bridge/*` and the routed app shell
  // described in SPEC §5.2.
  const status: string = 'scaffold';
</script>

<main data-testid="app-shell">
  <h1>Cuttle</h1>
  <p data-testid="scaffold-status">Status: {status}</p>
</main>
