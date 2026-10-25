// @vitest-environment jsdom
// T9 CoachOverlay (docs/tutorial-plan.md T9, §3 review focus 1 and 4;
// docs/tutorial-design.md §5.5.1, §7, §9, §10). The composed overlay on top of
// the REAL GameScreen, on the REAL wasm bridge (engine v0.2.1), with the REAL
// TutorialTable built by a real TutorialStore (memory storage).
//
// Ledger: R25.3 (S3b through the overlay, S3c in the DOM, S4 "an enabled
// control leads forward"), R25.5 ("written when the done sheet appears"),
// R25.7 and R25.10 (unit), plan §3 review focus 1 (the fade rule) and 4
// (table mode never turns the tutorial).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import type { BridgeResult, Envelope, Move } from '../../src/lib/bridge/schema';
import { apply as bridgeApply, legalMoves, restore, snapshot, view } from '../../src/lib/bridge/engine';
import CoachOverlay from '../../src/lib/components/CoachOverlay.svelte';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { testIdForKey } from '../../src/lib/dragDrop';
import { MoveKind } from '../../src/lib/enums';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import type { CoachClock, CoachFrames } from '../../src/lib/tutorial/coach.svelte';
import { CANCEL_SUFFIX, LESSONS, NEXT_FIRST, SNAG_LINE } from '../../src/lib/tutorial/lessons';
import { nudgeFor } from '../../src/lib/tutorial/match';
import { TUTORIAL_KEY } from '../../src/lib/tutorial/progress';
import { BLAKE_THINK_MS, SUCCESS_BEAT_MS, TutorialTable, type TutorialEngine } from '../../src/lib/tutorial/table.svelte';
import { TutorialStore } from '../../src/lib/tutorial/tutorial.svelte';
import type { Lesson, LessonId, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { expectedIndex, mulberry32, walkTo, wrongIndices } from './tutorial-driver';

const here = path.dirname(fileURLToPath(import.meta.url));

function lessonOf(id: LessonId): Lesson {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} missing`);
  return l;
}

// The controller's own timers stay out of the fake clock the table's beats run on.
const idleClock: CoachClock = { set: () => 0, clear: () => {} };
const idleFrames: CoachFrames = { request: () => 0, cancel: () => {} };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

// ---------------------------------------------------------------------------
// The mounted lesson: GameScreen and CoachOverlay as siblings, as App has them
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let screen: ReturnType<typeof mount> | undefined;
let overlay: ReturnType<typeof mount> | undefined;
let storage: ReturnType<typeof memoryStorage>;
let store: TutorialStore<TutorialTable>;

function newStore(): TutorialStore<TutorialTable> {
  storage = memoryStorage();
  return new TutorialStore({
    storage,
    createTable: (lesson, deps) => new TutorialTable(lesson, deps),
    learnerName: () => 'Alice',
    reducedMotion: () => false,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
  }
  flushSync();
}

async function mountLesson(table: TutorialTable, props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  screen = mount(GameScreen, { target: host, props: { source: table } });
  overlay = mount(CoachOverlay, { target: host, props: { table, store, clock: idleClock, frames: idleFrames, ...props } });
  await settle();
}

function cleanup(): void {
  if (overlay) unmount(overlay);
  if (screen) unmount(screen);
  host?.remove();
  overlay = undefined;
  screen = undefined;
  host = undefined;
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

function bubble(): HTMLElement {
  const el = q('coach-bubble');
  if (!el) throw new Error('no coach bubble');
  return el;
}

/** The line itself; the live region around it also holds the win headline (T12b). */
function copy(): string {
  return bubble().querySelector('[aria-live] .coach__copy')?.textContent?.trim() ?? '';
}

function overlayRoot(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('[data-coach-overlay]');
  if (!el) throw new Error('no overlay root');
  return el;
}

function targets(): string[] {
  const raw = overlayRoot().getAttribute('data-coach-targets') ?? '';
  return raw === '' ? [] : raw.split(' ');
}

/** Stages legal move `i` by taps (the T6 walk). */
async function stage(env: Envelope, i: number): Promise<void> {
  const m: Move = env.legalMoves[i];
  if (m.Kind === MoveKind.DiscardPair) {
    await click(`hand-card-${m.DiscardA}`);
    return click(`hand-card-${m.DiscardB}`);
  }
  if (m.Kind === MoveKind.Draw) return click('deck-pile');
  await click(`hand-card-${m.HandIndex}`);
  const key = boardTargetKey(m);
  if (key === null) throw new Error('a hand move with no board key');
  await click(testIdForKey(key));
  if (q('ambiguity-chooser')) await click(`ambiguity-chooser-option-${i}`);
}

/** Plays the step's expected move through the page (a Draw commits on the deck's second tap). */
async function playExpected(table: TutorialTable, pick = 0): Promise<void> {
  const env = table.envelope!;
  const i = expectedIndex(table, pick);
  await stage(env, i);
  if (env.legalMoves[i].Kind === MoveKind.Draw) await click('deck-pile');
  else await click('staging-confirm');
}

async function runBeats(table: TutorialTable): Promise<void> {
  for (let n = 0; n < 50 && (table.phase === 'success' || table.phase === 'blake'); n++) {
    vi.advanceTimersToNextTimer();
    await settle();
  }
}

let errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  settings.revealPreference = 'two-step';
  settings.tableMode = false;
  settings.reducedMotion = false;
  store = newStore();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  store.exitHome();
  vi.useRealTimers();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

function startAt(id: LessonId, stepId: string | null, pick = 0): TutorialTable {
  store.start(id);
  const table = store.table!;
  if (stepId !== null) walkTo(table, stepId, { pick });
  return table;
}

// ---------------------------------------------------------------------------
// S3b: the coach follows staging, every board move step, every legal move
// ---------------------------------------------------------------------------

const BOARD_STEPS: [LessonId, string][] = [
  [1, '1.5'],
  [2, '2.1'],
  [2, '2.2'],
  [3, '3.1'],
  [3, '3.2'],
  [4, '4.1'],
  [4, '4.2'],
  [5, '5.1'],
  [5, '5.2'],
  [5, '5.4'],
];

describe('S3b: the coach follows staging (R25.3)', () => {
  for (const [id, stepId] of BOARD_STEPS) {
    it(`step ${stepId}: staged-right exactly for the expected setup, staged-wrong for every other, refused at a wrong Confirm`, async () => {
      const table = startAt(id, stepId);
      await mountLesson(table);
      const step = table.step as MoveStep;
      const env = table.envelope!;
      const right = new Set<number>();
      for (let k = 0; k < 2; k++) right.add(expectedIndex(table, k));

      expect(bubble().dataset.step).toBe(stepId);
      expect(bubble().dataset.stage).toBe('idle');
      expect(copy()).toBe(step.main);

      let wrongEntries = 0;
      for (let i = 0; i < env.legalMoves.length; i++) {
        const m = env.legalMoves[i];
        const label = `${stepId} move ${i} "${env.descriptions[i]}"`;
        if (m.Kind === MoveKind.Pass || m.Kind === MoveKind.Decline) continue;
        await stage(env, i);
        if (right.has(i)) {
          expect(bubble().dataset.stage, label).toBe('staged-right');
          expect(copy(), label).toBe(step.staged);
          expect(targets(), label).toEqual(['staging-confirm']);
        } else {
          wrongEntries++;
          expect(bubble().dataset.stage, label).toBe('staged-wrong');
          expect(bubble().dataset.tone, label).toBe('nudge');
          // Every lesson slot holds one move (T6: no chooser group), so the
          // line is that move's nudge.
          expect(copy(), label).toBe(nudgeFor(m, step, env.state) + CANCEL_SUFFIX);
          expect(bubble().textContent, label).not.toContain('Confirm');
          expect(targets(), label).toEqual(['staging-cancel']);
        }
        await click('staging-cancel');
        expect(bubble().dataset.stage, `${label}: after Cancel`).toBe('idle');
        expect(copy(), `${label}: after Cancel`).toBe(wrongEntries >= 2 ? step.tapRoute : step.main);
      }
      expect(table.wrongTries).toBe(wrongEntries);

      // A wrong Confirm: refused, the bare nudge (no Cancel sentence).
      const wrong = wrongIndices(table).find((i) => {
        const k = env.legalMoves[i].Kind;
        return k !== MoveKind.Pass && k !== MoveKind.Decline;
      });
      if (wrong !== undefined) {
        await stage(env, wrong);
        const staged = copy();
        expect(staged.endsWith(CANCEL_SUFFIX.trim())).toBe(true);
        if (env.legalMoves[wrong].Kind === MoveKind.Draw) await click('deck-pile');
        else await click('staging-confirm');
        expect(bubble().dataset.stage).toBe('refused');
        expect(copy()).toBe(staged.slice(0, staged.length - CANCEL_SUFFIX.length));
        expect(copy()).not.toContain('Cancel');
      }

      // The expected move still completes the step.
      await playExpected(table);
      expect(bubble().dataset.stage).toBe('done');
      expect(copy()).toBe(step.success);
      // T12b: the win is announced exactly once, by the headline in the live region.
      const live = bubble().querySelector('[aria-live]')?.textContent ?? '';
      expect(live.match(/You win!/g)?.length ?? 0).toBe(stepId === '1.5' || stepId === '5.4' ? 1 : 0);
    });
  }
});

describe('S3b: a staged-wrong line is the step nudge for that setup', () => {
  it('1.5: the 9 on his 10 gets its own line, anything else the generic', async () => {
    const table = startAt(1, '1.5');
    await mountLesson(table);
    const step = table.step as MoveStep;
    const env = table.envelope!;
    const nineOnTen = env.legalMoves.findIndex((m) => m.Kind === MoveKind.OneOff && m.Card?.Rank === 9);
    await stage(env, nineOnTen);
    expect(copy()).toBe(step.nudges[0].text + CANCEL_SUFFIX);
    await click('staging-cancel');
    const four = env.legalMoves.findIndex((m) => m.Kind === MoveKind.PlayPoint && m.Card?.Rank === 4);
    await stage(env, four);
    expect(copy()).toBe(step.generic + CANCEL_SUFFIX);
  });
});

// ---------------------------------------------------------------------------
// S3c: step 4.2 in the DOM
// ---------------------------------------------------------------------------

describe('S3c: step 4.2 in the DOM (design §5.5.1, issue #93)', () => {
  it('on the board at curtain none; a discard is refused with the nudge and the board stays live; the 2 on the marker finishes', async () => {
    const table = startAt(4, '4.2');
    await mountLesson(table);
    const step = table.step as MoveStep;
    expect(table.curtain).toEqual({ kind: 'none' });
    const board = q('board');
    expect(board).not.toBeNull();
    expect(q('counter-prompt')).toBeNull();
    expect(q('discard-picker')).not.toBeNull();
    expect(bubble().dataset.stage).toBe('idle');
    expect(copy()).toBe(step.main);
    const two = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 2);
    expect(targets()).toEqual([`hand-card-${two}`]);

    // The wrong move: pay the discard. Refused, nothing applied.
    const discard = table.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.DiscardPair);
    await stage(table.envelope!, discard);
    expect(bubble().dataset.stage).toBe('staged-wrong');
    await click('staging-confirm');
    expect(table.refusals).toBe(1);
    expect(bubble().dataset.stage).toBe('refused');
    expect(copy()).toBe(step.nudges[0].text);
    expect(q('board')).toBe(board);
    expect(q('staging-confirm')).toBeNull();
    expect(table.envelope!.state.you.hand).toHaveLength(2);
    for (const i of [0, 1]) expect(enabled(q(`hand-card-${i}`)), `hand-card-${i}`).toBe(true);
    expect(enabled(q('coach-show-me'))).toBe(true);

    // The tap route: the 2, the marker, Confirm.
    await click(`hand-card-${two}`);
    expect(bubble().dataset.stage).toBe('selected');
    expect(copy()).toBe(step.tapRoute); // staged-wrong plus the refusal: two tries (§7.4)
    expect(targets()).toEqual([`hand-card-${two}`, 'counter-link']);
    await click('counter-link');
    expect(bubble().dataset.stage).toBe('staged-right');
    expect(copy()).toBe(step.staged);
    expect(targets()).toEqual(['staging-confirm']);

    await click('staging-confirm');
    expect(bubble().dataset.stage).toBe('done');
    expect(copy()).toBe(step.success);
    expect(q('board')).not.toBeNull();
    expect(q('discard-picker')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S4: always a way forward
// ---------------------------------------------------------------------------

function enabled(el: HTMLElement | null): boolean {
  if (!el) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('data-disabled') === 'true') return false;
  return el.closest('[data-inert="true"], [inert]') === null;
}

function expectWayForward(table: TutorialTable, label: string): void {
  expect(table.phase, label).toBe('step');
  expect(overlayRoot().getAttribute('data-covered'), label).toBe('false');
  for (const id of ['coach-leave', 'menu-button']) expect(enabled(q(id)), `${label}: ${id}`).toBe(true);
  const step = table.step!;
  // T14 M4: Show me is there exactly when the step has a demo to show.
  const stage = bubble().dataset.stage ?? '';
  const demo = step.kind === 'move' && step.demo.kind !== 'none' && ['idle', 'selected', 'refused'].includes(stage);
  if (demo) expect(enabled(q('coach-show-me')), `${label}: Show me`).toBe(true);
  else expect(q('coach-show-me'), `${label}: no Show me without a demo`).toBeNull();
  if (step.kind === 'next') {
    expect(enabled(q('coach-next')), `${label}: Next`).toBe(true);
    return;
  }
  if (step.kind === 'appear') {
    const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
    expect(enabled(q(`hand-card-${jack}`)), `${label}: the Jack`).toBe(true);
    return;
  }
  if (q('staging-confirm')) {
    expect(enabled(q('staging-cancel')), `${label}: Cancel`).toBe(true);
    return;
  }
  const m = table.envelope!.legalMoves[expectedIndex(table)];
  const id = m.Kind === MoveKind.Draw ? 'deck-pile' : `hand-card-${m.HandIndex}`;
  expect(enabled(q(id)), `${label}: ${id}`).toBe(true);
}

/** One random exploring or wrong action at the current step. */
async function randomAction(table: TutorialTable, rand: () => number): Promise<string> {
  const env = table.envelope!;
  const pickOf = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const step = table.step!;
  const legal = (step.kind === 'move' ? wrongIndices(table) : env.legalMoves.map((_, i) => i)).filter((i) => {
    const k = env.legalMoves[i].Kind;
    return k !== MoveKind.Pass && k !== MoveKind.Decline;
  });
  const r = rand();
  if (r < 0.2) {
    const hand = env.state.you.hand.length;
    const card = Math.floor(rand() * hand);
    await click(`hand-card-${card}`);
    if (q('card-detail-popover')) await click('card-detail-popover-close');
    if (step.kind === 'appear') return 'tap a card';
    // At an owed discard (4.2) a tap is a pick; tapping it again drops it.
    if (q('discard-picker')) {
      await click(`hand-card-${card}`);
      return 'pick a card, unpick it';
    }
    // tap it again or another: either way, drop the selection
    const board = q('board');
    board?.click();
    await settle();
    return 'select a card';
  }
  if (legal.length === 0) return 'nothing';
  const i = pickOf(legal);
  await stage(env, i);
  if (r < 0.6) {
    await click('staging-cancel');
    return `stage ${i}, Cancel`;
  }
  if (env.legalMoves[i].Kind === MoveKind.Draw) await click('deck-pile');
  else await click('staging-confirm');
  return `stage ${i}, Confirm`;
}

describe('S4: always a way forward (R25.3)', () => {
  for (const seed of [1, 2, 3]) {
    for (const id of [1, 2, 3, 4, 5] as const) {
      it(`lesson ${id}, seed ${seed}: after every action an enabled control leads forward`, async () => {
        const rand = mulberry32(seed * 100 + id);
        const table = startAt(id, null);
        await mountLesson(table);
        for (let guard = 0; guard < 20 && table.phase === 'step'; guard++) {
          const step = table.step!;
          expectWayForward(table, `${step.id} on arrival`);
          const n = Math.floor(rand() * 4);
          for (let k = 0; k < n; k++) {
            const what = await randomAction(table, rand);
            if (table.step?.id !== step.id) break; // 5.3 completes on a tap
            expectWayForward(table, `${step.id} after "${what}"`);
          }
          if (table.step?.id !== step.id || table.phase !== 'step') {
            await runBeats(table);
            continue;
          }
          if (step.kind === 'next') {
            if (table.line.tone === 'nudge') expect(copy()).toBe(NEXT_FIRST);
            await click('coach-next');
          } else if (step.kind === 'appear') {
            const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
            await click(`hand-card-${jack}`);
            await click('card-detail-popover-close');
          } else {
            await playExpected(table, Math.floor(rand() * 2));
          }
          await runBeats(table);
        }
        expect(table.phase).toBe('finished');
        expect(q('coach-lesson-done')).not.toBeNull();
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Review focus 1: the fade rule
// ---------------------------------------------------------------------------

function expectFaded(faded: boolean, label: string): void {
  const style = getComputedStyle(overlayRoot());
  expect(overlayRoot().getAttribute('data-covered'), label).toBe(faded ? 'true' : 'false');
  if (faded) {
    expect(style.opacity, label).toBe('0');
    expect(style.pointerEvents, label).toBe('none');
  } else {
    expect(style.pointerEvents, label).not.toBe('none');
  }
}

describe('review focus 1: the overlay fades for every sheet, and their controls take clicks', () => {
  it('menu, Rules, menu Home', async () => {
    const onHome = vi.fn();
    const table = new TutorialTable(lessonOf(1), { learnerName: 'Alice', reducedMotion: () => false, onHome });
    walkTo(table, '1.5');
    await mountLesson(table);
    expectFaded(false, 'at rest');
    await click('menu-button');
    expectFaded(true, 'menu open');
    await click('menu-rules');
    expect(q('rules-sheet')).not.toBeNull();
    expectFaded(true, 'rules open');
    await click('rules-close');
    expect(q('rules-sheet')).toBeNull();
    expectFaded(true, 'back to the menu');
    await click('menu-home');
    expect(onHome).toHaveBeenCalledTimes(1);
    expectFaded(false, 'menu closed');
  });

  it('the scrap browser', async () => {
    const table = startAt(1, '1.5');
    await mountLesson(table);
    await click('scrap-pile');
    expect(q('scrap-browser')).not.toBeNull();
    expectFaded(true, 'scrap browser open');
    await click('scrap-browser-close');
    expect(q('scrap-browser')).toBeNull();
    expectFaded(false, 'scrap browser closed');
  });

  it('the card popover (5.3 completes first, then the coach waits for it to close)', async () => {
    const table = startAt(5, '5.3');
    await mountLesson(table);
    const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
    await click(`hand-card-${jack}`);
    expect(q('card-detail-popover')).not.toBeNull();
    expect(table.step?.id).toBe('5.4');
    expectFaded(true, 'popover open');
    await click('card-detail-popover-close');
    expect(q('card-detail-popover')).toBeNull();
    expectFaded(false, 'popover closed');
    expect(bubble().dataset.step).toBe('5.4');
  });

  it('the ambiguity chooser', async () => {
    const table = startAt(1, '1.5');
    await mountLesson(table);
    const chooser = document.createElement('div');
    chooser.setAttribute('data-testid', 'ambiguity-chooser');
    q('game-screen')!.append(chooser);
    await settle();
    expectFaded(true, 'chooser open');
    chooser.remove();
    await settle();
    expectFaded(false, 'chooser closed');
  });
});

// ---------------------------------------------------------------------------
// Review focus 4: table mode never turns the tutorial
// ---------------------------------------------------------------------------

describe('review focus 4: table mode on', () => {
  it('data-table-rotated is "false" at every step of lesson 4, the owed discard included', async () => {
    settings.tableMode = true;
    const table = startAt(4, null);
    await mountLesson(table);
    const seen: string[] = [];
    const check = (label: string) => {
      expect(q('game-screen')!.getAttribute('data-table-rotated'), label).toBe('false');
      seen.push(label);
    };
    for (let guard = 0; guard < 10 && table.phase === 'step'; guard++) {
      check(`${table.step!.id}${q('discard-picker') ? ' (owed discard)' : ''}`);
      await playExpected(table);
      check(`${table.step?.id} success`);
      const inBeat = (): boolean => (table.phase as string) === 'success' || (table.phase as string) === 'blake';
      for (let n = 0; n < 50 && inBeat(); n++) {
        vi.advanceTimersToNextTimer();
        await settle();
        check(`${table.step?.id} ${table.phase}`);
      }
    }
    expect(seen).toContain('4.2 (owed discard)');
    expect(table.phase).toBe('finished');
  });
});

// ---------------------------------------------------------------------------
// R25.5: progress is written when the done sheet appears
// ---------------------------------------------------------------------------

function tutorialWrites(): number {
  return storage.setItem.mock.calls.filter(([key]) => key === TUTORIAL_KEY).length;
}

describe('R25.5: cuttle-web:tutorial is written when the done sheet mounts, not before', () => {
  it('lesson 1: not at the winning move, then at the sheet', async () => {
    const table = startAt(1, '1.5');
    await mountLesson(table);
    await playExpected(table);
    expect(table.phase).toBe('success');
    expect(q('coach-lesson-done')).toBeNull();
    expect(tutorialWrites()).toBe(0);
    expect(store.done).toEqual([]);
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    await settle();
    expect(q('coach-lesson-done')).not.toBeNull();
    expect(tutorialWrites()).toBe(1);
    expect(storage.data.get(TUTORIAL_KEY)).toBe('{"v":1,"done":[1]}');
    expect(storage.setItem.mock.calls.every(([key]) => key === TUTORIAL_KEY)).toBe(true);
  });

  it('lesson 2 ends on Next (P6): the sheet mounts and writes', async () => {
    const table = startAt(2, '2.3');
    await mountLesson(table);
    expect(tutorialWrites()).toBe(0);
    await click('coach-next');
    expect(q('coach-lesson-done')).not.toBeNull();
    expect(tutorialWrites()).toBe(1);
    expect(storage.data.get(TUTORIAL_KEY)).toBe('{"v":1,"done":[2]}');
    expect(q('coach-lesson-done')!.textContent).toContain('Lesson 2 done');
  });
});

// ---------------------------------------------------------------------------
// The bubble's and the sheet's controls
// ---------------------------------------------------------------------------

describe('controls', () => {
  it('Leave → leave(); Next → table.next(); Show me replays the demo', async () => {
    const table = startAt(1, null);
    const leave = vi.spyOn(store, 'leave');
    await mountLesson(table);
    expect(bubble().dataset.stage).toBe('next');
    await click('coach-next');
    expect(table.step?.id).toBe('1.2');
    expect(bubble().dataset.step).toBe('1.2');
    await click('coach-leave');
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('Show me plays the demo again', async () => {
    const animate = vi.fn(() => ({ cancel: () => {} }) as unknown as Animation);
    const original = Element.prototype.animate;
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    try {
      const table = startAt(1, '1.5');
      const frameQueue: (() => void)[] = [];
      await mountLesson(table, {
        frames: { request: (fn: () => void) => frameQueue.push(fn), cancel: () => {} } satisfies CoachFrames,
      });
      while (frameQueue.length) frameQueue.shift()!();
      await settle();
      const before = animate.mock.calls.length;
      await click('coach-show-me');
      expect(animate.mock.calls.length).toBeGreaterThan(before);
    } finally {
      Element.prototype.animate = original;
    }
  });

  it('the done sheet: Next lesson, Lessons, and Play a game after lesson 5', async () => {
    const t2 = startAt(2, '2.3');
    const next = vi.spyOn(store, 'nextLesson');
    const leave = vi.spyOn(store, 'leave');
    const exitHome = vi.spyOn(store, 'exitHome');
    await mountLesson(t2);
    await click('coach-next');
    expect(q('coach-play')).toBeNull();
    await click('coach-lessons');
    expect(leave).toHaveBeenCalledTimes(1);
    q('coach-next-lesson')!.click();
    expect(next).toHaveBeenCalledTimes(1);
    cleanup();

    const t5 = startAt(5, '5.4');
    await mountLesson(t5);
    await playExpected(t5);
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    await settle();
    expect(q('coach-lesson-done')!.textContent).toContain("You've learned Cuttle");
    expect(q('coach-next-lesson')).toBeNull();
    await click('coach-play');
    expect(exitHome).toHaveBeenCalled();
  });

  it('Escape on the done sheet means Lessons', async () => {
    const table = startAt(2, '2.3');
    const leave = vi.spyOn(store, 'leave');
    await mountLesson(table);
    await click('coach-next');
    const heading = q('coach-lesson-done')!.querySelector('h2')!;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    heading.dispatchEvent(event);
    await settle();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('errors are never a dead end', () => {
  it('a snag shows Restart lesson and Leave, the board takes no tap, and Restart goes back to step 0', async () => {
    let failApply = false;
    const engine: TutorialEngine = {
      restore,
      view,
      legalMoves,
      snapshot,
      apply: (i: number): BridgeResult =>
        failApply ? { ok: false, code: 'ILLEGAL_MOVE', message: 'forced for the test' } : bridgeApply(i),
    };
    const onHome = vi.fn();
    const table = new TutorialTable(lessonOf(2), { learnerName: 'Alice', reducedMotion: () => false, onHome, engine });
    const leave = vi.spyOn(store, 'leave');
    const frameQueue: (() => void)[] = [];
    const runFrames = () => {
      while (frameQueue.length) frameQueue.shift()!();
    };
    await mountLesson(table, {
      frames: { request: (fn: () => void) => frameQueue.push(fn), cancel: () => {} } satisfies CoachFrames,
    });
    failApply = true;
    await playExpected(table);
    failApply = false;
    expect(table.phase).toBe('error');
    expect(bubble().dataset.stage).toBe('error');
    expect(copy()).toBe(SNAG_LINE);
    expect(q('coach-restart')).not.toBeNull();
    expect(q('coach-leave')).not.toBeNull();
    expect(q('coach-show-me')).toBeNull();
    // The board is behind a blocker; the menu is still reachable.
    const block = host!.querySelector<HTMLElement>('[data-coach-block]');
    expect(block).not.toBeNull();
    expect(getComputedStyle(block!).pointerEvents).not.toBe('none');
    expect(enabled(q('menu-button'))).toBe(true);
    // The blocker starts under the score bar, so the menu row stays reachable.
    const scoreBar = q('score-bar')!;
    const rect = vi.spyOn(scoreBar, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 393, height: 44, top: 0, left: 0, right: 393, bottom: 44, toJSON: () => ({}),
    } as DOMRect);
    q('game-screen')!.setAttribute('data-poke', '1');
    await settle();
    runFrames();
    await settle();
    expect(host!.querySelector<HTMLElement>('[data-coach-block]')!.style.top).toBe('44px');
    rect.mockRestore();
    // The menu works in the error phase: Home goes home.
    await click('menu-button');
    expect(q('menu-home')).not.toBeNull();
    await click('menu-close');
    await click('coach-restart');
    expect(table.phase).toBe('step');
    expect(table.stepIndex).toBe(0);
    expect(bubble().dataset.stage).toBe('idle');
    expect(host!.querySelector('[data-coach-block]')).toBeNull();
    await click('coach-leave');
    expect(leave).toHaveBeenCalledTimes(1);
    await click('menu-button');
    await click('menu-home');
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

describe('Leave and the menu button act on their first tap during a beat (review B1)', () => {
  it('a pointerdown on Leave or the menu button during the success and narration beats does not skip; the click then acts', async () => {
    const table = startAt(2, null);
    const leave = vi.spyOn(store, 'leave');
    await mountLesson(table);
    await playExpected(table);
    expect(table.phase).toBe('success');
    // T14 M4: a beat has no demo, so no Show me; its slot is not a control.
    expect(q('coach-show-me')).toBeNull();
    const snapshot = () => [table.phase, table.stepIndex, bubble().dataset.step, bubble().dataset.stage, copy()];
    for (const id of ['coach-leave', 'menu-button']) {
      const before = snapshot();
      q(id)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(snapshot(), `success beat: ${id}`).toEqual(before);
    }
    await click('menu-button');
    expect(table.phase).toBe('success');
    await click('menu-close');
    expect(table.phase).toBe('success');
    expect(leave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    await settle();
    expect(copy()).toBe('Blake played a 6. He has 10.');
    const before = snapshot();
    q('coach-leave')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(snapshot(), 'narration beat: Leave').toEqual(before);
    await click('coach-leave');
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Accessibility (design §9, R25.10 unit)
// ---------------------------------------------------------------------------

describe('a11y (design §9)', () => {
  it('the copy is a polite live region and takes focus at lesson start; the overlay layers are aria-hidden', async () => {
    const table = startAt(1, null);
    await mountLesson(table);
    const live = bubble().querySelector('[aria-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(live);
    expect(host!.querySelector('.coach-spotlight')!.getAttribute('aria-hidden')).toBe('true');
    expect(host!.querySelector('.ghost-demo')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('Next takes focus on a next step only after key input', async () => {
    // Pointer: 2.2 drawn by taps, then 2.3 arrives.
    let table = startAt(2, '2.2');
    await mountLesson(table);
    window.dispatchEvent(new Event('pointerdown'));
    await playExpected(table);
    await runBeats(table);
    expect(table.step?.id).toBe('2.3');
    await settle();
    expect(document.activeElement).not.toBe(q('coach-next'));
    cleanup();
    store.exitHome();

    // Key: the same, with a key as the last input.
    table = startAt(2, '2.2');
    await mountLesson(table);
    await playExpected(table);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await runBeats(table);
    expect(table.step?.id).toBe('2.3');
    await settle();
    expect(document.activeElement).toBe(q('coach-next'));
  });

  it("the done sheet's heading takes focus", async () => {
    const table = startAt(2, '2.3');
    await mountLesson(table);
    await click('coach-next');
    expect(document.activeElement).toBe(q('coach-lesson-done')!.querySelector('h2'));
  });
});

// ---------------------------------------------------------------------------
// Layers and the FlightLayer slot (T11 fills it)
// ---------------------------------------------------------------------------

describe('layers (design §7.1)', () => {
  it('scrim < flights < ghost demo < bubble < done sheet, in DOM order', async () => {
    const table = startAt(2, '2.3');
    const flights = createRawSnippet(() => ({ render: () => '<div data-flight-slot aria-hidden="true"></div>' }));
    await mountLesson(table, { flights });
    await click('coach-next');
    const order = [
      host!.querySelector('.coach-spotlight'),
      host!.querySelector('[data-flight-slot]'),
      host!.querySelector('.ghost-demo'),
      bubble(),
      q('coach-lesson-done'),
    ];
    for (const el of order) expect(el).not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `layer ${i}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// No store reads (S3b: the coach reads only page state)
// ---------------------------------------------------------------------------

describe('no store reads', () => {
  it('coach.svelte.ts and CoachOverlay.svelte import nothing from the staging store', () => {
    for (const file of ['../../src/lib/tutorial/coach.svelte.ts', '../../src/lib/components/CoachOverlay.svelte']) {
      const src = readFileSync(path.resolve(here, file), 'utf8');
      const imports = src.split('\n').filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line));
      expect(imports.length, file).toBeGreaterThan(0);
      for (const line of imports) expect(line, file).not.toMatch(/staging/i);
      expect(src, file).not.toMatch(/StagingStore/);
    }
  });
});

