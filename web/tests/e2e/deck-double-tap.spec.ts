import { expect, test, type Page } from '@playwright/test';

// Issue #24: a second tap on the deck while the draw is staged commits the
// draw, exactly as Confirm would, and play moves on to the pass curtain.
// Golden deal (SPEC §2.6, seed 42, dealer P2): Alice acts first holding five
// cards, the deck holds 41, and Draw is legal. The hook only seeds the deal
// and reads the curtain/seq; every move is made through the real UI.

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  curtain(): string;
  viewer(): 0 | 1 | null;
  seq(): number;
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function reveal(page: Page): Promise<void> {
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
}

async function startGolden(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));
  await reveal(page);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(5);
  await expect(page.getByTestId('deck-pile')).toHaveText('41');
}

/**
 * The draw landed: the pass curtain is up for Blake with no board and no
 * hand in the DOM, and once Blake reveals, the public counts show Alice's
 * hand at 6 (+1) and the deck at 40 (-1).
 */
async function expectDrawCommitted(page: Page): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
  await expect(page.getByTestId('deck-pile')).toHaveCount(0);
  expect(await hook(page, (h) => h.seq())).toBe(1);
  expect(await hook(page, (h) => h.curtain())).toBe('handoff');

  await reveal(page);
  await expect(page.getByTestId('recap')).toContainText('Alice drew a card');
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.viewer())).toBe(1);
  await expect(page.getByTestId('opp-hand')).toContainText('6 cards');
  await expect(page.getByTestId('deck-pile')).toHaveText('40');
}

test('tapping the deck twice draws and goes to the pass curtain (issue #24)', async ({ page }) => {
  await startGolden(page);
  const deck = page.getByTestId('deck-pile');

  await deck.click();
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  expect(await hook(page, (h) => h.seq())).toBe(0); // one tap never applies (R12)
  await expect(deck).toHaveText('41');

  await deck.click();
  await expectDrawCommitted(page);
});

test('Confirm still commits a staged draw', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('deck-pile').click();
  await page.getByTestId('staging-confirm').click();
  await expectDrawCommitted(page);
});

test('with a hand card selected, two deck taps draw', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('hand-card-0').click();
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('deck-pile').click();
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  expect(await hook(page, (h) => h.seq())).toBe(0);
  await page.getByTestId('deck-pile').click();
  await expectDrawCommitted(page);
});

test('Enter twice on the focused deck draws, like two taps', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await startGolden(page);
  await page.getByTestId('deck-pile').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  expect(await hook(page, (h) => h.seq())).toBe(0);
  await page.keyboard.press('Enter');
  await expectDrawCommitted(page);
});

test('holding Enter on the deck only stages the draw (auto-repeat is not a second tap)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await startGolden(page);
  await page.getByTestId('deck-pile').focus();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.up('Enter');
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  expect(await hook(page, (h) => h.seq())).toBe(0);
  expect(await hook(page, (h) => h.curtain())).toBe('none');
});
