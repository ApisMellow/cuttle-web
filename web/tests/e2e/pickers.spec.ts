import { expect, test, type Page } from '@playwright/test';

// P2 W15 — the three pickers end to end, by tapping the UI (R6.1, R15.1,
// R15.3, R16.3). The test hook only seeds the deal (seed "17", dealer P1, so
// Blake acts first) and looks up move indices; every move is played through
// taps. The scripted line, found by a search over the real engine:
//   1. Blake plays 4♣ as a one-off; Alice picks two cards to discard
//      (DiscardPicker on her own hand), and plays on without a curtain.
//   2. Alice plays 7♣; the phone makes the round trip to Blake and back;
//      Alice sees the SevenRevealPanel and plays the revealed 8♦ for points.
//   3. Blake browses the scrap (browse mode), then plays 3♣ and takes a card
//      through the ScrapBrowser in pick mode.
// Run at iPhone 15 and the Mobile Safari toolbar height; each picker screen
// is checked for fit (the page never scrolls, sheets inside the viewport).

interface HookMove {
  index: number;
  kind: number;
  handIndex: number;
  targetKey: string | null;
  description: string;
  scrapIndex: number;
  discardA: number;
  discardB: number;
  revealIndex: number | null;
}

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  moves(): HookMove[];
  curtain(): string;
  viewer(): 0 | 1 | null;
  seq(): number;
}

const Kind = { OneOff: 4, SevenPick: 7, DiscardPair: 8 } as const;

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function findMove(page: Page, pattern: RegExp, kind: number): Promise<HookMove> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => m.kind === kind && pattern.test(m.description));
  if (!found) throw new Error(`no legal move matching ${pattern} (kind ${kind}); have ${JSON.stringify(moves)}`);
  return found;
}

async function expectFits(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    // The whole document's height: tokens.css resets the default body
    // margin (W19), so the page itself must fit the viewport.
    sh: document.documentElement.scrollHeight,
    ih: window.innerHeight,
  }));
  expect(m.sw, 'horizontal scroll').toBeLessThanOrEqual(m.cw);
  expect(m.sh, 'page taller than the viewport').toBeLessThanOrEqual(m.ih);
  // SPEC §5.9: every testid this item adds is a >= 44 x 44 tap target.
  const boxes = await page
    .locator('[data-testid^="seven-"], [data-testid^="scrap-"], [data-testid="discard-picker"], [data-testid^="staging-"]')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { id: e.getAttribute('data-testid'), w: r.width, h: r.height };
      }),
    );
  for (const box of boxes) {
    expect(box.w, `${box.id} width`).toBeGreaterThanOrEqual(44);
    expect(box.h, `${box.id} height`).toBeGreaterThanOrEqual(44);
  }
}

async function expectInViewport(page: Page, testid: string): Promise<void> {
  const size = page.viewportSize()!;
  const box = await page.getByTestId(testid).boundingBox();
  expect(box, testid).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 0.5);
}

/**
 * Hands the phone over: handoff -> reveal (two-step) -> recap if any. The
 * board stays out of the DOM until the receiver is looking.
 */
async function passThePhone(page: Page, to: string, label: 'Your turn' | 'Your response'): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toContainText(to);
  await expect(page.getByTestId('curtain-gate')).toContainText(label);
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.locator('[data-testid^="seven-"]')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('reveal-two-step')).toHaveText('Show my hand');
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('curtain-gate')).toHaveCount(0);
  if ((await page.getByTestId('recap').count()) > 0) {
    await expect(page.getByTestId('board')).toHaveCount(0);
    await page.getByTestId('recap-dismiss').click();
  }
}

/** The receiver of a counterable one-off lets it resolve (real window or synthetic ack; same control). */
async function letItResolve(page: Page): Promise<void> {
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  await page.getByTestId('counter-resolve').click();
}

async function playOneOff(page: Page, pattern: RegExp): Promise<HookMove> {
  const m = await findMove(page, pattern, Kind.OneOff);
  await page.getByTestId(`hand-card-${m.handIndex}`).click();
  await page.getByTestId('zone-oneoff').click();
  return m;
}

