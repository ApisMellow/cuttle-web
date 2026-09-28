import { expect, test } from '@playwright/test';

// P2 W14 (board polish, round-4), items B and C. Light tier per the brief:
// a browser fit measurement before and after is enough, no mutation
// hunting. This mounts Board directly (see
// web/tests/e2e/harness/mount-board.ts's header for why: GameScreen is
// still the P2 W12 skeleton in this worktree, so there is no live route to
// reach a rendered board through).
//
// B: fit at 360x740, 390x740 and 390x844 with an 8-card hand and the
// action bar showing (docs/design.md §10.6 — "at 360x740 ... no vertical
// scroll; ... compact tokens"). The brief's original diagnostic: the page
// was 758px (18px over budget) and the centre strip alone measured 97.4px
// against an 80px compact budget.
//
// Round-4 item W18 adds the realistic worst case this item's brief calls
// out: TWO point cards with TWO Jacks each, on BOTH players' sides (four
// Jack-holding point cards on screen at once). Per the product-owner
// redirect captured in point-row-stacking.spec.ts's header, only the top
// Jack of each stack ever renders (plus a non-reflowing decorative edge),
// so a deeper stack (3-4 Jacks, rarer) costs the row no more height than
// this case — this is the worst case that actually has to fit without a
// scroll.
//
// C: docs/design.md §6 — "five [field cards] fit at 390" — the tally chip
// must not cover the 5th point card at 390px wide.
//
// Fetched by the dev server at runtime (see the harness file's header
// comment for why this can't be a normal static import). Routed through a
// function parameter rather than a literal in each `import(...)` call: TS
// only attempts to resolve a dynamic import's module graph for a literal
// specifier, and this is a root-relative dev-server URL, not a path `tsc`
// can resolve — passing it as an argument keeps `svelte-check` (SPEC §7.6)
// green while the type-only import below still gives real types.
const HARNESS_URL = '/tests/e2e/harness/mount-board.ts';
type Harness = typeof import('./harness/mount-board');

test.describe('B: fit at 360x740, 390x740 and 390x844 with an 8-card hand', () => {
  for (const { width, height, allowScroll } of [
    // W18: at 360x740, the 8-card hand ALSO wraps to two rows (design.md
    // §6 — the fan's visible slice would fall under 44px at this width),
    // which alone already used almost every spare pixel of this
    // breakpoint's compact budget (measured ~29px of slack with no Jack
    // anywhere on the board). Growing both points rows for the worst
    // case costs ~2x that. PointRow's `--jack-offset` and deck-edge slack,
    // and Board's compact gap, are trimmed as far as this item judges
    // safe (see their comments) without either covering a corner index or
    // leaving no rendering-fuzz margin; the remainder (~19px, i.e. the
    // page runs about 19px taller than the viewport) is accepted as the
    // vertical scroll design.md and this item's brief both allow for a
    // stack that can't fit ("it's fine to let the board scroll
    // vertically... but say so" — reported in this item's hand-back).
    // 390x740 and 390x844 have no hand-wrap tax and fit with no scroll.
    { width: 360, height: 740, allowScroll: true },
    { width: 390, height: 740, allowScroll: false },
    { width: 390, height: 844, allowScroll: false },
  ]) {
    const label = allowScroll ? 'fits, or scrolls vertically within a documented bound' : 'fits with no vertical overflow';
    test(`${width}x${height}: board + action bar ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await page.waitForSelector('body');

      const result = await page.evaluate(async (harnessUrl) => {
        const { mountBoard, playerView, pointEntry, card, unmountAll } = (await import(harnessUrl)) as Harness;
        unmountAll();
        const view = playerView({
          you: {
            hand: [
              card(1, 0),
              card(2, 1),
              card(3, 2),
              card(4, 3),
              card(5, 0),
              card(6, 1),
              card(7, 2),
              card(8, 3),
            ],
            frozenHandIndices: [],
            // W18 realistic worst case: two point cards, each with two
            // Jacks, on this side.
            points: [
              pointEntry({
                Card: card(9, 0),
                Owner: 0,
                Controller: 0,
                JackStack: [card(11, 0), card(11, 1)],
                JackOwners: [0, 0],
              }),
              pointEntry({
                Card: card(8, 2),
                Owner: 0,
                Controller: 0,
                JackStack: [card(11, 2), card(11, 3)],
                JackOwners: [0, 0],
              }),
            ],
            permanents: [card(10, 1)],
          },
          opponent: {
            handCount: 5,
            hand: null,
            // Same worst case, mirrored on the opponent's side.
            points: [
              pointEntry({
                Card: card(6, 2),
                Owner: 1,
                Controller: 1,
                JackStack: [card(11, 0), card(11, 1)],
                JackOwners: [1, 1],
              }),
              pointEntry({
                Card: card(3, 3),
                Owner: 1,
                Controller: 1,
                JackStack: [card(11, 2), card(11, 3)],
                JackOwners: [1, 1],
              }),
            ],
            permanents: [card(3, 3)],
          },
          deckCount: 20,
          scrap: [card(2, 0)],
        });
        const { root, board, actionBar } = mountBoard({ view });
        const centerZone = board.querySelector('[data-testid="center-zone"]') as HTMLElement;
        return {
          totalHeight: root.getBoundingClientRect().height,
          centerZoneHeight: centerZone.getBoundingClientRect().height,
          actionBarHeight: actionBar?.getBoundingClientRect().height ?? 0,
          handWraps: (board.querySelector('[data-testid="player-hand"]')?.getBoundingClientRect().height ?? 0) > 90,
        };
      }, HARNESS_URL);

      console.log(`[board-fit ${width}x${height}]`, JSON.stringify(result));
      if (allowScroll) {
        // Bounded, not open-ended: a regression that makes the overflow
        // materially worse still fails this. 40px is comfortably above
        // the ~19px this item measured and reported.
        expect(result.totalHeight).toBeLessThanOrEqual(height + 40);
      } else {
        expect(result.totalHeight).toBeLessThanOrEqual(height);
      }
    });
  }
});

test.describe('C: the tally chip does not cover the 5th point card at 390px wide', () => {
  test.use({ viewport: { width: 390, height: 844 } });

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
