// T4 — placeBubble (docs/tutorial-design.md §7.3, plan B2). Fixtures are
// 393x852 literals: score bar 0-44, action bar 792-852, a 320x130 bubble
// (room for four lines).
import { describe, expect, it } from 'vitest';

import { PLACEMENT, intersects, placeBubble, type Box, type PlacementInput } from '../../src/lib/tutorial/placement';

const viewport: Box = { x: 0, y: 0, width: 393, height: 852 };
const ACTION_BAR_TOP = 792;
const SCORE_BAR_BOTTOM = 44;

function input(over: Partial<PlacementInput>): PlacementInput {
  return {
    viewport,
    holes: [],
    avoid: [],
    actionBarTop: ACTION_BAR_TOP,
    scoreBarBottom: SCORE_BAR_BOTTOM,
    bubble: { width: 320, height: 130 },
    ...over,
  };
}

/** The padded holes and avoid boxes: what the bubble must never touch. */
function obstacles(i: PlacementInput): Box[] {
  const pad = PLACEMENT.holePad;
  return [
    ...i.holes.map((h) => ({ x: h.x - pad, y: h.y - pad, width: h.width + pad * 2, height: h.height + pad * 2 })),
    ...i.avoid,
  ];
}

function boxOf(p: { x: number; y: number }, i: PlacementInput): Box {
  return { x: p.x, y: p.y, width: i.bubble.width, height: i.bubble.height };
}

function expectClear(i: PlacementInput): void {
  const p = placeBubble(i);
  for (const o of obstacles(i)) expect(intersects(boxOf(p, i), o), JSON.stringify(o)).toBe(false);
}

