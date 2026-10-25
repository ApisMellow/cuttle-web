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

import type { AppliedMove, Card, Move, MoveKind as MoveKindValue, PlayerId, PlayerView } from '../bridge/schema';
import { MoveKind, TargetZone } from '../enums';

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

// ─── Card flights (design §8.4, plan T10) ────────────────────────────────
//
// FLIP on clones. `snapshot` runs BEFORE the engine apply and records the
// screen rects and the identities seat 0 can already see: her own hand, cards
// on the table, and Blake's hand only when glasses show it. Alice's flights
// come from her `Move` (`capture`); Blake's come from the public log entry for
// his reply (`captureReply`) and never from his `Move`, whose indices are
// hidden information. Everything that only the new state can say (the card just
// drawn, Blake's hand after glasses) comes later, from seat 0's post-apply
// view, in `flightAfter`.
//
// `flightScript` turns a capture plus the destinations measured after the
// render into clone timelines. It is pure, so every plan can be tested without
// a browser. The FlightLayer component draws and animates the result; nothing
// here awaits an animation (SPEC §5.9) and every keyframe animates `transform`
// and `opacity` only.

/** What the snapshot and the layer search for board elements by testid. */
export type FlightRoot = ParentNode;

export type FlightPlanName =
  | 'toRow'
  | 'jackSteal'
  | 'scuttle'
  | 'oneOff'
  | 'drawFlip'
  | 'drawBack'
  | 'blakePlays'
  | 'glassesFlip'
  | 'arrive';

/** How the moving card ends up: a plan without the two wrappers that add a source or a follow-up. */
export type FlightLanding = Exclude<FlightPlanName, 'blakePlays' | 'glassesFlip'>;

/**
 * A rect as four plain fields. A DOMRect's fields are prototype getters, so
 * `{ ...domRect }` silently drops them (NaN keyframes): every rect this module
 * keeps or derives is built field by field, never spread.
 */
export function toRect(r: RectLike): RectLike {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

const shifted = (r: RectLike, dx: number, dy: number): RectLike => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });

/**
 * Pre-apply facts for one flight. `rects` and `cards` are keyed by role:
 * `source` (where the moving card starts), `target` (a scuttled or stolen
 * point card), `deck`, `scrap`, `oneoff`, `oppHand`, and `sweep:<testid>` for
 * each point card an Ace will scrap. `cards.source` is what the clone shows at
 * the start (`'back'` for the opponent's hidden hand and for the deck);
 * `cards.face` is what a back turns into, only when it is public.
 *
 * Fields after `cards` are derived once here so the layer needs nothing else.
 */
export interface FlightCapture {
  kind: MoveKindValue;
  rects: Record<string, RectLike>;
  cards: Record<string, Card | 'back'>;
  plan: FlightPlanName;
  landing: FlightLanding;
  /** Absolute seat of the mover (testids are keyed by absolute seat). */
  by: PlayerId;
  /** The mover is the viewer (Alice). */
  mine: boolean;
  /** The viewer could already see the opponent's hand when the move was made. */
  glasses: boolean;
  /** A glasses 8: it lands lying on its side. */
  sideways: boolean;
  /** The row the mover's card lands in (`point-<seat>-<i>` or `perm-<seat>-<i>`). */
  row: 'point' | 'perm' | null;
}

/**
 * The only facts a flight plan reads about a move: what kind it was, the card
 * played (public once it lands), and the point card it targeted (public, on
 * the table). Blake's flights are built from exactly this, taken from a log
 * entry already redacted for seat 0, never from his `Move`: its `HandIndex`
 * and target indices are hidden information (issue #69's class).
 */
export interface FlightMove {
  kind: MoveKindValue;
  card: Card | null;
  targetCard: Card | null;
}

/** The point or permanent card a move aims at, read from the viewer's own view. */
function targetCardIn(move: Move, view: PlayerView): Card | null {
  const m = move.Kind === MoveKind.SevenPick ? move.SubMove : move;
  if (!m) return null;
  const t = m.Kind === MoveKind.PlayPermanent ? m.JackTarget : m.Target;
  if (!t) return null;
  const side = t.Owner === view.viewer ? view.you : view.opponent;
  return (t.Zone === TargetZone.Points ? side.points[t.Index]?.Card : side.permanents[t.Index]) ?? null;
}

