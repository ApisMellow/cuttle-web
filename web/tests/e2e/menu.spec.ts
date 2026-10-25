import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

import { loadLegacyCounterWindow } from './helpers/legacy-counter-window';

// The in-game menu: R17.2 (Rules from the menu mid-decision, the game
// undisturbed), R23.2 (a menu control switches the card style, no reflow,
// never in the save), R4 (Home keeps the game; Resume brings it back
// exactly; New game from the menu asks first). SPEC §5.5, §5.6 rule 5, §5.7.
//
// The golden deal (seed "42", dealer P2): Alice holds 2♥ 3♣ A♥ K♦ Q♣,
// Blake 5♥ 9♥ 8♦ 4♦ 5♠ 4♥.
//
// Issue #93: engine v0.3.0 opens no counter window in new play, so the
// counter-window cases resume a legacy phase-1 save instead
// (helpers/legacy-counter-window.ts), which still shows the CounterPrompt.

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

async function hook<T>(page: Page, fn: (h: Hook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__cuttleTestHook)`) as Promise<T>;
}

async function save(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('cuttle-web:game'));
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

/** Every [data-testid] box on screen, keyed by testid. */
async function boxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid]')) {
      const r = el.getBoundingClientRect();
      out[el.dataset.testid as string] = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    }
    return out;
  });
}

async function startGoldenGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await hook(page, (h) => h.newGame('42', 1));
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

/**
 * Issue #93: a legacy counter window. Writes the phase-1 save addressed to
 * `to`, reloads, resumes, and passes the resume gate to the prompt (no
 * recap repeating the one-off, ruling 2026-09-29).
 */
async function resumeToPrompt(page: Page, to: 0 | 1, name: string): Promise<void> {
  await loadLegacyCounterWindow(page, to);
  await page.getByTestId('resume').click();
  await passResumeGate(page, name);
  await expect(page.getByTestId('recap')).toHaveCount(0);
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
}

async function play(page: Page, pattern: RegExp, kind: number, zone: string | null): Promise<void> {
  const moves = await hook(page, (h) => h.moves());
  const move = moves.find((m) => m.kind === kind && pattern.test(m.description));
  if (!move) throw new Error(`no legal move ${pattern}; have ${JSON.stringify(moves)}`);
  if (zone === 'deck') await page.getByTestId('deck-pile').click();
  else {
    await page.getByTestId(`hand-card-${move.handIndex}`).click();
    await page.getByTestId(zone as string).click();
  }
  await page.getByTestId('staging-confirm').click();
}

/**
 * SPEC §5.7 (ruling 2026-09-29): Resume at a board or a counter window comes
 * back behind a gate for the saved player. Asserts the gate hides everything,
 * then passes it through the two-step pill.
 */
async function passResumeGate(page: Page, name: string): Promise<void> {
  const gate = page.getByTestId('curtain-gate');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText(name);
  await expect(gate).toContainText('Resume game');
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.getByTestId('counter-prompt')).toHaveCount(0);
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(gate).toHaveCount(0);
}

async function openMenu(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('game-menu')).toBeVisible();
}

async function tapSizesOk(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.width, id).toBeGreaterThanOrEqual(44);
    expect(box!.height, id).toBeGreaterThanOrEqual(44);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
});

test('the menu button sits in the score bar; opening and closing it moves nothing on the board', async ({ page }) => {
  await startGoldenGame(page);
  const before = await boxes(page);
  const button = page.getByTestId('menu-button');
  await expect(button).toHaveAccessibleName('Menu');
  await expect(page.getByTestId('score-bar').getByTestId('menu-button')).toHaveCount(1);
  await tapSizesOk(page, ['menu-button']);

  await openMenu(page);
  await expect(page.getByTestId('menu-rules')).toBeFocused();
  await tapSizesOk(page, ['menu-rules', 'menu-home', 'menu-new-game', 'menu-close']);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('game-menu')).toHaveCount(0);
  await expect(button).toBeFocused();

  expect(await boxes(page)).toEqual(before);
});

test('R17.2: Rules from the menu at the reveal gate and at a legacy counter window leave the curtain, the save and lastSeenSeq alone', async ({ page }) => {
  await startGoldenGame(page);
  await play(page, /^draw/, 0, 'deck');

  // Blake's reveal gate. Rules must not advance it.
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await page.getByTestId('reveal-two-step').click();
  const atGate = await save(page);
  expect(await hook(page, (h) => h.curtain())).toBe('reveal');
  await openMenu(page);
  await page.getByTestId('menu-rules').click();
  await expect(page.getByTestId('rules-sheet')).toBeVisible();
  await page.getByTestId('rules-close').click();
  // r16: back to the menu, then close it.
  await page.getByTestId('menu-close').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  expect(await hook(page, (h) => h.curtain())).toBe('reveal');
  expect(await save(page)).toBe(atGate);
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();

  // A legacy counter window (issue #93): Alice, holding 2♣, against Blake's 6♣.
  await resumeToPrompt(page, 0, 'Alice');
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  const counters = await page.locator('[data-testid^="counter-option-"]').count();
  expect(counters).toBeGreaterThanOrEqual(1); // 2♣
  const atAck = await save(page);
  const seenBefore = JSON.parse(atAck as string).lastSeenSeq;
  const seq = await hook(page, (h) => h.seq());

  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu-rules').click();
  await expect(page.getByTestId('rules-sheet')).toBeVisible();
  await expect(page.getByTestId('game-screen')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rules-sheet')).toHaveCount(0);
  // r16: closing Rules comes back to the menu, on its Rules item.
  await expect(page.getByTestId('game-menu')).toBeVisible();
  await expect(page.getByTestId('menu-rules')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('game-menu')).toHaveCount(0);
  await expect(page.getByTestId('menu-button')).toBeFocused();

  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  await expect(page.locator('[data-testid^="counter-option-"]')).toHaveCount(counters);
  expect(await hook(page, (h) => h.curtain())).toBe('ack');
  expect(await hook(page, (h) => h.seq())).toBe(seq);
  expect(await save(page)).toBe(atAck);
  expect(JSON.parse((await save(page)) as string).lastSeenSeq).toEqual(seenBefore);
});

test('R23.2: the menu swaps Classic for Mythic mid-game, nothing moves, and the save is untouched', async ({ page }) => {
  // Mythic is the default (2026-09-29): start this game in Classic.
  await page.goto('/');
  await page.getByTestId('theme-option-vector').click();
  await startGoldenGame(page);
  const classic = await boxes(page);
  const saved = await save(page);
  expect(await page.locator('.bitmap-card-face').count()).toBe(0);

  await openMenu(page);
  const mythic = page.getByTestId('menu-theme-option-mythic');
  await expect(mythic).toBeVisible();
  await tapSizesOk(page, ['menu-theme-option-vector', 'menu-theme-option-mythic']);
  await mythic.click();
  await expect(mythic.locator('input')).toBeChecked();
  await page.getByTestId('menu-close').click();

  await expect(page.locator('.bitmap-card-face').first()).toBeVisible();
  expect(await boxes(page)).toEqual(classic);
  expect(await save(page)).toBe(saved);
  const settings = await page.evaluate(() => localStorage.getItem('cuttle-web:settings'));
  expect(JSON.parse(settings as string).themeId).toBe('mythic');

  // The pick persists across a reload, the home picker agrees, and the game resumes in Mythic.
  await page.reload();
  await expect(page.getByTestId('theme-option-mythic').locator('input')).toBeChecked();
  await page.getByTestId('resume').click();
  await passResumeGate(page, 'Alice');
  await expect(page.locator('.bitmap-card-face').first()).toBeVisible();
});

test('the menu links to the card gallery in the same tab; the game is saved and Resume picks it up', async ({ page }) => {
  // The gallery is a standalone page the Pages build copies in, not part of
  // the dev server, so serve its index from disk for this one URL.
  const index = readFileSync(fileURLToPath(new URL('../../../gallery/site/index.html', import.meta.url)));
  await page.route('**/gallery/', (route) => route.fulfill({ body: index, contentType: 'text/html' }));
  await startGoldenGame(page);
  const saved = await save(page);

  await openMenu(page);
  const link = page.getByTestId('menu-gallery');
  await expect(link).toHaveText('Card gallery');
  await tapSizesOk(page, ['menu-gallery']);
  await link.click();
  await expect(page).toHaveURL(/\/gallery\/$/);
  await expect(page).toHaveTitle('Mythic Deck Gallery');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mythic');

  // Back in the game: the same save, and Resume brings the board back.
  await page.goto('/');
  expect(await save(page)).toBe(saved);
  await page.getByTestId('resume').click();
  await passResumeGate(page, 'Alice');
  await expect(page.getByTestId('board')).toBeVisible();
});

test('R4: Home keeps the game; Resume brings back the same board and the same save, mid-game and mid-curtain', async ({ page }) => {
  await startGoldenGame(page);
  const board = await boxes(page);
  const saved = await save(page);

  await openMenu(page);
  await page.getByTestId('menu-home').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  expect(await save(page)).toBe(saved);
  await page.getByTestId('resume').click();
  await passResumeGate(page, 'Alice');
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await save(page)).toBe(saved);
  expect(await boxes(page)).toEqual(board);
  expect(await hook(page, (h) => h.viewer())).toBe(0);

  // Mid-curtain: Home at Blake's handoff comes back to the handoff, not a board.
  await play(page, /^draw/, 0, 'deck');
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  const atHandoff = await save(page);
  await openMenu(page);
  await expect(page.getByTestId('board')).toHaveCount(0);
  await page.getByTestId('menu-home').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
  await expect(page.getByTestId('board')).toHaveCount(0);
  expect(await save(page)).toBe(atHandoff);
});

test('R4.3: New game from the menu asks first, naming the game; Cancel keeps it, Abandon deals a new one', async ({ page }) => {
  await startGoldenGame(page);
  const saved = await save(page);

  await openMenu(page);
  await page.getByTestId('menu-new-game').click();
  await expect(page.getByRole('alertdialog')).toContainText('Abandon Alice vs Blake?');
  await page.getByTestId('cancel-abandon').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await save(page)).toBe(saved);

  await openMenu(page);
  await page.getByTestId('menu-new-game').click();
  await page.getByTestId('confirm-abandon').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('board')).toHaveCount(0);
  const fresh = JSON.parse((await save(page)) as string);
  expect(fresh.history).toEqual([]);
  expect(fresh.curtain.kind).toBe('handoff');
  expect(await save(page)).not.toBe(saved);
});

for (const size of [
  { width: 430, height: 932 },
  { width: 1440, height: 900 },
]) {
  test(`fits at ${size.width}x${size.height}: button and items are tap-sized, the menu stays on screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await startGoldenGame(page);
    await tapSizesOk(page, ['menu-button']);
    await openMenu(page);
    await tapSizesOk(page, ['menu-rules', 'menu-home', 'menu-new-game', 'menu-close']);
    const menu = await page.getByTestId('game-menu').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(size.width);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(size.height);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
}

test('R4 privacy: after a reload, Resume at the board and at a legacy counter window shows the gate first, and the gate is the same', async ({ page }) => {
  await startGoldenGame(page);
  await page.reload();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  const atBoard = await page.getByTestId('curtain-gate').innerHTML();
  await passResumeGate(page, 'Alice');
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await hook(page, (h) => h.viewer())).toBe(0);

  // Issue #93: reach Alice's counter window from a legacy save (she holds
  // 2♣ against Blake's 6♣), then reload there.
  await resumeToPrompt(page, 0, 'Alice');
  const atAck = await save(page);

  await page.reload();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  expect(await page.getByTestId('curtain-gate').innerHTML()).toBe(atBoard);
  expect(await hook(page, (h) => h.curtain())).toBe('handoff');
  await passResumeGate(page, 'Alice');
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  expect(await page.locator('[data-testid^="counter-option-"]').count()).toBeGreaterThanOrEqual(1);
  expect(await save(page)).toBe(atAck);
});
