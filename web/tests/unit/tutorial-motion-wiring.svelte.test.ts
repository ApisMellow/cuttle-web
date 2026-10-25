// @vitest-environment jsdom
// T11 (docs/tutorial-plan.md §6 T11; design §8.1, §8.4-§8.6, §9): the motion
// wired into a lesson. The REAL GameScreen and CoachOverlay over the REAL
// TutorialTable (engine v0.3.0 through the wasm bridge), built by a real
// TutorialStore, so the store forwards the table's flight hooks to the
// overlay exactly as in the app.
//
// jsdom has no layout and no WAAPI, so this file installs a recording
// `Element.prototype.animate` (animations that never finish) and a
// deterministic `getBoundingClientRect`. `document.getAnimations()` is the
// stub's own registry of animations not yet finished or cancelled.
//
// Ledger: R25.8 (both criteria: flights from public identities only, deal
// and beats never block input), R25.9 (unit side: reduced motion leaves no
// clone and no running animation), plus the plan's "win beats only in
// lessons 1 and 5".
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import { view as bridgeView } from '../../src/lib/bridge/engine';
import CoachOverlay from '../../src/lib/components/CoachOverlay.svelte';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { MoveKind } from '../../src/lib/enums';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { DEMO_ENTRY_MS, type CoachClock, type CoachFrames } from '../../src/lib/tutorial/coach.svelte';
import { ONEOFF_FLIGHT_MS } from '../../src/lib/tutorial/motion';
import { BLAKE_DONE_BEAT_MS, BLAKE_THINK_MS, SUCCESS_BEAT_MS, TutorialTable } from '../../src/lib/tutorial/table.svelte';
import { TutorialStore } from '../../src/lib/tutorial/tutorial.svelte';
import type { LessonId } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { driveStep, expectedIndex, walkTo } from './tutorial-driver';

// ---------------------------------------------------------------------------
// WAAPI and layout stubs
// ---------------------------------------------------------------------------

interface FakeAnimation {
  el: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  effect: null;
}

let calls: FakeAnimation[] = [];
let running = new Set<FakeAnimation>();
/** When set, `animate` throws on the elements it matches. */
let throwOn: ((el: Element) => boolean) | null = null;
/** The real macrotask scheduler, kept before any test fakes the timers. */
const realImmediate = globalThis.setImmediate;

const proto = Element.prototype as unknown as { animate?: unknown; getBoundingClientRect: () => DOMRect };
const doc = document as unknown as { getAnimations?: () => unknown[] };
let originalAnimate: unknown;
let originalRect: () => DOMRect;
const slots = new WeakMap<Element, number>();
let nextSlot = 0;

function installStubs(): void {
  originalAnimate = proto.animate;
  originalRect = proto.getBoundingClientRect;
  proto.animate = function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    if (throwOn?.(this)) throw new Error('animate failed');
    const a: FakeAnimation = {
      el: this,
      frames,
      options,
      onfinish: null,
      effect: null,
      finish: vi.fn(() => running.delete(a)),
      cancel: vi.fn(() => running.delete(a)),
    };
    calls.push(a);
    running.add(a);
    return a;
  };
  // Every element gets its own fixed, non-empty box, so flights have somewhere to go.
  proto.getBoundingClientRect = function (this: Element) {
    let k = slots.get(this);
    if (k === undefined) {
      k = nextSlot++;
      slots.set(this, k);
    }
    const x = 8 + ((k * 37) % 300);
    const y = 40 + ((k * 53) % 700);
    return { x, y, width: 60, height: 78, top: y, left: x, right: x + 60, bottom: y + 78, toJSON: () => ({}) } as DOMRect;
  };
  doc.getAnimations = () => [...running];
}

function removeStubs(): void {
  if (originalAnimate === undefined) delete proto.animate;
  else proto.animate = originalAnimate;
  proto.getBoundingClientRect = originalRect;
  delete doc.getAnimations;
}

// ---------------------------------------------------------------------------
// The mounted lesson, as App has it
// ---------------------------------------------------------------------------

const idleClock: CoachClock = { set: () => 0, clear: () => {} };
const idleFrames: CoachFrames = { request: () => 0, cancel: () => {} };