// W22: iPhone 15 (393x852) and the Mobile Safari toolbar case (393x660),
// where the board region scrolls but the page, the hand slot (and the 7's
// reveal in it) and the action bar never do.
for (const { width, height } of [
  { width: 393, height: 852 },
  { width: 393, height: 660 },
]) {
  test(`${width}x${height}: a 4 discard, a 7 reveal and a 3 scrap pick, all by tapping`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByTestId('name-input-0').fill('Alice');
    await page.getByTestId('name-input-1').fill('Blake');
    await page.getByTestId('new-game').click();
    // W25: every new game starts behind the curtain, including the hook's redeal.
    await expect(page.getByTestId('curtain-gate')).toBeVisible();
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
    await hook(page, (h) => h.newGame('17', 0));
    await passThePhone(page, 'Blake', 'Your turn');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect.poll(() => hook(page, (h) => h.viewer())).toBe(1);

    // 1. Blake plays the 4. Alice discards two cards on her own hand.
    const four = await playOneOff(page, /^play 4. as one-off$/);
    await expect(page.getByTestId('staging-bar')).toContainText(four.description);
    await page.getByTestId('staging-confirm').click();
    await passThePhone(page, 'Alice', 'Your response');
    await letItResolve(page);

    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('discard-picker')).toContainText('Choose 2 cards to discard');
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    const discards = (await hook(page, (h) => h.moves())).filter((m) => m.kind === Kind.DiscardPair);
    const handCount = await page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]').count();
    expect(discards).toHaveLength((handCount * (handCount - 1)) / 2);
    await expectFits(page);
    const seqBefore = await hook(page, (h) => h.seq());
    await page.getByTestId('hand-card-1').click();
    await expect(page.getByTestId('hand-card-1')).toHaveAttribute('data-staged', 'true');
    await expect(page.getByTestId('staging-bar')).toHaveCount(0);
    await page.getByTestId('hand-card-0').click();
    await expect(page.getByTestId('staging-bar')).toContainText(/^Discard .+ and .+/);
    expect(await hook(page, (h) => h.seq())).toBe(seqBefore); // R12: nothing applied yet
    await expectFits(page);
    await page.getByTestId('staging-confirm').click();

    // R15.3: the discarder plays on at once, no curtain; two fewer cards.
    await expect(page.getByTestId('discard-picker')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.curtain())).toBe('none');
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(handCount - 2);

    // 2. Alice plays the 7: round trip to Blake and back, then the reveal.
    const seven = await playOneOff(page, /^play 7. as one-off$/);
    await expect(page.getByTestId('staging-bar')).toContainText(seven.description);
    await page.getByTestId('staging-confirm').click();
    await passThePhone(page, 'Blake', 'Your response');
    await expect(page.locator('[data-testid^="seven-"]')).toHaveCount(0);
    await letItResolve(page);
    await passThePhone(page, 'Alice', 'Your turn');

    await expect(page.getByTestId('seven-reveal')).toBeVisible();
    await expect(page.getByTestId('seven-reveal')).toContainText('Top of the deck');
    await expectFits(page);
    await expectInViewport(page, 'seven-reveal');
    const pick = await findMove(page, /^7: play 8. as point card$/, Kind.SevenPick);
    expect(pick.revealIndex).not.toBeNull();
    await page.getByTestId(`seven-card-${pick.revealIndex}`).click();
    await expect(page.getByTestId('zone-points')).toHaveAttribute('data-state', 'highlighted');
    await page.getByTestId('zone-points').click();
    await expect(page.getByTestId('staging-bar')).toContainText(pick.description);
    await expectFits(page);
    await page.getByTestId('staging-confirm').click();

    // Blake: the revealed cards never reach his screens; the recap says only
    // that the top of the deck was revealed and what was played.
    await expect(page.getByTestId('curtain-gate')).toBeVisible();
    await expect(page.locator('[data-testid^="seven-"]')).toHaveCount(0);
    await page.getByTestId('reveal-two-step').click();
    await page.getByTestId('reveal-two-step').click();
    await expect(page.getByTestId('recap')).toContainText('Alice revealed the top of the deck and played');
    await expect(page.locator('[data-testid^="seven-"]')).toHaveCount(0);
    await page.getByTestId('recap-dismiss').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('[data-testid^="seven-"]')).toHaveCount(0);
    expect(await hook(page, (h) => h.viewer())).toBe(1);

    // 3a. R6.1: Blake browses the scrap: every card, then closes it.
    const scrapCount = Number(await page.getByTestId('center-zone').locator('.scrap-pile__count').textContent());
    expect(scrapCount).toBeGreaterThanOrEqual(3);
    await page.getByTestId('scrap-pile').click();
    await expect(page.getByTestId('scrap-browser')).toHaveAttribute('data-mode', 'browse');
    await expect(page.getByTestId('scrap-browser').locator('.cuttle-card-face')).toHaveCount(scrapCount);
    await expectFits(page);
    await expectInViewport(page, 'scrap-browser');
    await page.getByTestId('scrap-browser-close').click();
    await expect(page.getByTestId('scrap-browser')).toHaveCount(0);

    // 3b. Blake plays the 3 and picks a scrap card in pick mode.
    const threes = (await hook(page, (h) => h.moves())).filter(
      (m) => m.kind === Kind.OneOff && /^play 3. as one-off$/.test(m.description),
    );
    expect(threes.length).toBe(scrapCount);
    await page.getByTestId(`hand-card-${threes[0].handIndex}`).click();
    await page.getByTestId('zone-oneoff').click();
    await expect(page.getByTestId('scrap-browser')).toHaveAttribute('data-mode', 'pick');
    await expect(page.locator('[data-testid^="scrap-pick-"]')).toHaveCount(threes.length);
    await expect(page.getByTestId('staging-bar')).toHaveCount(0);
    await expectFits(page);
    await expectInViewport(page, 'scrap-browser');
    const take = threes[threes.length - 1];
    await page.getByTestId(`scrap-pick-${take.scrapIndex}`).click();
    await expect(page.getByTestId('scrap-browser')).toHaveCount(0);
    await expect(page.getByTestId('staging-bar')).toContainText(/^play 3. as one-off — take .+ from the scrap/);
    const seqBeforeThree = await hook(page, (h) => h.seq());
    await page.getByTestId('staging-confirm').click();
    await passThePhone(page, 'Alice', 'Your response');
    await letItResolve(page);
    await expect(page.getByTestId('board')).toBeVisible();
    expect(await hook(page, (h) => h.seq())).toBeGreaterThan(seqBeforeThree);
    await expectFits(page);
  });
}
