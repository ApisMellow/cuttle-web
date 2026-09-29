import { expect, test, type Page } from '@playwright/test';

// Playtest friction (2026-09-28, review N4): with the 9's ambiguity chooser
// open at 393x852, the player's own Permanents row stays fully visible — the
// sheet overlays the hand and action bar, never the row above them — and the
// page still fits the viewport. Two options is the most a chooser can hold:
// its candidates share one card and one target, and the engine offers at
// most a Scuttle plus one targeted one-off (a 2 or a 9) for that pair (a
// Jack's steal has no scuttle or one-off twin).
//
// Position, reached by tapping the UI from seed "1", dealer 0 (the hook only
// seeds the deal and names each move's hand index): Blake 9♥ for points,
// Alice 6♣ for points, Blake 4♣ for points, Alice 8♦ as glasses, Blake 2♠
// for points. Alice then holds 9♣ against Blake's 4♣ — scuttle or 9 one-off —
// with her glasses in her own Permanents row.

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
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

/** Through handoff -> reveal -> [recap] to the board, by the two-step pill. */
async function reachBoard(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const kind = await hook(page, (h) => h.curtain());
    if (kind === 'none') return;
    if (kind === 'recap') await page.getByTestId('recap-dismiss').click();
    else if (kind === 'ack') await page.getByTestId('counter-resolve').click();
    else await page.getByTestId('reveal-two-step').click();
  }
  expect(await hook(page, (h) => h.curtain())).toBe('none');
}

async function play(page: Page, description: string, zone: 'zone-points' | 'zone-permanents'): Promise<void> {
  await reachBoard(page);
  const moves = await hook(page, (h) => h.moves());
  const move = moves.find((m) => m.description === description);
  if (!move) throw new Error(`no ${description}; have ${JSON.stringify(moves.map((m) => m.description))}`);
  await page.getByTestId(`hand-card-${move.handIndex}`).click();
  await page.getByTestId(zone).click();
  await page.getByTestId('staging-confirm').click();
}

test.use({ viewport: { width: 393, height: 852 } });

test('393x852: the 9 chooser leaves your own Permanents row fully visible', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('1', 0));

  await play(page, 'play 9♥ as point card', 'zone-points');
  await play(page, 'play 6♣ as point card', 'zone-points');
  await play(page, 'play 4♣ as point card', 'zone-points');
  await play(page, 'play 8♦ as permanent', 'zone-permanents');
  await play(page, 'play 2♠ as point card', 'zone-points');
  await reachBoard(page);

  const moves = await hook(page, (h) => h.moves());
  const scuttle = moves.find((m) => m.description === "scuttle opponent's 4♣ with 9♣");
  expect(scuttle, JSON.stringify(moves.map((m) => m.description))).toBeDefined();
  // The fix's property: the sheet overlays; the board (the only scrolling
  // region) keeps its height, so nothing above the hand can be pushed out.
  const boardBefore = await page.getByTestId('board').evaluate((el) => el.clientHeight);
  await page.getByTestId(`hand-card-${scuttle!.handIndex}`).click();
  await page.getByTestId(scuttle!.targetKey!.replace(/:/g, '-')).click();

  const chooser = page.getByTestId('ambiguity-chooser');
  await expect(chooser).toBeVisible();
  await expect(page.locator('[data-testid^="ambiguity-chooser-option-"]')).toHaveCount(2);
  expect(await page.getByTestId('board').evaluate((el) => el.clientHeight), 'board height with the chooser open').toBe(boardBefore);

  const row = await page.getByTestId('zone-permanents').boundingBox();
  const sheet = await chooser.boundingBox();
  expect(row).not.toBeNull();
  expect(sheet).not.toBeNull();
  expect(row!.y, 'Permanents row starts on screen').toBeGreaterThanOrEqual(0);
  expect(row!.y + row!.height, 'Permanents row ends above the chooser').toBeLessThanOrEqual(sheet!.y);

  // Nothing covers the glasses: the topmost element at the card's centre is inside the row.
  const glasses = await page.getByTestId('perm-0-0').boundingBox();
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el !== null && el.closest('[data-testid="ambiguity-chooser"]') === null && el.closest('[data-testid="perm-0-0"], [data-testid="zone-permanents"]') !== null;
    },
    [glasses!.x + glasses!.width / 2, glasses!.y + glasses!.height / 2],
  );
  expect(hit).toBe(true);

  // The sheet is inside the viewport, its controls are real tap targets, and the page doesn't scroll.
  expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(852);
  for (const id of ['ambiguity-chooser-cancel']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  for (const box of await page.locator('[data-testid^="ambiguity-chooser-option-"]').evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().height),
  )) {
    expect(box).toBeGreaterThanOrEqual(44);
  }
  const fit = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    sh: document.documentElement.scrollHeight,
    ih: window.innerHeight,
  }));
  expect(fit.sw).toBeLessThanOrEqual(fit.cw);
  expect(fit.sh).toBeLessThanOrEqual(fit.ih);
});
