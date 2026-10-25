import { expect, test, type Page } from '@playwright/test';

import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonPosition } from '../../src/lib/tutorial/types';

// Issue #53 (SPEC §4.8): an Ace's wipe in a real browser, through the real
// wasm engine. The game starts from a saved position (the tutorial's
// `positionSnapshot`, Alice to move) resumed from Home; every move after
// that is made through the real UI. The hook only reads the move list.

interface HookMove {
  index: number;
  kind: number;
  handIndex: number;
  targetKey: string | null;
  description: string;
}

interface Hook {
  moves(): HookMove[];
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

const SAVE_KEY = 'cuttle-web:game';
const ONE_OFF = 4;

/** Alice's only one-off is the Ace; both sides have point cards. */
const POSITION: LessonPosition = {
  aliceHand: [c(1, 'H'), c(10, 'D')],
  alicePoints: [c(7, 'C')],
  blakeHand: [c(3, 'D'), c(13, 'H')],
  blakePoints: [c(9, 'D'), c(6, 'C')],
  scrap: [],
  deckTop: [c(9, 'C'), c(12, 'D')],
};

function save(pos: LessonPosition): string {
  return JSON.stringify({
    v: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    engineState: positionSnapshot(pos),
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Blake'],
    seed: '0',
    dealer: 1,
  });
}

async function passCurtain(page: Page): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function startAt(page: Page, pos: LessonPosition): Promise<void> {
  await page.goto('/');
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAVE_KEY, save(pos)] as const);
  await page.reload();
  await page.getByTestId('resume').click();
  await passCurtain(page);
}

async function playAce(page: Page): Promise<void> {
  const moves = await hook(page, (h) => h.moves());
  const ace = moves.find((m) => m.kind === ONE_OFF);
  if (!ace || ace.targetKey === null) throw new Error(`no Ace one-off in ${JSON.stringify(moves)}`);
  await page.getByTestId(`hand-card-${ace.handIndex}`).click();
  await page.getByTestId(ace.targetKey.replace(/:/g, '-')).click();
  await page.getByTestId('staging-confirm').click();
}

/** The mover's show over Alice's board, then (on its own, after 1.2 s) the handoff to Blake. */
async function showThenHandoff(page: Page): Promise<void> {
  const show = page.getByTestId('wipe-effect');
  await expect(show).toHaveAttribute('data-mode', 'show');
  await expect(show.locator('[data-part="wipe-clone"]')).toHaveCount(3);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toHaveCount(0);
  await expect(page.getByTestId('point-0-0')).toHaveCount(0);
  await expect(page.getByTestId('curtain-gate')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('wipe-effect')).toHaveCount(0);
}

test.describe('issue #53: an Ace’s wipe, shown and replayed', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test('the show before the pass, then the replay on Blake’s board', async ({ page }) => {
    await startAt(page, POSITION);
    await playAce(page);
    await showThenHandoff(page);

    await passCurtain(page);
    const replay = page.getByTestId('wipe-effect');
    await expect(replay).toHaveAttribute('data-mode', 'replay');
    await expect(replay.locator('[data-part="wipe-clone"]')).toHaveCount(3);
    await expect(page.getByTestId('wipe-effect')).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByTestId('board')).toHaveAttribute('data-inert', 'false');
  });

  test('with Replay effects off, Blake sees no replay; Alice’s show still plays', async ({ page }) => {
    await startAt(page, POSITION);
    await page.getByTestId('menu-button').click();
    const toggle = page.getByTestId('menu-replay-effects');
    const box = await toggle.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(toggle.locator('input')).toBeChecked();
    await toggle.click();
    await expect(toggle.locator('input')).not.toBeChecked();
    await page.getByTestId('menu-close').click();

    await playAce(page);
    await showThenHandoff(page);
    await passCurtain(page);
    await expect(page.getByTestId('wipe-effect')).toHaveCount(0);
    await expect(page.getByTestId('board')).toHaveAttribute('data-inert', 'false');
  });
});
