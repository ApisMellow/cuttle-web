// Coach bubble placement (docs/tutorial-design.md §7.3, plan B2). Pure: boxes
// in, a position out. No DOM reads, so it is testable with literals and T12
// can tune the constants below against the geometry e2e.
//
// Order (design §7.3):
//   1. below the lowest hole, if the bubble then ends 12 px above the action bar
//   2. above the highest hole, if it then starts at or below the score bar
//   3. beside the holes, on the side with more room, inside the free band
//   4. docked under the score bar (the last resort; may cover a hole)
// Candidates 1-3 are rejected if they would touch a padded hole or an
// `avoid` box (staging bar, menu button, counter-prompt options).
// `dock: 'under-menu'` (the counter prompt) skips straight to the dock.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementInput {
  viewport: Box;
  /** Spotlight targets, unpadded: the 6 px hole padding is added here. */
  holes: Box[];
  /** Boxes the bubble must never cover. */
  avoid: Box[];
  /** Top edge of the action bar (viewport y). */
  actionBarTop: number;
  /** Bottom edge of the score bar and menu row (viewport y). */
  scoreBarBottom: number;
  /** Measured width and the reserved height (room for 4 lines of copy). */
  bubble: { width: number; height: number };
  dock?: 'under-menu';
}

export interface BubblePlacement {
  x: number;
  y: number;
  /** Which edge carries the notch toward the hole; null when it points at nothing. */
  notch: 'up' | 'down' | null;
  /** Notch centre, in viewport x. */
  notchX: number;
}

/** Starting values (plan B2); T12 tunes them. */
export const PLACEMENT = {
  /** Clearance kept above the action bar. */
  clearance: 12,
  /** Side gutter. */
  gutter: 16,
  /** Padding around a hole (matches CoachSpotlight). */
  holePad: 6,
  /** Notch height, and the gap between a hole and the bubble. */
  notch: 8,
  /** Gap between the score bar and a docked bubble. */
  dockGap: 8,
} as const;

function inflate(b: Box, pad: number): Box {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

/** Strict overlap: boxes that only share an edge do not intersect. */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function bounds(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function placeBubble(input: PlacementInput): BubblePlacement {
  const { viewport, avoid, actionBarTop, scoreBarBottom, bubble } = input;
  const { gutter, clearance, notch, dockGap, holePad } = PLACEMENT;
  const { width, height } = bubble;

  const minX = viewport.x + gutter;
  const maxX = Math.max(minX, viewport.x + viewport.width - gutter - width);
  const clampX = (x: number): number => Math.min(Math.max(x, minX), maxX);

  const holes = input.holes.map((h) => inflate(h, holePad));
  const obstacles = [...holes, ...avoid];
  const free = (r: Box): boolean => !obstacles.some((o) => intersects(r, o));

  const viewportMid = viewport.x + viewport.width / 2;
  const span = holes.length > 0 ? bounds(holes) : null;
  const aimX = span ? span.x + span.width / 2 : viewportMid;

  const result = (x: number, y: number, side: 'up' | 'down' | null): BubblePlacement => ({
    x,
    y,
    notch: side,
    // Keep the notch clear of the rounded corners.
    notchX: side ? Math.min(Math.max(aimX, x + gutter + notch), x + width - gutter - notch) : x + width / 2,
  });

  const dockAt = (x: number): BubblePlacement => result(x, scoreBarBottom + dockGap, null);

  if (input.dock === 'under-menu' || !span) {
    return dockAt(clampX(input.dock === 'under-menu' ? viewportMid - width / 2 : aimX - width / 2));
  }

  const x = clampX(aimX - width / 2);

  // 1. Below the lowest hole.
  const belowY = span.y + span.height + notch;
  const below: Box = { x, y: belowY, width, height };
  if (belowY + height <= actionBarTop - clearance && free(below)) return result(x, belowY, 'up');

  // 2. Above the highest hole.
  const aboveY = span.y - notch - height;
  const above: Box = { x, y: aboveY, width, height };
  if (aboveY >= scoreBarBottom && free(above)) return result(x, aboveY, 'down');

  // 3. Beside the holes, the roomier side first, inside the free band.
  const bandTop = scoreBarBottom;
  const bandBottom = actionBarTop - clearance;
  if (bandBottom - bandTop >= height) {
    const sideY = Math.min(Math.max(span.y + span.height / 2 - height / 2, bandTop), bandBottom - height);
    const leftRoom = span.x - notch - minX;
    const rightRoom = viewport.x + viewport.width - gutter - (span.x + span.width + notch);
    const sides = [
      { room: leftRoom, x: span.x - notch - width },
      { room: rightRoom, x: span.x + span.width + notch },
    ].sort((a, b) => b.room - a.room);
    for (const side of sides) {
      if (side.room < width) continue;
      if (free({ x: side.x, y: sideY, width, height })) return result(side.x, sideY, null);
    }
  }

  // 4. Dock under the score bar.
  return dockAt(x);
}
