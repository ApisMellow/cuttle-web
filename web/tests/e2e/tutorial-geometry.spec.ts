import { expect, test, type Page } from '@playwright/test';

import {
  BEAT_MS,
  bubble,
  cancel,
  closePopover,
  geometryProblems,
  handRank,
  openLesson,
  openLessons,
  playExpected,
  playThrough,
  reach,
  settled,
  shot,
  stageWrong,
  stepsOf,
  tapSource,
  tapTarget,
  waitStage,
  waitStep,
  wrongSetup,
  confirm,
  type Reading,
} from './helpers/tutorial';
import type { MoveStep } from '../../src/lib/tutorial/types';

// Learn to play, plan T12 (R25.7, criterion L2): design §7.3 holds at 393x852
// for a representative set of steps (see STOP_AFTER). For each step walked and
// each stage the helper can reach (idle, selected, staged-right, staged-wrong,
// refused, the success and Blake beats, the done sheet):
//   - the bubble box intersects no `[data-coach-hole]`, `staging-bar`,
//     `menu-button` or `discard-picker`, nor `counter-link` once a 2 lights
//     it (4.2, issue #93);
//   - every spotlit target is really hit-testable at its centre, which proves
//     the overlay's scrollIntoView worked at 393x660 (jsdom can't);
//   - scrollWidth <= clientWidth on the page, the game screen, the board, the
//     bubble and the done sheet;
//   - every new testid on the page is at least 44x44.
// Waits are on `data-step` / `data-stage`, then a rAF poll until the geometry
// stops changing. No fixed timeouts.

// One viewport (393x852, the primary phone) and a small representative set:
// every lesson's first move step, plus lessons 1 and 4 played to their done
// sheet (1 is all next-steps and one move; 4 holds the owed discard and the
// counter from the board, the widest bubble-avoidance case). `null` = play the lesson to the end.
const VIEWPORT = { width: 393, height: 852 };
const STOP_AFTER: Record<number, string | null> = { 1: null, 2: '2.1', 3: '3.1', 4: null, 5: '5.1' };
const LESSON_IDS = [1, 2, 3, 4, 5] as const;

/** Records a reading's problems under a label; the test asserts the whole list at its end. */
function recorder(viewport: { width: number; height: number }, found: string[]) {
  return (label: string, r: Reading): void => {
    for (const p of geometryProblems(r, viewport)) found.push(`${label} (stage ${r.stage}): ${p}`);
  };
}

/** After the expected move's Confirm: the success beat, Blake's beats, then what follows. */
async function afterConfirm(page: Page, lessonId: number, index: number, note: (label: string, r: Reading) => void): Promise<void> {
  const steps = stepsOf(lessonId);
  const step = steps[index];
  const next = steps[index + 1];
  const label = `${step.id}`;
  note(`${label} success`, await reach(page, 'done'));
  if (step.kind === 'move' && step.blake.length > 0) {
    note(`${label} blake`, await reach(page, 'blake'));
  }
  if (next) {
    await waitStep(page, next.id);
  } else {
    await expect(page.getByTestId('coach-lesson-done')).toBeVisible();
    note(`${label} lesson-done sheet`, await settled(page));
  }
}

