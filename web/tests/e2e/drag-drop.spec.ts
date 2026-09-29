import { expect, test, type Page } from '@playwright/test';

import { plainMoveText } from '../../src/lib/recap';

// Issue #26: drag a hand card onto a zone, then Confirm. Real touch input
// (Chromium's CDP `Input.dispatchTouchEvent`, so the browser's own gesture
// handling runs: tap slop, scrolling, click synthesis) at the iPhone 15
// viewport, 393x852. Golden deal (SPEC §2.6, seed 42, dealer P2): Alice
// acts first holding 2♥ 3♣ A♥ K♦ Q♣. The hook only seeds the deal and reads
// moves/curtain/seq; every move is made through the real UI.

interface HookMove {
  index: number;
  kind: number;
  handIndex: number;
  targetKey: string | null;
  description: string;
}

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  moves(): HookMove[];
  curtain(): string;
  seq(): number;
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function startGolden(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(5);
}

/** 2♥ for points: its hand index and the staging text Confirm will show. */
async function twoForPoints(page: Page): Promise<{ handIndex: number; text: string }> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description));
  if (!found) throw new Error(`no 2 for points in ${JSON.stringify(moves)}`);
  return { handIndex: found.handIndex, text: plainMoveText(found.description) };
}

async function centre(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The left, always-visible slice of a fanned hand card. */
async function cardGrip(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + 16, y: box.y + box.height / 2 };
}

interface Touch {
  start(p: { x: number; y: number }): Promise<void>;
  move(p: { x: number; y: number }): Promise<void>;
  end(): Promise<void>;
}

async function touch(page: Page): Promise<Touch> {
  const cdp = await page.context().newCDPSession(page);
  let last = { x: 0, y: 0 };
  return {
    async start(p) {
      last = p;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    },
    async move(p) {
      // Several small steps, as a finger reports them.
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = last.x + ((p.x - last.x) * i) / steps;
        const y = last.y + ((p.y - last.y) * i) / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      last = p;
    },
    async end() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

test.describe('touch, 393x852', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test('drag a card to the points zone, then Confirm; nothing of the drag reaches the curtain', async ({ page }) => {
    await startGolden(page);
    const { handIndex, text } = await twoForPoints(page);
    const card = page.getByTestId(`hand-card-${handIndex}`);
    const finger = await touch(page);

    await finger.start(await cardGrip(page, `hand-card-${handIndex}`));
    const target = await centre(page, 'zone-points');
    await finger.move({ x: target.x, y: target.y + 40 });
    // Mid-drag: the card follows the finger; only its legal zones are lit.
    await expect(card).toHaveAttribute('data-dragging', 'true');
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('zone-points')).toHaveAttribute('data-state', 'highlighted');
    await expect(page.getByTestId('zone-permanents')).toHaveAttribute('data-state', 'normal');
    await finger.move(target);
    await finger.end();

    // The drop only stages (R12).
    await expect(page.getByTestId('staging-bar')).toContainText(text);
    await expect(card).toHaveAttribute('data-dragging', 'false');
    expect(await hook(page, (h) => h.seq())).toBe(0);

    await page.getByTestId('staging-confirm').tap();
    await expect(page.getByTestId('curtain-gate')).toBeVisible();
    await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
    expect(await hook(page, (h) => h.seq())).toBe(1);
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
    await expect(page.locator('[data-dragging]')).toHaveCount(0);
  });

  test('a drop on an illegal zone snaps the card back, unselected', async ({ page }) => {
    await startGolden(page);
    const { handIndex } = await twoForPoints(page);
    const card = page.getByTestId(`hand-card-${handIndex}`);
    const home = await card.boundingBox();
    const finger = await touch(page);

    await finger.start(await cardGrip(page, `hand-card-${handIndex}`));
    await finger.move(await centre(page, 'zone-permanents')); // a 2 is never a permanent
    await expect(page.getByTestId('zone-permanents')).toHaveAttribute('data-state', 'normal');
    await finger.end();

    await expect(page.getByTestId('staging-bar')).toHaveCount(0);
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await expect(card).toHaveAttribute('data-dragging', 'false');
    await expect(page.getByTestId('zone-points')).toHaveAttribute('data-state', 'normal');
    await expect.poll(async () => (await card.boundingBox())?.y).toBeCloseTo(home?.y ?? -1, 0);
    await expect.poll(async () => (await card.boundingBox())?.x).toBeCloseTo(home?.x ?? -1, 0);
    expect(await hook(page, (h) => h.seq())).toBe(0);
  });

  test('tap, tap, Confirm still works', async ({ page }) => {
    await startGolden(page);
    const { handIndex, text } = await twoForPoints(page);
    await page.getByTestId(`hand-card-${handIndex}`).tap();
    await expect(page.getByTestId(`hand-card-${handIndex}`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('zone-points').tap();
    await expect(page.getByTestId('staging-bar')).toContainText(text);
    await page.getByTestId('staging-confirm').tap();
    await expect(page.getByTestId('curtain-gate')).toBeVisible();
    expect(await hook(page, (h) => h.seq())).toBe(1);
  });

  test('a move under the 8 px threshold is a tap: the card is selected, not dragged', async ({ page }) => {
    await startGolden(page);
    const { handIndex } = await twoForPoints(page);
    const card = page.getByTestId(`hand-card-${handIndex}`);
    const grip = await cardGrip(page, `hand-card-${handIndex}`);
    const finger = await touch(page);

    await finger.start(grip);
    await finger.move({ x: grip.x + 3, y: grip.y - 4 }); // 5 px
    await expect(card).toHaveAttribute('data-dragging', 'false');
    await finger.end();

    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('zone-points')).toHaveAttribute('data-state', 'highlighted');
    await expect(page.getByTestId('staging-bar')).toHaveCount(0);
  });
});

test('short 393x660 view: a drag does not scroll the board, and still stages', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 660 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await startGolden(page);
    const { handIndex, text } = await twoForPoints(page);
    const board = page.getByTestId('board');
    const before = await board.evaluate((el) => el.scrollTop);
    const finger = await touch(page);

    await finger.start(await cardGrip(page, `hand-card-${handIndex}`));
    await finger.move(await centre(page, 'zone-points'));
    expect(await board.evaluate((el) => el.scrollTop)).toBe(before);
    await finger.end();

    await expect(page.getByTestId('staging-bar')).toContainText(text);
    expect(await board.evaluate((el) => el.scrollTop)).toBe(before);
  } finally {
    await context.close();
  }
});

test('mouse: press, drag and release on the points zone stages the move', async ({ page }) => {
  await startGolden(page);
  const { handIndex, text } = await twoForPoints(page);
  const grip = await cardGrip(page, `hand-card-${handIndex}`);
  const target = await centre(page, 'zone-points');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(page.getByTestId(`hand-card-${handIndex}`)).toHaveAttribute('data-dragging', 'true');
  await page.mouse.up();
  await expect(page.getByTestId('staging-bar')).toContainText(text);
  await expect(page.getByTestId(`hand-card-${handIndex}`)).toHaveAttribute('data-staged', 'true');
  await expect(page.getByTestId(`hand-card-${handIndex}`)).toHaveAttribute('data-dragging', 'false');
  expect(await hook(page, (h) => h.seq())).toBe(0);
});

test('reduced motion: the snap back has no animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await startGolden(page);
  const duration = await page
    .getByTestId('hand-card-0')
    .evaluate((el) => getComputedStyle(el).transitionDuration.split(',').map((d) => d.trim()));
  expect(duration.every((d) => d === '0s')).toBe(true);
});
