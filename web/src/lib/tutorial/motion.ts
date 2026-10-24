// Tutorial motion base (docs/tutorial-design.md §8.2, §8.3; plan T8, extended
// by T10). Three jobs:
//
//   1. `motionOn`: the one reduced-motion switch. Calm when either the OS
//      media query or the in-app setting asks, the same rule CoachBubble and
//      CoachSpotlight apply.
//   2. `readMotionTokens`: the durations and easing in tokens.css, read once
//      per lesson with getComputedStyle.
//   3. The ghost-demo timelines as pure keyframe lists, so they can be tested
//      without a browser. Every keyframe animates `transform` and `opacity`
//      only (design §8.7). Nothing here awaits an animation (SPEC §5.9).
//
// WAAPI easing strings cannot use var(), so the few easings below repeat the
// token values; tokens.css stays the source for CSS and for `easeLand`.

/** The rect fields the timelines read; a DOMRect and a plain `{x,y,width,height}` both fit. */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MotionTokens {
  flight: number;
  demoTravel: number;
  dealStagger: number;
  easeLand: string;
  fast: number;
  med: number;
  slow: number;
}

/** Design §8.2 values; used when a token cannot be read (jsdom, a missing stylesheet). */
const TOKEN_DEFAULTS: MotionTokens = {
  flight: 420,
  demoTravel: 660,
  dealStagger: 80,
  easeLand: 'cubic-bezier(0.3, 1.25, 0.5, 1)',
  fast: 120,
  med: 200,
  slow: 320,
};

/** The reduced-motion query, spelled once. */
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * False when either the media query or the setting asks for reduced motion.
 * `mql` is injectable for tests; by default it is window.matchMedia. A
 * missing or throwing matchMedia means "no preference".
 */
export function motionOn(settingsReduced: boolean, mql?: Pick<MediaQueryList, 'matches'>): boolean {
  if (settingsReduced) return false;
  try {
    const query =
      mql ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_QUERY) : null);
    return !(query?.matches ?? false);
  } catch {
    return true;
  }
}