describe('placeBubble', () => {
  it('goes below the lowest hole when it fits above the action bar', () => {
    const i = input({ holes: [{ x: 160, y: 380, width: 60, height: 84 }] });
    const p = placeBubble(i);
    // padded bottom 470, plus the 8 px notch
    expect(p.y).toBe(478);
    expect(p.notch).toBe('up');
    expectClear(i);
  });

  it('centres on the hole and points the notch at it', () => {
    const i = input({ holes: [{ x: 150, y: 380, width: 60, height: 84 }] });
    const p = placeBubble(i);
    expect(p.x + 160).toBe(180); // bubble centre = hole centre
    expect(p.notchX).toBe(180);
  });

  it('goes below with exactly 12 px to spare and above with 11', () => {
    // bubble bottom must be <= 792 - 12 = 780, so y <= 650, padded hole bottom <= 642
    const spare = input({ holes: [{ x: 160, y: 556, width: 60, height: 80 }] }); // padded bottom 642
    expect(placeBubble(spare).notch).toBe('up');
    expect(placeBubble(spare).y + 130).toBe(780);

    const tight = input({ holes: [{ x: 160, y: 557, width: 60, height: 80 }] }); // one px lower
    const p = placeBubble(tight);
    expect(p.notch).toBe('down');
    expectClear(tight);
  });

  it('goes above the highest hole when below does not fit', () => {
    const i = input({ holes: [{ x: 20, y: 700, width: 60, height: 78 }] });
    const p = placeBubble(i);
    expect(p.notch).toBe('down');
    // padded top 694, minus the notch and the bubble
    expect(p.y).toBe(694 - 8 - 130);
    expectClear(i);
  });

  it('uses the lowest of two holes for "below" and the highest for "above"', () => {
    const i = input({
      holes: [
        { x: 30, y: 120, width: 60, height: 60 },
        { x: 30, y: 200, width: 60, height: 60 },
      ],
    });
    const p = placeBubble(i);
    expect(p.notch).toBe('up');
    expect(p.y).toBe(266 + 8);
    expectClear(i);
  });

  it('goes to the side with more room when neither above nor below fits', () => {
    // Holes top and bottom, narrow and on the left: no vertical room, plenty on the right.
    const i = input({
      holes: [
        { x: 20, y: 60, width: 60, height: 60 },
        { x: 20, y: 700, width: 60, height: 78 },
      ],
      bubble: { width: 200, height: 130 },
    });
    const p = placeBubble(i);
    expect(p.notch).toBeNull();
    expect(p.x).toBe(86 + 8); // right of the padded holes, plus the gap
    expect(p.y).toBeGreaterThanOrEqual(SCORE_BAR_BOTTOM);
    expect(p.y + 130).toBeLessThanOrEqual(ACTION_BAR_TOP - 12);
    expectClear(i);

    // Mirror image: holes on the right, room on the left.
    const mirrored = input({
      holes: [
        { x: 313, y: 60, width: 60, height: 60 },
        { x: 313, y: 700, width: 60, height: 78 },
      ],
      bubble: { width: 200, height: 130 },
    });
    const m = placeBubble(mirrored);
    expect(m.notch).toBeNull();
    expect(m.x + 200).toBe(307 - 8);
    expectClear(mirrored);
  });

  it('docks under the score bar when nothing else clears', () => {
    // A wide hole mid-screen with counter options crowding both sides of it.
    const i = input({
      holes: [{ x: 20, y: 380, width: 353, height: 84 }],
      avoid: [
        { x: 16, y: 300, width: 361, height: 70 },
        { x: 16, y: 480, width: 361, height: 80 },
      ],
    });
    const p = placeBubble(i);
    expect(p.y).toBe(SCORE_BAR_BOTTOM + PLACEMENT.dockGap);
    expect(p.notch).toBeNull();
    expectClear(i);
  });

  it('refuses a candidate that would cover an avoid box and takes the next one', () => {
    // Below fits by geometry, but the staging bar sits right under the hole.
    const i = input({
      holes: [{ x: 160, y: 380, width: 60, height: 84 }],
      avoid: [{ x: 0, y: 480, width: 393, height: 60 }],
    });
    const p = placeBubble(i);
    expect(p.notch).toBe('down');
    expectClear(i);
  });

  it('under-menu docks below the prompt text (promptDock under the menu row), centred, whatever the holes say', () => {
    const i = input({ dock: 'under-menu', holes: [{ x: 20, y: 380, width: 60, height: 84 }] });
    const p = placeBubble(i);
    expect(p.y).toBe(SCORE_BAR_BOTTOM + PLACEMENT.promptDock);
    expect(p.x).toBe((393 - 320) / 2);
    expect(p.notch).toBeNull();
  });

  it('slides the dock down past a hole or avoid box it would touch, instead of covering it', () => {
    // Nothing fits above, below or beside (holes top and bottom, a staged card
    // pinned top-left), and the plain dock would graze the staged card.
    const i = input({
      holes: [{ x: 207, y: 800, width: 90, height: 44 }],
      avoid: [
        { x: 14, y: 177, width: 52, height: 68 },
        { x: 100, y: 697, width: 72, height: 90 },
      ],
      bubble: { width: 320, height: 150 },
    });
    const p = placeBubble(i);
    expect(p.notch).toBeNull();
    expect(p.y).toBeGreaterThan(SCORE_BAR_BOTTOM + PLACEMENT.dockGap);
    expect(p.y + 150).toBeLessThanOrEqual(ACTION_BAR_TOP - PLACEMENT.clearance);
    expectClear(i);

    // A hole at the dock position: slid below it, not on it.
    const hole = input({
      holes: [
        { x: 8, y: 60, width: 64, height: 80 },
        { x: 8, y: 640, width: 64, height: 80 },
      ],
    });
    expectClear(hole);
  });

  it('stays at the dock when no free spot exists above the action bar', () => {
    const i = input({ avoid: [{ x: 0, y: 44, width: 393, height: 700 }] });
    expect(placeBubble(i).y).toBe(SCORE_BAR_BOTTOM + PLACEMENT.dockGap);
  });

  it('docks when there are no holes at all', () => {
    const p = placeBubble(input({}));
    expect(p.y).toBe(SCORE_BAR_BOTTOM + PLACEMENT.dockGap);
    expect(p.notch).toBeNull();
  });

  it('clamps x to a 16 px gutter on both edges', () => {
    const left = placeBubble(input({ holes: [{ x: 0, y: 380, width: 40, height: 84 }] }));
    expect(left.x).toBe(16);
    // The notch still points at the hole, kept clear of the corner.
    expect(left.notchX).toBeGreaterThanOrEqual(left.x + 24);
    expect(left.notchX).toBeLessThanOrEqual(left.x + 320 - 24);

    const right = placeBubble(input({ holes: [{ x: 353, y: 380, width: 40, height: 84 }] }));
    expect(right.x).toBe(393 - 16 - 320);
  });

  it('keeps every placement inside the viewport gutters', () => {
    for (const hx of [0, 100, 200, 340]) {
      for (const hy of [60, 300, 560, 700]) {
        const p = placeBubble(input({ holes: [{ x: hx, y: hy, width: 50, height: 60 }] }));
        expect(p.x).toBeGreaterThanOrEqual(16);
        expect(p.x + 320).toBeLessThanOrEqual(393 - 16);
      }
    }
  });

  it('never covers a hole across a sweep of single-hole positions that have room', () => {
    for (const hx of [0, 100, 200, 340]) {
      for (const hy of [60, 200, 300, 500, 560, 700]) {
        expectClear(input({ holes: [{ x: hx, y: hy, width: 50, height: 60 }] }));
      }
    }
  });

  it('works at the short 393x660 view', () => {
    const short = input({
      viewport: { x: 0, y: 0, width: 393, height: 660 },
      actionBarTop: 600,
      holes: [{ x: 160, y: 380, width: 60, height: 84 }],
    });
    const p = placeBubble(short);
    // below would end at 478+130 = 608 > 588, so it goes above
    expect(p.notch).toBe('down');
    expectClear(short);
  });
});

