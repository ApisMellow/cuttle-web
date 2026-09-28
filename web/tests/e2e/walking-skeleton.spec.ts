import { expect, test } from '@playwright/test';

// SPEC §5.2 — the app shell now routes to HomeScreen instead of the P1b
// walking-skeleton status page, so the "Run golden-deal check" button this
// test used to click no longer exists. The golden-deal proof itself still
// matters (it is the end-to-end confirmation that the real, browser-loaded
// WASM binary boots and deals correctly — the three vitest files that boot
// wasm use a Node-side loader, not a real browser, so this is the only
// place that exercises `ensureEngine()`'s actual `<script>`-tag + `fetch`
// boot sequence, SPEC §2.3). It is reached by calling the registered
// `__cuttleNewGame` bridge global directly, in-page, the instant the app
// has proven it booted (HomeScreen rendered) and before any other bridge
// call has touched the engine's one shared instance this page owns.
test('boots the compiled engine and verifies the golden deal through the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  const result = await page.evaluate(() => {
    const raw = (window as unknown as { __cuttleNewGame: (opts: string) => string }).__cuttleNewGame(
      JSON.stringify({ seed: '42', dealer: 1 }),
    );
    return JSON.parse(raw) as { legalMoves: unknown[]; descriptions: string[] };
  });

  expect(result.legalMoves.length).toBe(7);
  expect(result.descriptions).toContain('play A♥ as one-off');
});
