import { expect, test } from '@playwright/test';

// Fetched by the dev server at runtime (see the harness file's header
// comment for why this can't be a normal static import). Routed through a
// function parameter rather than a literal in each `import(...)` call: TS
// only attempts to resolve a dynamic import's module graph for a literal
// specifier, and this is a root-relative dev-server URL, not a path `tsc`
// can resolve — passing it as an argument keeps `svelte-check` (SPEC §7.6)
// green while the type-only import below still gives real types.
const HARNESS_URL = '/tests/e2e/harness/mount-board.ts';
type Harness = typeof import('./harness/mount-board');

// P2 W14 (board polish, round-4) — the Jack-stacking ruling (docs/design.md
// §6/§7, confirmed 2026-09-28, product owner):
//
//   "Jacks stolen onto a point card are laid on top of it, each shifted
//    slightly down, so the stolen card's top strip stays visible above the
//    Jacks — that strip is where the card's identity lives."
//
// jsdom (web/tests/unit/point-row.test.ts) has no real layout engine, so
// the geometry criteria below — a real, measured top strip, and
// `elementFromPoint` hit-testing through overlapping absolutely-positioned
// boxes — can only be proven in a real browser. This file mounts PointRow
// directly (web/tests/e2e/harness/mount-board.ts), not through the app's
// route: GameScreen doesn't host the board yet in this worktree (see the
// harness file's header comment).
//
// Both field-width breakpoints from docs/design.md §5 are exercised:
// 390x844 (phone, 60px field cards) and 360x740 (compact, 52px, the
// `max-height: 780px` breakpoint in card-geometry.css / tokens.css).
const BREAKPOINTS = [
  { name: '390x844 (phone, 60px field)', width: 390, height: 844 },
  { name: '360x740 (compact, 52px field)', width: 360, height: 740 },
];

for (const { name, width, height } of BREAKPOINTS) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });

    test('a top strip of the point card, at least 16px tall, stays visible above the top edge of every Jack (criterion 1), and the point card face — not a Jack — answers a tap on that strip (criterion 3)', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const measured = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        unmountAll();
        const host = mountPointRow({
          rowId: 0,
          entries: [
            pointEntry({
              Card: card(6, 1),
              Owner: 1,
              Controller: 0,
              JackStack: [card(11, 0), card(11, 2)],
              JackOwners: [1, 0],
            }),
          ],
          pointTotal: 6,
          label: 'Points',
          highlighted: new Set<string>(),
          staged: new Set<string>(),
          ontap: () => {},
        });

        const slot = host.querySelector('.point-row__slot') as HTMLElement;
        const face = host.querySelector('.point-row__face') as HTMLElement;
        const rankEl = host.querySelector('.point-row__face .cuttle-card-face__rank') as HTMLElement;
        const suitEl = host.querySelector('.point-row__face .cuttle-card-face__suit') as HTMLElement;
        const jacks = [...host.querySelectorAll<HTMLElement>('.point-row__jack')];

        const slotRect = slot.getBoundingClientRect();
        const faceRect = face.getBoundingClientRect();
        const rankRect = rankEl.getBoundingClientRect();
        const suitRect = suitEl.getBoundingClientRect();
        const jackRects = jacks.map((j) => j.getBoundingClientRect());
        const lowestJackTop = Math.min(...jackRects.map((r) => r.top));

        // A point inside the identity content (rank+suit), comfortably
        // above every Jack's top edge: horizontally centred on the card,
        // vertically at the rank glyph's own midpoint.
        const x = faceRect.left + faceRect.width / 2;
        const y = rankRect.top + rankRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const hitTestid = hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
        const hitIsJack = hit?.closest('.point-row__jack') !== null;

        return {
          stripHeight: lowestJackTop - slotRect.top,
          contentBottom: Math.max(rankRect.bottom, suitRect.bottom) - slotRect.top,
          hitTestid,
          hitIsJack,
          jackCount: jacks.length,
        };
      }, HARNESS_URL);

      expect(measured.jackCount).toBe(2);
      // Criterion 1: at least 16px, at BOTH breakpoints.
      expect(measured.stripHeight).toBeGreaterThanOrEqual(16);
      // Criterion 2 (browser corroboration): the rank+suit content the
      // theme draws sits entirely above the lowest Jack's top edge — inside
      // the strip, not spilling under the stack.
      expect(measured.contentBottom).toBeLessThanOrEqual(measured.stripHeight);
      // Criterion 3: elementFromPoint on the strip's glyph hits the point
      // card's face, not a Jack.
      expect(measured.hitTestid).toBe('point-0-0');
      expect(measured.hitIsJack).toBe(false);
    });

    test('the newest Jack (last in JackStack) paints on top where Jacks overlap (criterion 4)', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const result = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        unmountAll();
        // Three suits (clubs, hearts, spades) so each Jack's glyph is
        // distinguishable; JackOwners is irrelevant to rendering here.
        const host = mountPointRow({
          rowId: 1,
          entries: [
            pointEntry({
              Card: card(6, 1),
              Owner: 1,
              Controller: 1,
              JackStack: [card(11, 0), card(11, 2), card(11, 3)],
              JackOwners: [1, 1, 1],
            }),
          ],
          pointTotal: 6,
          label: 'Points',
          highlighted: new Set<string>(),
          staged: new Set<string>(),
          ontap: () => {},
        });

        const jacks = [...host.querySelectorAll<HTMLElement>('.point-row__jack')];
        const rects = jacks.map((j) => j.getBoundingClientRect());
        // The overlap point: the last (newest) Jack's own centre, which by
        // construction (each Jack shifted only slightly down) sits inside
        // every earlier Jack's box too.
        const last = rects[rects.length - 1];
        const x = last.left + last.width / 2;
        const y = last.top + last.height / 2;
        const hit = document.elementFromPoint(x, y);
        const hitJack = hit?.closest('.point-row__jack');
        const hitIndex = hitJack ? jacks.indexOf(hitJack as HTMLElement) : -1;

        return { jackCount: jacks.length, hitIndex };
      }, HARNESS_URL);

      expect(result.jackCount).toBe(3);
      // The hit-tested element is the LAST Jack (index 2, the newest).
      expect(result.hitIndex).toBe(2);
    });

    test('the row stays within its height budget (criterion 6)', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const result = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        unmountAll();
        const host = mountPointRow({
          rowId: 0,
          entries: [
            pointEntry({ Card: card(4, 0), Owner: 0, Controller: 0 }),
            pointEntry({
              Card: card(6, 1),
              Owner: 1,
              Controller: 0,
              JackStack: [card(11, 0), card(11, 2)],
              JackOwners: [1, 0],
            }),
          ],
          pointTotal: 10,
          label: 'Points',
          highlighted: new Set<string>(),
          staged: new Set<string>(),
          ontap: () => {},
        });
        const cardsBox = host.querySelector('.point-row__cards') as HTMLElement;
        const budget = getComputedStyle(cardsBox).getPropertyValue('--cu-zone-points').trim();
        return {
          rowHeight: host.getBoundingClientRect().height,
          budgetPx: parseFloat(budget),
        };
      }, HARNESS_URL);

      expect(result.rowHeight).toBeLessThanOrEqual(result.budgetPx + 0.5);
      // Sanity: the compact/phone budget values from tokens.css.
      expect(result.budgetPx).toBeGreaterThanOrEqual(84);
      expect(result.budgetPx).toBeLessThanOrEqual(96);
    });
  });
}
