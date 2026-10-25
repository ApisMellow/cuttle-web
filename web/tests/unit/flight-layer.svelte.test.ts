// @vitest-environment jsdom
// T10 - card flights (docs/tutorial-design.md §8.4): `capture`, `flightPlan`,
// the pure clone timelines in `flightScript`, and the FlightLayer component.
// jsdom has no Element.animate, so each component test installs a recording
// stub; one test removes it to prove the layer survives its absence.
//
// `.svelte.test.ts` so the motion-flip test drives ONE mounted instance
// through a `$state` props object.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, Move, MoveKind, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import FlightLayer from '../../src/lib/components/FlightLayer.svelte';
import { vectorTheme } from '../../src/lib/theme';
import type { CardTheme } from '../../src/lib/theme';
import {
  REDUCED_RING_MS,
  capture,
  captureReply,
  flightAfter,
  flightMoveOf,
  flightPlan,
  flightScript,
  snapshot,
  type FlightAfter,
  type FlightCapture,
  type FlightEnds,
  type FlightPlanName,
  type FlightScript,
} from '../../src/lib/tutorial/motion';
import { appliedMove, playerView } from './game-test-support';

// ─── Fixtures ────────────────────────────────────────────────────────────

const K = { Draw: 0, PlayPoint: 1, PlayPermanent: 2, Scuttle: 3, OneOff: 4, Counter: 5, Decline: 6, SevenPick: 7, DiscardPair: 8, Pass: 9 } as const;
const card = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });
const move = (Kind: MoveKind, over: Partial<Move> = {}): Move => ({
  Kind,
  Card: null,
  HandIndex: 0,
  Target: null,
  JackTarget: null,
  ScrapIndex: 0,
  DiscardA: 0,
  DiscardB: 0,
  SubMove: null,
  ...over,
});

const nine = card(9, 1);
const seven = card(7, 0);
const eight = card(8, 0);
const king = card(13, 2);
const jack = card(11, 3);
const ace = card(1, 3);
const four = card(4, 1);
const ten = card(10, 3);

type Rect = [x: number, y: number, w: number, h: number];

function rectOf([x, y, width, height]: Rect): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect;
}

/**
 * A real browser's DOMRect: its fields are prototype getters, so spreading one
 * (`{ ...rect }`) loses every field. Plain-object fixtures hid exactly that.
 */
class GetterRect {
  readonly #r: Rect;
  constructor(r: Rect) {
    this.#r = r;
  }
  get x() {
    return this.#r[0];
  }
  get y() {
    return this.#r[1];
  }
  get width() {
    return this.#r[2];
  }
  get height() {
    return this.#r[3];
  }
  get left() {
    return this.#r[0];
  }
  get top() {
    return this.#r[1];
  }
  get right() {
    return this.#r[0] + this.#r[2];
  }
  get bottom() {
    return this.#r[1] + this.#r[3];
  }
}

let makeRect: (r: Rect) => DOMRect = rectOf;
const getterRect = (r: Rect): DOMRect => new GetterRect(r) as unknown as DOMRect;

/** An element whose layout box is fixed (jsdom has no layout). */
function place(parent: Element, tag: string, testId: string | null, rect: Rect, className?: string): HTMLElement {
  const el = document.createElement(tag);
  if (testId) el.setAttribute('data-testid', testId);
  if (className) el.className = className;
  el.getBoundingClientRect = () => makeRect(rect);
  parent.append(el);
  return el;
}

/** A board at 393x852 shaped like the real one's testids. */
function board(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  for (let i = 0; i < 3; i++) place(root, 'button', `hand-card-${i}`, [20 + i * 50, 740, 60, 78]);
  place(root, 'button', 'deck-pile', [40, 380, 60, 78]);
  place(root, 'button', 'zone-oneoff', [120, 380, 150, 78]);
  place(root, 'button', 'scrap-pile', [300, 380, 60, 78]);
  const opp = place(root, 'div', 'opp-hand', [20, 60, 200, 42]);
  for (let i = 0; i < 3; i++) place(opp, 'span', null, [20 + i * 18, 60, 32, 42], 'opponent-hand__card');
  place(root, 'button', 'point-0-0', [20, 600, 60, 78]);
  place(root, 'button', 'point-1-0', [20, 200, 52, 68]);
  place(root, 'button', 'point-1-1', [90, 200, 52, 68]);
  place(root, 'button', 'perm-0-0', [200, 600, 60, 78]);
  return root;
}

const add = (root: Element, testId: string, rect: Rect) => place(root, 'button', testId, rect);

const view = (over: Partial<PlayerView> = {}): PlayerView =>
  playerView({
    you: { hand: [nine, seven, eight], frozenHandIndices: [], points: [{ Card: card(5, 0), Owner: 0, JackStack: [], JackOwners: [], Controller: 0 }], permanents: [], watched: false },
    opponent: {
      handCount: 3,
      hand: null,
      points: [
        { Card: ten, Owner: 1, JackStack: [], JackOwners: [], Controller: 1 },
        { Card: card(6, 2), Owner: 1, JackStack: [], JackOwners: [], Controller: 1 },
      ],
      permanents: [],
    },
    ...over,
  });

/** The public log entry for a move, as seat 0 sees it: no index, no hand position. */
const entry = (by: PlayerId, kind: MoveKind, played: Card | null = null, targetCard: Card | null = null): AppliedMove =>
  appliedMove({ by, kind, card: played, targetCard });

/** Blake's flight from nothing but seat 0's pre-apply snapshot and the log entry. */
const reply = (e: AppliedMove, v: PlayerView = view(), root: Element = board()): FlightCapture => captureReply(snapshot(v, root), e);

/** A view where Alice's glasses are down: Blake's hand is shown. */
const glassesView = (seen: Card[]): PlayerView => view({ opponent: { ...view().opponent, handCount: seen.length, hand: seen } });

const ENDS: FlightEnds = {
  landing: { x: 90, y: 600, width: 60, height: 78 },
  scrap: { x: 300, y: 380, width: 60, height: 78 },
  oppHand: { x: 20, y: 60, width: 200, height: 42 },
  oppCards: [
    { x: 20, y: 60, width: 32, height: 42 },
    { x: 38, y: 60, width: 32, height: 42 },
    { x: 56, y: 60, width: 32, height: 42 },
  ],
  card: { width: 60, height: 78 },
  jackOffset: 37,
};
const NO_AFTER: FlightAfter = { drawn: null, oppHand: null };

const ALLOWED = new Set(['transform', 'opacity', 'offset', 'easing']);

function checkFrames(frames: Keyframe[]): void {
  expect(frames.length).toBeGreaterThan(1);
  let last = 0;
  for (const f of frames) {
    for (const key of Object.keys(f)) expect(ALLOWED.has(key), `key ${key}`).toBe(true);
    const offset = f.offset as number;
    expect(offset).toBeGreaterThanOrEqual(last);
    expect(offset).toBeLessThanOrEqual(1);
    last = offset;
  }
  expect(frames[0].offset).toBe(0);
  expect(frames[frames.length - 1].offset).toBe(1);
}

const lastTransform = (frames: Keyframe[]): string => String(frames[frames.length - 1].transform);
const num = (re: RegExp, s: string): number => Number(re.exec(s)?.[1]);

// ─── flightPlan: every move kind has a named plan ────────────────────────