function parseMs(raw: string, fallback: number): number {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(raw.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : n;
}

/** Reads the motion tokens as seen by `el`. A zeroed token (reduced motion) reads as 0. */
export function readMotionTokens(el: Element): MotionTokens {
  const style = getComputedStyle(el);
  const ms = (name: string, fallback: number) => parseMs(style.getPropertyValue(name), fallback);
  return {
    flight: ms('--cu-dur-flight', TOKEN_DEFAULTS.flight),
    demoTravel: ms('--cu-dur-demo-travel', TOKEN_DEFAULTS.demoTravel),
    dealStagger: ms('--cu-dur-deal-stagger', TOKEN_DEFAULTS.dealStagger),
    easeLand: style.getPropertyValue('--cu-ease-land').trim() || TOKEN_DEFAULTS.easeLand,
    fast: ms('--cu-dur-fast', TOKEN_DEFAULTS.fast),
    med: ms('--cu-dur-med', TOKEN_DEFAULTS.med),
    slow: ms('--cu-dur-slow', TOKEN_DEFAULTS.slow),
  };
}

// ─── Easing ──────────────────────────────────────────────────────────────

const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'; // --cu-ease-out
const EASE_LAND = TOKEN_DEFAULTS.easeLand; // --cu-ease-land
const EASE_IN = 'ease-in';

/** --cu-ease-in-out as a function, so the travel can be sampled along an arc. */
const easeInOut = cubicBezier(0.6, 0, 0.3, 1);

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const coord = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (coord(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return coord(y1, y2, (lo + hi) / 2);
  };
}

// ─── Keyframe helpers ────────────────────────────────────────────────────

/** Two decimals, never "-0". */
const n2 = (n: number): number => Math.round(n * 100) / 100 + 0;

interface Stop {
  at: number;
  opacity: number;
  transform: string;
  easing?: string;
}

function toFrames(stops: Stop[], total: number): Keyframe[] {
  return stops.map((s) => {
    const frame: Keyframe = { offset: s.at / total, opacity: s.opacity, transform: s.transform };
    if (s.easing) frame.easing = s.easing;
    return frame;
  });
}

// ─── Drag demo (design §8.3) ─────────────────────────────────────────────
//
//   0-200      the dot fades in over the card centre (scale 1.25 to 1)
//   200-320    press: the dot goes to 0.85, the ghost card appears and lifts 12 px
//   320-980    dot and ghost travel to the target on a gentle arc (24 px higher
//              at the midpoint), the card turning -4deg to 0, ease-in-out
//   980-1180   release: the dot returns to scale 1, the card is set down
//   1180-1500  both fade out (the target ring flashes in `dragRingFrames`)

export const DRAG_TRAVEL_MS = 660;
const IN_MS = 200;
const PRESS_MS = 120;
const RELEASE_MS = 200;
const FADE_MS = 320;
const ARC_PX = 24;
const LIFT_PX = 12;
const GHOST_OPACITY = 0.72;
const TRAVEL_STEPS = 12;

export interface DragDemoOptions {
  /** Travel time; defaults to the design's 660 ms (`--cu-dur-demo-travel`). */
  travelMs?: number;
}

function dragTimes(opts: DragDemoOptions | undefined) {
  const travel = Math.max(1, opts?.travelMs ?? DRAG_TRAVEL_MS);
  const travelStart = IN_MS + PRESS_MS;
  const travelEnd = travelStart + travel;
  const releaseEnd = travelEnd + RELEASE_MS;
  return { travel, travelStart, travelEnd, releaseEnd, total: releaseEnd + FADE_MS };
}

const centre = (r: RectLike) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * The drag demo as keyframes. Offsets are fractions of `durationMs`. The
 * elements are anchored at the source centre; the transforms are offsets from
 * it. `dot` is the fingertip, `card` the ghost card (opacity at most 0.72).
 */
export function dragDemoFrames(
  from: RectLike,
  to: RectLike,
  opts?: DragDemoOptions,
): { dot: Keyframe[]; card: Keyframe[]; durationMs: number } {
  const t = dragTimes(opts);
  const a = centre(from);
  const b = centre(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const dotAt = (at: number, opacity: number, x: number, y: number, s: number, easing?: string): Stop => ({
    at,
    opacity,
    transform: `translate(${n2(x)}px, ${n2(y)}px) scale(${n2(s)})`,
    easing,
  });
  const cardAt = (at: number, opacity: number, x: number, y: number, deg: number, s: number, easing?: string): Stop => ({
    at,
    opacity,
    transform: `translate(${n2(x)}px, ${n2(y)}px) rotate(${n2(deg)}deg) scale(${n2(s)})`,
    easing,
  });

  const dot: Stop[] = [
    dotAt(0, 0, 0, 0, 1.25, EASE_OUT),
    dotAt(IN_MS, 1, 0, 0, 1, EASE_OUT),
    dotAt(t.travelStart, 1, 0, 0, 0.85, 'linear'),
  ];
  const card: Stop[] = [
    cardAt(0, 0, 0, 0, 0, 1, 'linear'),
    cardAt(IN_MS, 0, 0, 0, 0, 1, EASE_OUT),
    cardAt(t.travelStart, GHOST_OPACITY, 0, -LIFT_PX, -4, 1.04, 'linear'),
  ];

  // The travel is sampled so the ease-in-out and the arc are exact: the chord
  // progress follows the token easing, the arc follows the clock and peaks at
  // the midpoint.
  for (let i = 1; i <= TRAVEL_STEPS; i++) {
    const u = i / TRAVEL_STEPS;
    const p = easeInOut(u);
    const arc = ARC_PX * 4 * u * (1 - u);
    const at = t.travelStart + t.travel * u;
    const last = i === TRAVEL_STEPS;
    dot.push(dotAt(at, 1, dx * p, dy * p - arc, 0.85, last ? EASE_LAND : 'linear'));
    card.push(cardAt(at, GHOST_OPACITY, dx * p, dy * p - arc - LIFT_PX, -4 * (1 - p), 1.04, last ? EASE_LAND : 'linear'));
  }

  dot.push(dotAt(t.releaseEnd, 1, dx, dy, 1, EASE_IN));
  card.push(cardAt(t.releaseEnd, GHOST_OPACITY, dx, dy, 0, 1, EASE_IN));
  dot.push(dotAt(t.total, 0, dx, dy, 1));
  card.push(cardAt(t.total, 0, dx, dy, 0, 1));

  return { dot: toFrames(dot, t.total), card: toFrames(card, t.total), durationMs: t.total };
}

/**
 * The target ring's flash at release: dark through the travel, in with a small
 * settle at release, then gone with the fade. Same `durationMs` as the drag.
 */
export function dragRingFrames(opts?: DragDemoOptions): Keyframe[] {
  const t = dragTimes(opts);
  const still = (at: number, opacity: number, s: number, easing?: string): Stop => ({
    at,
    opacity,
    transform: `scale(${s})`,
    easing,
  });
  return toFrames(
    [
      still(0, 0, 1.08, 'linear'),
      still(t.travelEnd, 0, 1.08, EASE_OUT),
      still(t.travelEnd + 80, 1, 1, 'linear'),
      still(t.releaseEnd, 1, 1, EASE_IN),
      still(t.total, 0, 1),
    ],
    t.total,
  );
}

// ─── Tap demo (design §8.3) ──────────────────────────────────────────────
//
// The dot fades in over 200 ms, presses to 0.82 over 90 ms, a ripple ring
// expands (scale 1 to 2.2, opacity 0.6 to 0, 360 ms) and the dot fades over
// 200 ms: about 900 ms. "Tap twice" repeats the press and ripple 300 ms apart.

const TAP_IN_MS = 200;
const TAP_DOWN_MS = 90;
const TAP_SPRING_MS = 150;
const TAP_GAP_MS = 300;
const RIPPLE_MS = 360;
const TAP_FADE_MS = 200;
const TAP_HOLD_MS = 50;

/** The tap demo as keyframes: a fingertip dot that stays put, and one ripple ring. */
export function tapDemoFrames(times: 1 | 2): { dot: Keyframe[]; ripple: Keyframe[]; durationMs: number } {
  const presses = Array.from({ length: times }, (_, k) => TAP_IN_MS + TAP_GAP_MS * k);
  const downs = presses.map((p) => p + TAP_DOWN_MS);
  const rippleEnds = downs.map((d, k) => (k < downs.length - 1 ? Math.min(d + RIPPLE_MS, downs[k + 1] - 5) : d + RIPPLE_MS));
  const fadeStart = rippleEnds[rippleEnds.length - 1] + TAP_HOLD_MS;
  const total = fadeStart + TAP_FADE_MS;

  const dotAt = (at: number, opacity: number, s: number, easing?: string): Stop => ({
    at,
    opacity,
    transform: `scale(${s})`,
    easing,
  });
  const dot: Stop[] = [dotAt(0, 0, 1.25, EASE_OUT), dotAt(TAP_IN_MS, 1, 1, EASE_OUT)];
  presses.forEach((press, k) => {
    if (k > 0) dot.push(dotAt(press, 1, 1, EASE_OUT));
    dot.push(dotAt(downs[k], 1, 0.82, EASE_LAND));
    dot.push(dotAt(downs[k] + TAP_SPRING_MS, 1, 1, 'linear'));
  });
  dot.push(dotAt(fadeStart, 1, 1, EASE_IN), dotAt(total, 0, 1));

  // One ripple element: each burst is held dark until it starts, so the
  // keyframes before it step rather than ramp.
  const ring = (at: number, opacity: number, s: number, easing?: string): Stop => ({
    at,
    opacity,
    transform: `scale(${s})`,
    easing,
  });
  const ripple: Stop[] = [ring(0, 0, 1, 'step-end')];
  downs.forEach((start, k) => {
    ripple.push(ring(start, 0.6, 1, EASE_OUT));
    ripple.push(ring(rippleEnds[k], 0, 2.2, 'step-end'));
  });
  ripple.push(ring(total, 0, 2.2));

  return { dot: toFrames(dot, total), ripple: toFrames(ripple, total), durationMs: total };
}
