import { expect, test } from '@playwright/test';

test('boots the compiled engine and verifies the golden deal through the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready');
  await page.getByTestId('golden-smoke').click();
  await expect(page.getByTestId('golden-result')).toContainText('7 legal moves');
  await expect(page.getByTestId('golden-result')).toContainText('play A♥ as one-off');
});