describe('flightPlan', () => {
  const plan = (m: Move, side: PlayerId, glasses = false): FlightPlanName => flightPlan(flightMoveOf(m, view()), side, glasses);

  it('maps Alice’s moves in the five lessons to the design table', () => {
    expect(plan(move(K.PlayPoint, { Card: nine }), 0)).toBe('toRow');
    expect(plan(move(K.PlayPermanent, { Card: king }), 0)).toBe('toRow');
    expect(plan(move(K.PlayPermanent, { Card: jack, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), 0)).toBe('jackSteal');
    expect(plan(move(K.Scuttle, { Card: ten, Target: { Owner: 1, Zone: 0, Index: 0 } }), 0)).toBe('scuttle');
    expect(plan(move(K.OneOff, { Card: ace }), 0)).toBe('oneOff');
    expect(plan(move(K.Draw), 0)).toBe('drawFlip');
    expect(plan(move(K.Counter, { Card: card(2, 2) }), 0)).toBe('counter');
  });

  it('the glasses 8 is its own plan, until glasses are already down', () => {
    expect(plan(move(K.PlayPermanent, { Card: eight }), 0)).toBe('glassesFlip');
    expect(plan(move(K.PlayPermanent, { Card: eight }), 0, true)).toBe('toRow');
  });

  it('every card Blake plays is blakePlays, whatever it lands as', () => {
    expect(plan(move(K.PlayPoint, { Card: card(6, 1) }), 1)).toBe('blakePlays');
    expect(plan(move(K.PlayPermanent, { Card: card(12, 3) }), 1)).toBe('blakePlays');
    expect(plan(move(K.PlayPermanent, { Card: eight }), 1)).toBe('blakePlays');
    expect(plan(move(K.PlayPermanent, { Card: jack, JackTarget: { Owner: 0, Zone: 0, Index: 0 } }), 1)).toBe('blakePlays');
    expect(plan(move(K.Scuttle, { Card: ten }), 1)).toBe('blakePlays');
    expect(plan(move(K.OneOff, { Card: four }), 1)).toBe('blakePlays');
  });

  it('Blake’s draw is a back, or flips like Alice’s under glasses', () => {
    expect(plan(move(K.Draw), 1)).toBe('drawBack');
    expect(plan(move(K.Draw), 1, true)).toBe('drawFlip');
  });

  it('a counter is a counter for either seat', () => {
    expect(plan(move(K.Counter), 1)).toBe('counter');
  });

  it('every other kind arrives, including a SevenPick with or without a sub-move', () => {
    for (const kind of [K.Decline, K.DiscardPair, K.Pass]) expect(plan(move(kind), 0)).toBe('arrive');
    expect(plan(move(K.SevenPick, { SubMove: move(K.PlayPoint, { Card: nine }) }), 0)).toBe('arrive');
    expect(plan(move(K.SevenPick), 0)).toBe('arrive');
    expect(plan(move(99 as MoveKind), 0)).toBe('arrive');
  });

  it('gives all ten engine kinds, for both seats, a plan that exists', () => {
    const names = new Set<FlightPlanName>(['toRow', 'jackSteal', 'scuttle', 'oneOff', 'drawFlip', 'drawBack', 'blakePlays', 'glassesFlip', 'counter', 'arrive']);
    for (const kind of Object.values(K)) {
      for (const side of [0, 1] as const) {
        for (const glasses of [false, true]) expect(names.has(flightPlan(flightMoveOf(move(kind, { Card: nine }), view()), side, glasses))).toBe(true);
      }
    }
  });
});

// ─── capture: what is public before the apply ────────────────────────────

describe('capture', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('Alice’s point play: her hand slot, her own card, the plan and landing row', () => {
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    expect(cap).toMatchObject({ kind: K.PlayPoint, plan: 'toRow', landing: 'toRow', by: 0, mine: true, glasses: false, sideways: false, row: 'point' });
    expect(cap.cards).toEqual({ source: nine });
    expect(cap.rects.source.x).toBe(20);
    expect(cap.rects.source.y).toBe(740);
  });

  it('a permanent lands in the permanents row; a glasses 8 lands sideways', () => {
    const root = board();
    expect(capture(move(K.PlayPermanent, { Card: king, HandIndex: 0 }), view(), root).row).toBe('perm');
    const eightCap = capture(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), root);
    expect(eightCap).toMatchObject({ plan: 'glassesFlip', sideways: true, row: 'perm' });
    expect(eightCap.rects.source.x).toBe(120);
  });

  it('Blake’s play leaves his LAST slot as a BACK; only the played card is carried, as its face', () => {
    const cap = reply(entry(1, K.PlayPoint, card(6, 1)));
    expect(cap).toMatchObject({ plan: 'blakePlays', by: 1, mine: false, row: 'point' });
    expect(cap.cards).toEqual({ source: 'back', face: card(6, 1) });
    // A fixed slot, not the whole hand container, and not one picked by what he plays.
    expect(cap.rects.source).toEqual({ x: 56, y: 60, width: 32, height: 42 });
    expect(reply(entry(1, K.PlayPoint, card(2, 3))).rects.source).toEqual(cap.rects.source);
    expect(JSON.stringify(cap.cards)).not.toContain(JSON.stringify(nine));
  });

  it('Blake’s play under glasses leaves the slot holding that very card, already face up', () => {
    const cap = reply(entry(1, K.PlayPoint, card(6, 1)), glassesView([card(2, 0), card(6, 1), card(3, 3)]));
    expect(cap.glasses).toBe(true);
    expect(cap.cards).toEqual({ source: card(6, 1) });
    expect(cap.rects.source).toEqual({ x: 38, y: 60, width: 32, height: 42 });
  });

  it('a draw starts at the deck as a back and carries no face', () => {
    const root = board();
    const cap = capture(move(K.Draw), view(), root);
    expect(cap).toMatchObject({ plan: 'drawFlip', landing: 'drawFlip', row: null });
    expect(cap.cards).toEqual({ source: 'back' });
    expect(cap.rects.source.x).toBe(40);
    expect(reply(entry(1, K.Draw), view(), root).plan).toBe('drawBack');
  });

  it('a scuttle records the attacker, the scuttled point card and the scrap pile', () => {
    const root = board();
    const cap = capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), root);
    expect(cap.plan).toBe('scuttle');
    expect(cap.cards.target).toEqual(card(6, 2));
    expect(cap.rects.target.x).toBe(90);
    expect(cap.rects.scrap.x).toBe(300);
    expect(cap.rects.oneoff.x).toBe(120);
  });

  it('a Jack steal records the stolen point card; the Jack is the mover', () => {
    const root = board();
    const cap = capture(move(K.PlayPermanent, { Card: jack, HandIndex: 0, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), view(), root);
    expect(cap).toMatchObject({ plan: 'jackSteal', row: 'point' });
    expect(cap.cards.target).toEqual(ten);
    expect(cap.rects.target.y).toBe(200);
  });

  it('an Ace records every point card on both sides; another one-off records none', () => {
    const root = board();
    const sweepKeys = (cap: FlightCapture) => Object.keys(cap.rects).filter((k) => k.startsWith('sweep:')).sort();
    expect(sweepKeys(capture(move(K.OneOff, { Card: ace }), view(), root))).toEqual(['sweep:point-0-0', 'sweep:point-1-0', 'sweep:point-1-1']);
    expect(sweepKeys(capture(move(K.OneOff, { Card: four }), view(), root))).toEqual([]);
  });

  it('is for the learner only: it throws on the opponent\u2019s turn', () => {
    expect(() => capture(move(K.PlayPoint, { Card: card(6, 1) }), view({ active: 1 }), board())).toThrow(/learner/);
    expect(() => capture(move(K.Counter, { Card: card(2, 2) }), view({ active: 0 }), board())).not.toThrow();
  });

  it('survives a board with nothing on it', () => {
    const root = document.createElement('div');
    const cap = capture(move(K.PlayPoint, { Card: nine }), view(), root);
    expect(cap.rects).toEqual({});
    expect(cap.plan).toBe('toRow');
  });
});

