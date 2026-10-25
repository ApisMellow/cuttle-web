// @vitest-environment jsdom
// T9 App routing for Learn to play (docs/tutorial-plan.md T9; design §4,
// §6.4, D1). ONE mounted App per test, on the REAL wasm bridge (engine
// v0.2.1), with the real `tutorial` singleton and its real TutorialTable
// factory. `ensureEngine` is mocked (the test boots the wasm itself) and the
// service-worker glue is mocked so `reportScreen` can be watched.
//
// Ledger: R25.6 (Leave from every step, menu Home), R25.5 (the sheet's
// Escape lands on the lessons screen), R25.12 (S9, the in-game and
// result-screen half: nothing about the tutorial ever appears unasked).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import type { Envelope, Move } from '../../src/lib/bridge/schema';
import { testIdForKey } from '../../src/lib/dragDrop';
import { MoveKind } from '../../src/lib/enums';
import { LESSONS, SNAG_LINE } from '../../src/lib/tutorial/lessons';
import { TUTORIAL_KEY } from '../../src/lib/tutorial/progress';
import { BLAKE_THINK_MS, SUCCESS_BEAT_MS } from '../../src/lib/tutorial/table.svelte';
import type { LessonId } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { expectedIndex, walkTo } from './tutorial-driver';

vi.mock('../../src/lib/bridge/wasm', () => ({
  ensureEngine: vi.fn(() => Promise.resolve()),
  resetEngineForTests: vi.fn(),
}));

const pwa = vi.hoisted(() => ({
  reportScreen: vi.fn(),
  applyUpdateAtRematch: vi.fn((): boolean => false),
  takePendingRematch: vi.fn((): null => null),
  applyUpdateAtOnlineRematch: vi.fn((): boolean => false),
  takePendingOnlineRematch: vi.fn((): null => null),
}));
vi.mock('../../src/lib/pwa/register', () => pwa);

// One switch to make the next lesson table fail to build (the snag path).
const tableFail = vi.hoisted(() => ({ next: false }));
vi.mock('../../src/lib/tutorial/table.svelte', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/tutorial/table.svelte')>();
  class TutorialTable extends mod.TutorialTable {
    constructor(...args: ConstructorParameters<typeof mod.TutorialTable>) {
      if (tableFail.next) {
        tableFail.next = false;
        throw new Error('forced: the lesson table could not be built');
      }
      super(...args);
    }
  }
  return { ...mod, TutorialTable };
});

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');
const { tutorial } = await import('../../src/lib/tutorial/tutorial.svelte');
const { online } = await import('../../src/lib/stores/online.svelte');
const { TutorialTable } = await import('../../src/lib/tutorial/table.svelte');

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
  }
  flushSync();
}

