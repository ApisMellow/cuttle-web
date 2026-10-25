// Issue #54 — press and hold a card to see it enlarged. Pure helpers: no DOM,
// no store, no rule. GameScreen owns the pointer events and feeds them here.
//
//   LongPress   one pointer's press: arms a timer on `down`, cancels it when
//               the pointer travels DRAG_THRESHOLD_PX (a drag wins), fires
//               `onfire` after LONG_PRESS_MS, and on `up` says whether the
//               release ends a hold (so it must not act as a tap).
//   cardForKey  the face-up card a board target key names, from the viewer's
//               own view only (never the opponent's hand, the deck or a back).

import type { Card, PlayerView } from './bridge/schema';
import { DRAG_THRESHOLD_PX } from './dragDrop';
import type { TargetKey } from './targetKey';

/** How long a press must be held before the card enlarges. */
export const LONG_PRESS_MS = 2000;

/** How long after a hold's release a click on the pressed card is still swallowed. */
export const LONG_PRESS_SWALLOW_MS = 400;

export class LongPress {
  /** The key being held, once the timer has fired; `null` otherwise. */
  held: TargetKey | null = null;
  pointerId: number | null = null;
  key: TargetKey | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #startX = 0;
  #startY = 0;
  #swallowUntil = 0;
  readonly #onfire: (key: TargetKey) => void;
  readonly #ms: number;

  constructor(onfire: (key: TargetKey) => void, ms: number = LONG_PRESS_MS) {
    this.#onfire = onfire;
    this.#ms = ms;
  }

  /** Arms the hold for one pointer on one card. Ignored while another press is live. */
  down(pointerId: number, key: TargetKey, x: number, y: number): void {
    if (this.pointerId !== null) return;
    this.pointerId = pointerId;
    this.key = key;
    this.#startX = x;
    this.#startY = y;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.held = key;
      this.#onfire(key);
    }, this.#ms);
  }

  /** Past the drag threshold before the timer fires, the hold is dropped (a drag, or a scroll, wins). */
  move(pointerId: number, x: number, y: number): void {
    if (pointerId !== this.pointerId || this.held !== null) return;
    if (Math.hypot(x - this.#startX, y - this.#startY) >= DRAG_THRESHOLD_PX) this.cancel();
  }

  /**
   * The pointer was released. `true` when it ended a hold that had fired: the
   * view must close, and this release is not a tap (the next click on the
   * card is swallowed for LONG_PRESS_SWALLOW_MS). `false` for a short press
   * or another pointer.
   */
  up(pointerId: number, now: number): boolean {
    if (pointerId !== this.pointerId) return false;
    const fired = this.held !== null;
    this.cancel();
    if (fired) this.#swallowUntil = now + LONG_PRESS_SWALLOW_MS;
    return fired;
  }

  /** Whether a click at `now` is the tail of a hold and must be dropped. One-shot. */
  swallowClick(now: number): boolean {
    const swallow = now < this.#swallowUntil;
    this.#swallowUntil = 0;
    return swallow;
  }

  /** Clears the timer and the press (pointercancel, a curtain, unmount). */
  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.held = null;
    this.pointerId = null;
    this.key = null;
  }
}

/**
 * The card a board target key shows face-up to this viewer: one of their own
 * hand cards, or a point or permanent card on either side. Anything else
 * (the deck, the scrap, the 7's tray, a zone) is `null`. The opponent's hand
 * is never read.
 */
export function cardForKey(key: TargetKey, view: PlayerView): Card | null {
  const [kind, a, b] = key.split(':');
  if (kind === 'hand') return view.you.hand[Number(a)] ?? null;
  if (kind !== 'point' && kind !== 'perm') return null;
  const side = Number(a) === view.viewer ? view.you : view.opponent;
  const index = Number(b);
  if (kind === 'point') return side.points[index]?.Card ?? null;
  return side.permanents[index] ?? null;
}
