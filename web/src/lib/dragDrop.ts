// Issue #26 — drag a hand card onto a target (SPEC §6.1, "Drag and drop").
// Pure helpers only: no store, no DOM writes, no rule. A drag never commits
// anything; it ends in the same `tap(key)` a tap on the target would make,
// so the StagingStore stays the only path to `staged`, and Confirm (or a
// second deck tap) stays the only path to `apply` (R12).
//
//   DragGesture         tracks one pointer from pointerdown; below the 8 px
//                       threshold it is still a tap, past it a drag.
//   testIdForKey /      the board's testids and the TargetKey vocabulary,
//   targetKeyFromTestId both ways (testids are contract, SPEC §5.1).
//   dropKeyAt           the target key under the pointer at the drop.
//   dropTarget          whether a drop is a tap on a lit target or a snap back.

import { resolveBoardTap, parseTargetKey, type TargetKey } from './targetKey';
import type { PlayerId } from './bridge/schema';

/** How far a pointer must travel before a press on a hand card becomes a drag. */
export const DRAG_THRESHOLD_PX = 8;

export type DragPhase = 'idle' | 'pending' | 'dragging';

/** What the board draws for an active drag: which of the viewer's own hand cards, and its offset in px. */
export interface HandDrag {
  handIndex: number;
  x: number;
  y: number;
}

/**
 * One pointer's press on a hand card. `down` arms it (pending), `move`
 * reports `'start'` once the pointer has travelled DRAG_THRESHOLD_PX from
 * where it went down and `'move'` after that, and `up` reports `'tap'` (it
 * never started) or `'drop'`. Other pointers are ignored. Holds no DOM.
 */
export class DragGesture {
  phase: DragPhase = 'idle';
  pointerId: number | null = null;
  handIndex: number | null = null;
  dx = 0;
  dy = 0;
  #startX = 0;
  #startY = 0;

  down(pointerId: number, handIndex: number, x: number, y: number): void {
    if (this.phase !== 'idle') return;
    this.phase = 'pending';
    this.pointerId = pointerId;
    this.handIndex = handIndex;
    this.#startX = x;
    this.#startY = y;
    this.dx = 0;
    this.dy = 0;
  }

  move(pointerId: number, x: number, y: number): 'start' | 'move' | null {
    if (this.phase === 'idle' || pointerId !== this.pointerId) return null;
    this.dx = x - this.#startX;
    this.dy = y - this.#startY;
    if (this.phase === 'dragging') return 'move';
    if (Math.hypot(this.dx, this.dy) < DRAG_THRESHOLD_PX) return null;
    this.phase = 'dragging';
    return 'start';
  }

  up(pointerId: number): 'tap' | 'drop' | null {
    if (this.phase === 'idle' || pointerId !== this.pointerId) return null;
    const result = this.phase === 'dragging' ? 'drop' : 'tap';
    this.cancel();
    return result;
  }

  cancel(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.handIndex = null;
    this.dx = 0;
    this.dy = 0;
  }
}

/** The testid the board renders for a target key (SPEC §5.1). */
export function testIdForKey(key: TargetKey): string {
  if (key === 'deck') return 'deck-pile';
  if (key === 'scrap') return 'scrap-pile';
  if (key.startsWith('hand:')) return `hand-card-${key.slice('hand:'.length)}`;
  if (key.startsWith('seven:')) return `seven-card-${key.slice('seven:'.length)}`;
  return key.replace(/:/g, '-');
}

/** The inverse of `testIdForKey`: a testid that names a board target, as its key; anything else is `null`. */
export function targetKeyFromTestId(testId: string): TargetKey | null {
  if (testId === 'deck-pile') return 'deck';
  if (testId === 'scrap-pile') return 'scrap';
  let m = /^hand-card-(\d+)$/.exec(testId);
  if (m) return `hand:${Number(m[1])}`;
  m = /^seven-card-(\d+)$/.exec(testId);
  if (m) return `seven:${Number(m[1])}`;
  m = /^zone-(points|permanents|oneoff)$/.exec(testId);
  if (m) return parseTargetKey(`zone:${m[1]}`);
  m = /^(point|perm)-([01])-(\d+)$/.exec(testId);
  if (m) return parseTargetKey(`${m[1]}:${m[2]}:${Number(m[3])}`);
  return null;
}

/** The target key of whatever is under the pointer (`document.elementFromPoint`), or `null` for empty space. */
export function dropKeyAt(hit: Element | null): TargetKey | null {
  const owner = hit?.closest('[data-testid]');
  const testId = owner?.getAttribute('data-testid');
  return testId ? targetKeyFromTestId(testId) : null;
}

/**
 * What a drop does. A lit target (after the same rewrite a tap gets, so a
 * card already in your own lit points row counts as the points zone) is
 * returned, to be tapped exactly as a tap would. Anything else, including
 * empty space, the deck and any hand card, returns `null`: the card snaps
 * back.
 */
export function dropTarget(key: TargetKey | null, highlighted: ReadonlySet<string>, viewer: PlayerId): TargetKey | null {
  if (key === null) return null;
  const resolved = resolveBoardTap(key, highlighted, viewer);
  if (resolved.startsWith('hand:')) return null;
  return highlighted.has(resolved) ? resolved : null;
}