{
  const viewport = VIEWPORT;
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const lessonId of LESSON_IDS) {
      test(`lesson ${lessonId}: bubble geometry at every step and stage`, async ({ page }) => {
        test.setTimeout(120_000);
        const found: string[] = [];
        const note = recorder(viewport, found);
        const primary = true;
        const stopAfter = STOP_AFTER[lessonId];
        await openLesson(page, lessonId);
        const steps = stepsOf(lessonId);

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];

          if (step.kind === 'next') {
            note(`${step.id} next`, await reach(page, 'next', step.id));
            await page.getByTestId('coach-next').click();
            if (steps[i + 1]) await waitStep(page, steps[i + 1].id);
            else await expect(page.getByTestId('coach-lesson-done')).toBeVisible();
            if (!steps[i + 1]) note(`${step.id} lesson-done sheet`, await settled(page));
            continue;
          }

          if (step.kind === 'appear') {
            note(`${step.id} appear`, await reach(page, 'appear', step.id));
            await handRank(page, 11).click();
            await expect(page.getByTestId(step.testId)).toBeVisible();
            note(`${step.id} popover up`, await settled(page));
            await closePopover(page);
            await waitStep(page, steps[i + 1].id);
            continue;
          }

          // A move step.
          const idle = await reach(page, 'idle', step.id);
          note(`${step.id} idle`, idle);
          if (primary && step.id === '4.2') await shot(page, 'step-4.2-idle');

          const wrong = wrongSetup(step.id);
          if (wrong) {
            // Wrong staged setup, then Cancel: staged-wrong, then back to idle.
            await stageWrong(page, wrong);
            note(`${step.id} staged-wrong`, await reach(page, 'staged-wrong'));
            if (primary && step.id === '1.5') await shot(page, 'step-1.5-staged-wrong');
            await cancel(page);
            await waitStage(page, 'idle');
            // Again, and this time Confirm anyway: the gate refuses (the backstop).
            await stageWrong(page, wrong);
            await waitStage(page, 'staged-wrong');
            await confirm(page);
            note(`${step.id} refused`, await reach(page, 'refused'));
            if (primary && step.id === '4.2') await shot(page, 'step-4.2-refused');
          }

          // The right move: select, stage, confirm.
          await tapSource(page, step);
          if (step.source.kind === 'hand') {
            note(`${step.id} selected`, await reach(page, 'selected'));
          }
          await tapTarget(page, step);
          note(`${step.id} staged-right`, await reach(page, 'staged-right'));
          if (primary && step.id === '4.2') await shot(page, 'step-4.2-staged');
          await confirm(page);
          await afterConfirm(page, lessonId, i, note);
          if (step.id === stopAfter) break;
        }

        expect(found, found.join('\n')).toEqual([]);
      });
    }

    test('the home and lessons screens: every new testid is at least 44x44 with no sideways scroll', async ({ page }) => {
      const found: string[] = [];
      const note = recorder(viewport, found);
      await page.goto('/');
      await expect(page.getByTestId('learn-to-play')).toBeVisible();
      note('home', await settled(page));
      await openLessons(page);
      note('lessons', await settled(page));
      expect(found, found.join('\n')).toEqual([]);
    });
  });
}

// The "bubble re-places once a dragged card settles at staged-right" case is
// cut (issue #51): a drop applies at once, so a drag no longer reaches
// staged-right and the settling card has no staged state to measure.

// ---------------------------------------------------------------------------
// T14 judge, M2: the success beat must not hide the hit. In 3.1 and 3.2 the
// scuttle lands on one of Blake's point cards, and in 4.1 the Ace sweeps them
// all; the bubble keeps clear of every card of his points row as it was when
// the move was made (the coach gets the flights' boxes from the overlay).
// ---------------------------------------------------------------------------