/** Alice's own move, with her view to name its target. */
export function flightMoveOf(move: Move, view: PlayerView): FlightMove {
  return { kind: move.Kind, card: move.Card, targetCard: targetCardIn(move, view) };
}

const isJackPlay = (m: FlightMove): boolean => m.kind === MoveKind.PlayPermanent && (m.targetCard !== null || m.card?.Rank === 11);
const isGlassesEight = (m: FlightMove): boolean => m.kind === MoveKind.PlayPermanent && m.card?.Rank === 8;

/**
 * How the mover's card lands. `side` is 0 for the viewer (Alice), 1 for the
 * opponent (Blake). A SevenPick or any kind without a plan arrives.
 */
export function flightLanding(move: FlightMove, side: PlayerId, glasses: boolean): FlightLanding {
  switch (move.kind) {
    case MoveKind.Draw:
      return side === 0 || glasses ? 'drawFlip' : 'drawBack';
    case MoveKind.PlayPoint:
    case MoveKind.PlayPermanent:
      return isJackPlay(move) ? 'jackSteal' : 'toRow';
    case MoveKind.Scuttle:
      return 'scuttle';
    // Issue #93: a counter is played on the last-turn marker in the middle,
    // then goes to the scrap as the rewind happens, like any one-off.
    case MoveKind.OneOff:
    case MoveKind.Counter:
      return 'oneOff';
    default:
      return 'arrive';
  }
}

/**
 * The named flight for a move (design §8.4 table). `side` is 0 for the viewer
 * (Alice) and 1 for the opponent (Blake); `glasses` is true when the viewer
 * can already see the opponent's hand. A card Blake plays from his hand is
 * `blakePlays` (a back leaves his hand, flips at the midpoint, lands as the
 * move would). Alice's glasses 8 is `glassesFlip` (it lands on its side, then
 * Blake's hand turns face up).
 */
export function flightPlan(move: FlightMove, side: PlayerId, glasses: boolean): FlightPlanName {
  const landing = flightLanding(move, side, glasses);
  if (landing === 'drawFlip' || landing === 'drawBack' || landing === 'arrive') return landing;
  if (side === 1) return 'blakePlays';
  if (isGlassesEight(move) && !glasses) return 'glassesFlip';
  return landing;
}

/**
 * The opponent's hand slots in order (the cards `OpponentHand` draws).
 * Coupling point: Blake's cards carry no testid (every testid must be a 44 px
 * target), so they are found by `OpponentHand`'s `.opponent-hand__card` class.
 * Rename it there and this finds nothing; the flights then skip his hand.
 */
export function oppHandSlots(root: ParentNode): Element[] {
  const hand = root.querySelector('[data-testid="opp-hand"]');
  return hand ? [...hand.querySelectorAll('.opponent-hand__card')] : [];
}

/** The element `<prefix><n>` with the highest n, e.g. the newest card in `point-0-`. */
export function lastIndexed(root: ParentNode, prefix: string): Element | null {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let best: Element | null = null;
  let bestIndex = -1;
  for (const el of root.querySelectorAll(`[data-testid^="${prefix}"]`)) {
    const m = pattern.exec(el.getAttribute('data-testid') ?? '');
    if (m && Number(m[1]) > bestIndex) {
      bestIndex = Number(m[1]);
      best = el;
    }
  }
  return best;
}

/** Kinds that move cards to the scrap without a plan of their own: the scrap pile arrives. */
const ARRIVE_AT_SCRAP: ReadonlySet<MoveKindValue> = new Set<MoveKindValue>([MoveKind.DiscardPair, MoveKind.SevenPick]);

const sameCard = (a: Card, b: Card): boolean => a.Rank === b.Rank && a.Suit === b.Suit;

// ─── Snapshot (pre-apply) and capture ────────────────────────────────────

/** A table card's seat, position in its row, identity and screen rect. */
export interface FlightTableCard {
  owner: PlayerId;
  index: number;
  card: Card;
  rect: RectLike;
}

/**
 * Everything a flight needs from the page BEFORE a move: rects (plain objects)
 * and the identities seat 0 can already see. Taken from the learner's view, so
 * nothing in it can name a card Blake holds (his hand appears only when that
 * view carries it, under glasses).
 */
