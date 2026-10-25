// @vitest-environment jsdom
// T7: the Home screen's Learn to play control (R25.1, R25.12 Home half;
// docs/tutorial-design.md D1, §4.1, §10). The one way into the tutorial is
// this static control. It never animates, pulses, badges, announces or opens
// anything on its own, and Home writes nothing about the tutorial.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeScreen from '../../src/lib/components/HomeScreen.svelte';
import TutorialLessons from '../../src/lib/components/TutorialLessons.svelte';
import { createFakeOnlineActions } from '../../src/lib/online/actions';
import { game } from '../../src/lib/stores/game.svelte';
import { online } from '../../src/lib/stores/online.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { TUTORIAL_KEY } from '../../src/lib/tutorial/progress';
import { TutorialStore, tutorial } from '../../src/lib/tutorial/tutorial.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
/** A fresh store per test over the real (jsdom) localStorage; the table factory is never reached from Home. */
let learn: TutorialStore;

function newStore(): TutorialStore {
  return new TutorialStore({ createTable: () => ({ dispose() {} }) });
}

/** Mount Home with this test's store, or (`useSingleton`) with the app's default. */
function render(opts: { useSingleton?: boolean } = {}): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  const props = { actions: createFakeOnlineActions(), onlineEnabled: true, ...(opts.useSingleton ? {} : { learn }) };
  instance = mount(HomeScreen, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function byId(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/** The muted line under the control, found the way assistive tech finds it. */
function statusLine(el: HTMLElement): string | undefined {
  const button = byId(el, 'learn-to-play');
  const id = button?.getAttribute('aria-describedby');
  if (!id) return undefined;
  return el.querySelector(`[id="${id}"]`)?.textContent?.trim();
}

beforeEach(() => {
  localStorage.clear();
  game.screen = 'home';
  game.notice = null;
  game.error = null;
  session.setNames('', '');
  settings.lastNames = null;
  online.close();
  tutorial.exitHome();
  learn = newStore();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  tutorial.exitHome();
});

describe('Home: Learn to play (R25.1)', () => {
  it('is a button reading "Learn to play", directly under the title and above Pass and play', () => {
    const el = render();
    const button = byId(el, 'learn-to-play');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.textContent?.trim()).toBe('Learn to play');

    const title = el.querySelector('h1');
    const pass = byId(el, 'mode-pass-play');
    expect(title?.textContent).toBe('Cuttle');
    // Under the title: the control's group is the title's next sibling.
    expect(title?.nextElementSibling?.contains(button)).toBe(true);
    // Above Pass and play.
    expect(button && pass ? button.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
  });

  it('adds no mode heading (the mode list stays Pass and play, then Play on two phones)', () => {
    const el = render();
    expect([...el.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Pass and play', 'Play on two phones']);
  });

  it('reads "Five short lessons" with nothing done', () => {
    expect(statusLine(render())).toBe('Five short lessons');
  });

  it('reads "3 of 5 done" from storage', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[1,2,4]}');
    expect(statusLine(render())).toBe('3 of 5 done');
  });

  it('reads "1 of 5 done" for one lesson', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[5]}');
    expect(statusLine(render())).toBe('1 of 5 done');
  });

  it('reads "All 5 lessons done" when every lesson is complete', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[1,2,3,4,5]}');
    expect(statusLine(render())).toBe('All 5 lessons done');
  });

  it('reads "Five short lessons" when the stored value is malformed', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":2,"done":[1,2,3]}');
    expect(statusLine(render())).toBe('Five short lessons');
  });

  it('reloads progress each time Home mounts', () => {
    const reload = vi.spyOn(learn, 'reload');
    render();
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[1,2]}');
    const el = render();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(statusLine(el)).toBe('2 of 5 done');
  });

  it('follows the store when a lesson is finished while Home is mounted', () => {
    const el = render();
    learn.finishLesson(1);
    flushSync();
    expect(statusLine(el)).toBe('1 of 5 done');
  });

  it('still renders, reading "Five short lessons", when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const el = render();
    expect(byId(el, 'learn-to-play')).not.toBeNull();
    expect(byId(el, 'new-game')).not.toBeNull();
    expect(statusLine(el)).toBe('Five short lessons');
  });

  it('tapping it calls open() and nothing else', () => {
    const open = vi.spyOn(learn, 'open');
    const start = vi.spyOn(learn, 'start');
    const el = render();
    expect(open).not.toHaveBeenCalled();
    byId(el, 'learn-to-play')?.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(learn.active).toBe(true);
    expect(learn.lessonId).toBeNull();
  });

  it('by default it is the app tutorial: reloaded at mount, opened on tap', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[1,2,3,4,5]}');
    const reload = vi.spyOn(tutorial, 'reload');
    const open = vi.spyOn(tutorial, 'open');
    const el = render({ useSingleton: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(statusLine(el)).toBe('All 5 lessons done');
    byId(el, 'learn-to-play')?.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(tutorial.active).toBe(true);
    expect(tutorial.lessonId).toBeNull();
  });

  it('keeps the existing mode testids and buttons', () => {
    const el = render();
    for (const id of ['mode-pass-play', 'name-input-0', 'name-input-1', 'table-mode-toggle', 'new-game', 'mode-online', 'online-create', 'online-join']) {
      expect(byId(el, id)).not.toBeNull();
    }
  });
});