describe('flightAfter', () => {
  const cap = (m: Move, v: PlayerView) => capture(m, v, document.createElement('div'));

  it('reads Alice’s new card from the end of her own hand', () => {
    const after = view({ you: { ...view().you, hand: [nine, seven, eight, card(4, 0)] } });
    expect(flightAfter(cap(move(K.Draw), view()), after).drawn).toEqual(card(4, 0));
  });

  it('a hidden opponent draw carries nothing', () => {
    const after = view({ opponent: { handCount: 4, hand: null, points: [], permanents: [] } });
    expect(flightAfter(reply(entry(1, K.Draw), view(), document.createElement('div')), after)).toEqual({ drawn: null, oppHand: null });
  });

  it('under glasses the opponent’s drawn card is the end of the hand Alice can see', () => {
    const seen = [card(2, 0), card(1, 3)];
    const before = glassesView([card(2, 0)]);
    const after = glassesView(seen);
    expect(flightAfter(reply(entry(1, K.Draw), before, document.createElement('div')), after).drawn).toEqual(card(1, 3));
  });

  it('the glasses 8 reads the hand glasses just revealed; other plans never do', () => {
    const seen = [card(2, 0), card(1, 3), card(5, 1)];
    const after = view({ opponent: { handCount: 3, hand: seen, points: [], permanents: [] } });
    expect(flightAfter(cap(move(K.PlayPermanent, { Card: eight }), view()), after).oppHand).toEqual(seen);
    expect(flightAfter(cap(move(K.PlayPoint, { Card: nine }), view()), after).oppHand).toBeNull();
    expect(flightAfter(cap(move(K.PlayPoint, { Card: nine }), view()), null)).toEqual({ drawn: null, oppHand: null });
  });
});

// ─── B1: real DOMRect-like rects ─────────────────────────────────────────

/** Every number a clone could animate is finite; no keyframe holds NaN or undefined. */
function expectFinite(frames: Keyframe[]): void {
  for (const f of frames) {
    expect(String(f.transform ?? ''), JSON.stringify(f)).not.toMatch(/NaN|undefined|Infinity/);
    expect(Number.isFinite(f.offset as number)).toBe(true);
    if (f.opacity !== undefined) expect(Number.isFinite(Number(f.opacity))).toBe(true);
  }
}

/** Where a clone's last pose puts its centre (the poses are offsets from the box centre). */
function endCentre(a: { box: { x: number; y: number; width: number; height: number }; frames: Keyframe[] }): [number, number] {
  const t = lastTransform(a.frames);
  return [a.box.x + a.box.width / 2 + num(/translate\((-?[\d.]+)px/, t), a.box.y + a.box.height / 2 + num(/translate\(-?[\d.]+px, (-?[\d.]+)px/, t)];
}

const getterEnds = (): FlightEnds => ({
  ...ENDS,
  landing: getterRect([90, 600, 60, 78]),
  scrap: getterRect([300, 380, 60, 78]),
  oppHand: getterRect([20, 60, 200, 42]),
  oppCards: [getterRect([20, 60, 32, 42]), getterRect([38, 60, 32, 42]), getterRect([56, 60, 32, 42])],
});

describe('real DOMRect-like rects (prototype getters)', () => {
  beforeEach(() => {
    makeRect = getterRect;
  });
  afterEach(() => {
    makeRect = rectOf;
    document.body.replaceChildren();
  });

  it('snapshot keeps plain four-field rects, never the getter objects', () => {
    const snap = snapshot(view(), board());
    for (const r of [snap.deck, snap.scrap, snap.oneoff, snap.oppHand, snap.oppSlots[0], snap.hand[0].rect, snap.points[0].rect]) {
      expect(Object.keys(r!).sort()).toEqual(['height', 'width', 'x', 'y']);
    }
    expect(snap.deck).toEqual({ x: 40, y: 380, width: 60, height: 78 });
    const cap = capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), board());
    for (const r of Object.values(cap.rects)) expect(Object.keys(r).sort()).toEqual(['height', 'width', 'x', 'y']);
  });

  it('no keyframe on any plan holds NaN, undefined or Infinity', () => {
    const seen = [card(2, 0), card(6, 1), card(3, 3)];
    const caps: FlightCapture[] = [
      capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), board()),
      capture(move(K.PlayPermanent, { Card: king, HandIndex: 0 }), view(), board()),
      capture(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), board()),
      capture(move(K.PlayPermanent, { Card: jack, HandIndex: 0, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), view(), board()),
      capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), board()),
      capture(move(K.OneOff, { Card: ace, HandIndex: 0 }), view(), board()),
      capture(move(K.OneOff, { Card: four, HandIndex: 0 }), view(), board()),
      capture(move(K.Draw), view(), board()),
      reply(entry(1, K.PlayPoint, card(6, 1))),
      reply(entry(1, K.PlayPermanent, jack, card(5, 0))),
      reply(entry(1, K.Scuttle, ten, card(5, 0))),
      reply(entry(1, K.OneOff, four)),
      reply(entry(1, K.Draw)),
      reply(entry(1, K.Draw), glassesView(seen)),
    ];
    for (const cap of caps) {
      const s = scriptOf(cap, getterEnds(), { drawn: card(4, 0), oppHand: seen });
      expect(s.actors.length, cap.plan).toBeGreaterThan(0);
      for (const a of s.actors) {
        expectFinite(a.frames);
        if (a.flipFrames) expectFinite(a.flipFrames);
        for (const v of Object.values({ x: a.box.x, y: a.box.y, w: a.box.width, h: a.box.height })) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('the Jack ends one jack offset below the landing slot; the stolen card ends on it', () => {
    const s = scriptOf(capture(move(K.PlayPermanent, { Card: jack, HandIndex: 0, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), view(), board()), getterEnds());
    const mover = s.actors.find((a) => a.key === 'mover')!;
    const stolen = s.actors.find((a) => a.key === 'stolen')!;
    const [jx, jy] = endCentre(mover);
    expect([jx, jy]).toEqual([120, 639 + 37]);
    expect(endCentre(stolen)).toEqual([120, 639]);
  });

  it('a scuttle sends both cards to the scrap centre, after hitting the target', () => {
    const s = scriptOf(capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), board()), getterEnds());
    for (const a of s.actors) expect(endCentre(a)).toEqual([330, 419]);
    const mover = s.actors.find((a) => a.key === 'mover')!;
    // At the hit (300 ms) the attacker sits on the target (point-1-1, 4 px off).
    const hit = mover.frames.find((f) => Math.abs((f.offset as number) * mover.durationMs - 300) < 0.5)!;
    const t = String(hit.transform);
    const cx = mover.box.x + mover.box.width / 2 + num(/translate\((-?[\d.]+)px/, t);
    expect(cx).toBeCloseTo(90 + 26 + 4, 1);
  });
});

// ─── B2: Blake's flights from public data only ───────────────────────────