export interface FlightSnapshot {
  viewer: 0;
  deck: RectLike | null;
  scrap: RectLike | null;
  oneoff: RectLike | null;
  oppHand: RectLike | null;
  /** Blake's hand slots, left to right, one per card. */
  oppSlots: RectLike[];
  /** Alice's hand by hand index. */
  hand: { card: Card; rect: RectLike | null }[];
  points: FlightTableCard[];
  perms: FlightTableCard[];
  /** `view0.opponent.hand`: non-null only while Alice's glasses are down. */
  seenOppHand: Card[] | null;
}

/** Records rects and public identities. Call it synchronously BEFORE the engine apply with seat 0's view. */
export function snapshot(view0: PlayerView, root: FlightRoot): FlightSnapshot {
  if (view0.viewer !== 0) throw new Error('flights are drawn from seat 0’s view');
  const rectOf = (testId: string): RectLike | null => {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    return el ? toRect(el.getBoundingClientRect()) : null;
  };
  const table = (prefix: 'point' | 'perm'): FlightTableCard[] => {
    const out: FlightTableCard[] = [];
    for (const owner of [0, 1] as const) {
      const side = owner === 0 ? view0.you : view0.opponent;
      const cards = prefix === 'point' ? side.points.map((p) => p.Card) : side.permanents;
      cards.forEach((card, index) => {
        const rect = rectOf(`${prefix}-${owner}-${index}`);
        if (rect) out.push({ owner, index, card, rect });
      });
    }
    return out;
  };
  return {
    viewer: 0,
    deck: rectOf('deck-pile'),
    scrap: rectOf('scrap-pile'),
    oneoff: rectOf('zone-oneoff'),
    oppHand: rectOf('opp-hand'),
    oppSlots: oppHandSlots(root).map((el) => toRect(el.getBoundingClientRect())),
    hand: view0.you.hand.map((card, i) => ({ card, rect: rectOf(`hand-card-${i}`) })),
    points: table('point'),
    perms: table('perm'),
    seenOppHand: view0.opponent.hand,
  };
}

interface Source {
  rect: RectLike | null;
  /** What the clone shows at the start. */
  card: Card | 'back' | null;
  /** What a back turns into (public once played). */
  face: Card | null;
}

function build(snap: FlightSnapshot, move: FlightMove, by: PlayerId, src: Source): FlightCapture {
  const mine = by === snap.viewer;
  const side: PlayerId = mine ? 0 : 1;
  const glasses = snap.seenOppHand !== null;
  const landing = flightLanding(move, side, glasses);
  const rects: Record<string, RectLike> = {};
  const cards: Record<string, Card | 'back'> = {};
  const put = (key: string, rect: RectLike | null): void => {
    if (rect) rects[key] = rect;
  };

  const drawn = landing === 'drawFlip' || landing === 'drawBack';
  const fromHand = landing === 'toRow' || landing === 'jackSteal' || landing === 'scuttle' || landing === 'oneOff';
  if (drawn) {
    put('source', snap.deck);
    cards.source = 'back';
  } else if (fromHand) {
    put('source', src.rect);
    if (src.card) cards.source = src.card;
    if (src.face) cards.face = src.face;
  }

  if ((landing === 'scuttle' || landing === 'jackSteal') && move.targetCard) {
    // By identity: the card's own position on the table, never an index from the move.
    const target = snap.points.find((p) => sameCard(p.card, move.targetCard as Card));
    if (target) {
      rects.target = target.rect;
      cards.target = target.card;
    }
  }
  if (landing === 'scuttle' || landing === 'oneOff') {
    put('scrap', snap.scrap);
    put('oneoff', snap.oneoff);
  }
  if (landing === 'oneOff' && move.card?.Rank === 1) {
    // An Ace scraps every point card on the table.
    for (const p of snap.points) {
      const key = `sweep:point-${p.owner}-${p.index}`;
      rects[key] = p.rect;
      cards[key] = p.card;
    }
  }
  put('oppHand', snap.oppHand);

  return {
    kind: move.kind,
    rects,
    cards,
    plan: flightPlan(move, side, glasses),
    landing,
    by,
    mine,
    glasses,
    sideways: isGlassesEight(move),
    row: landing === 'jackSteal' || move.kind === MoveKind.PlayPoint ? 'point' : landing === 'toRow' ? 'perm' : null,
  };
}

/**
 * The capture for ALICE's move (the learner only): she has the `Move`, so her
 * hand slot and card come from her own view. Never call it with the opponent's
 * Move: his flights use `snapshot` + `captureReply`. It throws unless it is
 * the learner's turn (`view.active === 0`), which is when it runs, before her
 * apply (an owed discard opens her turn, so a counter there is hers too).
 */
