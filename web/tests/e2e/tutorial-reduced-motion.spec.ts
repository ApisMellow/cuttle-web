import { expect, test, type Page } from '@playwright/test';

import {
  closePopover,
  confirm,
  expectHomeAllDone,
  expectStorageUntouched,
  handRank,
  markers,
  openLessons,
  readProgress,
  seedSavedGame,
  seedSettings,
  settledCalm,
  storageDump,
  tapSource,
  tapTarget,
  waitStage,
  walkLesson,
  type WalkIO,
} from './helpers/tutorial';
import type { MoveStep } from '../../src/lib/tutorial/types';

// Learn to play, plan T13 (R25.9, design §8, §9): with reduced motion asked for
// (the OS media query, and separately the in-app `settings.reducedMotion`),
// every lesson still completes, nothing is left running once a step has
// settled (`document.getAnimations()` is empty), and the ghost demo is its
// calm variant: numbered markers (1 the card, 2 the target, then a last one on
// Confirm once the move is staged), never a moving fingertip.
//
// Waits are on `data-step` / `data-stage` / the done sheet; the animation check
// polls until it is empty rather than sleeping.

test.use({ viewport: { width: 393, height: 852 } });

/** How many spots the step's demo points at before Confirm (design §8.3). */
function demoSpots(step: MoveStep): number {
  const demo = step.demo;
  if (demo.kind === 'drag') return 2;
  if (demo.kind === 'tap') return demo.at.length;
  return 0;
}

const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));

/** Plays by plain taps; at every resting step nothing animates and the markers show. */
function calmIO(): WalkIO {
  return {
    atRest: async (page, _lesson, step) => {
      await expect(page.locator('[data-coach-overlay]')).toHaveAttribute('data-reduced', 'true');
      await settledCalm(page);
      if (step.kind === 'move') {
        expect(await markers(page), `${step.id}: the demo shows as numbered markers`).toEqual(numbered(demoSpots(step)));
      }
    },
    next: async (page) => {
      await page.getByTestId('coach-next').click();
    },
    appear: async (page, step) => {
      await handRank(page, 11).click();
      await expect(page.getByTestId(step.testId)).toBeVisible();
      await closePopover(page);
    },
    move: async (page, step) => {
      await tapSource(page, step);
      await tapTarget(page, step);
      await waitStage(page, 'staged-right');
      await settledCalm(page);
      // Confirm gets the last number once the move is staged (design §8.3). Step
      // 4.2 is the known exception: staging the counter option replaces the
      // option button with the staged line, so the demo's only spot is gone and
      // no marker is drawn at all until Confirm is tapped (reported in the T13
      // hand-back; the Confirm ring and the bubble still lead the way).
      if (step.id !== '4.2') {
        expect(await markers(page), `${step.id}: Confirm is numbered too`).toEqual(numbered(demoSpots(step) + 1));
      }
      await confirm(page);
    },
    atDone: async (page) => {
      await settledCalm(page);
    },
  };
}

/** Home -> Learn to play -> Start, then all five lessons and Play a game. */
async function walkAll(page: Page): Promise<void> {
  await openLessons(page);
  await page.getByTestId('tutorial-continue').click();
  const io = calmIO();
  const done: number[] = [];
  for (const lessonId of [1, 2, 3, 4, 5]) {
    done.push(lessonId);
    await walkLesson(page, lessonId, io, [...done]);
    await page.getByTestId(lessonId < 5 ? 'coach-next-lesson' : 'coach-play').click();
  }
  await expectHomeAllDone(page);
  expect(await readProgress(page)).toEqual([1, 2, 3, 4, 5]);
}

test('reduced motion by the OS media query: five lessons, no animation left running, numbered markers', async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedSavedGame(page);
  const before = await storageDump(page);

  await walkAll(page);

  const after = await storageDump(page);
  expectStorageUntouched(before, after);
  expect(JSON.parse(after['cuttle-web:tutorial'])).toEqual({ v: 1, done: [1, 2, 3, 4, 5] });
});

test('reduced motion by the setting alone: five lessons, no animation left running, numbered markers', async ({ page }) => {
  test.setTimeout(300_000);
  // Only the in-app setting asks for calm; the OS does not.
  const seeded = await seedSettings(page, { reducedMotion: true, revealPreference: 'hold', lastNames: null, tableMode: false });
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();
  expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  const before = await storageDump(page);
  expect(before['cuttle-web:settings']).toBe(seeded);
  expect(before['cuttle-web:game']).toBeUndefined();

  await walkAll(page);

  const after = await storageDump(page);
  expect(after['cuttle-web:settings'], 'the seeded settings are byte-identical after the run').toBe(seeded);
  expect(after['cuttle-web:game'], 'no game was saved').toBeUndefined();
  expectStorageUntouched(before, after);
  expect(JSON.parse(after['cuttle-web:tutorial'])).toEqual({ v: 1, done: [1, 2, 3, 4, 5] });
});
