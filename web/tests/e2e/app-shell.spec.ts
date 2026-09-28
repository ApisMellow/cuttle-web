import { expect, test } from '@playwright/test';

// SPEC §5.2 — HomeScreen / GameScreen wiring for this round's acceptance
// criteria: R1.3 (blank names default), R4.3 (the abandon confirm, cancel
// then confirm), and R4 resume-after-reload. These reach positions through
// the real UI (HomeScreen -> GameScreen), never by hand-writing localStorage
// or calling the bridge directly — the R1/R4 flows ARE the thing under
// test.

test('R1.3: blank names default to Player 1 / Player 2', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  // Leave both name-input-0 and name-input-1 untouched (blank).
  await page.getByTestId('new-game').click();

  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('game-screen')).toContainText('Player 1');
  await expect(page.getByTestId('game-screen')).toContainText('Player 2');
});

test('R4.3: New game confirms abandoning an in-progress game; cancel keeps it, confirm clears it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Bob');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('game-screen')).toContainText('Alice');
  await expect(page.getByTestId('game-screen')).toContainText('Bob');

  // A reload resets in-memory `game.screen` to 'home', but the snapshot
  // (written synchronously by newGame(), SPEC §5.7) survives, so HomeScreen
  // offers both Resume and the abandon-confirm path.
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('resume')).toBeVisible();

  // Cancel: the dialog closes, the in-progress game is untouched.
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('confirm-abandon')).toBeVisible();
  await expect(page.getByTestId('home-screen')).toContainText('Abandon Alice vs Bob?');
  await page.getByTestId('cancel-abandon').click();
  await expect(page.getByTestId('confirm-abandon')).not.toBeVisible();

  // The game really survived Cancel: HomeScreen's own Resume flag proves
  // nothing about storage, so reload (a fresh HomeScreen reads the stored
  // snapshot again) and resume it through the store.
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('game-screen')).toContainText('Alice vs Bob');

  // Confirm: back to Home, and a fresh game replaces the abandoned one.
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('confirm-abandon')).toBeVisible();
  await page.getByTestId('confirm-abandon').click();

  await expect(page.getByTestId('game-screen')).toBeVisible();
  // Blank inputs on this fresh Home mount -> defaults (R1.3), proving the
  // abandoned game (Alice vs Bob) is really gone, not just hidden.
  await expect(page.getByTestId('game-screen')).toContainText('Player 1');
  await expect(page.getByTestId('game-screen')).toContainText('Player 2');
});

test('R4: Resume restores the in-progress game after a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Bob');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();

  await page.getByTestId('resume').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('game-screen')).toContainText('Alice');
  await expect(page.getByTestId('game-screen')).toContainText('Bob');
});

// docs/design.md §10 testable rule 1 / this round's brief "Visual": no
// horizontal scroll from 360 to 430 wide, on both screens this item owns.
for (const width of [360, 390, 430]) {
  test(`no horizontal scroll at ${width}px wide (HomeScreen, GameScreen)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);

    await page.getByTestId('new-game').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  });
}

// This round's brief, "Testids": every listed testid sits on a >=44px
// element or a root container. Root containers (home-screen, game-screen)
// span the full viewport by construction; this checks the ones that don't.
test('interactive testids clear the 44x44 tap-target floor at 390x844', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  for (const id of ['name-input-0', 'name-input-1', 'new-game']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Bob');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('resume')).toBeVisible();

  const resumeBox = await page.getByTestId('resume').boundingBox();
  expect(resumeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(resumeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.getByTestId('new-game').click();
  for (const id of ['confirm-abandon', 'cancel-abandon']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