export function capture(move: Move, view: PlayerView, root: FlightRoot): FlightCapture {
  if (view.active !== 0) throw new Error('capture is for the learner\u2019s own move; use snapshot + captureReply for Blake');
  const snap = snapshot(view, root);
  const slot = snap.hand[move.HandIndex];
  return build(snap, flightMoveOf(move, view), 0, {
    rect: slot?.rect ?? null,
    card: slot?.card ?? move.Card,
    face: null,
  });
}

/**
 * The capture for BLAKE's reply, from a pre-apply snapshot and the public log
 * entry for his move (already redacted for seat 0). Pure. It reads only
 * `entry.by`, `kind`, `card` and `targetCard`: never an index, never his
 * `Move`. His clone leaves a fixed, content-independent slot (the last one) as
 * a back and turns to `entry.card` at the midpoint. Only when glasses already
 * show his hand does it use the slot holding that very card.
 */
export function captureReply(snap: FlightSnapshot, entry: Pick<AppliedMove, 'by' | 'kind' | 'card' | 'targetCard'>): FlightCapture {
  const by = entry.by;
  const move: FlightMove = { kind: entry.kind, card: entry.card, targetCard: entry.targetCard };
  const seen = snap.seenOppHand;
  const slotOf = move.card && seen ? seen.findIndex((c) => sameCard(c, move.card as Card)) : -1;
  const slots = snap.oppSlots;
  const rect = (slotOf >= 0 ? slots[slotOf] : slots[slots.length - 1]) ?? null;
  const showing = slotOf >= 0 && seen ? seen[slotOf] : null;
  return build(snap, move, by, {
    rect,
    card: showing ?? 'back',
    face: showing ? null : move.card,
  });
}

/** What only the post-apply view can say. Both come from the viewer's own view. */
export interface FlightAfter {
  /** The card just drawn: the viewer's own, or the opponent's when the viewer can see his hand. */
  drawn: Card | null;
  /** The opponent's hand once glasses are down; null when still hidden. */
  oppHand: Card[] | null;
}

/** Reads the identities a flight needs from seat 0's post-apply view; nothing else. */
export function flightAfter(cap: FlightCapture, after: PlayerView | null | undefined): FlightAfter {
  if (!after) return { drawn: null, oppHand: null };
  if (after.viewer !== 0) throw new Error('flights are drawn from seat 0’s view');
  let drawn: Card | null = null;
  if (cap.landing === 'drawFlip') {
    const hand = cap.by === after.viewer ? after.you.hand : after.opponent.hand;
    drawn = hand && hand.length > 0 ? hand[hand.length - 1] : null;
  }
  return { drawn, oppHand: cap.plan === 'glassesFlip' ? after.opponent.hand : null };
}

/**
 * T14 judge M2: what a flight crosses, for the coach bubble to keep clear of
 * during the beat, most important first: the hit card (scuttle, Jack steal),
 * every point card an Ace sweeps, where the card lands (`landing`, measured
 * once the new state has rendered), the one-off spot, the scrap, and last
 * where the card started (it leaves there first). Pure; plain rects out.
 */
export function flightBoxes(cap: FlightCapture, landing: RectLike | null): RectLike[] {
  const r = cap.rects;
  const out: RectLike[] = [];
  if (r.target) out.push(r.target);
  for (const [key, rect] of Object.entries(r)) if (key.startsWith('sweep:')) out.push(rect);
  if (landing) out.push(landing);
  if (cap.landing === 'oneOff' && r.oneoff) out.push(r.oneoff);
  if ((cap.landing === 'scuttle' || cap.landing === 'oneOff') && r.scrap) out.push(r.scrap);
  if (r.source) out.push(r.source);
  return out.map(toRect);
}

/** Where a calm (reduced-motion) change gets its ochre ring. */
export type FlightRingTarget = 'landing' | 'scrap' | 'oppHand';

export function ringTargets(cap: FlightCapture): FlightRingTarget[] {
  if (cap.plan === 'glassesFlip') return ['landing', 'oppHand'];
  switch (cap.landing) {
    case 'toRow':
    case 'jackSteal':
    case 'drawFlip':
    case 'drawBack':
      return ['landing'];
    case 'scuttle':
    case 'oneOff':
      return ['scrap'];
    default:
      return ARRIVE_AT_SCRAP.has(cap.kind) ? ['scrap'] : [];
  }
}

