import { expect, test, type Page } from '@playwright/test';

// Card labels (review N3): in the real GameScreen at 1440x900, staging a 9
// one-off (the longest staged line, name included, at the desktop type
// step) keeps the action bar at its idle height, so
// staging never reflows the board. The test hook only seeds the deal (seed
// "1", dealer Alice, so Blake acts first) and looks up move indices; every
// move is played through taps. Line, found by a search over the real
// engine: Blake plays 2♠ for points; Alice plays her 9♣ as a one-off on it.
// The desktop reserve must also hold the three-line clamp's worst case.

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
  viewer(): 0 | 1 | null;
}

const Kind = { PlayPoint: 1, OneOff: 4 } as const;

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function findMove(page: Page, pattern: RegExp, kind: number): Promise<HookMove> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => m.kind === kind && pattern.test(m.description));
  if (!found) throw new Error(`no legal move matching ${pattern}; have ${JSON.stringify(moves)}`);
  return found;
}

async function passThePhone(page: Page, to: string): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toContainText(to);
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('curtain-gate')).toHaveCount(0);
  if ((await page.getByTestId('recap').count()) > 0) await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function barHeight(page: Page): Promise<number> {
  return page.locator('.game-screen__action-bar').evaluate((el) => el.getBoundingClientRect().height);
}

test('1440x900: staging a 9 one-off keeps the action bar at its idle height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await hook(page, (h) => h.newGame('1', 0));
  await passThePhone(page, 'Blake');
  expect(await hook(page, (h) => h.viewer())).toBe(1);

  const point = await findMove(page, /^play 2. as point card$/, Kind.PlayPoint);
  await page.getByTestId(`hand-card-${point.handIndex}`).click();
  await page.getByTestId('zone-points').click();
  await page.getByTestId('staging-confirm').click();
  await passThePhone(page, 'Alice');
  expect(await hook(page, (h) => h.viewer())).toBe(0);

  const idle = await barHeight(page);
  const boardIdle = await page.getByTestId('board').evaluate((el) => el.getBoundingClientRect().height);

  const nine = await findMove(page, /^play 9. as one-off$/, Kind.OneOff);
  expect(nine.targetKey).toBe('point:1:0');
  await page.getByTestId(`hand-card-${nine.handIndex}`).click();
  await page.getByTestId('point-1-0').click();
  await page.getByTestId(`ambiguity-chooser-option-${nine.index}`).click();
  await expect(page.getByTestId('staging-bar')).toContainText(/^Send Back Play 9. as a one-off: back to their hand/);

  expect(await barHeight(page)).toBeCloseTo(idle, 0);
  expect(await page.getByTestId('board').evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(boardIdle, 0);
  const clipped = await page
    .locator('.staging-bar__description')
    .evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);

  // The reserve covers the clamp's worst case, not just this line: three
  // lines of the description plus the bar's padding fit the idle height, so
  // a longer themed name can't grow the bar either.
  const worstCase = await page.locator('.staging-bar').evaluate((bar) => {
    const p = bar.querySelector('.staging-bar__description') as HTMLElement;
    const cs = getComputedStyle(p);
    const pad = parseFloat(getComputedStyle(bar).paddingTop) + parseFloat(getComputedStyle(bar).paddingBottom);
    return 3 * parseFloat(cs.lineHeight) + pad;
  });
  expect(worstCase).toBeLessThanOrEqual(idle + 0.5);
});
