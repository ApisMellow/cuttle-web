import { expect, test, type Page } from '@playwright/test';

import { plainMoveText } from '../../src/lib/recap';

// W25 item 6 (desktop keyboard): every lit target is reachable with Tab and
// activates with Enter or Space, with a visible focus ring. Reached through
// the real UI; the hook only seeds the golden deal (SPEC §2.6, seed 42,
// dealer P2: Alice acts first holding 2♥ 3♣ A♥ K♦ Q♣).

interface Hook {
  newGame(seed: string, dealer: 0 | 1): Promise<void>;
  moves(): { index: number; kind: number; handIndex: number; targetKey: string | null; description: string }[];
  curtain(): string;
  seq(): number;
}

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function reveal(page: Page): Promise<void> {
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

async function activeClass(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.getAttribute('class') ?? '');
}

/** Tabs forward from the current focus until `testId` has focus; returns the presses it took, or -1. */
async function tabTo(page: Page, testId: string, max = 40): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    if ((await activeTestId(page)) === testId) return i;
  }
  return -1;
}

async function startGolden(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));
  await reveal(page);
}

test('a hand card selected with Enter, then the lit Points zone reached by Tab and played with Enter', async ({ page }) => {
  await startGolden(page);
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;

  await page.getByTestId(`hand-card-${two.handIndex}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`hand-card-${two.handIndex}`)).toHaveAttribute('aria-pressed', 'true');

  // Keyboard selection moves focus straight to the first lit target.
  await expect.poll(() => activeTestId(page)).toBe('zone-points');
  const ring = await page.getByTestId('zone-points').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(two.description));
});

test('the lit One-off zone is reached by Tab and activates with Space', async ({ page }) => {
  await startGolden(page);
  const moves = await hook(page, (h) => h.moves());
  const ace = moves.find((m) => m.kind === 4 && m.targetKey === 'zone:oneoff')!;

  await page.getByTestId(`hand-card-${ace.handIndex}`).focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId(`hand-card-${ace.handIndex}`)).toHaveAttribute('aria-pressed', 'true');
  // The Ace lights two zones; the second is at most a few Tabs away.
  await expect.poll(() => activeTestId(page)).toMatch(/^zone-/);
  if ((await activeTestId(page)) !== 'zone-oneoff') expect(await tabTo(page, 'zone-oneoff', 6)).toBeGreaterThan(0);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('staging-bar')).toContainText(plainMoveText(ace.description));
});

// r16 (2026-09-29 playtest, "Desktop and accessibility"): focus never falls
// to <body>. A whole turn and the handoff that follows it, keyboard only.
test('keyboard only: curtain, reveal, select, stage, Confirm and the next curtain each land focus on the next control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));

  // The curtain: focus on its text (never a control, review B1); one Tab
  // reaches the "I'm Alice" pill; Enter, Enter reveals.
  await expect.poll(() => activeClass(page)).toContain('gate__text');
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('reveal-two-step');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('reveal-two-step')).toHaveText('Show my hand');
  await expect.poll(() => activeTestId(page)).toBe('reveal-two-step');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('board')).toBeVisible();

  // The board: focus on a hand card, not <body>.
  await expect.poll(() => activeTestId(page)).toMatch(/^hand-card-\d$/);
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;
  const at = Number((await activeTestId(page))!.slice('hand-card-'.length));
  // Tab (or Shift+Tab) along the hand to the 2.
  for (let i = 0; i < Math.abs(two.handIndex - at); i++) await page.keyboard.press(two.handIndex > at ? 'Tab' : 'Shift+Tab');
  expect(await activeTestId(page)).toBe(`hand-card-${two.handIndex}`);
  await page.keyboard.press('Enter');
  await expect.poll(() => activeTestId(page)).toBe('zone-points');

  // Staging moves focus straight to Confirm (it used to be 7 Tabs away).
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('staging-bar')).toBeVisible();
  await expect.poll(() => activeTestId(page)).toBe('staging-confirm');

  // Confirm: the curtain for Blake, focus on its text again; Tab to his pill.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
  await expect.poll(() => activeClass(page)).toContain('gate__text');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  // Blake's recap: focus on its heading; Tab to "See the board".
  await expect(page.getByTestId('recap')).toBeVisible();
  await expect.poll(() => activeClass(page)).toContain('recap__heading');
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('recap-dismiss');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect.poll(() => activeTestId(page)).toMatch(/^hand-card-\d$/);
});

// r16 review B1 (privacy): focus placement. Press 1 on Confirm applies;
// the curtain then focuses its text, not a control, so presses 2-4 have
// nothing to activate. (This checks where focus lands; the key guard for
// held and repeated keys is covered by the held-Enter tests below and the
// unit tests.)
test('privacy: Enter x4 from Confirm leaves the curtain at handoff, "I\'m Blake" showing, no board or recap', async ({ page }) => {
  await startGolden(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;
  await page.getByTestId(`hand-card-${two.handIndex}`).click();
  await page.getByTestId('zone-points').click();
  await page.getByTestId('staging-confirm').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('reveal-two-step')).toHaveText("I'm Blake");
  expect(await hook(page, (h) => h.curtain())).toBe('handoff');
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.getByTestId('recap')).toHaveCount(0);
});

/** Chromium auto-repeat: `down` on a key that is already down sends `repeat: true`. */
async function repeatKey(page: Page, key: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down(key);
    await page.waitForTimeout(40);
  }
}

async function stageTwoByPointer(page: Page): Promise<void> {
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;
  await page.getByTestId(`hand-card-${two.handIndex}`).click();
  await page.getByTestId('zone-points').click();
  await expect(page.getByTestId('staging-confirm')).toBeVisible();
}

// r16 re-review B1 (privacy): Enter held from Alice's Confirm, Tabbed onto
// the pill and then the ring while still held: the repeats neither click
// the pill nor run the ring's hold. The curtain stays at handoff.
test('privacy: Enter held from Confirm, Tab, Tab, repeats continue: the curtain stays at handoff', async ({ page }) => {
  await startGolden(page);
  await stageTwoByPointer(page);
  await page.getByTestId('staging-confirm').focus();
  await page.keyboard.down('Enter'); // fresh: applies
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('reveal-two-step');
  await repeatKey(page, 'Enter', 8);
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('reveal-hold');
  await repeatKey(page, 'Enter', 25); // 1 s of repeats on the ring
  await page.keyboard.up('Enter');
  await page.waitForTimeout(200);
  expect(await hook(page, (h) => h.curtain())).toBe('handoff');
  await expect(page.getByTestId('reveal-two-step')).toHaveText("I'm Blake");
});

// r16 re-review B2 (R12): a held key never commits a move.
test('R12: Enter held on a hand card for 1 s applies no move', async ({ page }) => {
  await startGolden(page);
  const seq = await hook(page, (h) => h.seq());
  const moves = await hook(page, (h) => h.moves());
  const two = moves.find((m) => m.kind === 1 && /^play 2. as point card$/.test(m.description))!;
  await page.getByTestId(`hand-card-${two.handIndex}`).focus();
  await page.keyboard.down('Enter'); // fresh: selects, focus moves to the lit target
  await repeatKey(page, 'Enter', 25);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(200);
  expect(await hook(page, (h) => h.curtain())).toBe('none');
  await expect(page.getByTestId('staging-bar')).toHaveCount(0);
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.seq())).toBe(seq);
});

test('R12: a repeated Enter on the board\'s staged Confirm applies nothing', async ({ page }) => {
  await startGolden(page);
  await stageTwoByPointer(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('Enter'); // the fresh press lands on nothing
  await page.getByTestId('staging-confirm').focus();
  await repeatKey(page, 'Enter', 5); // only repeats reach Confirm
  await page.keyboard.up('Enter');
  await page.waitForTimeout(200);
  expect(await hook(page, (h) => h.curtain())).toBe('none');
  await expect(page.getByTestId('staging-confirm')).toBeVisible();
});

// r16 (d-16): on a desktop the counter prompt keeps to the 560 px column,
// centred, and focus starts on its heading.
test('1440x900: the counter prompt keeps to the board column, with focus on a control', async ({ page }) => {
  await startGolden(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const moves = await hook(page, (h) => h.moves());
  const ace = moves.find((m) => m.kind === 4 && m.targetKey === 'zone:oneoff')!;
  await page.getByTestId(`hand-card-${ace.handIndex}`).click();
  await page.getByTestId('zone-oneoff').click();
  await page.getByTestId('staging-confirm').click();
  // Blake's response: the curtain, then the prompt (real window or synthetic ack alike).
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.locator('[data-testid="recap"], [data-testid="counter-prompt"]').first()).toBeVisible();
  if ((await page.getByTestId('recap').count()) > 0) await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  const box = (await page.getByTestId('counter-prompt').boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(560.5);
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThanOrEqual(1);
  // Focus on the heading (review B1); one Tab reaches a control.
  await expect.poll(() => activeClass(page)).toContain('counter-prompt__heading');
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toMatch(/^(counter-option-\d+|counter-resolve)$/);
});

// r16: hold-to-peek from the keyboard. Space held on the ring for the hold
// time reveals; the two-step pill stays the quick keyboard path.
test('keyboard hold: Space held on the ring reveals', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('new-game').click();
  await expect.poll(() => activeClass(page)).toContain('gate__text');
  await page.getByTestId('reveal-hold').focus();
  await page.keyboard.down(' ');
  await page.waitForTimeout(900);
  await page.keyboard.up(' ');
  await expect(page.getByTestId('board')).toBeVisible();
});

test('mouse hover lifts a hand card', async ({ page }) => {
  await startGolden(page);
  const card = page.getByTestId('hand-card-0');
  const before = await card.evaluate((el) => getComputedStyle(el).transform);
  await card.hover();
  await expect.poll(() => card.evaluate((el) => getComputedStyle(el).transform)).not.toBe(before);
});

test('Escape clears a keyboard selection', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('hand-card-0').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'false');
});

test('a second click on the selected hand card unselects it (issue #25)', async ({ page }) => {
  await startGolden(page);
  const card = page.getByTestId('hand-card-0');
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'false');
});

test('a mouse click on a hand card does not move focus to a target', async ({ page }) => {
  await startGolden(page);
  await page.getByTestId('hand-card-0').click();
  await expect(page.getByTestId('hand-card-0')).toHaveAttribute('aria-pressed', 'true');
  expect(await activeTestId(page)).not.toMatch(/^zone-/);
});
