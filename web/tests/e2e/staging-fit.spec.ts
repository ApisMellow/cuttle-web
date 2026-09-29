import { expect, test } from '@playwright/test';

// Card labels (review S1): no staged description is ever cut off. Every
// one-off and permanent kind (both 9 cases included), plus scuttle, points,
// draw, discard and a 7's dead end, is staged into the real StagingBar at
// each target viewport; the description must fit its three-line clamp and
// the bar must keep its reserved height, so staging never reflows the
// board. Light tier: real-browser layout, no jsdom.

const HARNESS_URL = '/tests/e2e/harness/mount-board.ts';
type Harness = typeof import('./harness/mount-board');

for (const [width, height] of [
  [393, 852],
  [430, 932],
  [1440, 900],
] as const) {
  test(`${width}x${height}: every staged move fits the staging line`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForSelector('body');
    const fits = await page.evaluate(async (harnessUrl) => {
      const H = (await import(harnessUrl)) as Harness;
      H.unmountAll();
      return H.measureStagingFit(H.stagingFitCases());
    }, HARNESS_URL);
    expect(fits.length).toBeGreaterThanOrEqual(21);
    for (const fit of fits) {
      expect.soft(fit.overflows, `clipped: ${fit.description}`).toBe(false);
      expect.soft(fit.barHeight, `bar grew: ${fit.description}`).toBeLessThanOrEqual(fit.reserved + 0.5);
    }
  });
}