let host: HTMLDivElement | undefined;
let screen: ReturnType<typeof mount> | undefined;
let overlay: ReturnType<typeof mount> | undefined;
let store: TutorialStore<TutorialTable>;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
  }
  flushSync();
}

async function startLesson(
  id: LessonId,
  stepId: string | null = null,
  pick = 0,
  coach: { clock?: CoachClock; frames?: CoachFrames } = {},
): Promise<TutorialTable> {
  store.start(id);
  const table = store.table!;
  if (stepId !== null) walkTo(table, stepId, { pick });
  host = document.createElement('div');
  document.body.append(host);
  screen = mount(GameScreen, { target: host, props: { source: table } });
  overlay = mount(CoachOverlay, { target: host, props: { table, store, clock: coach.clock ?? idleClock, frames: coach.frames ?? idleFrames } });
  await settle();
  return table;
}

function cleanup(): void {
  if (overlay) unmount(overlay);
  if (screen) unmount(screen);
  host?.remove();
  overlay = screen = host = undefined;
}

const q = (sel: string) => host!.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...host!.querySelectorAll<HTMLElement>(sel)];
const testid = (el: Element) => el.getAttribute('data-testid') ?? '';

/** The flight clones on screen, with what each shows. */
function clones(): { actor: string; back: boolean; face: boolean }[] {
  return qa('.flight-layer [data-part="flight"]').map((el) => ({
    actor: el.getAttribute('data-actor') ?? '',
    back: el.querySelector('[data-side="back"]') !== null,
    face: el.querySelector('[data-side="face"]') !== null,
  }));
}

