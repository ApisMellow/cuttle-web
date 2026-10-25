import { expect, test, type Page } from '@playwright/test';

import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonPosition } from '../../src/lib/tutorial/types';

// Issue #93 (SPEC §4.3): the counter rewind in a real browser, through the
// real wasm engine. Each game starts from a saved position (the tutorial's
// `positionSnapshot`, Alice to move) resumed from Home, so the position is
// exact; every move after that is made through the real UI. The hook only
// reads the curtain and the move list.
//
// Touch cases at 393x852 drive Chromium's own touch input (CDP), as
// drag-drop.spec.ts does. One desktop case uses the mouse and keyboard.

interface HookMove {
  index: number;
  kind: number;
  handIndex: number;
  targetKey: string | null;
  description: string;
  revealIndex: number | null;
}

interface Hook {
  moves(): HookMove[];
  curtain(): string;
  viewer(): 0 | 1 | null;
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

const SAVE_KEY = 'cuttle-web:game';

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

/** Resumes the saved position from Home and passes the resume gate to Alice's board. */
async function startAt(page: Page, pos: LessonPosition): Promise<void> {
  await page.goto('/');
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAVE_KEY, save(pos)] as const);
  await page.reload();
  await page.getByTestId('resume').click();
  await passCurtain(page);
}

async function passCurtain(page: Page): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function handIndexOf(page: Page, pattern: RegExp): Promise<number> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => pattern.test(m.description));
  if (!found) throw new Error(`no move ${pattern} in ${JSON.stringify(moves)}`);
  return found.handIndex;
}

/** Plays a hand card as a one-off by tap, tap (its target: the one-off zone, or the card a 9 aims at), Confirm. */
async function oneOff(page: Page, pattern: RegExp): Promise<void> {
  const moves = await hook(page, (h) => h.moves());
  const move = moves.find((m) => pattern.test(m.description));
  if (!move || move.targetKey === null) throw new Error(`no move ${pattern} in ${JSON.stringify(moves)}`);
  await page.getByTestId(`hand-card-${move.handIndex}`).click();
  await page.getByTestId(move.targetKey.replace(/:/g, '-')).click();
  await page.getByTestId('staging-confirm').click();
}

async function centre(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function cardGrip(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + 16, y: box.y + box.height / 2 };
}

