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

// P2 W14 (board polish, round-4) introduced Jack stacking; W17 (round-4)
// redirected it to a full-size, corner-indexed downward cascade. Round-4
// item W18 found the W17 cascade clipped — a 2-Jack stack's lowest layer
// showed only its own corner, cut off by the row's fixed height budget
// (`--cu-zone-points`, sized for a bare point card, never a stacked one).
//
// Mid-item, the product owner redirected W18 itself, twice:
//
//   1. Don't cascade multiple Jacks. Render only the TOP (newest,
//      `JackStack[length - 1]`) Jack — full card size, offset downward,
//      exactly as the W17 cascade's first layer — so the point card's
//      corner index stays visible. Only the top Jack is ever a legal
//      target and steals alternate owners, so one layer loses no
//      information. 2+ Jacks get a small badge... which a THIRD redirect
//      then dropped in favour of a "deck thickness" cue: two thin,
//      plain card-back-coloured edges peeking 2-4px past the shown Jack's
//      own right/bottom edge, identical at 2, 3 or 4 Jacks (no per-count
//      variation, no digits anywhere on the board). The count survives
//      only as the stack's `aria-label` ("stolen, N Jacks") for screen
//      readers.
//
//   r16 (2026-09-29 playtest, friction 3): the card's button names the
//   whole stack ("6 of Diamonds, 3 Jacks on it, top Jack of Spades"). The
//   board still shows no count (owner ruling, same day).
//
// docs/design.md §6/§7, as currently written, still describes the W17
// cascade (full-size Jacks stacking downward, several deep) — this is a
// SPEC tension flagged in this item's hand-back, not resolved here; the
// product-owner redirect above governs the implementation and this file.
//
// Because the cascade is gone, PointRow's `--cu-zone-points` row can also
// go back to a FIXED height per row (still grown when any entry in the
// row holds a Jack, since a full-size Jack never fit the bare-card budget
// even one layer deep — but that growth is now the SAME fixed amount
// regardless of stack depth, not depth-dependent).
//
// jsdom (web/tests/unit/point-row.test.ts) has no real layout engine, so
// the geometry criteria below — a real, measured corner index, and
// `elementFromPoint` hit-testing through overlapping absolutely-positioned
// boxes — can only be proven in a real browser. This file mounts PointRow
// directly (web/tests/e2e/harness/mount-board.ts), not through the app's
// route: GameScreen doesn't host the board yet in this worktree (see the
// harness file's header comment).
//
// W22: both phone tiers of the iPhone 15 target are exercised: 393x852
// (base, 60px field cards, 37px Jack offset) and 430x932 (roomy, 66px,
// 40px). The 360x740 compact tier is gone.
const BREAKPOINTS = [
  { name: '393x852 (iPhone 15, 60px field)', width: 393, height: 852 },
  { name: '430x932 (Pro Max, 66px field)', width: 430, height: 932 },
];

