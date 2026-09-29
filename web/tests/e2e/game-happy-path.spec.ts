import { expect, test, type Page } from '@playwright/test';

import { plainMoveText } from '../../src/lib/recap';

// P2 W13 — the first end-to-end playable path, at the phone viewport
// (390x844, playwright.config.ts). A new game through HomeScreen, redealt
// through the test hook to the SPEC §2.6 golden deal (seed "42", dealer P2)
// so every hand is known, then:
//   1. Alice plays 2♥ for points (hand -> Points zone -> Confirm),
//   2. the curtain hands the phone to Blake (board unmounted throughout),
//   3. Blake plays 5♥ as a one-off; Alice holds no 2, so the engine resolves
//      it and the client stages the synthetic ack (SPEC §4.3),
//   4. Alice walks handoff -> reveal -> recap -> CounterPrompt with only
//      "Let it resolve", then her board,
//   5. Alice draws, and the phone goes back to Blake.
// The reveal gate is driven through the two-step path (SPEC §4.5). The hook
// is used only to seed the deal and to find a move's hand index; every move
// is played by tapping the UI.

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

/** Runs `fn` against `window.__cuttleTestHook` in the page (SPEC §6.5; dev builds only). */
async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function curtainKind(page: Page): Promise<string> {
  return hook(page, (h) => h.curtain());
}

async function findMove(page: Page, pattern: RegExp, kind: number): Promise<HookMove> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => m.kind === kind && pattern.test(m.description));
  if (!found) throw new Error(`no legal move matching ${pattern} (kind ${kind}); have ${JSON.stringify(moves)}`);
  return found;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

/** handoff -> reveal -> [recap] via the two-step pill; the board must stay out of the DOM throughout. */
async function passThePhone(page: Page, to: string, label: 'Your turn' | 'Your response'): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toContainText(to);
  await expect(page.getByTestId('curtain-gate')).toContainText(label);
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await page.getByTestId('reveal-two-step').click(); // "I'm NAME" arms it
  await expect(page.getByTestId('reveal-two-step')).toHaveText('Show my hand');
  await expect(page.getByTestId('board')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click();

  await expect(page.getByTestId('recap')).toBeVisible();
  await expect(page.getByTestId('board')).toHaveCount(0);
}

test('happy path: points play, one-off with synthetic ack, curtain handoffs both ways', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();

  // W25 (privacy): a new game starts behind the curtain to the first player,
  // so whoever tapped New game sees no hand until that player reveals.
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
  await expect(page.getByTestId('board')).toHaveCount(0);

  // Golden deal: Alice (P1) holds 2♥ 3♣ A♥ K♦ Q♣ and acts first.
  await hook(page, (h) => h.newGame('42', 1));
  expect(await curtainKind(page)).toBe('handoff');
  await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
  await expect(page.getByTestId('curtain-gate')).toContainText('Your turn');
  await page.getByTestId('reveal-two-step').click();
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click(); // no recap at the deal
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(5);
  expect(await hook(page, (h) => h.viewer())).toBe(0);
  await expect(page.getByTestId('deck-pile')).toHaveAttribute('data-disabled', 'false');
  await expectNoHorizontalScroll(page);

  // 1. Alice: 2♥ for points. A single tap never applies (R12).
  const twoForPoints = await findMove(page, /^play 2. as point card$/, 1);
  await page.getByTestId(`hand-card-${twoForPoints.handIndex}`).click();
  expect(await hook(page, (h) => h.seq())).toBe(0);
  await page.getByTestId('zone-points').click();
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(twoForPoints.description));
  expect(await hook(page, (h) => h.seq())).toBe(0);
  await page.getByTestId('staging-confirm').click();

  // 2. The phone goes to Blake.
  expect(await curtainKind(page)).toBe('handoff');
  await passThePhone(page, 'Blake', 'Your turn');
  await expect(page.getByTestId('recap')).toContainText('Alice played');
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.viewer())).toBe(1);
  await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(6);
  // Alice's 2 is on the board, in her (the opponent's) points row.
  await expect(page.getByTestId('point-0-0')).toBeVisible();

  // 3. Blake: 5♥ as a one-off (draw two). Alice holds no 2.
  const fiveOneOff = await findMove(page, /^play 5. as one-off$/, 4);
  expect(fiveOneOff.targetKey).toBe('zone:oneoff');
  await page.getByTestId(`hand-card-${fiveOneOff.handIndex}`).click();
  await page.getByTestId('zone-oneoff').click();
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(fiveOneOff.description));
  await page.getByTestId('staging-confirm').click();

  // 4. Alice acknowledges. The handoff label is the neutral "Your response".
  await passThePhone(page, 'Alice', 'Your response');
  await expect(page.getByTestId('recap')).toContainText('Blake played');
  await page.getByTestId('recap-dismiss').click();

  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.locator('[data-testid^="counter-option-"]')).toHaveCount(0);
  const resolve = page.getByTestId('counter-resolve');
  await expect(resolve).toHaveText('Let it resolve');
  const box = await resolve.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((box?.y ?? 0) + (box?.height ?? 0) / 2).toBeGreaterThan(844 / 3); // lower two-thirds
  expect(await hook(page, (h) => h.seq())).toBe(2); // the ack wrote no history
  await resolve.click();

  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.viewer())).toBe(0);
  expect(await curtainKind(page)).toBe('none');
  await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(4);
  // Blake's hand grew by two (6 - the 5 + 2 drawn), shown as a count only.
  await expect(page.getByTestId('opp-hand')).toContainText('7');

  // 5. Alice draws; the phone goes back to Blake.
  await page.getByTestId('deck-pile').click();
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  await page.getByTestId('staging-confirm').click();
  await passThePhone(page, 'Blake', 'Your turn');
  await expect(page.getByTestId('recap')).toContainText('Alice drew a card');
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.viewer())).toBe(1);
  expect(await hook(page, (h) => h.seq())).toBe(3);
  await expectNoHorizontalScroll(page);
});
