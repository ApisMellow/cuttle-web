// Card gallery (gallery/site/): a standalone page deployed beside the game at
// /gallery/. It isn't part of the Vite app, so this spec serves the folder
// from disk under a fake origin and blocks every other request (the web
// fonts), which also proves the page needs nothing from the game.

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const SITE = fileURLToPath(new URL('../../../gallery/site/', import.meta.url));
const ORIGIN = 'http://gallery.test';
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.webp': 'image/webp',
};

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/gallery/')) return route.abort();
    const rel = url.pathname.slice('/gallery/'.length) || 'index.html';
    try {
      const body = readFileSync(join(SITE, rel));
      await route.fulfill({ body, contentType: TYPES[extname(rel)] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
});

test('gallery loads 57 cards and navigates by button, key and thumbnail', async ({ page }) => {
  await page.goto(`${ORIGIN}/gallery/`);
  await expect(page.locator('body[data-ready="true"]')).toHaveCount(1);

  await expect(page.getByTestId('gallery-slide')).toHaveCount(57);
  await expect(page.getByRole('navigation', { name: 'All cards' }).getByRole('button')).toHaveCount(57);
  await expect(page.getByTestId('gallery-count')).toHaveText('1 of 57');
  await expect(page.getByTestId('gallery-prev')).toBeDisabled();

  await page.getByTestId('gallery-next').click();
  await expect(page.getByTestId('gallery-count')).toHaveText('2 of 57');
  await expect(page.locator('#cap-title')).toHaveText('Board Wipe');
  await expect(page.locator('.slide.is-current img')).toHaveAttribute('alt', /Ace of clubs/);

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('gallery-count')).toHaveText('3 of 57');
  await page.keyboard.press('End');
  await expect(page.getByTestId('gallery-count')).toHaveText('57 of 57');
  await expect(page.getByTestId('gallery-next')).toBeDisabled();

  await page.getByRole('button', { name: '8 of hearts, played as glasses, Glasses' }).click();
  await expect(page.locator('#cap-sub')).toHaveText('8 of hearts, played as glasses');
  await expect(page).toHaveURL(/#glasses-hearts$/);

  // "Play Cuttle" goes back up to the game.
  await expect(page.getByTestId('gallery-play')).toHaveAttribute('href', '../');
  // Nothing scrolls sideways at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