describe('the bubble copy is not a control: taps and Enter/Space on it skip a beat (review round 2)', () => {
  for (const input of ['pointerdown', 'Enter', 'Space'] as const) {
    it(`${input} on the copy skips the success and narration beats, never the think pause; Tab and Escape never skip`, async () => {
      const table = startAt(2, null);
      await mountLesson(table);
      // The copy is the focus target at lesson start, so it is a keyboard player's Enter target.
      const live = () => bubble().querySelector<HTMLElement>('[aria-live]')!;
      const press = (k: string) => live().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const act = () =>
        input === 'pointerdown' ? live().dispatchEvent(new Event('pointerdown', { bubbles: true })) : press(input === 'Enter' ? 'Enter' : ' ');

      await playExpected(table);
      expect(table.phase).toBe('success');
      for (const k of ['Tab', 'Escape']) {
        press(k);
        await settle();
        expect(table.phase, `${k} during the success beat`).toBe('success');
      }

      act();
      await settle();
      expect(table.phase, 'the success beat is skipped').toBe('blake');
      expect(copy()).toBe("Blake's turn.");

      act();
      await settle();
      expect(copy(), 'the think pause ignores it').toBe("Blake's turn.");

      vi.advanceTimersByTime(700);
      await settle();
      expect(copy()).toBe('Blake played a 6. He has 10.');
      act();
      await settle();
      expect(table.phase, 'the narration beat is skipped').toBe('step');
      expect(table.step?.id).toBe('2.2');
    });
  }
});