/** Reduced motion: a static ring on each destination for this long. */
export const REDUCED_RING_MS = 600;

// ─── Flight timelines ────────────────────────────────────────────────────

const FLIGHT_ARC_PX = 26;
const FLIGHT_LIFT = 0.07;
const FLIGHT_TILT_DEG = -4;
const HIT_MS = 300;
const HIT_HOLD_MS = 80;
const SCRAP_MS = 320;
const ONEOFF_IN_MS = 300;
const ONEOFF_HOLD_MS = 240;
const SWEEP_GAP_MS = 50;
const GLASSES_GAP_MS = 70;
const FLIP_MS = 240;
const FADE_OUT_MS = 200;
/** How long a one-off's card takes on the board: into the middle spot, a short hold, then to the scrap. */
export const ONEOFF_FLIGHT_MS = ONEOFF_IN_MS + ONEOFF_HOLD_MS + SCRAP_MS;
const LEG_STEPS = 10;
const STAND_IN_PX = 4;

const easeLandFn = cubicBezier(0.3, 1.25, 0.5, 1); // --cu-ease-land: overshoots, then settles

export interface FlightEnds {
  /** The newest card of the mover's row, the new hand slot, or the opponent's new hand slot. */
  landing: RectLike | null;
  scrap: RectLike | null;
  oppHand: RectLike | null;
  /** The opponent's hand slots as drawn after the move (glasses flip). */
  oppCards: RectLike[];
  /** A hand-size card, from the app's geometry tokens. */
  card: { width: number; height: number };
  /** How far a Jack sits below the point card it is on. */
  jackOffset: number;
}

interface FlightLeg {
  to: RectLike;
  startMs: number;
  ms: number;
  ease: (u: number) => number;
  arcPx?: number;
  lift?: number;
  tiltDeg?: number;
  /** Final rotation; 90 lays the card on its side. */
  rotateDeg?: number;
  /** Final opacity (a fade-out ends at 0). */
  opacity?: number;
}

interface Pose {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rot: number;
  op: number;
}

/** A pose for a clone laid out as `box`: where its centre goes and how it scales to show as `r`. */
function poseOf(box: RectLike, r: RectLike, rot = 0, op = 1): Pose {
  const a = centre(box);
  const b = centre(r);
  const swap = Math.abs(rot % 180) === 90;
  return {
    cx: b.x - a.x,
    cy: b.y - a.y,
    sx: (swap ? r.height : r.width) / box.width,
    sy: (swap ? r.width : r.height) / box.height,
    rot,
    op,
  };
}

const poseStop = (at: number, p: Pose): Stop => ({
  at,
  opacity: n2(p.op),
  transform: `translate(${n2(p.cx)}px, ${n2(p.cy)}px) rotate(${n2(p.rot)}deg) scale(${n2(p.sx)}, ${n2(p.sy)})`,
  easing: 'linear',
});

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * One clone's keyframes over `durationMs`: it sits at `start`, then each leg
 * carries it along a gentle arc (lifted and leaning mid-flight, easing in to a
 * small overshoot and settle), and it holds the last pose to the end.
 */
function actorFrames(box: RectLike, start: RectLike, legs: FlightLeg[], durationMs: number): Keyframe[] {
  let cur = poseOf(box, start);
  const stops: Stop[] = [poseStop(0, cur)];
  let t = 0;
  for (const leg of legs) {
    if (leg.startMs > t) stops.push(poseStop(leg.startMs, cur));
    const next = poseOf(box, leg.to, leg.rotateDeg ?? 0, leg.opacity ?? cur.op);
    for (let i = 1; i <= LEG_STEPS; i++) {
      const u = i / LEG_STEPS;
      const p = leg.ease(u);
      const bump = 4 * u * (1 - u);
      stops.push(
        poseStop(leg.startMs + leg.ms * u, {
          cx: lerp(cur.cx, next.cx, p),
          cy: lerp(cur.cy, next.cy, p) - (leg.arcPx ?? 0) * bump,
          sx: lerp(cur.sx, next.sx, p) * (1 + (leg.lift ?? 0) * bump),
          sy: lerp(cur.sy, next.sy, p) * (1 + (leg.lift ?? 0) * bump),
          rot: lerp(cur.rot, next.rot, p) + (leg.tiltDeg ?? 0) * bump,
          op: lerp(cur.op, next.op, u),
        }),
      );
    }
    cur = next;
    t = leg.startMs + leg.ms;
  }
  if (t < durationMs) stops.push(poseStop(durationMs, cur));
  return toFrames(stops, durationMs);
}

