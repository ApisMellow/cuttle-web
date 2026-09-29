import { expect, test, type Page } from '@playwright/test';

// PRD §10 A-6 (several themes, player's choice), R23.2 (a persisted theme
// control), R23.3 (per-card fallback to vector), R23.1's e2e bullet (a
// theme swap never reflows the board). Real browser, real Mythic assets
// from web/static/themes/, the golden deal (seed "42", dealer P2) so the
// hands are known: Alice holds 2♥ 3♣ A♥ K♦ Q♣.

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  curtain(): string;
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function startGoldenGame(page: Page): Promise<void> {
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await hook(page, (h) => h.newGame('42', 1));
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function pickTheme(page: Page, id: string): Promise<void> {
  const option = page.getByTestId(`theme-option-${id}`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(option.locator('input')).toBeChecked();
}

/** Every [data-testid] box on the board, keyed by testid. */
async function boardBoxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid]')) {
      const r = el.getBoundingClientRect();
      out[el.dataset.testid as string] = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    }
    return out;
  });
}

/** Every Mythic face image in the hand has loaded and is drawn. */
async function handImages(page: Page): Promise<Array<{ src: string; loaded: boolean }>> {
  return page
    .getByTestId('player-hand')
    .locator('img')
    .evaluateAll((imgs) =>
      (imgs as HTMLImageElement[]).map((img) => ({ src: img.currentSrc || img.src, loaded: img.complete && img.naturalWidth > 0 })),
    );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
});

test('the home screen offers Classic and Mythic; the pick persists across a reload and never enters the save', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('theme-option-vector')).toContainText('Classic');
  await expect(page.getByTestId('theme-option-vector').locator('input')).toBeChecked();
  for (const id of ['vector', 'mythic']) {
    const box = await page.getByTestId(`theme-option-${id}`).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  // Only the tiny catalog has loaded: no manifest, no image yet.
  const early = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(early.some((u) => u.includes('/themes/mythic/'))).toBe(false);

  await pickTheme(page, 'mythic');
  await page.reload();
  await expect(page.getByTestId('theme-option-mythic').locator('input')).toBeChecked();

  await startGoldenGame(page);
  await expect(page.getByTestId('player-hand').locator('img')).toHaveCount(5);
  await expect.poll(async () => (await handImages(page)).every((i) => i.loaded)).toBe(true);
  const srcs = (await handImages(page)).map((i) => i.src);
  for (const card of ['2-hearts', '3-clubs', 'A-hearts', 'K-diamonds', 'Q-clubs']) {
    expect(srcs.some((s) => s.includes(`/${card}.webp`))).toBe(true);
  }
  // The opponent's hand stays card backs: Mythic's one back image, naming no card.
  const oppBacks = page.getByTestId('opp-hand').locator('img');
  await expect(oppBacks).toHaveCount(6);
  for (const src of await oppBacks.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))) {
    expect(src).toMatch(/\/themes\/mythic\/back(-2x)?\.webp$/);
  }

  const save = await page.evaluate(() => localStorage.getItem('cuttle-web:game'));
  expect(save).not.toBeNull();
  expect(save).not.toMatch(/mythic|themeId/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('a face image that fails to load falls back to the vector face for that card only, in the same box', async ({ page }) => {
  await page.route(/\/themes\/mythic\/faces(-2x)?\/A-hearts\.webp$/, (route) => route.abort());
  await page.goto('/');
  await pickTheme(page, 'mythic');
  await startGoldenGame(page);

  const hand = page.getByTestId('player-hand');
  await expect(hand.locator('img')).toHaveCount(4);
  await expect(hand.locator('.cuttle-card-face')).toHaveCount(1);
  await expect(hand.locator('.cuttle-card-face')).toContainText('A');
  await expect.poll(async () => (await handImages(page)).every((i) => i.loaded)).toBe(true);

  // Every hand card keeps the container's box.
  const sizes = await hand.locator('[data-testid^="hand-card-"]').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    }),
  );
  expect(new Set(sizes).size).toBe(1);
});

test('swapping Classic for Mythic never moves or resizes anything on the board', async ({ page }) => {
  await page.goto('/');
  await startGoldenGame(page);
  const classic = await boardBoxes(page);
  expect(await page.locator('.bitmap-card-face').count()).toBe(0);

  // Same game, resumed with Mythic chosen.
  await page.evaluate(() => {
    const raw = localStorage.getItem('cuttle-web:settings');
    const settings = raw ? JSON.parse(raw) : {};
    localStorage.setItem('cuttle-web:settings', JSON.stringify({ ...settings, themeId: 'mythic' }));
  });
  await page.reload();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.bitmap-card-face').first()).toBeVisible();
  const mythic = await boardBoxes(page);
  expect(mythic).toEqual(classic);
});