// ---------------------------------------------------------------------------
// T12b: rings keyed by target; one definition of the coach's own controls
// ---------------------------------------------------------------------------

describe('T12b wiring', () => {
  it('each spotlight ring is keyed by the target it rings', async () => {
    // 2.1: one hole at rest (1.5 lights two from the start, T14), two once selected.
    const table = startAt(2, '2.1');
    const queue: (() => void)[] = [];
    const run = async () => {
      while (queue.length) queue.shift()!();
      await settle();
    };
    await mountLesson(table, { frames: { request: (fn: () => void) => queue.push(fn), cancel: () => {} } satisfies CoachFrames });
    await run();
    const ringKeys = () => [...overlayRoot().querySelectorAll('[data-coach-hole]')].map((el) => el.getAttribute('data-coach-hole'));
    const targets = () => (overlayRoot().getAttribute('data-coach-targets') ?? '').split(' ').filter(Boolean);
    expect(targets()).toHaveLength(1);
    expect(ringKeys()).toEqual(targets());
    const seven = table.envelope!.state.you.hand.findIndex((c) => c.Rank === 7 && c.Suit === 0);
    await click(`hand-card-${seven}`);
    await run();
    expect(targets()).toEqual([`hand-card-${seven}`, 'zone-points']);
    expect(ringKeys()).toEqual(targets());
  });

  it("the deal skip uses the coach's own-controls rule, not a copy of it", () => {
    const src = readFileSync(path.join(here, '..', '..', 'src', 'lib', 'components', 'CoachOverlay.svelte'), 'utf8');
    expect(src).not.toContain('[data-testid="coach-bubble"] button');
    expect(src).toMatch(/import \{[^}]*\bownsInput\b[^}]*\} from '\.\.\/tutorial\/coach\.svelte'/);
  });
});