/**
 * The turn of a card over (back to face): rotateY 0 to 180 inside the window,
 * a small pop at the half-turn, still before and after. Pairs with two sides
 * that use `backface-visibility: hidden`.
 */
export function flipFrames(startMs: number, ms: number, durationMs: number): Keyframe[] {
  const mid = startMs + ms / 2;
  const end = startMs + ms;
  const frame = (at: number, deg: number, scale: number, easing: string): Keyframe => ({
    offset: at / durationMs,
    transform: `rotateY(${deg}deg) scale(${scale})`,
    easing,
  });
  const frames: Keyframe[] = [frame(0, 0, 1, startMs > 0 ? 'linear' : 'ease-in')];
  if (startMs > 0) frames.push(frame(startMs, 0, 1, 'ease-in'));
  frames.push(frame(mid, 90, 1.06, 'ease-out'), frame(end, 180, 1, 'linear'));
  if (end < durationMs) frames.push(frame(durationMs, 180, 1, 'linear'));
  return frames;
}

/** The "arrive" fallback: the destination element grows in (design §8.4). */
export function arriveFrames(): Keyframe[] {
  return [
    { opacity: 0, transform: 'scale(0.92)', easing: EASE_OUT },
    { opacity: 1, transform: 'scale(1)' },
  ];
}

export interface FlightActor {
  key: string;
  /** The clone is laid out at this rect; its poses scale from it. */
  box: RectLike;
  /** Show the back of a card (the clone starts on it). */
  back: boolean;
  /** Show this face (after the flip when `back` is also true). */
  face: Card | null;
  size: 'hand' | 'field' | 'mini';
  delayMs: number;
  durationMs: number;
  frames: Keyframe[];
  /** rotateY frames for the inner flipper; null when the card never turns. */
  flipFrames: Keyframe[] | null;
  /**
   * A glasses 8 only (T12b): opacity frames for a layer drawing the theme's
   * glasses face, the face the permanents row shows for it. It fades in
   * while the card turns on its side, so the clone lands already looking
   * like the real card. Null for every other card.
   */
  glassesFrames: Keyframe[] | null;
}

export type FlightHoldTarget = 'landing' | 'scrap' | `oppCard:${number}`;

export interface FlightScript {
  actors: FlightActor[];
  /** Real elements held invisible (`[{opacity:0},{opacity:0}]`, fill none) for this long. */
  holds: { target: FlightHoldTarget; ms: number }[];
  /** Elements that play the `arrive` fallback. */
  arrives: 'scrap'[];
  rings: FlightRingTarget[];
  durationMs: number;
}

const area = (r: RectLike): number => r.width * r.height;

const centredIn = (zone: RectLike, width: number, height: number): RectLike => ({
  x: zone.x + (zone.width - width) / 2,
  y: zone.y + (zone.height - height) / 2,
  width,
  height,
});

/** A card-size rect centred in `zone`, shrunk to fit if the zone is smaller. */
function fitInto(zone: RectLike, card: { width: number; height: number }): RectLike {
  const s = Math.min(1, zone.width / card.width, zone.height / card.height);
  return centredIn(zone, card.width * s, card.height * s);
}

interface ActorOptions {
  back: boolean;
  face: Card | null;
  flipWindow?: [number, number];
  /** The glasses face fades in over this window (ms into the actor's timeline). */
  glassesWindow?: [number, number];
  fromHand?: boolean;
  delayMs?: number;
  durationMs?: number;
}

/** A layer's opacity: 0 until `startMs`, rising to 1 by `endMs`, then held. */
function fadeInFrames(startMs: number, endMs: number, durationMs: number): Keyframe[] {
  return [
    { offset: 0, opacity: 0, easing: 'linear' },
    { offset: n2(startMs / durationMs), opacity: 0, easing: 'ease-in-out' },
    { offset: n2(endMs / durationMs), opacity: 1, easing: 'linear' },
    { offset: 1, opacity: 1 },
  ];
}

/** The glasses face takes over during the middle of the 8's quarter turn, well before it settles. */
const GLASSES_FADE: [number, number] = [0.3, 0.65];

