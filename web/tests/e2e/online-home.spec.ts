import { expect, test, type Page } from '@playwright/test';

// W13a: two-phone Home, Create and Join screens at the iPhone 15 viewport,
// against the in-app fake (the dev build's default OnlineActions).

test.use({ viewport: { width: 393, height: 852 } });

async function fits(page: Page, testId: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const el of await page.locator(`[data-testid="${testId}"] button, [data-testid="${testId}"] input[type="text"]`).all()) {
    const box = await el.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44 - 0.5);
  }
}

test('Home offers three ways to play and fits the phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode-pass-play')).toBeVisible();
  await expect(page.getByTestId('table-mode-toggle')).toBeVisible();
  await expect(page.getByTestId('online-create')).toBeVisible();
  await expect(page.getByTestId('online-join')).toBeVisible();
  await fits(page, 'home-screen');
});

// W13b, R24.14 (plan §10): offline, Play on two phones stays and explains.
test('offline, Play on two phones stays visible and says it needs a connection', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('online-create')).toBeEnabled();
  await expect(page.getByTestId('online-offline')).toHaveCount(0);

  await context.setOffline(true);
  await expect(page.getByTestId('mode-online')).toBeVisible();
  await expect(page.getByTestId('online-offline')).toHaveText('You’re offline. Online games need a connection.');
  await expect(page.getByTestId('online-create')).toBeDisabled();
  await expect(page.getByTestId('online-join')).toBeDisabled();
  const box = await page.getByTestId('online-offline').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44 - 0.5);
  await fits(page, 'home-screen');

  await context.setOffline(false);
  await expect(page.getByTestId('online-offline')).toHaveCount(0);
  await expect(page.getByTestId('online-create')).toBeEnabled();
});

test('a join link opens the join screen with the code filled in and clears the hash', async ({ page }) => {
  await page.goto('/#/join/abcd');
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await expect(page.getByTestId('join-code-input')).toHaveValue('ABCD');
  await expect(page.getByTestId('online-name-input')).toBeFocused();
  expect(new URL(page.url()).hash).toBe('');
  await fits(page, 'join-screen');

  await page.getByTestId('online-name-input').fill('Blake');
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('online-connected')).toContainText('Alice');
});

test('a full room shows a clear error', async ({ page }) => {
  await page.goto('/#/join/FFFF');
  await page.getByTestId('online-name-input').fill('Blake');
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('online-error')).toContainText('two players');
});

test('create flow reaches the waiting screen with the code, Share and Cancel', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('online-create').click();
  await expect(page.getByTestId('create-screen')).toBeVisible();
  await page.getByTestId('online-name-input').fill('Alice');
  await page.getByTestId('create-room').click();

  await expect(page.getByTestId('waiting-screen')).toBeVisible();
  await expect(page.getByTestId('room-code')).toHaveText('K7QX');
  await expect(page.getByTestId('share-invite')).toBeVisible();
  await expect(page.getByTestId('invite-link')).toContainText('#/join/K7QX');
  const box = await page.getByTestId('room-code').boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(393);
  await fits(page, 'waiting-screen');

  await page.getByTestId('cancel-room').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});

test('Join with a code by hand', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('online-join').click();
  await page.getByTestId('join-code-input').fill('k7qx');
  await page.getByTestId('online-name-input').fill('Blake');
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('online-connected')).toBeVisible();
});