/** Plays the expected move through the table (the gate), then lets the flight render. */
async function playMove(table: TutorialTable, pick = 0): Promise<void> {
  void table.apply(expectedIndex(table, pick));
  await settle();
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

const isWave = (a: FakeAnimation) => /^point-0-\d+$/.test(testid(a.el)) && a.frames.some((f) => f.transform === 'translateY(-10px)');
const isMeterPulse = (a: FakeAnimation) => a.el.classList.contains('score-bar__meter');

let errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  settings.tableMode = false;
  settings.reducedMotion = false;
  calls = [];
  running = new Set();
  throwOn = null;
  installStubs();
  store = new TutorialStore({
    storage: { getItem: () => null, setItem: () => {} },
    createTable: (lesson, deps) => new TutorialTable(lesson, deps),
    learnerName: () => 'Alice',
    reducedMotion: () => !!settings.reducedMotion,
  });
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  store.exitHome();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  removeStubs();
  settings.reducedMotion = false;
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

// ---------------------------------------------------------------------------
// Flights (design §8.4)
// ---------------------------------------------------------------------------

describe('flights (design §8.4)', () => {
  it('a learner move flies from her hand to the row, and the landing ring flashes ochre as it lands', async () => {
    const table = await startLesson(2);
    calls = [];
    await playMove(table); // 2.1: the 7 of clubs to her points
    const c = clones();
    expect(c.map((x) => x.actor)).toEqual(['mover']);
    expect(c[0].face).toBe(true);
    expect(c[0].back).toBe(false);
    const flight = calls.find((a) => a.el.getAttribute('data-actor') === 'mover');
    expect(flight).toBeDefined();
    // The real landing card is held invisible while its clone flies.
    const hold = calls.find((a) => testid(a.el) === 'point-0-1' && a.frames.every((f) => f.opacity === 0));
    expect(hold?.options.fill).toBe('none');
    // The flash: ochre ring at the landing, timed to the flight's end.
    const flash = calls.find((a) => a.el.hasAttribute('data-flash'));
    expect(flash).toBeDefined();
    expect(flash!.options.delay).toBe(420);
    for (const a of calls) for (const f of a.frames) for (const k of Object.keys(f)) expect(['offset', 'easing', 'composite', 'opacity', 'transform']).toContain(k);
  });

  it('Blake\'s card leaves his hand as a back and turns face up in flight; his hidden draw stays a back', async () => {
    const table = await startLesson(2);
    await playMove(table);
    await advance(SUCCESS_BEAT_MS);
    expect(table.phase).toBe('blake');
    calls = [];
    await advance(BLAKE_THINK_MS); // he plays his 6 of diamonds
    const played = clones().filter((x) => x.actor === 'mover');
    expect(played).toEqual([{ actor: 'mover', back: true, face: true }]);
    const flip = calls.find((a) => a.el.getAttribute('data-part') === 'flipper');
    expect(flip?.frames.some((f) => String(f.transform).includes('rotateY(180deg)'))).toBe(true);
    // No ochre flash for Blake: ochre answers the learner's own drop.
    expect(calls.some((a) => a.el.hasAttribute('data-flash'))).toBe(false);

    // 2.2: Alice draws, then Blake draws a card she can't see.
    await advance(BLAKE_DONE_BEAT_MS);
    expect(table.step?.id).toBe('2.2');
    await playMove(table);
    const mine = clones().filter((x) => x.actor === 'mover').at(-1)!;
    expect(mine.face).toBe(true); // her own drawn card flips up
    await advance(SUCCESS_BEAT_MS); // her clone's backstop has run: it is gone
    expect(table.phase).toBe('blake');
    calls = [];
    await advance(BLAKE_THINK_MS);
    const his = clones().filter((x) => x.actor === 'mover');
    expect(his).toEqual([{ actor: 'mover', back: true, face: false }]);
    // No face anywhere in the layer: nothing on screen names the card he drew.
    expect(qa('.flight-layer [data-side="face"]')).toEqual([]);
    const hidden = bridgeView(1);
    if (!hidden.ok) throw new Error('view(1)');
    const drawn: Card = hidden.state.you.hand.at(-1)!;
    expect(table.envelope!.state.opponent.hand).toBeNull();
    expect(JSON.stringify(table.envelope!.history.at(-1))).not.toContain(`{"Rank":${drawn.Rank},"Suit":${drawn.Suit}}`);
  });

  it('the glasses 8 (5.1) lands on its side, then Blake\'s hand turns face up in place', async () => {
    const table = await startLesson(5);
    calls = [];
    await playMove(table);
    const c = clones();
    expect(c.find((x) => x.actor === 'mover')).toBeDefined();
    const glasses = c.filter((x) => x.actor.startsWith('glasses:'));
    expect(glasses.length).toBe(4); // his four cards, now public
    for (const g of glasses) expect(g).toMatchObject({ back: true, face: true });
    const mover = calls.find((a) => a.el.getAttribute('data-actor') === 'mover');
    expect(String(mover!.frames.at(-1)!.transform)).toContain('rotate(90deg)');

    // Under glasses Blake's draw is public to Alice: it flips like hers. Its
    // face can only come from seat 0's post-apply view.
    await advance(SUCCESS_BEAT_MS);
    expect(table.phase).toBe('blake');
    await advance(BLAKE_THINK_MS);
    expect(table.envelope!.history.at(-1)).toMatchObject({ by: 1, kind: MoveKind.Draw });
    const draw = clones().filter((x) => x.actor === 'mover');
    expect(draw).toEqual([{ actor: 'mover', back: true, face: true }]);
  });
});

// ---------------------------------------------------------------------------
// The deal (design §8.5)
// ---------------------------------------------------------------------------

describe('the lesson-1 deal (design §8.5)', () => {
  it('deals her three cards face up and his five backs from the deck, then brings the coach in', async () => {
    await startLesson(1);
    const deal = qa('[data-deal]');
    expect(deal.length).toBe(8);
    const faces = deal.filter((el) => el.querySelector('.coach-motion__side + .coach-motion__side'));
    expect(faces.length).toBe(3);
    // Each real hand card is held invisible until its clone lands; the points fade in.
    for (const i of [0, 1, 2]) {
      expect(calls.some((a) => testid(a.el) === `hand-card-${i}` && a.frames.every((f) => f.opacity === 0))).toBe(true);
    }
    expect(calls.some((a) => testid(a.el) === 'point-0-0' && a.frames[0].opacity === 0 && a.frames.at(-1)!.opacity === 1)).toBe(true);
    // The bubble and the scrim wait for the last card.
    const bubbleIn = calls.find((a) => testid(a.el) === 'coach-bubble');
    expect(bubbleIn?.frames[0].opacity).toBe(0);
    expect(bubbleIn?.frames.at(-1)!.opacity).toBe(1);
    // The bubble is in the DOM and usable all along (never blocked).
    expect(q('[data-testid="coach-next"]')).not.toBeNull();
  });

  it('a tap during the deal calls finish() on every deal animation and clears the clones', async () => {
    await startLesson(1);
    const dealAnims = [...calls];
    expect(dealAnims.length).toBeGreaterThan(8);
    q('[data-testid="board"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    for (const a of dealAnims) expect(a.finish, testid(a.el) || a.el.className).toHaveBeenCalled();
    expect(qa('[data-deal]')).toEqual([]);
  });

  it('a tap on the coach\'s own controls or the menu button does not skip the deal (T9\'s exclusion)', async () => {
    await startLesson(1);
    const dealAnims = [...calls];
    for (const id of ['coach-next', 'coach-leave', 'menu-button']) {
      q(`[data-testid="${id}"]`)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
    await settle();
    for (const a of dealAnims) expect(a.finish).not.toHaveBeenCalled();
    expect(qa('[data-deal]').length).toBe(8);
    // It ends on its own: the backstop clears the clones.
    await advance(2000);
    expect(qa('[data-deal]')).toEqual([]);
  });

  it('no deal in lessons 2 to 5', async () => {
    for (const id of [2, 3, 4, 5] as const) {
      await startLesson(id);
      expect(qa('[data-deal]'), `lesson ${id}`).toEqual([]);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Win beats (design §8.6): lessons 1 and 5 only
// ---------------------------------------------------------------------------

describe('win beats (design §8.6)', () => {
  for (const [id, step] of [
    [1, '1.5'],
    [5, '5.4'],
  ] as const) {
    it(`lesson ${id}: the wave, the meter pulse and the "You win!" headline, after the card lands`, async () => {
      const table = await startLesson(id, step);
      calls = [];
      await playMove(table);
      const wave = calls.filter(isWave);
      const points = qa('[data-testid^="point-0-"]').filter((el) => /^point-0-\d+$/.test(testid(el)));
      expect(wave.length).toBe(points.length);
      wave.forEach((a, i) => expect(a.options.delay).toBe(480 + i * 70));
      expect(calls.filter(isMeterPulse).length).toBe(1);
      const headline = q('[data-testid="coach-bubble"] .coach__headline');
      expect(headline?.textContent).toBe('You win!');
      // The win is in the announced copy too, once.
      const live = q('[data-testid="coach-bubble"] [aria-live]')!.textContent ?? '';
      expect(live.match(/You win!/g)?.length).toBe(1);
      await advance(SUCCESS_BEAT_MS);
      expect(table.phase).toBe('finished');
      expect(q('[data-testid="coach-bubble"] .coach__headline')?.textContent).toBe('You win!');
    });
  }

  for (const id of [2, 3, 4] as const) {
    it(`lesson ${id}: no wave, no pulse, no headline anywhere in the lesson`, async () => {
      const table = await startLesson(id);
      for (let guard = 0; guard < 20 && table.phase === 'step'; guard++) {
        driveStep(table);
        await settle();
        expect(q('[data-testid="coach-bubble"] .coach__headline')).toBeNull();
      }
      expect(table.phase).toBe('finished');
      expect(calls.filter(isWave)).toEqual([]);
      expect(calls.filter(isMeterPulse)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Reduced motion (design §8.4-§8.6, R25.9 unit side)
// ---------------------------------------------------------------------------

describe('reduced motion', () => {
  for (const id of [1, 2, 3, 4, 5] as const) {
    it(`lesson ${id}: no clone, no animation running once each step settles; the calm variants remain`, async () => {
      settings.reducedMotion = true;
      const table = await startLesson(id);
      expect(qa('[data-deal]')).toEqual([]);
      let rings = 0;
      for (let guard = 0; guard < 20 && table.phase === 'step'; guard++) {
        const step = table.step!;
        if (step.kind === 'move') {
          void table.apply(expectedIndex(table));
          await settle();
          rings += qa('.flight-layer [data-part="ring"]').length;
          expect(clones()).toEqual([]);
          expect(qa('[data-flash]')).toEqual([]);
          const inBeat = (): boolean => ['success', 'blake'].includes(table.phase);
          for (let n = 0; n < 50 && inBeat(); n++) await advance(100);
        } else {
          driveStep(table);
          await settle();
        }
        expect(document.getAnimations(), `step ${step.id}`).toEqual([]);
      }
      expect(table.phase).toBe('finished');
      expect(calls).toEqual([]);
      expect(rings).toBeGreaterThan(0);
      if (id === 1 || id === 5) expect(q('[data-testid="coach-bubble"] .coach__headline')?.textContent).toBe('You win!');
    });
  }
});

// ---------------------------------------------------------------------------
// Review round (T11): attach/detach, non-winning moves, no testids, no leaks
// ---------------------------------------------------------------------------

describe('the overlay attaches its motion only while mounted', () => {
  it('unmounting CoachOverlay detaches it: a hook fired afterwards reaches no sink', async () => {
    const hits: string[] = [];
    const attach = store.attachMotion.bind(store);
    vi.spyOn(store, 'attachMotion').mockImplementation((table, sink) =>
      attach(table, {
        beforeApply: (m, v) => (hits.push('beforeApply'), sink.beforeApply(m, v)),
        afterApply: () => (hits.push('afterApply'), sink.afterApply()),
        beforeReply: (v) => (hits.push('beforeReply'), sink.beforeReply(v)),
        afterReply: (e) => (hits.push('afterReply'), sink.afterReply(e)),
      }),
    );
    const table = await startLesson(2);
    expect(store.attachMotion).toHaveBeenCalledTimes(1);
    if (overlay) unmount(overlay);
    overlay = undefined;
    await settle();
    void table.apply(expectedIndex(table)); // 2.1, then Blake's reply
    await settle();
    await advance(SUCCESS_BEAT_MS);
    await advance(BLAKE_THINK_MS);
    expect(table.seq).toBe(2);
    expect(hits).toEqual([]);
  });
});

describe('no win beats on a non-winning move, even in the winning lessons', () => {
  it('lesson 1, steps 1.1-1.4: no headline, wave or pulse before the win', async () => {
    const table = await startLesson(1);
    for (const id of ['1.1', '1.2', '1.3', '1.4']) {
      expect(table.step?.id).toBe(id);
      table.next();
      await settle();
      expect(q('[data-testid="coach-bubble"] .coach__headline'), id).toBeNull();
    }
    expect(calls.filter(isWave)).toEqual([]);
    expect(calls.filter(isMeterPulse)).toEqual([]);
  });

  it('lesson 5, the 8, the Jack and the popover step (5.1-5.3): no headline, wave or pulse', async () => {
    const table = await startLesson(5);
    for (let guard = 0; guard < 10 && table.step?.id !== '5.4'; guard++) {
      driveStep(table);
      await settle();
      expect(q('[data-testid="coach-bubble"] .coach__headline'), table.step?.id).toBeNull();
      expect(q('[data-testid="coach-bubble"] [aria-live]')!.textContent).not.toContain('You win!');
    }
    expect(table.step?.id).toBe('5.4');
    expect(calls.filter(isWave)).toEqual([]);
    expect(calls.filter(isMeterPulse)).toEqual([]);
  });
});

describe('motion pieces are decoration only', () => {
  it('deal clones and the landing flash carry no testid, and their layer is aria-hidden', async () => {
    await startLesson(1);
    const layer = q('.coach-motion')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(qa('[data-deal]').length).toBe(8);
    for (const el of qa('[data-deal]')) {
      expect(el.hasAttribute('data-testid')).toBe(false);
      expect(el.querySelector('[data-testid]')).toBeNull();
      expect(el.closest('[aria-hidden="true"]')).toBe(layer);
    }
    cleanup();
    const table = await startLesson(2);
    void table.apply(expectedIndex(table));
    await settle();
    const flashes = qa('[data-flash]');
    expect(flashes.length).toBe(1);
    for (const el of flashes) {
      expect(el.hasAttribute('data-testid')).toBe(false);
      expect(el.closest('[aria-hidden="true"]')).toBe(q('.coach-motion'));
    }
    expect(q('.coach-motion [data-testid]')).toBeNull();
  });

  it('a motion failure after the render never surfaces as an unhandled rejection, and the lesson goes on', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const table = await startLesson(2);
      throwOn = (el) => el.hasAttribute('data-flash');
      void table.apply(expectedIndex(table));
      await settle();
      // Node reports an unhandled rejection after the microtask queue drains: wait one real macrotask.
      await new Promise((resolve) => realImmediate(resolve));
      await new Promise((resolve) => realImmediate(resolve));
      expect(rejections).toEqual([]);
      expect(table.phase).toBe('success');
      await advance(SUCCESS_BEAT_MS);
      expect(table.phase).toBe('blake');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// T14 judge nice-to-have 2: as glasses go down (5.1) and Blake's hand turns
// face up, his hand gets a brief iris ring, from the moment the 8 lands. Reduced
// motion keeps the FlightLayer's static ring there (ringTargets: 'oppHand').
describe('the glasses ring (5.1)', () => {
  it('flashes an iris ring around his hand as it flips, transform and opacity only; other moves do not', async () => {
    const table = await startLesson(5);
    calls = [];
    await playMove(table); // 5.1: the 8 of clubs as glasses
    const oppHand = q('[data-testid="opp-hand"]')!.getBoundingClientRect();
    const rings = calls.filter((a) => a.el.getAttribute('data-flash-tone') === 'iris');
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    expect((ring.el as HTMLElement).style.left).toBe(`${oppHand.x - 6}px`);
    expect((ring.el as HTMLElement).style.top).toBe(`${oppHand.y - 6}px`);
    expect(ring.options.delay).toBe(420); // as the 8 lands and his cards start to turn
    expect(Number(ring.options.duration)).toBeGreaterThanOrEqual(600);
    for (const f of ring.frames) for (const k of Object.keys(f)) expect(['offset', 'easing', 'opacity', 'transform']).toContain(k);
    // The ochre landing flash is still there for the 8 itself.
    expect(calls.some((a) => a.el.getAttribute('data-flash-tone') === 'ochre')).toBe(true);

    // A plain points play draws no iris ring.
    cleanup();
    const t2 = await startLesson(2);
    calls = [];
    await playMove(t2);
    expect(calls.some((a) => a.el.getAttribute('data-flash-tone') === 'iris')).toBe(false);
  });

  it('reduced motion: no flash animation at all (the flight layer draws its static ring on his hand)', async () => {
    settings.reducedMotion = true;
    const table = await startLesson(5);
    calls = [];
    await playMove(table);
    expect(calls.some((a) => a.el.hasAttribute('data-flash'))).toBe(false);
    expect(qa('.flight-layer [data-part="ring"]').length).toBeGreaterThanOrEqual(2); // the 8's landing and his hand
  });
});

// Issue #93: Blake's 4 (4.1 -> 4.2) resolves at once, so it lands like any
// one-off, on the board: into the middle spot, then the scrap. Alice's
// counter at 4.2 reuses that landing: her 2 flies from her hand through the
// middle to the scrap as the rewind happens.
describe('the one-off and counter flights around 4.2', () => {
  /** Where a flight's last keyframe puts the clone's centre. */
  function endCentre(a: FakeAnimation): { x: number; y: number } {
    const el = a.el as HTMLElement;
    const box = { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
    const last = String(a.frames[a.frames.length - 1].transform);
    const [dx, dy] = [...last.matchAll(/(-?[\d.]+)px/g)].slice(0, 2).map((m) => Number(m[1]));
    return { x: box.x + box.w / 2 + dx, y: box.y + box.h / 2 + dy };
  }

  it("Blake's 4 ends on the scrap pile, with the board on show", async () => {
    const table = await startLesson(4);
    await playMove(table); // 4.1: the Ace
    await advance(SUCCESS_BEAT_MS);
    calls = [];
    await advance(BLAKE_THINK_MS); // he plays the 4; it resolves
    expect(table.step?.id).toBe('4.2');
    expect(table.curtain).toEqual({ kind: 'none' });
    expect(q('[data-testid="board"]')).not.toBeNull();
    expect(q('[data-testid="counter-prompt"]')).toBeNull();
    const scrap = q('[data-testid="scrap-pile"]')!.getBoundingClientRect();
    const flight = calls.find((a) => a.el.getAttribute('data-actor') === 'mover');
    expect(flight, 'his card flies').toBeDefined();
    const end = endCentre(flight!);
    expect(end.x).toBeCloseTo(scrap.x + scrap.width / 2, 1);
    expect(end.y).toBeCloseTo(scrap.y + scrap.height / 2, 1);
  });

  it('the counter: her 2 flies from her hand to the scrap', async () => {
    const table = await startLesson(4, '4.2');
    const env = table.envelope!;
    const counter = env.legalMoves.findIndex((m) => m.Kind === MoveKind.Counter);
    const handSlot = q(`[data-testid="hand-card-${env.legalMoves[counter].HandIndex}"]`)!.getBoundingClientRect();
    calls = [];
    await playMove(table);
    expect(table.phase).toBe('success');
    const scrap = q('[data-testid="scrap-pile"]')!.getBoundingClientRect();
    const flight = calls.find((a) => a.el.getAttribute('data-actor') === 'mover');
    expect(flight, 'her 2 flies').toBeDefined();
    const el = flight!.el as HTMLElement;
    expect(parseFloat(el.style.left)).toBeCloseTo(handSlot.x, 1);
    expect(parseFloat(el.style.top)).toBeCloseTo(handSlot.y, 1);
    const end = endCentre(flight!);
    expect(end.x).toBeCloseTo(scrap.x + scrap.width / 2, 1);
    expect(end.y).toBeCloseTo(scrap.y + scrap.height / 2, 1);
  });
});

// T14 review N1, N4: the overlay's entry hold for 4.2's demo (Blake's 4 crosses the middle spot it drags to).
describe('the 4.2 entry hold, from the overlay', () => {
  /** The coach's own clock and frames, run by hand (the table's beats stay on vi's timers). */
  function coachTime() {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const queue: (() => void)[] = [];
    const clock: CoachClock = {
      set: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
      clear: (h) => void timers.delete(h),
    };
    const frames: CoachFrames = { request: (fn) => (queue.push(fn), ++id), cancel: () => {} };
    return {
      clock,
      frames,
      async tick(ms: number) {
        now += ms;
        for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
          if (t.at > now) continue;
          timers.delete(k);
          t.fn();
        }
        await settle();
        while (queue.length) queue.shift()!();
        await settle();
      },
    };
  }
  const played = (name: string) => calls.filter((a) => a.el.getAttribute('data-part') === name);

  it("N1: the drag demo waits for Blake's 4 to land (ONEOFF_FLIGHT_MS + 250), not the usual 250 ms", async () => {
    const t = coachTime();
    const table = await startLesson(4, null, 0, t);
    await playMove(table);
    await advance(SUCCESS_BEAT_MS);
    await advance(BLAKE_THINK_MS);
    expect(table.step?.id).toBe('4.2');
    calls = [];
    await t.tick(0);
    expect(played('dot'), 'no demo while his card lands').toEqual([]);
    await t.tick(DEMO_ENTRY_MS);
    expect(played('dot'), 'not at the usual entry time').toEqual([]);
    await t.tick(ONEOFF_FLIGHT_MS + 250 - DEMO_ENTRY_MS);
    expect(played('dot').length).toBeGreaterThan(0);
  });

  it('N4: a restart from 4.2 does not carry the hold back to 4.1 (its drag demo shows at once)', async () => {
    const t = coachTime();
    const table = await startLesson(4, null, 0, t);
    await playMove(table);
    await advance(SUCCESS_BEAT_MS);
    await advance(BLAKE_THINK_MS);
    expect(table.step?.id).toBe('4.2');
    await t.tick(0);
    table.restart();
    await settle();
    expect(table.step?.id).toBe('4.1');
    calls = [];
    await t.tick(0);
    expect(played('dot').length, "4.1's drag demo plays on entry, unheld").toBeGreaterThan(0);
  });
});