function makeActor(key: string, start: RectLike, legs: FlightLeg[], o: ActorOptions): FlightActor {
  const upright = [start, ...legs.filter((l) => !l.rotateDeg).map((l) => l.to)];
  const box = upright.reduce((a, b) => (area(b) > area(a) ? b : a));
  const legsEnd = legs.reduce((m, l) => Math.max(m, l.startMs + l.ms), 0);
  const durationMs = Math.max(1, o.durationMs ?? legsEnd);
  const flip = o.back && o.face !== null && o.flipWindow !== undefined;
  return {
    key,
    box: toRect(box),
    back: o.back,
    face: o.face,
    size: o.fromHand ? 'hand' : box.width < 44 ? 'mini' : 'field',
    delayMs: o.delayMs ?? 0,
    durationMs,
    frames: actorFrames(box, start, legs, durationMs),
    flipFrames: flip && o.flipWindow ? flipFrames(o.flipWindow[0], o.flipWindow[1] - o.flipWindow[0], durationMs) : null,
    glassesFrames: o.glassesWindow && o.face !== null ? fadeInFrames(o.glassesWindow[0], o.glassesWindow[1], durationMs) : null,
  };
}

/**
 * The clone timelines for one flight (design §8.4 table). Pure: `ends` holds
 * the destinations measured after the render, `after` the identities only the
 * new state knows. A plan whose pieces are missing (no landing element, say)
 * yields no actors; motion never breaks play.
 */
