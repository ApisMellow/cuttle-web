import { expect, test, type Page } from '@playwright/test';

// Issue #27 (SPEC §4.7): the 5's draw, shown to the player who drew and to
// no one else. Golden deal (SPEC §2.6, seed 42, dealer P2):
//   1. Alice plays 2♥ for points; the phone goes to Blake.
//   2. Blake plays 5♥ as a one-off. Alice holds cards but no 2, so the engine
//      resolves it at once (ruling 2026-09-29, §4.3): no counter prompt for
//      Alice. Blake sees his two drawn cards on his own screen, only those
//      two, and continues with a tap, a key, or by waiting 3 seconds.
//   3. The phone then goes to Alice for her normal turn; her screens never
//      show his drawn cards.
// The hook only seeds the deal and reads public state; every move is a tap.

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

async function findMove(page: Page, pattern: RegExp, kind: number): Promise<HookMove> {
  const moves = await hook(page, (h) => h.moves());
  const found = moves.find((m) => m.kind === kind && pattern.test(m.description));
  if (!found) throw new Error(`no legal move matching ${pattern} (kind ${kind}); have ${JSON.stringify(moves)}`);
  return found;
}

async function gate(page: Page): Promise<void> {
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

/** Squashed text of each drawn card slot in the reveal ("9♠"). */
async function drawnLabels(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="draw-reveal"] [data-draw-slot][data-drawn="true"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, '')));
}

async function squashedBody(page: Page): Promise<string> {
  return page.evaluate(() => (document.body.textContent ?? '').replace(/\s+/g, ''));
}

/** Steps 1-2: up to Blake's Confirm on the 5, which puts his reveal up. Returns with the reveal on screen. */
async function toBlakesReveal(page: Page, confirm: (page: Page) => Promise<void> = (p) => p.getByTestId('staging-confirm').click()): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  // Classic (vector) faces print their rank and suit as text, so the drawn
  // cards can be named and searched for; Mythic (the default) is art only.
  await page.getByTestId('theme-option-vector').click();
  await page.getByTestId('new-game').click();
  await hook(page, (h) => h.newGame('42', 1));
  await gate(page);
  await expect(page.getByTestId('board')).toBeVisible();

  const twoForPoints = await findMove(page, /^play 2. as point card$/, 1);
  await page.getByTestId(`hand-card-${twoForPoints.handIndex}`).click();
  await page.getByTestId('zone-points').click();
  await page.getByTestId('staging-confirm').click();

  await gate(page);
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('board')).toBeVisible();
  const fiveOneOff = await findMove(page, /^play 5. as one-off$/, 4);
  await page.getByTestId(`hand-card-${fiveOneOff.handIndex}`).click();
  await page.getByTestId('zone-oneoff').click();
  await confirm(page);

  // Alice has no 2: the 5 resolved at once, and Blake still holds the phone.
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toHaveCount(0);
  await expect(page.getByTestId('counter-prompt')).toHaveCount(0);
  expect(await hook(page, (h) => h.viewer())).toBe(1);
}

for (const viewport of [
  { name: 'iPhone 393x852', width: 393, height: 852 },
  { name: 'desktop 1280x900', width: 1280, height: 900 },
]) {
  test(`${viewport.name}: Blake sees only his two drawn cards before the pass, continues, and Alice gets her turn with no prompt`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await toBlakesReveal(page);

    const panel = page.getByTestId('draw-reveal');
    await expect(panel).toContainText('You drew 2 cards');
    await expect(page.getByTestId('board')).toHaveCount(0);
    const labels = await drawnLabels(page);
    expect(labels.length).toBe(2);
    // Before the pass: only the drawn cards, never the rest of his hand.
    await expect(page.locator('[data-testid="draw-reveal"] [data-draw-slot]')).toHaveCount(2);
    // A blank label would make every "not in the body" check below vacuous.
    for (const l of labels) expect(l).toMatch(/^(A|[2-9]|10|J|Q|K)\S$/);

    const cont = page.getByTestId('draw-reveal-continue');
    const box = await cont.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    const slots = await page.locator('[data-testid="draw-reveal"] [data-draw-slot]').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    for (const s of slots) {
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.right).toBeLessThanOrEqual(viewport.width);
    }
    await expectNoHorizontalScroll(page);

    // Continue: the pass to Alice, for her normal turn. No counter prompt.
    await cont.click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);
    await gate(page);
    await expect(page.getByTestId('recap')).toBeVisible();
    await expect(page.getByTestId('counter-prompt')).toHaveCount(0);
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);
    await page.getByTestId('recap-dismiss').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);

    // Alice draws; Blake's next board has the cards in hand and no second reveal.
    await page.getByTestId('deck-pile').click();
    await page.getByTestId('staging-confirm').click();
    await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
    await gate(page);
    await page.getByTestId('recap-dismiss').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
    await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(7);
  });
}

test('waiting 3 seconds continues on its own, to the pass', async ({ page }) => {
  await toBlakesReveal(page);
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0, { timeout: 6000 });
  await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
});

test('a key held down from Confirm does not skip the reveal; a fresh press continues', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await toBlakesReveal(page, async (p) => {
    await p.getByTestId('staging-confirm').focus();
    await p.keyboard.down('Enter'); // confirms the 5
  });
  await expect(page.getByTestId('draw-reveal-continue')).toBeFocused();
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.up('Enter');
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
});

test('reduced motion: the faces are shown at once, and the reveal still continues', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toBlakesReveal(page);
  const panel = page.getByTestId('draw-reveal');
  await expect(panel).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('[data-draw-back]')).toHaveCount(0);
  await page.getByTestId('draw-reveal-continue').click();
  await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
});

test('a reload mid-reveal comes back to the pass to Alice, never to the cards', async ({ page }) => {
  await toBlakesReveal(page);
  await page.reload();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
});