describe('captureReply (no Move for Blake)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const queen = card(12, 3);
  const eightC = card(8, 0);
  const sixD = card(6, 1);
  const fourD = card(4, 1);

  it('builds every Blake flight in the lessons from a log entry alone', () => {
    expect(reply(entry(1, K.PlayPoint, sixD))).toMatchObject({ plan: 'blakePlays', landing: 'toRow', row: 'point', cards: { source: 'back', face: sixD } });
    expect(reply(entry(1, K.PlayPoint, eightC))).toMatchObject({ plan: 'blakePlays', landing: 'toRow', row: 'point', sideways: false, cards: { source: 'back', face: eightC } });
    expect(reply(entry(1, K.PlayPermanent, queen))).toMatchObject({ plan: 'blakePlays', landing: 'toRow', row: 'perm', cards: { source: 'back', face: queen } });
    expect(reply(entry(1, K.OneOff, fourD))).toMatchObject({ plan: 'blakePlays', landing: 'oneOff', cards: { source: 'back', face: fourD } });
    expect(reply(entry(1, K.OneOff, fourD)).rects.oneoff).toEqual({ x: 120, y: 380, width: 150, height: 78 });
    expect(reply(entry(1, K.Draw))).toMatchObject({ plan: 'drawBack', glasses: false, cards: { source: 'back' } });
    expect(reply(entry(1, K.Draw), glassesView([card(2, 0)]))).toMatchObject({ plan: 'drawFlip', glasses: true, cards: { source: 'back' } });
  });

  it('names a target by its card, not an index: Blake’s Jack finds Alice’s point where it is', () => {
    const cap = reply(entry(1, K.PlayPermanent, jack, card(5, 0)));
    expect(cap).toMatchObject({ plan: 'blakePlays', landing: 'jackSteal', row: 'point' });
    expect(cap.cards.target).toEqual(card(5, 0));
    expect(cap.rects.target).toEqual({ x: 20, y: 600, width: 60, height: 78 });
    // His own point card, at a different place in the row, is found just as well.
    expect(reply(entry(1, K.Scuttle, ten, card(6, 2))).rects.target).toEqual({ x: 90, y: 200, width: 52, height: 68 });
  });

  it('reads only by, kind, card and targetCard from the entry (any other field is a failure)', () => {
    const touched: string[] = [];
    const strict = new Proxy(entry(1, K.PlayPermanent, jack, card(5, 0)), {
      get(target, key, receiver) {
        touched.push(String(key));
        if (!['by', 'kind', 'card', 'targetCard'].includes(String(key))) throw new Error(`captureReply read entry.${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => captureReply(snapshot(view(), board()), strict)).not.toThrow();
    expect(new Set(touched)).toEqual(new Set(['by', 'kind', 'card', 'targetCard']));
  });

  it('a hand index or target index riding on the entry changes nothing', () => {
    const plain = entry(1, K.PlayPoint, sixD);
    const noisy = { ...plain, index: 2, HandIndex: 2, Target: { Owner: 0, Zone: 0, Index: 0 }, description: 'Blake played the 6 of Diamonds from slot 3' };
    expect(reply(noisy as AppliedMove)).toEqual(reply(plain));
  });

  it('his clone leaves a slot chosen without looking at what he plays', () => {
    const slots = new Set(
      [sixD, eightC, card(1, 0), queen, fourD].map((c) => JSON.stringify(reply(entry(1, K.PlayPoint, c)).rects.source)),
    );
    expect(slots.size).toBe(1);
  });

  it('snapshot and flightAfter refuse any view but seat 0’s', () => {
    expect(() => snapshot(view({ viewer: 1 }), board())).toThrow(/seat 0/);
    const cap = reply(entry(1, K.Draw));
    expect(() => flightAfter(cap, view({ viewer: 1 }))).toThrow(/seat 0/);
    expect(() => flightAfter(cap, view())).not.toThrow();
  });

  it('a hidden opponent hand leaves nothing of it in the snapshot', () => {
    const snap = snapshot(view(), board());
    expect(snap.seenOppHand).toBeNull();
    expect(snap.oppSlots).toHaveLength(3);
    expect(JSON.stringify(snap)).not.toContain('"Rank":2,"Suit":0');
  });
});

// ─── flightScript: pure timelines ────────────────────────────────────────

function scriptOf(cap: FlightCapture, over: Partial<FlightEnds> = {}, after = NO_AFTER, flight = 420): FlightScript {
  return flightScript(cap, { ...ENDS, ...over }, after, { flight });
}

function script(m: Move, v: PlayerView, over: Partial<FlightEnds> = {}, after = NO_AFTER, flight = 420): FlightScript {
  const root = board();
  const cap = capture(m, v, root);
  document.body.replaceChildren();
  return scriptOf(cap, over, after, flight);
}

/** Blake's reply script, built with no `Move` in scope. */
function replyScript(e: AppliedMove, v: PlayerView = view(), over: Partial<FlightEnds> = {}, after = NO_AFTER): FlightScript {
  const cap = reply(e, v);
  document.body.replaceChildren();
  return scriptOf(cap, over, after);
}

describe('flightScript', () => {
  it('Alice’s point play flies her card, face up, hand to the new row slot in the flight time', () => {
    const s = script(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view());
    expect(s.actors).toHaveLength(1);
    const a = s.actors[0];
    expect(a).toMatchObject({ back: false, face: nine, size: 'hand', flipFrames: null, durationMs: 420 });
    expect(s.holds).toEqual([{ target: 'landing', ms: 420 }]);
    expect(s.rings).toEqual(['landing']);
    checkFrames(a.frames);
    expect(a.frames[0].transform).toBe('translate(0px, 0px) rotate(0deg) scale(1, 1)');
    // Lands exactly on the new slot: centre delta (90+30)-(20+30)=70, (600+39)-(740+39)=-140.
    expect(lastTransform(a.frames)).toBe('translate(70px, -140px) rotate(0deg) scale(1, 1)');
  });

  it('lifts, leans and overshoots on the way (a physical arc, then a settle)', () => {
    const a = script(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view()).actors[0];
    const ys = a.frames.map((f) => num(/translate\(-?[\d.]+px, (-?[\d.]+)px\)/, String(f.transform)));
    expect(Math.min(...ys)).toBeLessThan(-140 - 20); // rises past the straight line
    expect(a.frames.some((f) => num(/scale\(([\d.]+),/, String(f.transform)) > 1.03)).toBe(true); // lifted
    expect(a.frames.some((f) => num(/rotate\((-?[\d.]+)deg/, String(f.transform)) < -1)).toBe(true); // leaning
    const xs = a.frames.map((f) => num(/translate\((-?[\d.]+)px/, String(f.transform)));
    expect(Math.max(...xs)).toBeGreaterThan(70); // the ease-land overshoot, then back to 70
    expect(xs[xs.length - 1]).toBe(70);
  });

  it('uses the flight token for its duration', () => {
    const s = script(move(K.PlayPoint, { Card: nine }), view(), {}, NO_AFTER, 500);
    expect(s.actors[0].durationMs).toBe(500);
    expect(s.durationMs).toBe(500);
    expect(script(move(K.PlayPoint, { Card: nine }), view(), {}, NO_AFTER, 0).actors[0].durationMs).toBe(420);
  });

  it('Blake’s play starts as a back and turns face up at the midpoint', () => {
    const s = replyScript(entry(1, K.PlayPoint, card(6, 1)));
    const a = s.actors[0];
    expect(a).toMatchObject({ back: true, face: card(6, 1) });
    expect(a.size).toBe('field'); // laid out at the larger (landing) size, not the 32 px slot
    expect(a.box.width).toBe(60);
    const flip = a.flipFrames!;
    expect(flip).not.toBeNull();
    for (const f of flip) expect(Object.keys(f).every((k) => ALLOWED.has(k))).toBe(true);
    expect(String(flip[0].transform)).toContain('rotateY(0deg)');
    expect(lastTransform(flip)).toContain('rotateY(180deg)');
    const half = flip.find((f) => String(f.transform).includes('rotateY(90deg)'))!;
    expect(half.offset as number).toBeGreaterThan(0.45);
    expect(half.offset as number).toBeLessThan(0.55);
  });

  it('Blake’s hidden draw is a back all the way; Alice’s flips at 60% to the card she drew', () => {
    const blake = replyScript(entry(1, K.Draw), view(), { landing: ENDS.oppCards[2] });
    expect(blake.actors[0]).toMatchObject({ back: true, face: null, flipFrames: null });

    const alice = script(move(K.Draw), view(), { landing: { x: 170, y: 740, width: 60, height: 78 } }, { drawn: card(4, 0), oppHand: null });
    const a = alice.actors[0];
    expect(a).toMatchObject({ back: true, face: card(4, 0) });
    const half = a.flipFrames!.find((f) => String(f.transform).includes('rotateY(90deg)'))!;
    expect(half.offset as number).toBeCloseTo(0.6, 1);
    expect(alice.holds).toEqual([{ target: 'landing', ms: 420 }]);
  });

  it('a drawBack plan never shows a face, whatever the after view says', () => {
    const cap = reply(entry(1, K.Draw));
    expect(cap.plan).toBe('drawBack');
    const s = scriptOf(cap, { landing: ENDS.oppCards[2] }, { drawn: card(1, 3), oppHand: [card(1, 3)] });
    expect(s.actors[0]).toMatchObject({ back: true, face: null, flipFrames: null });
  });

  it('without the post-apply view a drawn card lands as a back (never a guess)', () => {
    const a = script(move(K.Draw), view(), { landing: { x: 170, y: 740, width: 60, height: 78 } }).actors[0];
    expect(a).toMatchObject({ back: true, face: null, flipFrames: null });
  });

  it('a glasses 8 turns 90 degrees in flight, then Blake’s hand turns over 70 ms apart', () => {
    const seen = [card(2, 0), card(1, 3), card(5, 1)];
    const s = script(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), {}, { drawn: null, oppHand: seen });
    const mover = s.actors.find((a) => a.key === 'mover')!;
    expect(lastTransform(mover.frames)).toContain('rotate(90deg)');
    const turns = s.actors.filter((a) => a.key.startsWith('glasses:'));
    expect(turns.map((a) => a.face)).toEqual(seen);
    for (const t of turns) expect(t).toMatchObject({ back: true });
    // Each turn waits for the 8 to land, then starts 70 ms after the last.
    expect(turns.map((t) => t.durationMs)).toEqual([420 + 240, 420 + 70 + 240, 420 + 140 + 240]);
    expect(s.holds.filter((h) => String(h.target).startsWith('oppCard:')).map((h) => h.ms)).toEqual(turns.map((t) => t.durationMs));
    expect(s.rings).toEqual(['landing', 'oppHand']);
    for (const t of turns) {
      checkFrames(t.frames);
      checkFrames(t.flipFrames!);
    }
  });

  it('a glasses 8 becomes the glasses face during its turn, fully shown before it lands (T12b)', () => {
    const s = script(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view());
    const mover = s.actors.find((a) => a.key === 'mover')!;
    const g = mover.glassesFrames;
    expect(g).not.toBeNull();
    checkFrames(g!);
    for (const f of g!) expect(Object.keys(f).every((k) => k === 'opacity' || k === 'offset' || k === 'easing')).toBe(true);
    expect(g![0].opacity).toBe(0);
    expect(g![g!.length - 1].opacity).toBe(1);
    // It starts as the plain 8 (the card leaving the hand) and is all glasses by the landing.
    const firstFull = g!.find((f) => f.opacity === 1)!;
    expect((firstFull.offset as number) * mover.durationMs).toBeLessThan(420);
    expect((g!.filter((f) => f.opacity === 0).at(-1)!.offset as number) * mover.durationMs).toBeGreaterThan(0);
    // Nothing else turns into glasses: a King, an 8 played for points, Blake's cards.
    expect(script(move(K.PlayPermanent, { Card: king }), view()).actors[0].glassesFrames).toBeNull();
    expect(script(move(K.PlayPoint, { Card: eight, HandIndex: 2 }), view()).actors[0].glassesFrames).toBeNull();
    const seen = [card(2, 0), card(1, 3), card(5, 1)];
    const withFlip = script(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), {}, { drawn: null, oppHand: seen });
    for (const a of withFlip.actors.filter((x) => x.key !== 'mover')) expect(a.glassesFrames).toBeNull();
  });

  it('a glasses 8 played BY Blake turns face up and becomes the glasses face too (public once played, as PermanentRow draws it)', () => {
    expect(replyScript(entry(1, K.PlayPermanent, eight)).actors.find((a) => a.key === 'mover')).toMatchObject({ back: true, face: eight, glassesFrames: expect.any(Array) });
  });

  it('a glasses 8 without Blake’s hand in the after view still flies; nothing turns over', () => {
    const s = script(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view());
    expect(s.actors.map((a) => a.key)).toEqual(['mover']);
  });

  it('a Jack steal flies the Jack onto the stolen card and slides the stolen card across with it', () => {
    const s = script(move(K.PlayPermanent, { Card: jack, HandIndex: 0, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), view());
    expect(s.actors.map((a) => a.key)).toEqual(['stolen', 'mover']);
    const [stolen, jackActor] = s.actors;
    expect(stolen).toMatchObject({ face: ten, back: false });
    // The stolen card starts in his row (52x68 at 20,200) and ends laid out on the new slot (60x78 at 90,600).
    expect(String(stolen.frames[0].transform)).toBe('translate(-74px, -405px) rotate(0deg) scale(0.87, 0.87)');
    expect(lastTransform(stolen.frames)).toBe('translate(0px, 0px) rotate(0deg) scale(1, 1)');
    // The Jack sits one jack offset below the point card.
    expect(lastTransform(jackActor.frames)).toBe('translate(70px, -103px) rotate(0deg) scale(1, 1)');
    expect(s.holds).toEqual([{ target: 'landing', ms: 420 }]);
  });

  it('a scuttle hits (300), holds (80) and sends both cards to the scrap (320)', () => {
    const s = script(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view());
    expect(s.actors.map((a) => a.key)).toEqual(['target', 'mover']);
    expect(s.actors.map((a) => a.durationMs)).toEqual([700, 700]);
    expect(s.holds).toEqual([{ target: 'scrap', ms: 700 }]);
    expect(s.rings).toEqual(['scrap']);
    for (const a of s.actors) {
      checkFrames(a.frames);
      // Both end centred on the scrap pile (300+30, 380+39).
      const t = lastTransform(a.frames);
      const dx = num(/translate\((-?[\d.]+)px/, t);
      expect(a.box.x + a.box.width / 2 + dx).toBeCloseTo(330, 1);
    }
    // The scuttled card does not move until the hit has landed and held.
    const target = s.actors[0];
    const still = target.frames.filter((f) => (f.offset as number) * 700 <= 380).map((f) => String(f.transform));
    expect(new Set(still).size).toBe(1);
  });

  it('a scuttle with no scrap pile to land on fades the pair out instead', () => {
    const s = script(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), { scrap: null });
    expect(s.holds).toEqual([]);
    for (const a of s.actors) expect(a.frames[a.frames.length - 1].opacity).toBe(0);
  });

  it('an Ace goes to the one-off zone (300), holds (240), then to the scrap; every point card follows, 50 ms apart', () => {
    const s = script(move(K.OneOff, { Card: ace, HandIndex: 0 }), view());
    const [mover, ...sweeps] = s.actors;
    expect(mover.key).toBe('mover');
    expect(mover.durationMs).toBe(300 + 240 + 320);
    expect(sweeps.map((a) => a.key)).toEqual(['sweep:point-0-0', 'sweep:point-1-0', 'sweep:point-1-1']);
    expect(sweeps.map((a) => a.delayMs)).toEqual([300, 350, 400]);
    expect(sweeps.map((a) => a.face)).toEqual([card(5, 0), ten, card(6, 2)]);
    expect(s.holds).toEqual([{ target: 'scrap', ms: 860 }]);
    expect(s.durationMs).toBe(860);
    // The Ace is centred in the zone (120+75, 380+39) at the hold.
    const hold = mover.frames.find((f) => Math.abs((f.offset as number) * 860 - 540) < 0.5)!;
    const dx = num(/translate\((-?[\d.]+)px/, String(hold.transform));
    expect(mover.box.x + mover.box.width / 2 + dx).toBeCloseTo(195, 1);
  });

  it('a one-off with nothing to scrap into (a counter window) settles in the zone and fades; no sweep, no hold', () => {
    const s = script(move(K.OneOff, { Card: ace }), view(), { scrap: null });
    expect(s.actors.map((a) => a.key)).toEqual(['mover']);
    expect(s.holds).toEqual([]);
    expect(s.actors[0].frames[s.actors[0].frames.length - 1].opacity).toBe(0);
  });

  it('a counter has no clone: the scrap pile arrives', () => {
    const s = script(move(K.Counter, { Card: card(2, 2) }), view());
    expect(s).toMatchObject({ actors: [], holds: [], arrives: ['scrap'], rings: ['scrap'], durationMs: 200 });
  });

  it('the arrive fallback only reaches the scrap for kinds that put cards there', () => {
    expect(script(move(K.DiscardPair), view()).arrives).toEqual(['scrap']);
    expect(script(move(K.Decline), view()).arrives).toEqual([]);
    expect(script(move(K.Pass), view()).rings).toEqual([]);
  });

  it('a plan missing a piece plays nothing instead of throwing', () => {
    expect(script(move(K.PlayPoint, { Card: nine }), view(), { landing: null }).actors).toEqual([]);
    expect(script(move(K.Scuttle, { Card: ten }), view()).actors).toEqual([]); // no target in the capture
  });

  it('every keyframe on every plan animates transform and opacity only', () => {
    const after: FlightAfter = { drawn: card(4, 0), oppHand: [card(2, 0), card(3, 0), card(4, 0)] };
    const cases: (() => FlightScript)[] = [
      () => script(move(K.PlayPoint, { Card: nine }), view(), {}, after),
      () => replyScript(entry(1, K.PlayPoint, card(6, 1)), view(), {}, after),
      () => script(move(K.PlayPermanent, { Card: eight }), view(), {}, after),
      () => script(move(K.OneOff, { Card: ace }), view(), {}, after),
      () => script(move(K.Scuttle, { Card: ten, Target: { Owner: 1, Zone: 0, Index: 0 } }), view(), {}, after),
      () => script(move(K.Draw), view(), {}, after),
    ];
    for (const build of cases) {
      const s = build();
      for (const a of s.actors) {
        checkFrames(a.frames);
        if (a.flipFrames) for (const f of a.flipFrames) expect(Object.keys(f).every((k) => ALLOWED.has(k))).toBe(true);
      }
    }
  });
});

// ─── FlightLayer ─────────────────────────────────────────────────────────

interface Call {
  el: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { cancel: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; onfinish: (() => void) | null };
}

interface Layer {
  play(cap: FlightCapture, root: ParentNode, after?: PlayerView | null): void;
}

interface Props {
  theme: CardTheme;
  motion: boolean;
}

let calls: Call[] = [];
let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
const proto = Element.prototype as unknown as { animate?: unknown };
let originalAnimate: unknown;

beforeEach(() => {
  calls = [];
  originalAnimate = proto.animate;
  proto.animate = function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { cancel: vi.fn(), finish: vi.fn(), onfinish: null as (() => void) | null };
    calls.push({ el: this, frames, options, animation });
    return animation;
  };
});

afterEach(() => {
  teardown();
  vi.useRealTimers();
  document.body.replaceChildren();
  if (originalAnimate === undefined) delete proto.animate;
  else proto.animate = originalAnimate;
});

function teardown(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function mountLayer(props: Props): Layer {
  teardown();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(FlightLayer, { target: host, props });
  flushSync();
  return instance as unknown as Layer;
}

const base = (over: Partial<Props> = {}): Props => ({ theme: vectorTheme, motion: true, ...over });
const layerEl = () => host!.firstElementChild as HTMLElement;
const clones = () => [...layerEl().querySelectorAll<HTMLElement>('[data-part="flight"]')];
const ringEls = () => [...layerEl().querySelectorAll<HTMLElement>('[data-part="ring"]')];
const flipCalls = () => calls.filter((c) => c.el.getAttribute('data-part') === 'flipper');
const holdCalls = () => calls.filter((c) => JSON.stringify(c.frames) === '[{"opacity":0},{"opacity":0}]');

/** Records which cards a probe theme was asked to draw. */
function probeTheme(): { theme: CardTheme; faces: Card[]; backs: number } {
  const seen = { faces: [] as Card[], backs: 0 };
  const theme: CardTheme = {
    ...vectorTheme,
    id: 'probe',
    Face: ((_anchor: unknown, props: { card: Card }) => {
      seen.faces.push(props.card);
    }) as unknown as CardTheme['Face'],
    Back: (() => {
      seen.backs++;
    }) as unknown as CardTheme['Back'],
  };
  return {
    theme,
    faces: seen.faces,
    get backs() {
      return seen.backs;
    },
  };
}

describe('FlightLayer, motion on', () => {
  it('flies one clone for Alice’s point play and holds the real destination invisible', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    const dest = add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);

    expect(clones()).toHaveLength(1);
    const flight = calls.find((c) => c.el.getAttribute('data-part') === 'flight')!;
    expect(flight.options).toMatchObject({ duration: 420, fill: 'both' });
    checkFrames(flight.frames);

    const holds = holdCalls();
    expect(holds).toHaveLength(1);
    expect(holds[0].el).toBe(dest);
    expect(holds[0].options).toMatchObject({ duration: 420, fill: 'none' });
  });

  it('writes nothing onto the board: no attribute, class or child changes', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    const before = root.outerHTML;
    layer.play(cap, root);
    expect(root.outerHTML).toBe(before);
    expect(layerEl().contains(root)).toBe(false);
  });

  it('every clone is aria-hidden and pointer-transparent and no node in the layer carries a staging marker', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.Draw), view(), root);
    add(root, 'hand-card-3', [170, 740, 60, 78]);
    layer.play(cap, root, view({ you: { ...view().you, hand: [nine, seven, eight, card(4, 0)] } }));

    expect(clones()).toHaveLength(1);
    const c = clones()[0];
    expect(c.getAttribute('aria-hidden')).toBe('true');
    expect(c.style.pointerEvents).toBe('none');
    expect(layerEl().getAttribute('aria-hidden')).toBe('true');
    expect(layerEl().style.pointerEvents).toBe('none');
    // The real Classic faces rendered (so the scrub had something to remove).
    expect(layerEl().querySelectorAll('[data-size]').length).toBeGreaterThan(0);
    for (const attr of ['data-testid', 'data-staged', 'aria-pressed', 'data-state']) {
      expect(layerEl().querySelector(`[${attr}]`), attr).toBeNull();
    }
  });

  it('draws clones with the theme’s own Face and Back inside a box sized from the rect', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    const c = clones()[0];
    expect(c.style.left).toBe('20px'); // the hand slot
    expect(c.style.top).toBe('740px');
    expect(c.style.width).toBe('60px');
    expect(c.style.height).toBe('78px');
    const side = c.querySelector<HTMLElement>('.flight__side')!;
    expect(side.firstElementChild?.getAttribute('data-size')).toBe('hand');
    expect(side.firstElementChild?.getAttribute('style') ?? '').not.toContain('width');
  });

  it('Blake’s draw without glasses clones a Back only', () => {
    const probe = probeTheme();
    const layer = mountLayer(base({ theme: probe.theme }));
    const root = board();
    const cap = reply(entry(1, K.Draw), view(), root);
    // Even when the after view could name the card, a hidden hand is never read.
    const after = view({ opponent: { handCount: 4, hand: null, points: [], permanents: [] } });
    place(root.querySelector('[data-testid="opp-hand"]')!, 'span', null, [74, 60, 32, 42], 'opponent-hand__card');
    layer.play(cap, root, after);
    expect(clones()).toHaveLength(1);
    expect(probe.backs).toBe(1);
    expect(probe.faces).toEqual([]);
    expect(flipCalls()).toHaveLength(0);
  });

  it('Blake’s draw lands on his LAST hand slot', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = reply(entry(1, K.Draw), view(), root);
    const opp = root.querySelector('[data-testid="opp-hand"]')!;
    place(opp, 'span', null, [74, 60, 32, 42], 'opponent-hand__card'); // his new, fourth slot
    layer.play(cap, root);
    const flight = calls.find((c) => c.el.getAttribute('data-part') === 'flight')!;
    const box = { x: parseFloat(flight.el.style.left), y: parseFloat(flight.el.style.top), w: parseFloat(flight.el.style.width), h: parseFloat(flight.el.style.height) };
    const t = String(flight.frames[flight.frames.length - 1].transform);
    const cx = box.x + box.w / 2 + num(/translate\((-?[\d.]+)px/, t);
    const cy = box.y + box.h / 2 + num(/translate\(-?[\d.]+px, (-?[\d.]+)px/, t);
    expect([cx, cy]).toEqual([74 + 16, 60 + 21]);
    expect(holdCalls()[0].el).toBe(opp.lastElementChild);
  });

  it('Alice’s draw flips to the card she drew; without the after view it stays a back', () => {
    const probe = probeTheme();
    const layer = mountLayer(base({ theme: probe.theme }));
    const root = board();
    const cap = capture(move(K.Draw), view(), root);
    add(root, 'hand-card-3', [170, 740, 60, 78]);
    layer.play(cap, root, view({ you: { ...view().you, hand: [nine, seven, eight, card(4, 0)] } }));
    expect(probe.faces).toEqual([card(4, 0)]);
    expect(probe.backs).toBe(1);
    expect(flipCalls()).toHaveLength(1);
    expect(flipCalls()[0].frames.some((f) => String(f.transform).includes('rotateY(180deg)'))).toBe(true);

    layer.play(cap, root);
    expect(probe.faces).toEqual([card(4, 0)]);
    expect(flipCalls()).toHaveLength(1);
  });

  it('Blake’s played card is a Back that flips to the card he played', () => {
    const probe = probeTheme();
    const layer = mountLayer(base({ theme: probe.theme }));
    const root = board();
    const cap = reply(entry(1, K.PlayPoint, card(6, 1)), view(), root);
    add(root, 'point-1-2', [160, 200, 52, 68]);
    layer.play(cap, root);
    expect(probe.faces).toEqual([card(6, 1)]);
    expect(probe.backs).toBe(1);
    expect(flipCalls()).toHaveLength(1);
    const sides = [...layerEl().querySelectorAll<HTMLElement>('.flight__side')];
    expect(sides.map((s) => s.getAttribute('data-side'))).toEqual(['back', 'face']);
    expect(sides[1].style.transform).toBe('rotateY(180deg)');
  });

  it('a Jack steal flies two clones; a scuttle two; an Ace one plus a sweep', () => {
    const layer = mountLayer(base());
    let root = board();
    let cap = capture(move(K.PlayPermanent, { Card: jack, HandIndex: 0, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }), view(), root);
    root.querySelector('[data-testid="point-1-0"]')!.remove();
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    expect(clones()).toHaveLength(2);
    expect(holdCalls().map((h) => h.el.getAttribute('data-testid'))).toEqual(['point-0-1']);

    teardown();
    calls.length = 0;
    const layer2 = mountLayer(base());
    root = board();
    cap = capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), root);
    root.querySelector('[data-testid="point-1-1"]')!.remove();
    layer2.play(cap, root);
    expect(clones()).toHaveLength(2);
    expect(holdCalls().map((h) => h.el.getAttribute('data-testid'))).toEqual(['scrap-pile']);
    expect(holdCalls()[0].options.duration).toBe(700);

    teardown();
    calls.length = 0;
    const layer3 = mountLayer(base());
    root = board();
    cap = capture(move(K.OneOff, { Card: ace, HandIndex: 0 }), view(), root);
    for (const id of ['point-0-0', 'point-1-0', 'point-1-1']) root.querySelector(`[data-testid="${id}"]`)!.remove();
    layer3.play(cap, root);
    expect(clones()).toHaveLength(4);
  });

  it('the glasses 8 holds each of Blake’s cards until its own turn-over starts', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), root);
    add(root, 'perm-0-1', [270, 600, 78, 60]);
    const seen = [card(2, 0), card(1, 3), card(5, 1)];
    layer.play(cap, root, view({ opponent: { handCount: 3, hand: seen, points: [], permanents: [] } }));
    expect(clones()).toHaveLength(4);
    expect(flipCalls()).toHaveLength(3);
    expect(holdCalls().map((h) => h.options.duration)).toEqual([420, 660, 730, 800]);
  });

  it('the glasses 8 clone carries the theme’s glasses face, laid out landscape and turned back, so it lands as the row draws it (T12b)', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), root);
    add(root, 'perm-0-1', [270, 600, 78, 60]);
    layer.play(cap, root);
    const mover = clones().find((c) => c.getAttribute('data-actor') === 'mover')!;
    expect(mover.style.width).toBe('60px'); // the hand slot, upright
    expect(mover.style.height).toBe('78px');
    const g = mover.querySelector<HTMLElement>('[data-part="glasses"]');
    expect(g).not.toBeNull();
    // The same face the permanents row draws for a glasses 8: variant glasses, field size.
    const face = g!.querySelector('[data-variant="glasses"]');
    expect(face).not.toBeNull();
    expect(face?.getAttribute('data-size')).toBe('field');
    // A landscape box (one card-height wide), centred in the upright clone and
    // turned -90deg, so the clone's own 90deg turn leaves it upright.
    expect([g!.style.left, g!.style.top, g!.style.width, g!.style.height]).toEqual(['-9px', '9px', '78px', '60px']);
    expect(g!.style.transform).toBe('rotate(-90deg)');
    // It fades in on the flight's own timing (opacity only), and stays.
    const anim = calls.find((c) => c.el === g)!;
    expect(anim).toBeDefined();
    expect(anim.options).toMatchObject({ duration: 420, fill: 'both' });
    expect(anim.frames.at(-1)!.opacity).toBe(1);
    // No staging marker inside it either.
    for (const attr of ['data-testid', 'data-staged', 'aria-pressed', 'data-state']) expect(g!.querySelector(`[${attr}]`), attr).toBeNull();

    // An upright permanent's clone has no glasses layer.
    const layer2 = mountLayer(base());
    const root2 = board();
    const kingCap = capture(move(K.PlayPermanent, { Card: king, HandIndex: 0 }), view({ you: { ...view().you, hand: [king, seven, eight] } }), root2);
    add(root2, 'perm-0-1', [270, 600, 60, 78]);
    layer2.play(kingCap, root2);
    expect(clones()).toHaveLength(1);
    expect(layerEl().querySelector('[data-part="glasses"]')).toBeNull();
  });

  it('a counter has no clone; the scrap pile plays the arrive animation (scale 0.92 to 1)', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.Counter, { Card: card(2, 2) }), view(), root);
    layer.play(cap, root);
    expect(clones()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].el.getAttribute('data-testid')).toBe('scrap-pile');
    expect(calls[0].frames[0]).toMatchObject({ opacity: 0, transform: 'scale(0.92)' });
    expect(calls[0].frames[1]).toMatchObject({ opacity: 1, transform: 'scale(1)' });
    expect(calls[0].options).toMatchObject({ duration: 200, fill: 'none' });
    for (const f of calls[0].frames) for (const key of Object.keys(f)) expect(ALLOWED.has(key)).toBe(true);
  });

  it('removes its clones, and cancels every animation, once the flight is over', () => {
    vi.useFakeTimers();
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    expect(clones()).toHaveLength(1);
    vi.advanceTimersByTime(419);
    expect(clones()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    flushSync();
    expect(clones()).toHaveLength(0);
    for (const c of calls) expect(c.animation.cancel).toHaveBeenCalled();
  });

  it('a finish event ends the flight early', () => {
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    const reported = calls.filter((c) => c.animation.onfinish);
    expect(reported.length).toBeGreaterThan(0);
    reported[0].animation.onfinish!();
    flushSync();
    expect(clones()).toHaveLength(0);
  });

  it('unmounting mid-flight cancels the animations and leaves no timer behind', () => {
    vi.useFakeTimers();
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    teardown();
    for (const c of calls) expect(c.animation.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing, and does not throw, when the destination is not on the page', () => {
    const layer = mountLayer(base());
    const root = board();
    root.querySelector('[data-testid="point-0-0"]')!.remove();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    expect(() => layer.play(cap, root)).not.toThrow();
    expect(clones()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('survives a theme that throws and a capture with no rects', () => {
    const throwing: CardTheme = {
      ...vectorTheme,
      Face: (() => {
        throw new Error('boom');
      }) as unknown as CardTheme['Face'],
    };
    const layer = mountLayer(base({ theme: throwing }));
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    expect(() => layer.play(cap, root)).not.toThrow();
    expect(() => layer.play(capture(move(K.PlayPoint, { Card: nine }), view(), document.createElement('div')), root)).not.toThrow();
  });

  it('survives a missing Element.animate: no throw, no clone, a calm ring instead', () => {
    vi.useFakeTimers();
    delete proto.animate;
    const layer = mountLayer(base());
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    expect(() => layer.play(cap, root)).not.toThrow();
    expect(clones()).toHaveLength(0);
    expect(ringEls()).toHaveLength(1);
  });

  it('keeps the geometry and 3D rules in its stylesheet: perspective 900px, hidden backfaces, no z-index', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'FlightLayer.svelte'), 'utf8');
    const css = source.slice(source.indexOf('<style>'));
    expect(css).toMatch(/\.flight-layer\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*perspective:\s*900px/s);
    expect(css).toMatch(/backface-visibility:\s*hidden/);
    expect(css).not.toMatch(/z-index/);
    expect(css).not.toMatch(/:global|zoom|!important/);
    // Only transform and opacity are ever animated: no CSS transition or keyframes.
    expect(css).not.toMatch(/transition|@keyframes|animation:/);
  });
});

describe('FlightLayer, motion off (reduced-motion rings)', () => {
  it('draws no clone and calls no animate; a ring marks the landing for 600 ms', () => {
    vi.useFakeTimers();
    const layer = mountLayer(base({ motion: false }));
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);
    layer.play(cap, root);
    expect(calls).toHaveLength(0);
    expect(clones()).toHaveLength(0);
    const rings = ringEls();
    expect(rings).toHaveLength(1);
    expect(rings[0].style.left).toBe('86px');
    expect(rings[0].style.top).toBe('596px');
    expect(rings[0].style.width).toBe('68px');
    expect(REDUCED_RING_MS).toBe(600);
    vi.advanceTimersByTime(599);
    expect(ringEls()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    flushSync();
    expect(ringEls()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('rings the scrap for a scuttle and a counter, and Blake’s hand as well for the glasses 8', () => {
    vi.useFakeTimers();
    const layer = mountLayer(base({ motion: false }));
    const root = board();
    layer.play(capture(move(K.Scuttle, { Card: ten, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 1 } }), view(), root), root);
    layer.play(capture(move(K.Counter, { Card: card(2, 2) }), view(), root), root);
    expect(ringEls().map((r) => r.style.left)).toEqual(['296px', '296px']);
    vi.advanceTimersByTime(700);
    flushSync();

    add(root, 'perm-0-1', [270, 600, 78, 60]);
    layer.play(capture(move(K.PlayPermanent, { Card: eight, HandIndex: 2 }), view(), root), root);
    expect(ringEls()).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it('draws nothing for a move that changes nothing visible, and nothing to ring when the board is missing', () => {
    const layer = mountLayer(base({ motion: false }));
    const root = board();
    layer.play(capture(move(K.Pass), view(), root), root);
    layer.play(capture(move(K.PlayPoint, { Card: nine }), view(), document.createElement('div')), document.createElement('div'));
    expect(ringEls()).toHaveLength(0);
  });

  it('switching motion on a mounted instance changes the next flight, not the layer', () => {
    const props = $state<Props>(base());
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(FlightLayer, { target: host, props });
    flushSync();
    const layer = instance as unknown as Layer;
    const first = host.firstElementChild;
    const root = board();
    const cap = capture(move(K.PlayPoint, { Card: nine, HandIndex: 0 }), view(), root);
    add(root, 'point-0-1', [90, 600, 60, 78]);

    layer.play(cap, root);
    expect(clones()).toHaveLength(1);
    expect(ringEls()).toHaveLength(0);
    const animated = calls.length;

    props.motion = false;
    flushSync();
    layer.play(cap, root);
    expect(calls).toHaveLength(animated);
    expect(ringEls()).toHaveLength(1);
    expect(host.firstElementChild).toBe(first);
  });
});