describe('Home: never prompts (R25.12 Home half, D1)', () => {
  it('with empty storage shows only the static control: no live region, dialog, badge or status about the tutorial', () => {
    const el = render();
    expect(el.querySelector('[aria-live]')).toBeNull();
    expect(el.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull();
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();

    // The control's group holds exactly the button and its muted line.
    const button = byId(el, 'learn-to-play') as HTMLElement;
    const group = button.parentElement as HTMLElement;
    expect(group.children).toHaveLength(2);
    expect(group.textContent?.replace(/\s+/g, ' ').trim()).toBe('Learn to play Five short lessons');
    // No badge, dot or "new" marker on the control.
    expect(button.children).toHaveLength(0);
    expect(el.textContent).not.toMatch(/\bnew here\b|\btry the tutorial\b/i);

    // Nothing else on Home mentions lessons or the tutorial.
    const outside = [...el.querySelectorAll<HTMLElement>('*')].filter(
      (n) => !group.contains(n) && n.children.length === 0 && /lesson|tutorial|learn/i.test(n.textContent ?? ''),
    );
    expect(outside).toEqual([]);
  });

  it('with progress stored, still no live region, dialog or badge', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[1,2,3]}');
    const el = render();
    expect(el.querySelector('[aria-live]')).toBeNull();
    expect(el.querySelector('[role="dialog"], [role="alertdialog"], dialog, [role="status"]')).toBeNull();
    expect((byId(el, 'learn-to-play') as HTMLElement).children).toHaveLength(0);
  });

  it('mounting Home writes nothing to storage (no "seen" flag) and does not open the tutorial', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const open = vi.spyOn(learn, 'open');
    const openApp = vi.spyOn(tutorial, 'open');
    render();
    cleanup();
    render({ useSingleton: true });
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(TUTORIAL_KEY)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openApp).not.toHaveBeenCalled();
    expect(learn.active).toBe(false);
    expect(tutorial.active).toBe(false);
  });

  it('the control has no animation, transition or pulse, and meets the tap floor', () => {
    // jsdom has no layout or computed animations; this pins the CSS that the
    // fit check measures (hand-back), and that Home carries no motion at all.
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'HomeScreen.svelte'), 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '';
    expect(style).not.toMatch(/animation|@keyframes|transition/);
    const rule = /\.home-screen__learn-button\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*var\(--cu-tap-min\)/);
    expect(rule).toMatch(/width:\s*100%/);
  });

  it('the control is quiet: a raised-ink pill, never an accent fill', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'HomeScreen.svelte'), 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '';
    const rule = /\.home-screen__learn-button\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--cu-ink-raised\);/);
    expect(rule).not.toMatch(/--cu-ochre|--cu-iris/);
  });

  it('Home does not put focus on the control when it mounts', () => {
    const el = render();
    const button = byId(el, 'learn-to-play');
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('autofocus')).toBe(false);
    expect(document.activeElement).not.toBe(button);
  });
});

// Review B1: a browser that blocks site data throws from the `localStorage`
// getter itself (SecurityError), not from getItem/setItem. The default
// storage path must survive it.
describe('blocked site data: the localStorage getter throws', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    restore = () => {
      if (own) Object.defineProperty(globalThis, 'localStorage', own);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    };
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('the getter really throws in this test', () => {
    expect(() => localStorage.getItem(TUTORIAL_KEY)).toThrow();
  });

  it('Home still mounts with the control and "Five short lessons"', () => {
    learn = newStore(); // default storage path: nothing injected
    const el = render();
    expect(byId(el, 'learn-to-play')).not.toBeNull();
    expect(byId(el, 'new-game')).not.toBeNull();
    expect(statusLine(el)).toBe('Five short lessons');
  });

  it('the lessons screen still mounts', () => {
    const store = newStore();
    store.open();
    cleanup();
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(TutorialLessons, { target: host, props: { store } });
    flushSync();
    expect(byId(host, 'tutorial-lessons')).not.toBeNull();
    expect(byId(host, 'tutorial-continue')?.textContent?.trim()).toBe('Start');
  });

  it('finishing lessons keeps progress in memory without throwing', () => {
    const store = newStore();
    expect(() => store.reload()).not.toThrow();
    expect(() => store.finishLesson(2)).not.toThrow();
    expect(() => store.finishLesson(1)).not.toThrow();
    expect(() => store.reload()).not.toThrow();
    expect(store.done).toEqual([1, 2]);
    expect(store.nextUnfinished).toBe(3);
  });
});
