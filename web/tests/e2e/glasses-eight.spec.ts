import { expect, test } from '@playwright/test';

// W24: a glasses 8 lies sideways in the permanents row. Real-browser
// checks jsdom can't make: the box really is landscape, and a tap anywhere
// on it (including the part an upright card would not cover) hit-tests to
// that card's own testid and fires its own `perm:` key, as it must when the
// sideways 8 is the target of a 2 or a 9.

const HARNESS_URL = '/tests/e2e/harness/mount-board.ts';
type Harness = typeof import('./harness/mount-board');

for (const { width, height } of [
  { width: 393, height: 852 },
  { width: 430, height: 932 },
]) {
  test(`${width}x${height}: a tap anywhere on a sideways 8 resolves to its own key, on either side`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForSelector('body');

    const result = await page.evaluate(async (harnessUrl) => {
      const H = (await import(harnessUrl)) as Harness;
      H.unmountAll();
      (document.getElementById('app') as HTMLElement).style.display = 'none';
      const view = H.playerView({
        you: { hand: [H.card(2, 2)], frozenHandIndices: [], points: [], permanents: [H.card(8, 1)], watched: true },
        opponent: { handCount: 3, hand: null, points: [], permanents: [H.card(12, 3), H.card(8, 0)] },
      });
      const taps: string[] = [];
      const { board } = H.mountGameColumn({
        view,
        // As when a 2 is staged: both glasses are legal targets.
        highlighted: new Set(['perm:1:1', 'perm:0:0']),
        ontap: (k) => taps.push(k),
      });

      const probe = (testid: string) => {
        const el = board.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
        const r = el.getBoundingClientRect();
        const hits: string[] = [];
        // Centre, and the right tenth: outside where an upright card of the
        // same width would end.
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0.9, 0.5],
          [0.9, 0.15],
          [0.1, 0.85],
        ]) {
          const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          hits.push(hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? 'none');
        }
        el.click();
        return { width: r.width, height: r.height, hits, state: el.querySelector('[data-state]')?.getAttribute('data-state') };
      };

      const opp = probe('perm-1-1');
      const mine = probe('perm-0-0');
      const queen = board.querySelector<HTMLElement>('[data-testid="perm-1-0"]')!.getBoundingClientRect();
      return { opp, mine, taps, queen: { width: queen.width, height: queen.height } };
    }, HARNESS_URL);

    console.log(`[glasses-eight ${width}x${height}]`, JSON.stringify(result));
    for (const side of [result.opp, result.mine]) {
      expect(side.width).toBeGreaterThan(side.height * 1.2);
      expect(side.height).toBeGreaterThanOrEqual(44);
      expect(side.state).toBe('highlighted');
    }
    expect(result.opp.hits).toEqual(['perm-1-1', 'perm-1-1', 'perm-1-1', 'perm-1-1']);
    expect(result.mine.hits).toEqual(['perm-0-0', 'perm-0-0', 'perm-0-0', 'perm-0-0']);
    expect(result.taps).toEqual(['perm:1:1', 'perm:0:0']);
    // The Queen beside it stays upright.
    expect(result.queen.height).toBeGreaterThan(result.queen.width);
  });
}
