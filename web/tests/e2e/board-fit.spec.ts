import { expect, test } from '@playwright/test';

// Board fit, rewritten for W22 (the iPhone 15 design pass). The target
// device is now iPhone 15-sized or larger; the 360x740 compact target is
// gone. Light tier: real-browser measurements, no mutation hunting.
//
// The worst-case board used throughout: an 8-card hand, TWO point cards
// with Jacks on EACH side (one of them a 2-Jack stack, which draws the
// deck-thickness edge but costs no extra height, W18), and permanents on
// both sides, with the real StagingBar filling the action bar.
//
// B1: 393x852 (iPhone 15) and 430x932 (15 Plus / Pro Max) in standalone
//     mode, with the safe areas a real device reports there (59 top, 34
//     bottom; stood in through the --cu-safe-* tokens, since Chromium's
//     env() is always 0): the whole board fits the space between them with
//     no scroll, and the 8 cards hold one row.
// B2: 393x660, Mobile Safari with both toolbars: the board region scrolls,
//     the page never does, and the hand and the action bar stay fully on
//     screen.
// C:  the tally chip does not cover the 5th point card at 393 wide.
//
// The harness mounts Board directly (GameScreen needs the game store);
// mountGameColumn mirrors GameScreen's column layout, see its comment.

const HARNESS_URL = '/tests/e2e/harness/mount-board.ts';
type Harness = typeof import('./harness/mount-board');

interface ColumnFit {
  pageScrollHeight: number;
  innerHeight: number;
  pageScrollWidth: number;
  clientWidth: number;
  boardClient: number;
  boardScroll: number;
  handTop: number;
  handBottom: number;
  handRows: number;
  barTop: number;
  barBottom: number;
  safeBottom: number;
}

async function measureColumn(page: import('@playwright/test').Page, insets: { top: number; bottom: number }): Promise<ColumnFit> {
  await page.goto('/');
  await page.waitForSelector('body');
  return page.evaluate(
    async ({ harnessUrl, insets }) => {
      const H = (await import(harnessUrl)) as Harness;
      H.unmountAll();
      // Measure the mounted column alone: the real app shell (loaded only
      // for its tokens) would otherwise add its own screen's height.
      (document.getElementById('app') as HTMLElement).style.display = 'none';
      document.documentElement.style.setProperty('--cu-safe-top', `${insets.top}px`);
      document.documentElement.style.setProperty('--cu-safe-bottom', `${insets.bottom}px`);
      const view = H.worstCaseView();
      const { board, actionBar } = H.mountGameColumn({ view, stagedDescription: 'Scuttle 6♥ with 9♣' });
      const hand = board.querySelector('[data-testid="player-hand"]') as HTMLElement;
      const cards = [...hand.querySelectorAll('[data-testid^="hand-card-"]')].map((c) => c.getBoundingClientRect().top);
      const handRect = hand.getBoundingClientRect();
      const barRect = actionBar.getBoundingClientRect();
      return {
        pageScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        pageScrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        boardClient: board.clientHeight,
        boardScroll: board.scrollHeight,
        handTop: handRect.top,
        handBottom: handRect.bottom,
        handRows: new Set(cards.map((t) => Math.round(t / 20))).size,
        barTop: barRect.top,
        barBottom: barRect.bottom,
        safeBottom: window.innerHeight - insets.bottom,
      };
    },
    { harnessUrl: HARNESS_URL, insets },
  );
}