async function renderApp(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(App, { target: host });
  await settle();
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
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

function lastReported(): string | undefined {
  return pwa.reportScreen.mock.calls.at(-1)?.[0];
}

async function openLesson(id: LessonId): Promise<InstanceType<typeof TutorialTable>> {
  if (!q('tutorial-lessons')) await click('learn-to-play');
  await click(`tutorial-lesson-${id}`);
  const table = tutorial.table;
  if (!table) throw new Error('no lesson table');
  return table;
}

async function stage(env: Envelope, i: number): Promise<void> {
  const m: Move = env.legalMoves[i];
  if (m.Kind === MoveKind.Counter) return click(`counter-option-${i}`);
  if (m.Kind === MoveKind.Draw) return click('deck-pile');
  await click(`hand-card-${m.HandIndex}`);
  await click(testIdForKey(boardTargetKey(m)!));
}

let errors: ReturnType<typeof vi.spyOn>;

function resetGame(): void {
  game.envelope = null;
  game.history = [];
  game.seq = 0;
  game.viewer = null;
  game.curtain = { kind: 'none' };
  game.lastSeenSeq = { 0: 0, 1: 0 };
  game.error = null;
  game.screen = 'home';
  game.notice = null;
  game.drawReveal = null;
}

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  pwa.reportScreen.mockClear();
  tableFail.next = false;
  tutorial.exitHome();
  tutorial.reload();
  resetGame();
  session.setNames('', '');
  session.tally = { 0: 0, 1: 0 };
  settings.revealPreference = 'two-step';
  settings.tableMode = false;
  settings.reducedMotion = false;
  online.view = 'none';
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  tutorial.exitHome();
  vi.useRealTimers();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

describe('routing (design §6.4)', () => {
  it('Home → Learn to play → the lessons screen → a lesson: GameScreen with the coach, the real table', async () => {
    await renderApp();
    expect(q('home-screen')).not.toBeNull();
    expect(lastReported()).toBe('home');

    await click('learn-to-play');
    expect(q('tutorial-lessons')).not.toBeNull();
    expect(q('home-screen')).toBeNull();
    expect(lastReported()).toBe('home');

    await click('tutorial-lesson-1');
    expect(q('tutorial-lessons')).toBeNull();
    expect(q('game-screen')).not.toBeNull();
    expect(q('coach-bubble')).not.toBeNull();
    expect(q('coach-bubble')!.dataset.step).toBe('1.1');
    expect(tutorial.table).toBeInstanceOf(TutorialTable);
    expect(lastReported()).toBe('game');
    expect(pwa.reportScreen.mock.calls.map(([s]) => s)).not.toContain('tutorial');
    // Focus goes to the coach's copy at lesson start (design §9).
    expect(document.activeElement).toBe(q('coach-bubble')!.querySelector('[aria-live]'));
    // The real game is untouched: no envelope, no save.
    expect(game.screen).toBe('home');
    expect(game.envelope).toBeNull();
    expect(localStorage.getItem('cuttle-web:game')).toBeNull();
  });

  it('a lesson whose table cannot be built shows a snag line on the lessons screen, never an uncaught error', async () => {
    await renderApp();
    await click('learn-to-play');
    tableFail.next = true;
    await click('tutorial-lesson-3');
    expect(q('tutorial-lessons')).not.toBeNull();
    expect(q('game-screen')).toBeNull();
    const alert = host!.querySelector('[role="alert"]');
    expect(alert?.textContent?.trim()).toBe(SNAG_LINE);
    // A second try works and clears the line.
    await click('tutorial-lesson-3');
    expect(q('game-screen')).not.toBeNull();
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it('Next lesson on the done sheet starts the next lesson on a fresh GameScreen', async () => {
    await renderApp();
    const table = await openLesson(2);
    const screen1 = q('game-screen');
    walkTo(table, '2.3');
    await settle();
    await click('coach-next');
    expect(q('coach-lesson-done')).not.toBeNull();
    expect(localStorage.getItem(TUTORIAL_KEY)).toBe('{"v":1,"done":[2]}');
    await click('coach-next-lesson');
    expect(tutorial.lessonId).toBe(3);
    expect(q('game-screen')).not.toBe(screen1);
    expect(q('coach-bubble')!.dataset.step).toBe('3.1');
    expect(q('coach-lesson-done')).toBeNull();
  });

  it("Escape on the done sheet lands on the lessons screen, not Home", async () => {
    await renderApp();
    const table = await openLesson(2);
    walkTo(table, '2.3');
    await settle();
    await click('coach-next');
    const heading = q('coach-lesson-done')!.querySelector('h2')!;
    // The same keydown then reaches GameScreen's window listener, still
    // mounted: its source must not have changed under it (no listener error).
    const listenerErrors = vi.fn();
    window.addEventListener('error', listenerErrors);
    heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    window.removeEventListener('error', listenerErrors);
    expect(listenerErrors).not.toHaveBeenCalled();
    await settle();
    vi.advanceTimersByTime(50);
    await settle();
    expect(q('tutorial-lessons')).not.toBeNull();
    expect(q('home-screen')).toBeNull();
    expect(tutorial.active).toBe(true);
  });

  it('Play a game after lesson 5 goes Home', async () => {
    await renderApp();
    const table = await openLesson(5);
    walkTo(table, '5.4');
    await settle();
    const i = expectedIndex(table);
    await stage(table.envelope!, i);
    await click('staging-confirm');
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    await settle();
    expect(q('coach-lesson-done')!.textContent).toContain("You've learned Cuttle");
    await click('coach-play');
    expect(q('home-screen')).not.toBeNull();
    expect(tutorial.active).toBe(false);
    expect(lastReported()).toBe('home');
  });
});

describe('S8: exits (R25.6)', () => {
  for (const lesson of LESSONS) {
    it(`Leave from every step of lesson ${lesson.id} lands on the lessons screen`, async () => {
      await renderApp();
      await click('learn-to-play');
      for (const step of lesson.steps) {
        const table = await openLesson(lesson.id);
        if (step.id !== lesson.steps[0].id) walkTo(table, step.id);
        await settle();
        expect(q('coach-bubble')!.dataset.step, step.id).toBe(step.id);
        await click('coach-leave');
        expect(q('tutorial-lessons'), step.id).not.toBeNull();
        expect(q('game-screen'), step.id).toBeNull();
        expect(q('coach-bubble'), step.id).toBeNull();
        expect(tutorial.active).toBe(true);
        expect(tutorial.lessonId).toBeNull();
        // The old lesson's timers are stale: nothing moves later.
        vi.advanceTimersByTime(5000);
        await settle();
        expect(q('tutorial-lessons'), step.id).not.toBeNull();
      }
    });
  }

  it('menu Home lands on Home with the tutorial closed; the tutorial menu has no New game', async () => {
    await renderApp();
    const table = await openLesson(1);
    walkTo(table, '1.5');
    await settle();
    await click('menu-button');
    expect(q('menu-home')).not.toBeNull();
    expect(q('menu-rules')).not.toBeNull();
    expect(q('menu-new-game')).toBeNull();
    await click('menu-home');
    expect(q('home-screen')).not.toBeNull();
    expect(q('game-screen')).toBeNull();
    expect(tutorial.active).toBe(false);
    expect(tutorial.table).toBeNull();
    expect(lastReported()).toBe('home');
  });
});

// ---------------------------------------------------------------------------
// S9: no prompt, ever (D1, R25.12) — the App half
// ---------------------------------------------------------------------------

const TUTORIAL_WORDS = /learn to play|lesson|tutorial|coach/i;

function expectNoTutorial(where: string): void {
  const root = host!;
  expect(root.querySelector('[data-testid^="coach-"]'), `${where}: coach testid`).toBeNull();
  expect(root.querySelector('[data-testid^="tutorial-"]'), `${where}: tutorial testid`).toBeNull();
  expect(root.querySelector('[data-coach-overlay], .coach-spotlight, .ghost-demo'), `${where}: overlay`).toBeNull();
  expect(tutorial.active, `${where}: tutorial active`).toBe(false);
  if (q('home-screen')) {
    // Home's one static control and its muted line are the only mention.
    const learn = q('learn-to-play')!;
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="learn-to-play"]')?.parentElement?.remove();
    expect(clone.textContent ?? '', `${where}: home text`).not.toMatch(TUTORIAL_WORDS);
    expect(learn.getAttribute('aria-live')).toBeNull();
    expect(root.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]').length, `${where}: dialogs`).toBe(0);
  } else {
    expect(root.textContent ?? '', `${where}: text`).not.toMatch(TUTORIAL_WORDS);
    for (const dialog of root.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="status"], [aria-live]')) {
      expect(dialog.textContent ?? '', `${where}: ${dialog.getAttribute('role') ?? 'live region'}`).not.toMatch(TUTORIAL_WORDS);
    }
  }
}

function pickMove(env: Envelope): number {
  const moves = env.legalMoves;
  let best = -1;
  moves.forEach((m, i) => {
    if (m.Kind === MoveKind.PlayPoint && (best < 0 || (m.Card?.Rank ?? 0) > (moves[best].Card?.Rank ?? 0))) best = i;
  });
  if (best >= 0) return best;
  for (const kind of [MoveKind.Draw, MoveKind.Decline]) {
    const i = moves.findIndex((m) => m.Kind === kind);
    if (i >= 0) return i;
  }
  return 0;
}

describe('S9: no prompt, ever — App half (R25.12)', () => {
  it('with empty storage, Home, a whole pass-and-play game and its result screen show nothing about the tutorial', async () => {
    await renderApp();
    expectNoTutorial('home');
    await click('new-game');
    expect(game.screen).toBe('game');
    const screens = new Set<string>();
    for (let n = 0; n < 800 && game.curtain.kind !== 'result'; n++) {
      const kind = game.curtain.kind;
      screens.add(kind);
      if (game.drawReveal !== null) {
        game.dismissDrawReveal();
      } else if (kind === 'handoff' || kind === 'reveal' || kind === 'recap') {
        await game.advanceCurtain();
      } else {
        await game.apply(pickMove(game.envelope!));
      }
      await settle();
      expectNoTutorial(`game step ${n} (${kind})`);
    }
    expect(game.curtain.kind).toBe('result');
    expect(screens).toContain('none');
    expect(q('game-screen')).toBeNull(); // the result screen
    expectNoTutorial('result');
    vi.advanceTimersByTime(10_000);
    await settle();
    expectNoTutorial('result, later');
    expect(localStorage.getItem(TUTORIAL_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review round 1 (T9)
// ---------------------------------------------------------------------------

describe('Leave works on its first tap during a beat (review B1)', () => {
  it('during the success beat and during Blake\'s narration, pointerdown + click on Leave lands on the lessons screen', async () => {
    for (const beat of ['success', 'narration'] as const) {
      await renderApp();
      const table = await openLesson(2);
      await stage(table.envelope!, expectedIndex(table));
      await click('staging-confirm');
      expect(table.phase).toBe('success');
      if (beat === 'narration') {
        vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
        await settle();
        expect(q('coach-bubble')!.querySelector('[aria-live]')!.textContent).toContain('Blake played a 6');
      }
      const step = q('coach-bubble')!.dataset.step;
      const stage0 = q('coach-bubble')!.dataset.stage;
      q('coach-leave')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(q('coach-bubble')!.dataset.step, beat).toBe(step);
      expect(q('coach-bubble')!.dataset.stage, beat).toBe(stage0);
      await click('coach-leave');
      expect(q('tutorial-lessons'), beat).not.toBeNull();
      expect(q('game-screen'), beat).toBeNull();
      cleanup();
      tutorial.exitHome();
    }
  });
});

/** Records window listeners and MutationObservers created from now on. */
function watchTeardown() {
  const capture = (o: unknown): boolean => (typeof o === 'boolean' ? o : !!(o as AddEventListenerOptions | undefined)?.capture);
  const added: [string, unknown, boolean][] = [];
  const removed: [string, unknown, boolean][] = [];
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  const add = vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => {
    added.push([type, fn, capture(o)]);
    if (fn) realAdd(type, fn, o);
  });
  const remove = vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) => {
    removed.push([type, fn, capture(o)]);
    if (fn) realRemove(type, fn, o);
  });
  const observe = vi.spyOn(MutationObserver.prototype, 'observe');
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  return {
    /** Every listener added before `upTo` (the lesson's) must be gone. */
    expectTornDown(label: string, upTo: number): void {
      const lessonAdds = added.slice(0, upTo);
      expect(lessonAdds.length, `${label}: the lesson added window listeners`).toBeGreaterThan(0);
      for (const kind of ['pointerdown', 'keydown', 'resize']) {
        expect(lessonAdds.some(([t]) => t === kind), `${label}: a ${kind} listener was added`).toBe(true);
      }
      for (const [type, fn, cap] of lessonAdds) {
        expect(removed.some(([t, f, c]) => t === type && f === fn && c === cap), `${label}: window ${type} (capture ${cap}) removed`).toBe(true);
      }
      const observers = observe.mock.contexts.slice();
      expect(observers.length, `${label}: the coach observed its root`).toBeGreaterThan(0);
      for (const o of observers) expect(disconnect.mock.contexts, `${label}: observer disconnected`).toContain(o);
    },
    restore(): void {
      add.mockRestore();
      remove.mockRestore();
      observe.mockRestore();
      disconnect.mockRestore();
    },
    mark(): number {
      return added.length;
    },
  };
}

describe('leaving a lesson tears the coach down (review B2)', () => {
  for (const exit of ['Leave', 'menu Home'] as const) {
    it(`after ${exit}: no lesson window listener, every observer disconnected, nothing reacts to the old root`, async () => {
      await renderApp();
      await click('learn-to-play');
      const watch = watchTeardown();
      try {
        const table = await openLesson(1);
        walkTo(table, '1.5');
        await settle();
        const oldRoot = q('game-screen')!;
        // What the lesson added; the screen shown after the exit adds its own.
        const lessonAdds = watch.mark();
        if (exit === 'Leave') {
          await click('coach-leave');
          expect(q('tutorial-lessons')).not.toBeNull();
        } else {
          await click('menu-button');
          await click('menu-home');
          expect(q('home-screen')).not.toBeNull();
        }
        watch.expectTornDown(exit, lessonAdds);
        // The old root, detached, mutated: nothing anywhere reacts.
        const before = document.body.innerHTML;
        oldRoot.setAttribute('data-poke', '1');
        oldRoot.append(document.createElement('div'));
        await settle();
        vi.advanceTimersByTime(10_000);
        await settle();
        expect(document.body.innerHTML).toBe(before);
      } finally {
        watch.restore();
      }
    });
  }
});

describe('Learn to play is never interrupted by the online flow (ruling N1)', () => {
  it('a #/join/CODE link while the lessons screen is open is ignored and cleared', async () => {
    await renderApp();
    await click('learn-to-play');
    location.hash = '#/join/ABCD';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();
    expect(online.view).toBe('none');
    expect(location.hash).toBe('');
    expect(q('tutorial-lessons')).not.toBeNull();
    await click('tutorial-lessons-back');
    expect(q('home-screen')).not.toBeNull();
    expect(online.view).toBe('none');
  });

  it('a #/join/CODE link during a lesson is ignored and cleared', async () => {
    await renderApp();
    await openLesson(1);
    location.hash = '#/join/ABCD';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();
    expect(online.view).toBe('none');
    expect(location.hash).toBe('');
    expect(q('coach-bubble')).not.toBeNull();
  });

  it('routing checks the tutorial before the online flow', async () => {
    await renderApp();
    await click('learn-to-play');
    online.openCreate();
    await settle();
    expect(q('tutorial-lessons')).not.toBeNull();
    expect(lastReported()).toBe('home');
    await click('tutorial-lesson-1');
    expect(q('coach-bubble')).not.toBeNull();
    expect(lastReported()).toBe('game');
  });
});
