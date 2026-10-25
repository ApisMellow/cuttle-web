import { expect, test, type Page } from '@playwright/test';

import {
  BEAT_MS,
  CANCEL_SUFFIX,
  bubble,
  coachTargets,
  coachText,
  expectHomeAllDone,
  expectStorageUntouched,
  handRank,
  newFinger,
  nudgeTexts,
  openLesson,
  playThrough,
  press,
  readProgress,
  seedSavedGame,
  stageWrong,
  storageDump,
  touchMove,
  waitStage,
  walkLesson,
  wrongSetup,
  type Finger,
  type WalkIO,
} from './helpers/tutorial';
import type { MoveStep } from '../../src/lib/tutorial/types';

// Learn to play, plan T13 (R25.7 criterion L3): a player's walk through all
// five lessons by touch, at 393x852. Real touch input (Chromium's
// CDP `Input.dispatchTouchEvent`, so the browser's own gesture handling runs):
// play moves are DRAGGED onto their target, the deck and the counter are
// TAPPED. Each lesson also gets one deliberate wrong staging (the coach must
// call it wrong, spotlight Cancel and say nothing about Confirm), then Cancel
// and the right move; lesson 4 also gets one "Let it resolve" tap.
//
// Every wait is on `data-step` / `data-stage` / the done sheet. Nothing here
// asserts exact success copy or bubble positions: stages, testids, the nudge
// suffix, the sheet headings and storage only (the copy is read from LESSONS).

const viewport = { width: 393, height: 852 } as const;

/** The step in each lesson that gets the deliberate wrong staging (design §7.2). */
const WRONG_STEP: Record<number, string> = { 1: '1.5', 2: '2.1', 3: '3.1', 4: '4.1', 5: '5.1' };

/** The wrong move is staged, the coach says so, and Cancel returns the step to idle. */
async function wrongThenCancel(page: Page, lessonStepId: string, step: MoveStep): Promise<void> {
  const setup = wrongSetup(lessonStepId);
  if (!setup) throw new Error(`no wrong setup for ${lessonStepId}`);
  await stageWrong(page, setup, 'tap');
  await waitStage(page, 'staged-wrong');

  const text = await coachText(page);
  expect(text.endsWith(CANCEL_SUFFIX), `"${text}" must end with the Cancel sentence`).toBe(true);
  const nudge = text.slice(0, -CANCEL_SUFFIX.length);
  expect(nudgeTexts(step), 'the line before the Cancel sentence is one of the step\'s nudges').toContain(nudge);
  await expect(bubble(page)).not.toContainText(/confirm/i);
  expect(await coachTargets(page), 'Cancel is the one spotlit control').toEqual(['staging-cancel']);
  await expect(page.locator('[data-coach-hole]')).toHaveCount(1);

  await page.getByTestId('staging-cancel').tap();
  await waitStage(page, 'idle');
}

/** Lesson 4, step 4.2: "Let it resolve" is the one wrong move; the prompt comes back usable. */
async function declineThenCounter(page: Page, step: MoveStep): Promise<void> {
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  await page.getByTestId('counter-resolve').tap();
  await waitStage(page, 'refused');

  const text = await coachText(page);
  expect(nudgeTexts(step), 'a refusal shows the nudge').toContain(text);
  expect(text, 'a refusal has no Cancel sentence').not.toContain('Tap Cancel');
  // A fresh prompt: its counter option and "Let it resolve" are both present and enabled.
  const prompt = page.getByTestId('counter-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('[data-testid^="counter-option-"]').first()).toBeEnabled();
  await expect(page.getByTestId('counter-resolve')).toBeEnabled();
}

function touchIO(finger: Finger): WalkIO {
  return {
    next: async (page) => {
      await page.getByTestId('coach-next').tap();
    },
    appear: async (page, step) => {
      // Step 5.3: tap the other Jack; the popover is the step's element.
      await handRank(page, 11).tap();
      await expect(page.getByTestId(step.testId)).toBeVisible();
      await page.getByTestId('card-detail-popover-close').tap();
    },
    beforeMove: async (page, lesson, step) => {
      if (step.id === '4.2') {
        await declineThenCounter(page, step);
      } else if (WRONG_STEP[lesson.id] === step.id) {
        await wrongThenCancel(page, step.id, step);
      }
    },
    move: (page, step) => touchMove(page, finger, step),
  };
}

{
  test.describe(`touch ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('Home to "You\'ve learned Cuttle": all five lessons by drag and tap', async ({ page }) => {
      test.setTimeout(180_000);

      // A real saved game and its settings must come through the whole run byte-identical.
      await seedSavedGame(page);
      const before = await storageDump(page);
      expect(before['cuttle-web:game'], 'the seeded game is saved').toBeTruthy();
      expect(before['cuttle-web:settings'], 'the names are saved').toBeTruthy();
      expect(before['cuttle-web:tutorial'], 'no tutorial progress yet').toBeUndefined();

      // Home -> Learn to play -> Start.
      await page.getByTestId('learn-to-play').tap();
      await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
      await expect(page.getByTestId('tutorial-continue')).toHaveText('Start');
      await page.getByTestId('tutorial-continue').tap();

      const io = touchIO(await newFinger(page));
      const done: number[] = [];
      for (const lessonId of [1, 2, 3, 4, 5]) {
        done.push(lessonId);
        await walkLesson(page, lessonId, io, [...done]);
        if (lessonId < 5) {
          await page.getByTestId('coach-next-lesson').tap();
        } else {
          await expect(page.getByTestId('coach-play')).toHaveText('Play a game');
          await page.getByTestId('coach-play').tap();
        }
      }

      await expectHomeAllDone(page);
      expect(await readProgress(page)).toEqual([1, 2, 3, 4, 5]);
      const after = await storageDump(page);
      expectStorageUntouched(before, after);
      expect(JSON.parse(after['cuttle-web:tutorial'])).toEqual({ v: 1, done: [1, 2, 3, 4, 5] });
    });
  });
}

// ---------------------------------------------------------------------------
// Leave from the middle of a lesson, with a press that lasts (the regression:
// a finger rests ~100 ms, and the first tap must still act).
// ---------------------------------------------------------------------------

test.describe('touch 393x852: Leave', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test('Leave from a mid-lesson step lands on the lessons screen on the first tap, and saves nothing', async ({ page }) => {
    test.setTimeout(120_000);
    await openLesson(page, 3);
    await playThrough(page, 3, '3.2');
    await waitStage(page, 'idle', BEAT_MS);
    await expect(bubble(page)).toHaveAttribute('data-step', '3.2');

    await press(page, await newFinger(page), page.getByTestId('coach-leave'), 100);
    await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
    await expect(bubble(page)).toHaveCount(0);
    expect(await readProgress(page), 'leaving a lesson does not finish it').toBeNull();
  });
});