test.describe('B1: the worst-case board fits iPhone 15 and Pro Max in standalone mode, no scroll', () => {
  for (const { width, height } of [
    { width: 393, height: 852 },
    { width: 430, height: 932 },
  ]) {
    test(`${width}x${height} with 59/34 safe areas: board, hand and action bar fit with no scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const m = await measureColumn(page, { top: 59, bottom: 34 });
      console.log(`[board-fit ${width}x${height} standalone]`, JSON.stringify(m));
      expect(m.pageScrollHeight, 'page scrolls').toBeLessThanOrEqual(m.innerHeight);
      expect(m.pageScrollWidth, 'horizontal scroll').toBeLessThanOrEqual(m.clientWidth);
      // The board region itself needs no scroll: everything is on screen.
      expect(m.boardScroll, 'board region scrolls').toBeLessThanOrEqual(m.boardClient + 0.5);
      // Nothing tappable in the home-indicator strip; the hand sits above the bar.
      expect(m.barBottom).toBeLessThanOrEqual(m.safeBottom + 0.5);
      expect(m.handBottom).toBeLessThanOrEqual(m.barTop + 0.5);
      // design brief: 8 cards on one row.
      expect(m.handRows).toBe(1);
    });
  }
});

test.describe('B2: Mobile Safari with toolbars (393x660): the board scrolls, the hand and action bar stay pinned', () => {
  test('393x660: page never scrolls; hand and action bar fully visible; board region scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 660 });
    const m = await measureColumn(page, { top: 0, bottom: 0 });
    console.log('[board-fit 393x660 toolbars]', JSON.stringify(m));
    expect(m.pageScrollHeight, 'page scrolls').toBeLessThanOrEqual(m.innerHeight);
    expect(m.pageScrollWidth, 'horizontal scroll').toBeLessThanOrEqual(m.clientWidth);
    // The worst case does not fit here: the board region takes the scroll.
    expect(m.boardScroll).toBeGreaterThan(m.boardClient);
    expect(m.handTop).toBeGreaterThanOrEqual(0);
    expect(m.handBottom).toBeLessThanOrEqual(m.barTop + 0.5);
    expect(m.barBottom).toBeLessThanOrEqual(m.innerHeight + 0.5);
    expect(m.handRows).toBe(1);
  });
});

test.describe('C: the tally chip does not cover the 5th point card at 393px wide', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test('5 point cards render with the tally chip clear of the 5th card', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('body');

    const result = await page.evaluate(async (harnessUrl) => {
      const { mountBoard, playerView, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
      unmountAll();
      const view = playerView({
        you: {
          hand: [],
          frozenHandIndices: [],
          points: [
            pointEntry({ Card: card(2, 0), Owner: 0, Controller: 0 }),
            pointEntry({ Card: card(3, 1), Owner: 0, Controller: 0 }),
            pointEntry({ Card: card(4, 2), Owner: 0, Controller: 0 }),
            pointEntry({ Card: card(5, 3), Owner: 0, Controller: 0 }),
            pointEntry({ Card: card(6, 0), Owner: 0, Controller: 0 }),
          ],
          permanents: [],
        },
        // 2+3+4+5+6 = 20: a realistic two-digit tally, wider than the "0"
        // default — the brief's overlap only shows up once the chip is
        // wide enough to eat into the 5th card's slot.
        scoreboard: {
          you: { points: 20, threshold: 21, kings: 0, hasWon: false },
          opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
        },
      });
      const { board } = mountBoard({ view, withActionBarPlaceholder: false });
      const fifthCard = board.querySelector('[data-testid="point-0-4"]') as HTMLElement;
      const tally = board.querySelector('.player-zone .point-row__tally') as HTMLElement;
      const cardRect = fifthCard.getBoundingClientRect();
      const tallyRect = tally.getBoundingClientRect();
      const overlapWidth = Math.max(
        0,
        Math.min(cardRect.right, tallyRect.right) - Math.max(cardRect.left, tallyRect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(cardRect.bottom, tallyRect.bottom) - Math.max(cardRect.top, tallyRect.top),
      );
      return {
        overlapArea: overlapWidth * overlapHeight,
        cardRect: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom },
        tallyRect: { left: tallyRect.left, right: tallyRect.right, top: tallyRect.top, bottom: tallyRect.bottom },
      };
    }, HARNESS_URL);

    console.log('[board-fit tally-overlap]', JSON.stringify(result));
    expect(result.overlapArea).toBe(0);
  });
});