export function flightScript(
  cap: FlightCapture,
  ends: FlightEnds,
  after: FlightAfter,
  tokens: Pick<MotionTokens, 'flight'>,
): FlightScript {
  const F = tokens.flight > 0 ? tokens.flight : TOKEN_DEFAULTS.flight;
  const actors: FlightActor[] = [];
  const holds: FlightScript['holds'] = [];
  const arrives: FlightScript['arrives'] = [];
  const src = cap.rects.source;
  const startCard = cap.cards.source;
  const back = startCard === 'back';
  const known: Card | null = back ? (cap.cards.face && cap.cards.face !== 'back' ? cap.cards.face : null) : (startCard ?? null);
  const scrapSpot = ends.scrap ? fitInto(ends.scrap, ends.card) : null;
  const lean = { arcPx: FLIGHT_ARC_PX, lift: FLIGHT_LIFT, tiltDeg: FLIGHT_TILT_DEG };

  switch (cap.landing) {
    case 'toRow': {
      if (!src || !ends.landing || startCard === undefined) break;
      actors.push(
        makeActor('mover', src, [{ to: ends.landing, startMs: 0, ms: F, ease: easeLandFn, ...lean, rotateDeg: cap.sideways ? 90 : undefined }], {
          back,
          face: known,
          flipWindow: [F * 0.3, F * 0.7],
          // T12b: a glasses 8 lands showing the glasses face, as the row draws it.
          glassesWindow: cap.sideways ? [F * GLASSES_FADE[0], F * GLASSES_FADE[1]] : undefined,
          fromHand: cap.mine,
        }),
      );
      holds.push({ target: 'landing', ms: F });
      if (cap.plan === 'glassesFlip' && after.oppHand) {
        ends.oppCards.forEach((rect, i) => {
          const face = after.oppHand?.[i] ?? null;
          if (!face) return;
          const startAt = F + i * GLASSES_GAP_MS;
          actors.push(makeActor(`glasses:${i}`, rect, [], { back: true, face, flipWindow: [startAt, startAt + FLIP_MS], durationMs: startAt + FLIP_MS }));
          holds.push({ target: `oppCard:${i}`, ms: startAt + FLIP_MS });
        });
      }
      break;
    }
    case 'jackSteal': {
      if (!src || !ends.landing || startCard === undefined) break;
      const stolen = cap.cards.target;
      if (cap.rects.target && stolen && stolen !== 'back') {
        // The stolen point card slides across to its new spot at the same time.
        actors.push(
          makeActor('stolen', cap.rects.target, [{ to: ends.landing, startMs: 0, ms: F, ease: easeLandFn, arcPx: 10, lift: 0.03 }], {
            back: false,
            face: stolen,
          }),
        );
      }
      const jackSpot = shifted(ends.landing, 0, ends.jackOffset);
      actors.push(
        makeActor('mover', src, [{ to: jackSpot, startMs: 0, ms: F, ease: easeLandFn, ...lean }], {
          back,
          face: known,
          flipWindow: [F * 0.3, F * 0.7],
          fromHand: cap.mine,
        }),
      );
      holds.push({ target: 'landing', ms: F });
      break;
    }
    case 'scuttle': {
      const target = cap.rects.target;
      const targetCard = cap.cards.target;
      if (!src || !target || !targetCard || targetCard === 'back' || startCard === undefined) break;
      const hit = shifted(target, STAND_IN_PX, STAND_IN_PX);
      const leaveAt = HIT_MS + HIT_HOLD_MS;
      const away: FlightLeg[] = scrapSpot
        ? [{ to: scrapSpot, startMs: leaveAt, ms: SCRAP_MS, ease: easeInOut }]
        : [{ to: hit, startMs: leaveAt, ms: FADE_OUT_MS, ease: easeInOut, opacity: 0 }];
      const total = away[0].startMs + away[0].ms;
      actors.push(
        makeActor('target', target, away.map((l) => ({ ...l, to: scrapSpot ? l.to : target })), {
          back: false,
          face: targetCard,
          durationMs: total,
        }),
        makeActor('mover', src, [{ to: hit, startMs: 0, ms: HIT_MS, ease: easeLandFn, ...lean }, ...away], {
          back,
          face: known,
          flipWindow: [HIT_MS * 0.3, HIT_MS * 0.7],
          fromHand: cap.mine,
          durationMs: total,
        }),
      );
      if (scrapSpot) holds.push({ target: 'scrap', ms: total });
      break;
    }
    case 'oneOff': {
      const zone = cap.rects.oneoff;
      if (!src || !zone || startCard === undefined) break;
      // With no scrap on the page the card shrinks to fit the zone, then fades.
      const spot = scrapSpot ? centredIn(zone, ends.card.width, ends.card.height) : fitInto(zone, ends.card);
      const leaveAt = ONEOFF_IN_MS + ONEOFF_HOLD_MS;
      const away: FlightLeg = scrapSpot
        ? { to: scrapSpot, startMs: leaveAt, ms: SCRAP_MS, ease: easeInOut }
        : // No scrap on the page: the card just settles, then fades.
          { to: spot, startMs: leaveAt, ms: FADE_OUT_MS, ease: easeInOut, opacity: 0 };
      actors.push(
        makeActor('mover', src, [{ to: spot, startMs: 0, ms: ONEOFF_IN_MS, ease: easeLandFn, ...lean }, away], {
          back,
          face: known,
          flipWindow: [ONEOFF_IN_MS * 0.3, ONEOFF_IN_MS * 0.7],
          fromHand: cap.mine,
        }),
      );
      if (scrapSpot) {
        // Ace: every captured point card flies to the scrap, 50 ms apart.
        let k = 0;
        for (const [key, rect] of Object.entries(cap.rects)) {
          const sweepCard = cap.cards[key];
          if (!key.startsWith('sweep:') || !sweepCard || sweepCard === 'back') continue;
          actors.push(
            makeActor(key, rect, [{ to: scrapSpot, startMs: 0, ms: SCRAP_MS, ease: easeInOut }], {
              back: false,
              face: sweepCard,
              delayMs: ONEOFF_IN_MS + k * SWEEP_GAP_MS,
            }),
          );
          k++;
        }
        holds.push({ target: 'scrap', ms: Math.max(...actors.map((a) => a.delayMs + a.durationMs)) });
      }
      break;
    }
    case 'drawFlip':
    case 'drawBack': {
      if (!src || !ends.landing) break;
      const face = cap.landing === 'drawFlip' ? after.drawn : null;
      actors.push(
        makeActor('mover', src, [{ to: ends.landing, startMs: 0, ms: F, ease: easeLandFn, ...lean, tiltDeg: 0 }], {
          back: true,
          face,
          flipWindow: [F * 0.45, F * 0.75],
          fromHand: true,
        }),
      );
      holds.push({ target: 'landing', ms: F });
      break;
    }
    default:
      if (ARRIVE_AT_SCRAP.has(cap.kind) && ends.scrap) arrives.push('scrap');
  }

  const durationMs = Math.max(
    0,
    ...actors.map((a) => a.delayMs + a.durationMs),
    ...holds.map((h) => h.ms),
    ...(arrives.length > 0 ? [TOKEN_DEFAULTS.med] : []),
  );
  return { actors, holds, arrives, rings: ringTargets(cap), durationMs };
}
