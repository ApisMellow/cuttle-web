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
    // The UI font ships with the app, so every platform measures the same
    // glyphs. Measuring before it loads would test the system fallback.
    const fontLoaded = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('400 16px "Atkinson Hyperlegible Next"'),
        document.fonts.load('700 16px "Atkinson Hyperlegible Next"'),
      ]);
      // check() is also true when no such family is declared at all, so
      // require real loaded faces (regular and bold).
      const loaded = [...document.fonts].filter(
        (f) => f.family.replace(/"/g, '') === 'Atkinson Hyperlegible Next' && f.status === 'loaded',
      );
      const weights = new Set(loaded.map((f) => f.weight));
      return weights.has('400') && weights.has('700') && document.fonts.check('16px "Atkinson Hyperlegible Next"');
    });
    expect(fontLoaded, 'bundled UI font failed to load').toBe(true);
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
