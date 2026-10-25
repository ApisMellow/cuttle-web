import { expect, test, type Page } from '@playwright/test';

import {
  expectHomeAllDone,
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

// Learn to play, plan T13 (R25.10, design §9): the whole tutorial from the
// keyboard at 393x852. Tab moves focus (nothing here calls focus()), Enter and
// Space activate; the two keys alternate between lessons so both are proved.
// Focus is never parked on <body> at a step the learner has to act on, and
// Escape on a done sheet means "Lessons".
//
// Waits are on `data-step` / `data-stage` / the done sheet.

test.use({ viewport: { width: 393, height: 852 } });

/** Enter in odd lessons, Space in even ones (the Confirm key swaps the other way). */
const keyFor = (lessonId: number): { select: ActivateKey; confirm: ActivateKey } =>
  lessonId % 2 === 1 ? { select: 'Enter', confirm: 'Space' } : { select: 'Space', confirm: 'Enter' };

function keyboardIO(lessonId: number): WalkIO {
  const { select, confirm } = keyFor(lessonId);
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

/** Next lesson, by keys. */
async function nextLessonByKeys(page: Page, key: ActivateKey): Promise<void> {
  await focusByKeys(page, 'coach-next-lesson');
  await page.keyboard.press(key);
}

test('keyboard only: Home to "You\'ve learned Cuttle", Escape on a done sheet goes to Lessons', async ({ page }) => {
  test.setTimeout(300_000);

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

  const done: number[] = [];
  for (const lessonId of [1, 2, 3, 4, 5]) {
    done.push(lessonId);
    await walkLesson(page, lessonId, keyboardIO(lessonId), [...done]);

    if (lessonId === 2) {
      // Escape on the done sheet means "Lessons": the lessons screen, with the next one waiting.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
      await expect(page.getByTestId('coach-bubble')).toHaveCount(0);
      await focusByKeys(page, 'tutorial-continue');
      await expect(page.getByTestId('tutorial-continue')).toHaveText('Continue: lesson 3');
      await page.keyboard.press('Enter');
    } else if (lessonId < 5) {
      await nextLessonByKeys(page, keyFor(lessonId).confirm);
    } else {
      await focusByKeys(page, 'coach-play');
      await expect(page.getByTestId('coach-play')).toHaveText('Play a game');
      await page.keyboard.press('Space');
    }
  }

  await expectHomeAllDone(page);
  expect(await readProgress(page)).toEqual([1, 2, 3, 4, 5]);
  expectStorageUntouched(before, await storageDump(page));
});