test.describe('393x852: the success beat keeps the hit in sight', () => {
  const viewport = { width: 393, height: 852 };
  test.use({ viewport });

  const HIT_STEPS: [number, string][] = [
    [4, '4.1'],
  ];

  for (const [lessonId, id] of HIT_STEPS) {
    test(`${id}: at \`done\` the bubble covers none of Blake's point cards it hit or swept`, async ({ page }) => {
      test.setTimeout(120_000);
      await openLesson(page, lessonId);
      await playThrough(page, lessonId, id);
      await waitStep(page, id, BEAT_MS);
      await waitStage(page, 'idle', BEAT_MS);
      const step = stepsOf(lessonId).find((s): s is MoveStep => s.id === id && s.kind === 'move');
      if (!step) throw new Error(`${id} is not a move step`);
      await tapSource(page, step);
      await tapTarget(page, step);
      await waitStage(page, 'staged-right');
      // His points row as the move is made: what the flight hits or sweeps.
      const row = page.locator('[data-testid^="point-1-"]');
      const boxes = (await row.evaluateAll((els) =>
        els
          .filter((el) => /^point-1-\d+$/.test(el.getAttribute('data-testid') ?? ''))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.getAttribute('data-testid') ?? '', box: { x: r.x, y: r.y, width: r.width, height: r.height } };
          }),
      ));
      expect(boxes.length, 'his points row is on the board').toBeGreaterThan(0);
      await confirm(page);
      const reading = await reach(page, 'done');
      expect(reading.bubble).not.toBeNull();
      const covered = boxes.filter((b) => {
        const a = reading.bubble!;
        return a.x < b.box.x + b.box.width && b.box.x < a.x + a.width && a.y < b.box.y + b.box.height && b.box.y < a.y + a.height;
      });
      expect(covered.map((b) => b.id), `bubble ${JSON.stringify(reading.bubble)}`).toEqual([]);
      const problems = geometryProblems(reading, viewport);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// scrollIntoView (design §7.2): at 393x660 the board scrolls, and the coach
// brings the spotlit target into view. jsdom has no layout, so it is proved here.
// ---------------------------------------------------------------------------

test.describe('393x660: the coach scrolls the board to the spotlit target', () => {
  test.use({ viewport: { width: 393, height: 660 } });

  test('down to the player zone, whose bottom edge starts below the fold', async ({ page }) => {
    const found: string[] = [];
    const note = recorder({ width: 393, height: 660 }, found);
    const board = page.getByTestId('board');
    const scrollTop = () => board.evaluate((el) => el.scrollTop);
    await openLesson(page, 1);

    // The first three spotlights (score bar, opponent zone, centre) sit in the
    // top part of the board, so the board stays where it is.
    await reach(page, 'next', '1.1');
    const range = await board.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(range, 'the board must scroll at this height for the test to mean anything').toBeGreaterThan(0);
    for (const id of ['1.1', '1.2', '1.3']) {
      await waitStep(page, id);
      expect(await scrollTop()).toBe(0);
      await page.getByTestId('coach-next').click();
    }

    // 1.4 spotlights the player zone, whose bottom edge is below the fold: the
    // coach scrolls the board down to it (by `scrollIntoView`, instant or smooth).
    await waitStep(page, '1.4');
    await expect.poll(scrollTop).toBe(range);
    note('1.4 after scrolling down', await reach(page, 'next', '1.4'));

    expect(found, found.join('\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Presses on the coach's own controls during a beat (the regression: a press
// that lasts a moment, as a finger does, must act on its first tap and must
// not skip the beat or move the bubble out from under the finger). Show me
// is not offered during a beat (T14 M4), so Leave and the menu button carry it.
// ---------------------------------------------------------------------------

test.describe('realistic presses on Leave and the menu button', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  /** Lesson 2, step 2.1 played: the success beat, then Blake's narration. */
  async function toBeat(page: Page, beat: 'done' | 'blake'): Promise<void> {
    await openLesson(page, 2);
    await reach(page, 'idle', '2.1');
    const step = stepsOf(2)[0];
    if (step.kind !== 'move') throw new Error('lesson 2 starts with a move step');
    await playExpected(page, step);
    await waitStage(page, beat);
  }

  for (const beat of ['done', 'blake'] as const) {
    const name = beat === 'done' ? 'a success beat' : "Blake's narration";

    test(`Leave lands on the lessons screen on the first tap during ${name}`, async ({ page }) => {
      await toBeat(page, beat);
      // pointerdown, about 100 ms, pointerup.
      await page.getByTestId('coach-leave').click({ delay: 100 });
      await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
    });

    // T14 M4: a beat has no demo, so it offers no Show me. The press that
    // must not skip it is the menu button's (an own control too).
    test(`during ${name} there is no Show me, and the menu button neither skips the beat nor moves the bubble`, async ({ page }) => {
      await toBeat(page, beat);
      await expect(page.getByTestId('coach-show-me')).toHaveCount(0);
      // Let the bubble finish placing (rAF poll until the geometry stops changing) before measuring.
      await settled(page);
      const before = await bubble(page).boundingBox();
      await page.getByTestId('menu-button').click({ delay: 100 });
      await expect(page.getByTestId('game-menu')).toBeVisible();
      // The press is one of the coach's own controls: the beat is still the same beat.
      await expect(bubble(page)).toHaveAttribute('data-stage', beat);
      await expect(bubble(page)).toHaveAttribute('data-step', '2.1');
      const after = await bubble(page).boundingBox();
      expect(after).toEqual(before);
    });
  }
});

test.describe('the menu during a lesson', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  // The error phase (a script or engine snag, design §6.2 step 4) cannot be
  // reached through the UI without a test hook that corrupts the lesson table,
  // so this covers the live phases only; the board blocker leaves the menu row
  // free by construction (CoachOverlay) and has a unit test.
  test('menu then Home returns to Home, and the overlay fades while the menu is up', async ({ page }) => {
    await openLesson(page, 2);
    await reach(page, 'idle', '2.1');
    await page.getByTestId('menu-button').click();
    await expect(page.getByTestId('game-menu')).toBeVisible();
    await expect(page.locator('[data-coach-overlay]')).toHaveAttribute('data-covered', 'true');
    await page.getByTestId('menu-home').click();
    await expect(page.getByTestId('learn-to-play')).toBeVisible();
  });
});