/** Drags a hand card onto a target with a real finger. */
async function dragTo(page: Page, handIndex: number, testId: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const from = await cardGrip(page, `hand-card-${handIndex}`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  // Past the 8 px threshold first, so the drag starts and the marker lights.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y - 20 }] });
  await expect(page.getByTestId('counter-link')).toHaveAttribute('data-state', 'highlighted');
  const to = await centre(page, testId);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y - 20 + ((to.y - (from.y - 20)) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function lastMove(page: Page): Promise<string> {
  return (await page.getByTestId('center-zone').locator('p').first().textContent()) ?? '';
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Alice's 9♥ sends Blake's 10♥ home (a 9 can't scuttle a 10, so there's no chooser); both hold a 2. */
const CHAIN: LessonPosition = {
  aliceHand: [c(9, 'H'), c(2, 'D'), c(10, 'C')],
  alicePoints: [],
  blakeHand: [c(2, 'C'), c(7, 'D')],
  blakePoints: [c(10, 'H')],
  scrap: [],
  deckTop: [c(5, 'C'), c(6, 'C'), c(4, 'H'), c(3, 'H')],
};

/** Alice at 13: her 7 reveals 10♥, for 23 on a counterable turn. Blake holds 2♣. */
const PENDING_WIN: LessonPosition = {
  aliceHand: [c(7, 'C'), c(9, 'H')],
  alicePoints: [c(10, 'S'), c(3, 'S')],
  blakeHand: [c(2, 'C'), c(5, 'D')],
  blakePoints: [],
  scrap: [],
  deckTop: [c(10, 'H'), c(4, 'D'), c(6, 'C')],
};

/** Alice's 4♠ leaves Blake owing two; he holds 2♣. */
const OWED: LessonPosition = {
  aliceHand: [c(4, 'S'), c(9, 'H')],
  alicePoints: [],
  blakeHand: [c(2, 'C'), c(7, 'D'), c(13, 'C')],
  blakePoints: [],
  scrap: [],
  deckTop: [c(5, 'C'), c(6, 'C')],
};

/** Alice plays the 7, then picks the revealed 10♥ for points. */
async function aliceWinsWithSeven(page: Page): Promise<void> {
  await oneOff(page, /^play 7♣ as one-off/);
  await expect(page.getByTestId('seven-reveal')).toBeVisible();
  const moves = await hook(page, (h) => h.moves());
  const pick = moves.find((m) => m.revealIndex !== null && m.targetKey === 'zone:points' && /10♥/.test(m.description));
  if (!pick) throw new Error(`no 10♥ pick in ${JSON.stringify(moves)}`);
  await page.getByTestId(`seven-card-${pick.revealIndex}`).click();
  await page.getByTestId('zone-points').click();
  await page.getByTestId('staging-confirm').click();
}

// ---------------------------------------------------------------------------
// Touch, 393x852
// ---------------------------------------------------------------------------

test.describe('touch, 393x852', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test('a counter and a counter-back: no curtain for either, and each undoes the last turn', async ({ page }) => {
    await startAt(page, CHAIN);
    await oneOff(page, /^play 9♥ as one-off/);
    await passCurtain(page);

    // Blake: nothing marks the counter until the 2 is picked up.
    await expect(page.getByTestId('counter-link')).toHaveAttribute('data-state', 'normal');
    await dragTo(page, await handIndexOf(page, /^counter/i), 'counter-link');
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.curtain())).toBe('none');
    expect(await hook(page, (h) => h.viewer())).toBe(1);
    expect(await lastMove(page)).toBe("You countered with 2♣ and undid Alice's last turn.");
    // He plays on: a draw ends his turn.
    await page.getByTestId('deck-pile').click();
    await page.getByTestId('staging-confirm').click();
    await passCurtain(page);

    // Alice counters back, by tap, tap, Confirm.
    const two = await handIndexOf(page, /^counter/i);
    await page.getByTestId(`hand-card-${two}`).click();
    await expect(page.getByTestId('counter-link')).toHaveAttribute('data-state', 'highlighted');
    await page.getByTestId('counter-link').click();
    await expect(page.getByTestId('staging-bar')).toContainText("Counter with 2♦: undo Blake's last turn.");
    await page.getByTestId('staging-confirm').click();
    await expect(page.getByTestId('staging-bar')).toHaveCount(0);
    expect(await hook(page, (h) => h.curtain())).toBe('none');
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    expect(await lastMove(page)).toBe("You countered with 2♦ and undid Blake's last turn.");
  });

  test('a pending win, let happen: "Not So Fast!", the handoff, one tap, and Alice wins', async ({ page }) => {
    await startAt(page, PENDING_WIN);
    await aliceWinsWithSeven(page);
    const beat = page.getByTestId('not-so-fast');
    await expect(beat).toContainText('Not So Fast!');
    await expect(beat.getByRole('button')).toHaveCount(0);
    await beat.tap();
    await passCurtain(page);

    await expect(page.getByTestId('not-so-fast')).toHaveCount(0);
    await expect(page.getByTestId('let-it-happen')).toHaveCount(1);
    const box = await page.getByTestId('let-it-happen').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await expect(page.locator('[data-testid^="hand-card-"][aria-pressed="true"]')).toHaveCount(0);
    await page.getByTestId('let-it-happen').tap();
    await expect(page.getByTestId('result-screen')).toBeVisible();
    await expect(page.getByTestId('result-screen')).toContainText('Alice');
  });

  test('a pending win, countered: Blake drags his 2 onto the marker and plays on', async ({ page }) => {
    await startAt(page, PENDING_WIN);
    await aliceWinsWithSeven(page);
    await page.getByTestId('not-so-fast').tap();
    await passCurtain(page);

    await dragTo(page, await handIndexOf(page, /^counter/i), 'counter-link');
    await expect(page.getByTestId('let-it-happen')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.curtain())).toBe('none');
    expect(await hook(page, (h) => h.viewer())).toBe(1);
    expect(await lastMove(page)).toBe("You countered with 2♣ and undid Alice's last turn.");
  });

  test("a 4 countered at Blake's turn start: the picker goes, no curtain, his turn goes on", async ({ page }) => {
    await startAt(page, OWED);
    await oneOff(page, /^play 4♠ as one-off/);
    await passCurtain(page);

    await expect(page.getByTestId('discard-picker')).toBeVisible();
    await expect(page.getByTestId('counter-link')).toHaveAttribute('data-state', 'normal');
    await dragTo(page, await handIndexOf(page, /^counter/i), 'counter-link');
    await expect(page.getByTestId('discard-picker')).toHaveCount(0);
    expect(await hook(page, (h) => h.curtain())).toBe('none');
    expect(await hook(page, (h) => h.viewer())).toBe(1);
    const kinds = await hook(page, (h) => h.moves().map((m) => m.description));
    expect(kinds).toContain('draw a card');
  });
});

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

test.describe('desktop, 1280x800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the beat leaves on its own after 3 s; "Let it happen" by keyboard', async ({ page }) => {
    await startAt(page, PENDING_WIN);
    await aliceWinsWithSeven(page);
    await expect(page.getByTestId('not-so-fast')).toBeVisible();
    // No input: the 3 s wait raises the handoff to Blake.
    await expect(page.getByTestId('curtain-gate')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('not-so-fast')).toHaveCount(0);
    await passCurtain(page);

    await page.getByTestId('let-it-happen').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('result-screen')).toBeVisible();
  });
});