// T14 judge M2: during a success or Blake beat the cards in flight are `soft`
// boxes. The bubble keeps clear of all of them when there is room; when there
// isn't, the last (least important) is dropped first, then the next, and the
// hard `avoid` boxes and holes are never given up.
describe('placeBubble: soft boxes (the cards in flight)', () => {
  const hit = { x: 14, y: 175, width: 60, height: 70 }; // the scuttled point card
  const scrap = { x: 323, y: 340, width: 60, height: 84 };
  const source = { x: 70, y: 705, width: 60, height: 78 }; // where the card left the hand

  it('keeps clear of every soft box when there is room', () => {
    const i = input({ avoid: [{ x: 10, y: 48, width: 373, height: 42 }], soft: [hit, scrap, source] });
    const p = placeBubble(i);
    for (const b of [...i.avoid, hit, scrap, source]) expect(intersects(boxOf(p, i), b), JSON.stringify(b)).toBe(false);
    // Without the soft boxes it would have docked right over the hit.
    const plain = placeBubble({ ...i, soft: [] });
    expect(intersects(boxOf(plain, i), hit)).toBe(true);
  });

  it('drops the soft boxes from the end until a spot is clear, never the first ones first', () => {
    // A band so tight that only dropping the last soft box leaves room.
    const blocker = { x: 0, y: 260, width: 393, height: 80 };
    // The second soft box fills everything below the blocker: only dropping it leaves room.
    const tight = input({ avoid: [blocker], soft: [hit, { x: 0, y: 345, width: 393, height: 447 }] });
    const p = placeBubble(tight);
    expect(intersects(boxOf(p, tight), blocker)).toBe(false);
    expect(intersects(boxOf(p, tight), hit), 'the first soft box is kept').toBe(false);
  });

  it('never trades a hard box for a soft one: with no room at all it docks as before', () => {
    const wall = { x: 0, y: 44, width: 393, height: 748 };
    const i = input({ avoid: [], soft: [wall] });
    expect(placeBubble(i)).toEqual(placeBubble(input({ avoid: [] })));
  });

  it('soft boxes are ignored by a candidate that already clears them (below a hole)', () => {
    const i = input({ holes: [{ x: 160, y: 380, width: 60, height: 84 }], soft: [scrap] });
    expect(placeBubble(i)).toEqual(placeBubble(input({ holes: i.holes })));
  });
});
