// @vitest-environment jsdom
// T11 L5 (docs/tutorial-plan.md §6 T11; design §11 L5, SPEC §5.9): no state
// path awaits an animation. `Element.prototype.animate` returns animations
// that NEVER finish (no `finished` promise ever settles, no `onfinish` ever
// fires), and the lessons must still run to the end through the mounted
// overlay, with every phase change landing exactly on the table's own timer.
// If anything in the gate, the beats or the coach waited on an animation, a
// lesson would stall or a beat would land late.
//
// Real GameScreen + CoachOverlay + TutorialTable (wasm, engine v0.2.1) built
// by a real TutorialStore, so the table's flight hooks reach the overlay.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import CoachOverlay from '../../src/lib/components/CoachOverlay.svelte';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import type { CoachClock, CoachFrames } from '../../src/lib/tutorial/coach.svelte';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { BLAKE_DONE_BEAT_MS, BLAKE_THINK_MS, SUCCESS_BEAT_MS, TutorialTable } from '../../src/lib/tutorial/table.svelte';
import { TutorialStore } from '../../src/lib/tutorial/tutorial.svelte';
import type { LessonId, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { driveLesson, expectedIndex } from './tutorial-driver';

let animateCalls = 0;
const never = new Promise<never>(() => {});
const proto = Element.prototype as unknown as { animate?: unknown; getBoundingClientRect: () => DOMRect };
let originalAnimate: unknown;
let originalRect: () => DOMRect;
const boxes = new WeakMap<Element, number>();
let nextBox = 0;

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

async function mountLesson(id: LessonId): Promise<TutorialTable> {
  store.start(id);
  const table = store.table!;
  host = document.createElement('div');
  document.body.append(host);
  screen = mount(GameScreen, { target: host, props: { source: table } });
  overlay = mount(CoachOverlay, { target: host, props: { table, store, clock: idleClock, frames: idleFrames } });
  await settle();
  return table;
}

function cleanup(): void {
  if (overlay) unmount(overlay);
  if (screen) unmount(screen);
  host?.remove();
  overlay = screen = host = undefined;
}

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  settings.tableMode = false;
  settings.reducedMotion = false;
  animateCalls = 0;
  originalAnimate = proto.animate;
  originalRect = proto.getBoundingClientRect;
  // Animations that never finish: no `finished`, no `onfinish`, and finish() does nothing.
  proto.animate = function () {
    animateCalls++;
    return { finished: never, onfinish: null, effect: null, playState: 'running', cancel: () => {}, finish: () => {} };
  };
  proto.getBoundingClientRect = function (this: Element) {
    let k = boxes.get(this);
    if (k === undefined) boxes.set(this, (k = nextBox++));
    const x = 8 + ((k * 37) % 300);
    const y = 40 + ((k * 53) % 700);
    return { x, y, width: 60, height: 78, top: y, left: x, right: x + 60, bottom: y + 78, toJSON: () => ({}) } as DOMRect;
  };
  store = new TutorialStore({
    storage: { getItem: () => null, setItem: () => {} },
    createTable: (lesson, deps) => new TutorialTable(lesson, deps),
    learnerName: () => 'Alice',
    reducedMotion: () => false,
  });
});

afterEach(() => {
  cleanup();
  store.exitHome();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  if (originalAnimate === undefined) delete proto.animate;
  else proto.animate = originalAnimate;
  proto.getBoundingClientRect = originalRect;
});

const ALL: LessonId[] = [1, 2, 3, 4, 5];

describe('L5: no state path awaits an animation', () => {
  for (const id of ALL) {
    it(`lesson ${id} finishes through the driver with the overlay mounted`, async () => {
      const table = await mountLesson(id);
      const result = driveLesson(table, { wrongFirst: 2, seed: id });
      await settle();
      expect(table.phase).toBe('finished');
      expect(result.steps).toEqual(LESSONS.find((l) => l.id === id)!.steps.map((s) => s.id));
      expect(host!.querySelector('[data-testid="coach-lesson-done"]')).not.toBeNull();
      expect(animateCalls, 'the motion actually ran').toBeGreaterThan(0);
    });
  }

  for (const id of ALL) {
    it(`lesson ${id}: every phase change lands on its timer, to the millisecond`, async () => {
      const table = await mountLesson(id);
      for (let guard = 0; guard < 20 && table.phase === 'step'; guard++) {
        const step = table.step!;
        if (step.kind === 'next') {
          table.next();
          await settle();
          continue;
        }
        if (step.kind === 'appear') {
          table.appeared(step.testId);
          await settle();
          continue;
        }
        const before = animateCalls;
        void table.apply(expectedIndex(table));
        await settle(); // the flight starts (after a tick), and must not hold anything up
        expect(animateCalls, `step ${step.id}: a flight played`).toBeGreaterThan(before);
        expect(table.phase).toBe('success');

        await tickTo(SUCCESS_BEAT_MS);
        const replies = (step as MoveStep).blake;
        for (let k = 0; k < replies.length; k++) {
          expect(table.phase, `step ${step.id} reply ${k}: thinking`).toBe('blake');
          expect(table.pending).toBe(true);
          const seq = table.seq;
          await tickTo(BLAKE_THINK_MS);
          expect(table.seq, `step ${step.id} reply ${k}: his move`).toBe(seq + 1);
          if (replies[k].done !== undefined) {
            expect(table.line.text).toBe(replies[k].done);
            await tickTo(BLAKE_DONE_BEAT_MS);
          }
        }
        expect(['step', 'finished']).toContain(table.phase);
        expect(table.pending).toBe(false);
      }
      expect(table.phase).toBe('finished');
    });
  }
});

/**
 * Advances to 1 ms before `ms` (nothing may change yet), then the last 1 ms
 * (the change must happen now). Microtasks run at each stop.
 */
async function tickTo(ms: number): Promise<void> {
  const table = store.table!;
  const phase = table.phase;
  const seq = table.seq;
  const line = table.line.text;
  vi.advanceTimersByTime(ms - 1);
  await settle();
  expect(table.phase, `still ${phase} at ${ms - 1} ms`).toBe(phase);
  expect(table.seq).toBe(seq);
  expect(table.line.text).toBe(line);
  vi.advanceTimersByTime(1);
  await settle();
  expect(table.phase !== phase || table.seq !== seq || table.line.text !== line, `a change at ${ms} ms`).toBe(true);
}
