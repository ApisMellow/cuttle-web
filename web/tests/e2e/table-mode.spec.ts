import { expect, test, type Page } from '@playwright/test';

import { plainMoveText } from '../../src/lib/recap';

// Issue #37 (SPEC §5.10): table mode. The phone lies flat between the
// players: player 1 (Alice, seat 0) at its bottom edge, player 2 (Blake,
// seat 1) at its top edge. Player 2's screens are turned 180°, so their side
// of the board lands at the physical top and player 1's at the bottom,
// whoever holds the view. Real touch input at the iPhone 15 viewport,
// 393x852. The hook only seeds the deal (seed 42, dealer Alice, so Blake
// acts first) and reads moves/curtain/seq; every move goes through the UI.

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
  viewer(): 0 | 1 | null;
  seq(): number;
}

type Box = { x: number; y: number; width: number; height: number };

const HEIGHT = 852;

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function box(page: Page, testId: string): Promise<Box> {
  const found = await page.getByTestId(testId).boundingBox();
  if (!found) throw new Error(`${testId} has no box`);
  return found;
}

function midY(b: Box): number {
  return b.y + b.height / 2;
}

/** Home screen -> table mode on (unless `table` is false) -> Alice vs Blake -> Blake's handoff. */
async function startBlakeFirst(page: Page, table = true): Promise<void> {
  await page.goto('/');
  if (table) {
    await page.getByTestId('table-mode-toggle').tap();
    await expect(page.getByTestId('table-mode-toggle').locator('input')).toBeChecked();
  }
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').tap();
  await hook(page, (h) => h.newGame('42', 0));
  await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
}

async function passGate(page: Page): Promise<void> {
  await page.getByTestId('reveal-two-step').tap();
  await page.getByTestId('reveal-two-step').tap();
  await expect(page.getByTestId('board')).toBeVisible();
}

/** A point on `testId` that really hits it (a fanned hand card is partly covered by its neighbour). */
async function grip(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const b = await box(page, testId);
  const y = midY(b);
  for (const x of [b.x + 16, b.x + b.width - 16, b.x + b.width / 2]) {
    const hit = await page.evaluate(
      ([px, py, id]) => document.elementFromPoint(px as number, py as number)?.closest(`[data-testid="${id}"]`) !== null,
      [x, y, testId] as const,
    );
    if (hit) return { x, y };
  }
  throw new Error(`no visible slice of ${testId}`);
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

test.describe('table mode, touch, 393x852', () => {
  test.use({ viewport: { width: 393, height: HEIGHT }, hasTouch: true, isMobile: true });

  test("player 2's board: their hand at the physical top, player 1's side at the bottom; the curtain still hides the hand", async ({ page }) => {
    await startBlakeFirst(page);
    // Blake's handoff is turned for him, and hides every card.
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'true');
    // Nobody passes the phone in table mode: the heading is the name's turn.
    await expect(page.getByTestId('curtain-gate')).toContainText("Blake's turn");
    await expect(page.getByTestId('curtain-gate')).toContainText('Hold to show your hand');
    await expect(page.getByTestId('curtain-gate')).not.toContainText('Pass');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
    await page.getByTestId('reveal-two-step').tap();
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'true');
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
    await page.getByTestId('reveal-two-step').tap();
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.viewer())).toBe(1);

    const hand = await box(page, 'player-hand');
    const mine = await box(page, 'player-zone');
    const theirs = await box(page, 'opponent-zone');
    const oppHand = await box(page, 'opp-hand');
    expect(midY(hand)).toBeLessThan(HEIGHT / 2);
    expect(midY(mine)).toBeLessThan(HEIGHT / 2);
    expect(midY(theirs)).toBeGreaterThan(HEIGHT / 2);
    expect(midY(oppHand)).toBeGreaterThan(HEIGHT / 2);
    expect(midY(hand)).toBeLessThan(midY(oppHand));
    // Still on screen, nothing pushed off an edge by the turn.
    expect(hand.y).toBeGreaterThanOrEqual(0);
    expect(oppHand.y + oppHand.height).toBeLessThanOrEqual(HEIGHT);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('a drag by player 2 in the turned view follows the finger and stages the right zone; then player 1 is upright at the bottom', async ({ page }) => {
    await startBlakeFirst(page);
    await passGate(page);
    const moves = await hook(page, (h) => h.moves());
    const play = moves.find((m) => m.kind === 1);
    if (!play) throw new Error(`no point play in ${JSON.stringify(moves)}`);
    const cardId = `hand-card-${play.handIndex}`;
    const card = page.getByTestId(cardId);

    const from = await grip(page, cardId);
    const before = await box(page, cardId);
    const target = await box(page, 'zone-points');
    const to = { x: target.x + target.width / 2, y: midY(target) };
    // Player 2's hand is at the physical top, so their points zone is below it.
    expect(to.y).toBeGreaterThan(from.y);

    const finger = await touch(page);
    await finger.start(from);
    const mid = { x: from.x, y: from.y + 60 };
    await finger.move(mid);
    await expect(card).toHaveAttribute('data-dragging', 'true');
    await expect(page.getByTestId('zone-points')).toHaveAttribute('data-state', 'highlighted');
    // The card moves with the finger in screen space, not against it.
    const during = await box(page, cardId);
    expect(during.y - before.y).toBeGreaterThan(40);
    expect(during.y - before.y).toBeLessThan(80);
    expect(Math.abs(during.x - before.x)).toBeLessThan(4);

    await finger.move(to);
    await finger.end();
    await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(play.description));
    expect(await hook(page, (h) => h.seq())).toBe(0);

    await page.getByTestId('staging-confirm').tap();
    // Alice's handoff faces Alice: upright, and the board is gone.
    await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'false');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
    await expect(page.locator('[data-dragging]')).toHaveCount(0);

    await page.getByTestId('reveal-two-step').tap();
    await page.getByTestId('reveal-two-step').tap();
    // Alice sees Blake's play in the recap first, upright.
    await expect(page.getByTestId('recap')).toBeVisible();
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'false');
    await page.getByTestId('recap-dismiss').tap();
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    const hand = await box(page, 'player-hand');
    const oppHand = await box(page, 'opp-hand');
    expect(midY(hand)).toBeGreaterThan(HEIGHT / 2);
    expect(midY(oppHand)).toBeLessThan(HEIGHT / 2);
  });

  test("normal pass-and-play: player 2's own hand is at the bottom, never turned", async ({ page }) => {
    await startBlakeFirst(page, false);
    await expect(page.getByTestId('curtain-gate')).toContainText('Pass');
    await expect(page.getByTestId('curtain-gate')).toContainText('Your turn');
    await expect(page.getByTestId('curtain-gate')).not.toContainText("Blake's turn");
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'false');
    await passGate(page);
    await expect(page.getByTestId('game-screen')).toHaveAttribute('data-table-rotated', 'false');
    expect(midY(await box(page, 'player-hand'))).toBeGreaterThan(HEIGHT / 2);
  });

  test('the setting survives a reload and the home screen stays upright', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('table-mode-toggle').tap();
    await page.reload();
    await expect(page.getByTestId('table-mode-toggle').locator('input')).toBeChecked();
    const home = await box(page, 'home-screen');
    const title = page.locator('.home-screen__title');
    const titleBox = await title.boundingBox();
    expect(titleBox && titleBox.y).toBeLessThan(home.y + home.height / 2);
  });
});
