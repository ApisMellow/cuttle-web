import { expect, test } from '@playwright/test';

import {
  expectStorageUntouched,
  focusByKeys,
  handRank,
  keyMove,
  readProgress,
  seedSavedGame,
  storageDump,
  walkLesson,
  type ActivateKey,
  type WalkIO,
} from './helpers/tutorial';

// Learn to play, plan T13 (R25.10, design §9): lesson 1 from the keyboard
// at 393x852 (Home to its done sheet). Tab moves focus (nothing here calls
// focus()), Enter and Space activate; Enter selects and Space confirms, so both
// are proved in the one lesson.
// Focus is never parked on <body> at a step the learner has to act on, and
// Escape on a done sheet means "Lessons".
//
// Waits are on `data-step` / `data-stage` / the done sheet.

test.use({ viewport: { width: 393, height: 852 } });

/** Both keys inside the one lesson: Enter selects (and presses Next), Space confirms. */
const KEYS: { select: ActivateKey; confirm: ActivateKey } = { select: 'Enter', confirm: 'Space' };

function keyboardIO(): WalkIO {
  const { select, confirm } = KEYS;
  return {
    next: async (page, step) => {
      // Design §9: after a key press Next takes focus by itself, so no Tab is needed.
      // The lesson's first step is the exception: lesson start focuses the coach's
      // copy, and Next is then the third control after it (Show me, Leave, Next).
      const presses = await focusByKeys(page, 'coach-next');
      if (step.id.endsWith('.1')) expect(presses).toBeLessThanOrEqual(3);
      else expect(presses, `Next should already have focus at ${step.id}`).toBe(0);
      await page.keyboard.press(select);
    },
    appear: async (page, step) => {
      // Step 5.3: Tab to the other Jack, open its popover, close it with the close control.
      const jackId = (await handRank(page, 11).getAttribute('data-testid')) ?? '';
      expect(jackId).not.toBe('');
      await focusByKeys(page, jackId);
      await page.keyboard.press(select);
      await expect(page.getByTestId(step.testId)).toBeVisible();
      await focusByKeys(page, 'card-detail-popover-close');
      await page.keyboard.press(select);
      await expect(page.getByTestId(step.testId)).toHaveCount(0);
    },
    move: (page, step) => keyMove(page, step, select, confirm),
    atDone: async (page) => {
      // The sheet's heading takes focus when it rises (design §9).
      await expect(page.getByTestId('coach-lesson-done').getByRole('heading')).toBeFocused();
    },
  };
}

test('keyboard only: Home to lesson 1 done, Escape on a done sheet goes to Lessons', async ({ page }) => {
  test.setTimeout(120_000);

  await seedSavedGame(page);
  const before = await storageDump(page);

  // Home -> Learn to play -> Start, from the keyboard.
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await focusByKeys(page, 'learn-to-play');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
  await focusByKeys(page, 'tutorial-continue');
  await expect(page.getByTestId('tutorial-continue')).toHaveText('Start');
  await page.keyboard.press('Space');

  // Start opens lesson 1; walk it by keys (Enter to select and press Next, Space to confirm).
  await walkLesson(page, 1, keyboardIO(), [1]);

  // Escape on the done sheet means "Lessons": the lessons screen, with the next one waiting.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
  await expect(page.getByTestId('coach-bubble')).toHaveCount(0);
  await focusByKeys(page, 'tutorial-continue');
  await expect(page.getByTestId('tutorial-continue')).toHaveText('Continue: lesson 2');

  expect(await readProgress(page)).toEqual([1]);
  expectStorageUntouched(before, await storageDump(page));
});
