import { expect, test, type Page } from '@playwright/test';

import { plainMoveText } from '../../src/lib/recap';

// W25 item 6 (desktop keyboard): every lit target is reachable with Tab and
// activates with Enter or Space, with a visible focus ring. Reached through
// the real UI; the hook only seeds the golden deal (SPEC §2.6, seed 42,
// dealer P2: Alice acts first holding 2♥ 3♣ A♥ K♦ Q♣).

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  moves(): { index: number; kind: number; handIndex: number; targetKey: string | null; description: string }[];
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function reveal(page: Page): Promise<void> {
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

/** Tabs forward from the current focus until `testId` has focus; returns the presses it took, or -1. */
async function tabTo(page: Page, testId: string, max = 40): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    if ((await activeTestId(page)) === testId) return i;
  }
  return -1;
}

async function startGolden(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));
  await reveal(page);
}

test('a hand card selected with Enter, then the lit Points zone reached by Tab and played with Enter', async ({ page }) => {
  await startGolden(page);
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;

  await page.getByTestId(`hand-card-${two.handIndex}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`hand-card-${two.handIndex}`)).toHaveAttribute('aria-pressed', 'true');

  // Keyboard selection moves focus straight to the first lit target.
  await expect.poll(() => activeTestId(page)).toBe('zone-points');
  const ring = await page.getByTestId('zone-points').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(two.description));
});

test('the lit One-off zone is reached by Tab and activates with Space', async ({ page }) => {
  await startGolden(page);
  const moves = await hook(page, (h) => h.moves());
  const ace = moves.find((m) => m.kind === 4 && m.targetKey === 'zone:oneoff')!;

  await page.getByTestId(`hand-card-${ace.handIndex}`).focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId(`hand-card-${ace.handIndex}`)).toHaveAttribute('aria-pressed', 'true');
  // The Ace lights two zones; the second is at most a few Tabs away.
  await expect.poll(() => activeTestId(page)).toMatch(/^zone-/);
  if ((await activeTestId(page)) !== 'zone-oneoff') expect(await tabTo(page, 'zone-oneoff', 6)).toBeGreaterThan(0);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(ace.description));
});

test('mouse hover lifts a hand card', async ({ page }) => {
  await startGolden(page);
  const card = page.getByTestId('hand-card-0');
  const before = await card.evaluate((el) => getComputedStyle(el).transform);
  await card.hover();
  await expect.poll(() => card.evaluate((el) => getComputedStyle(el).transform)).not.toBe(before);
});

test('Escape clears a keyboard selection', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('hand-card-0').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'false');
});

test('a mouse click on a hand card does not move focus to a target', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('hand-card-0').click();
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'true');
  expect(await activeTestId(page)).not.toMatch(/^zone-/);
});