for (const { name, width, height } of BREAKPOINTS) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });

    test('the shown Jack is fully visible — its whole box sits inside the row, never clipped (W18 problem 1, the original bug)', async ({
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

        const rowBox = host.querySelector('.point-row__cards') as HTMLElement;
        const jack = host.querySelector('.point-row__jack') as HTMLElement;
        const rowRect = rowBox.getBoundingClientRect();
        const jackRect = jack.getBoundingClientRect();

        return {
          jackTop: jackRect.top,
          jackBottom: jackRect.bottom,
          jackHeight: jackRect.height,
          rowTop: rowRect.top,
          rowBottom: rowRect.bottom,
        };
      }, HARNESS_URL);

      // The whole Jack — not just a corner peek — sits inside the row's
      // (grown) box: nothing clips it top or bottom.
      expect(measured.jackTop).toBeGreaterThanOrEqual(measured.rowTop - 0.5);
      expect(measured.jackBottom).toBeLessThanOrEqual(measured.rowBottom + 0.5);
      // Sanity: a real, non-degenerate card box, not a 0-height clip.
      expect(measured.jackHeight).toBeGreaterThan(40);
    });

    test('the same fixed row growth applies for any Jack-holding card, regardless of stack depth; a Jack-free row stays at the design budget', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const measured = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        const heightFor = (jackStack: ReturnType<typeof card>[]) => {
          unmountAll();
          const host = mountPointRow({
            rowId: 0,
            entries: [
              pointEntry({
                Card: card(6, 1),
                Owner: 0,
                Controller: 0,
                JackStack: jackStack,
                JackOwners: jackStack.map(() => 0 as const),
              }),
            ],
            pointTotal: 6,
            label: 'Points',
            highlighted: new Set<string>(),
            staged: new Set<string>(),
            ontap: () => {},
          });
          return (host.querySelector('.point-row__cards') as HTMLElement).getBoundingClientRect().height;
        };
        const noJackHost = (() => {
          unmountAll();
          const host = mountPointRow({
            rowId: 0,
            entries: [pointEntry({ Card: card(6, 1), Owner: 0, Controller: 0 })],
            pointTotal: 6,
            label: 'Points',
            highlighted: new Set<string>(),
            staged: new Set<string>(),
            ontap: () => {},
          });
          return (host.querySelector('.point-row__cards') as HTMLElement).getBoundingClientRect().height;
        })();

        const budget = (() => {
          unmountAll();
          const host = mountPointRow({
            rowId: 0,
            entries: [],
            pointTotal: 0,
            label: 'Points',
            highlighted: new Set<string>(),
            staged: new Set<string>(),
            ontap: () => {},
          });
          // W22: a row sizes itself from its card width (one card plus the
          // well padding), so the empty row's rendered height IS the budget.
          return (host.querySelector('.point-row__cards') as HTMLElement).getBoundingClientRect().height;
        })();

        return {
          noJack: noJackHost,
          budget,
          one: heightFor([card(11, 0)]),
          two: heightFor([card(11, 0), card(11, 2)]),
          three: heightFor([card(11, 0), card(11, 2), card(11, 3)]),
          four: heightFor([card(11, 0), card(11, 1), card(11, 2), card(11, 3)]),
        };
      }, HARNESS_URL);

      // No Jack anywhere in the row: exactly the design budget.
      expect(measured.noJack).toBeCloseTo(measured.budget, 0);
      // Any Jack at all: the SAME grown height, whether the stack is 1,
      // 2, 3 or 4 deep — the row no longer follows stack depth (only the
      // TOP Jack is ever drawn, W18), so it doesn't need to.
      expect(measured.one).toBeGreaterThan(measured.budget);
      expect(measured.two).toBeCloseTo(measured.one, 0);
      expect(measured.three).toBeCloseTo(measured.one, 0);
      expect(measured.four).toBeCloseTo(measured.one, 0);
    });

    test("the covered card's upper-left corner index stays fully visible above the shown Jack, and the point card face — not the Jack — answers a tap on that corner", async ({
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
        const rankEl = host.querySelector('.point-row__face .cuttle-card-face__rank') as HTMLElement;
        const suitEl = host.querySelector('.point-row__face .cuttle-card-face__suit') as HTMLElement;
        const jack = host.querySelector('.point-row__jack') as HTMLElement;

        const slotRect = slot.getBoundingClientRect();
        const rankRect = rankEl.getBoundingClientRect();
        const suitRect = suitEl.getBoundingClientRect();
        const jackRect = jack.getBoundingClientRect();

        // A point inside the corner index content (rank+suit), comfortably
        // above the Jack's top edge and near the card's LEFT edge (upper-
        // left corner, not centred): the rank glyph's own midpoint.
        const x = rankRect.left + rankRect.width / 2;
        const y = rankRect.top + rankRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const hitTestid = hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
        const hitIsJack = hit?.closest('.point-row__jack') !== null;

        return {
          rankLeftOffset: rankRect.left - slotRect.left,
          slotWidth: slotRect.width,
          indexBottom: Math.max(rankRect.bottom, suitRect.bottom) - slotRect.top,
          jackTopOffset: jackRect.top - slotRect.top,
          hitTestid,
          hitIsJack,
        };
      }, HARNESS_URL);

      // The index sits at the LEFT edge, not centred — well inside the
      // left third of the card width.
      expect(measured.rankLeftOffset).toBeLessThan(measured.slotWidth / 3);
      // The corner index content sits entirely above the Jack's top edge.
      expect(measured.indexBottom).toBeLessThanOrEqual(measured.jackTopOffset);
      // elementFromPoint on the corner glyph hits the point card's face,
      // not the Jack.
      expect(measured.hitTestid).toBe('point-0-0');
      expect(measured.hitIsJack).toBe(false);
    });

    test("the shown Jack's own upper-left corner index is never covered by the deck-thickness edge, and a tap there hits the Jack", async ({
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
              Owner: 0,
              Controller: 0,
              JackStack: [card(11, 0), card(11, 2), card(11, 3)],
              JackOwners: [0, 0, 0],
            }),
          ],
          pointTotal: 6,
          label: 'Points',
          highlighted: new Set<string>(),
          staged: new Set<string>(),
          ontap: () => {},
        });

        const jackRankEl = host.querySelector('.point-row__jack .cuttle-card-face__rank') as HTMLElement;
        const rect = jackRankEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);

        return {
          hitIsJack: hit?.closest('.point-row__jack') !== null,
          hitIsEdge: hit?.closest('.point-row__jack-edge') !== null,
        };
      }, HARNESS_URL);

      expect(measured.hitIsJack).toBe(true);
      expect(measured.hitIsEdge).toBe(false);
    });

    test('the shown Jack is the same size as the card it sits on — offset downward only, no narrowing, no sideways shift', async ({
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
        const jack = host.querySelector('.point-row__jack') as HTMLElement;

        const slotRect = slot.getBoundingClientRect();
        const faceRect = face.getBoundingClientRect();
        const jackRect = jack.getBoundingClientRect();

        return {
          slotWidth: slotRect.width,
          slotHeight: faceRect.height,
          jackWidth: jackRect.width,
          jackHeight: jackRect.height,
          jackLeftOffset: jackRect.left - slotRect.left,
          jackTopOffset: jackRect.top - slotRect.top,
        };
      }, HARNESS_URL);

      // Same width and height as the covered card — no narrowing.
      expect(measured.jackWidth).toBeCloseTo(measured.slotWidth, 0);
      expect(measured.jackHeight).toBeCloseTo(measured.slotHeight, 0);
      // No sideways shift — the Jack's left edge lines up with the card's.
      expect(Math.abs(measured.jackLeftOffset)).toBeLessThanOrEqual(0.5);
      // Offset downward only.
      expect(measured.jackTopOffset).toBeGreaterThan(0);
    });

    test('shows the newest (last) JackStack entry as the visible Jack, not an earlier one', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const result = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        unmountAll();
        // Three suits (clubs, hearts, spades) so the shown Jack's glyph is
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
        const suits = jacks.map((j) => j.querySelector('.cuttle-card-face__suit')?.textContent);

        return { jackCount: jacks.length, suits };
      }, HARNESS_URL);

      // Only ONE Jack card renders (W18) — the last JackStack entry,
      // Suit 3 (spades: ♠), not Suit 0 (clubs) or Suit 2 (hearts).
      expect(result.jackCount).toBe(1);
      expect(result.suits).toEqual(['♠']);
    });

    test('no deck-thickness edge for a single Jack; the same edge (2 slivers) for 2, 3 or 4 Jacks', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('#app, body');

      const result = await page.evaluate(async (harnessUrl) => {
        const { mountPointRow, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        const edgeCountFor = (jackStack: ReturnType<typeof card>[]) => {
          unmountAll();
          const host = mountPointRow({
            rowId: 0,
            entries: [
              pointEntry({
                Card: card(6, 1),
                Owner: 0,
                Controller: 0,
                JackStack: jackStack,
                JackOwners: jackStack.map(() => 0 as const),
              }),
            ],
            pointTotal: 6,
            label: 'Points',
            highlighted: new Set<string>(),
            staged: new Set<string>(),
            ontap: () => {},
          });
          const jackRect = (host.querySelector('.point-row__jack') as HTMLElement).getBoundingClientRect();
          const edges = [...host.querySelectorAll<HTMLElement>('.point-row__jack-edge')];
          // r16: the whole stack is named on the card's button; the board
          // itself shows no count (owner ruling, 2026-09-29).
          const stackLabel = host.querySelector('[data-testid="point-0-0"]')?.getAttribute('aria-label') ?? null;
          return {
            stackText: host.querySelector('.point-row__jack-stack')?.textContent ?? '',
            edgeCount: edges.length,
            // Every edge sticks out past the Jack's own box on the
            // bottom-right — never covers the top-left corner.
            allBeyondBottomRight: edges.every(
              (e) => e.getBoundingClientRect().bottom > jackRect.bottom && e.getBoundingClientRect().right > jackRect.right,
            ),
            stackLabel,
          };
        };

        return {
          one: edgeCountFor([card(11, 0)]),
          two: edgeCountFor([card(11, 0), card(11, 2)]),
          three: edgeCountFor([card(11, 0), card(11, 2), card(11, 3)]),
          four: edgeCountFor([card(11, 0), card(11, 1), card(11, 2), card(11, 3)]),
        };
      }, HARNESS_URL);

      expect(result.one.edgeCount).toBe(0);
      expect(result.one.stackLabel).toBe('6 of Diamonds, Jack of Clubs on it');

      for (const r of [result.two, result.three, result.four]) {
        expect(r.edgeCount).toBe(2);
        expect(r.allBeyondBottomRight).toBe(true);
        expect(r.stackText).not.toMatch(/\d/);
      }
      expect(result.two.stackLabel).toBe('6 of Diamonds, 2 Jacks on it, top Jack of Hearts');
      expect(result.three.stackLabel).toBe('6 of Diamonds, 3 Jacks on it, top Jack of Spades');
      expect(result.four.stackLabel).toBe('6 of Diamonds, 4 Jacks on it, top Jack of Spades');
    });
  });
}
