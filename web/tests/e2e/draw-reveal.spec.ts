import { expect, test, type Page } from '@playwright/test';

// Issue #27 (SPEC §4.7): the 5's draw, shown to the player who drew and to
// no one else. Golden deal (SPEC §2.6, seed 42, dealer P2):
//   1. Alice plays 2♥ for points; the phone goes to Blake.
//   2. Blake plays 5♥ as a one-off. Alice holds cards but no 2, so the engine
//      resolves it and a synthetic ack is staged (§4.3): no reveal before
//      the pass, because that would tell Blake that Alice had no 2 (R14).
//   3. Alice acks and draws; her screens never show a reveal.
//   4. Blake's next own view shows his two drawn cards face up; he continues
//      with a tap, a key, or by waiting 3 seconds.
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

/** Steps 1-3: up to the moment Blake's recap is on screen after Alice's draw. Checks Alice never sees a reveal. */
async function toBlakesRecap(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
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
  await page.getByTestId('staging-confirm').click();

  // No reveal before the pass: the ack handoff comes straight up for Alice.
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);

  await gate(page);
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('counter-prompt')).toBeVisible();
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  await page.getByTestId('counter-resolve').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  expect(await hook(page, (h) => h.viewer())).toBe(0);

  await page.getByTestId('deck-pile').click();
  await page.getByTestId('staging-confirm').click();
  await expect(page.getByTestId('curtain-gate')).toContainText('Blake');
  await gate(page);
  await expect(page.getByTestId('recap')).toBeVisible();
}

for (const viewport of [
  { name: 'iPhone 393x852', width: 393, height: 852 },
  { name: 'desktop 1280x900', width: 1280, height: 900 },
]) {
  test(`${viewport.name}: Blake sees his two drawn cards face up, taps Continue, and reaches his board`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await toBlakesRecap(page);
    await page.getByTestId('recap-dismiss').click();

    const panel = page.getByTestId('draw-reveal');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('You drew 2 cards');
    await expect(page.getByTestId('board')).toHaveCount(0);
    expect(await hook(page, (h) => h.viewer())).toBe(1);
    const labels = await drawnLabels(page);
    expect(labels.length).toBe(2);

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

    await cont.click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('player-hand').locator('[data-testid^="hand-card-"]')).toHaveCount(7);

    // Blake draws and passes: none of Alice's screens show his drawn cards.
    await page.getByTestId('deck-pile').click();
    await page.getByTestId('staging-confirm').click();
    await expect(page.getByTestId('curtain-gate')).toContainText('Alice');
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);
    await gate(page);
    await expect(page.getByTestId('recap')).toBeVisible();
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);
    await page.getByTestId('recap-dismiss').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
    expect(await hook(page, (h) => h.viewer())).toBe(0);
    for (const l of labels) expect(await squashedBody(page)).not.toContain(l);
  });
}

test('waiting 3 seconds continues on its own', async ({ page }) => {
  await toBlakesRecap(page);
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0, { timeout: 6000 });
  await expect(page.getByTestId('board')).toBeVisible();
});

test('a key held down from the recap does not skip the reveal; a fresh press continues', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await toBlakesRecap(page);
  await page.getByTestId('recap-dismiss').focus();
  await page.keyboard.down('Enter'); // dismisses the recap
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await expect(page.getByTestId('draw-reveal-continue')).toBeFocused();
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.down('Enter'); // repeat: true
  await page.keyboard.up('Enter');
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  await expect(page.getByTestId('board')).toBeVisible();
});

test('reduced motion: the faces are shown at once, and the reveal still continues', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toBlakesRecap(page);
  await page.getByTestId('recap-dismiss').click();
  const panel = page.getByTestId('draw-reveal');
  await expect(panel).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('[data-draw-back]')).toHaveCount(0);
  await page.getByTestId('draw-reveal-continue').click();
  await expect(page.getByTestId('board')).toBeVisible();
});

test('a reload mid-reveal comes back behind the resume gate, never straight to the cards', async ({ page }) => {
  await toBlakesRecap(page);
  await page.getByTestId('recap-dismiss').click();
  await expect(page.getByTestId('draw-reveal')).toBeVisible();
  await page.reload();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('draw-reveal')).toHaveCount(0);
  await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);
});
