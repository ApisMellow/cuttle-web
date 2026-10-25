// @vitest-environment jsdom
// T7: the lessons screen (docs/tutorial-design.md §4.2, §10; plan §4 B7, T7).
// One mounted instance per test, driven through a real TutorialStore with a
// fake table factory and an in-memory storage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TutorialLessons from '../../src/lib/components/TutorialLessons.svelte';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { TUTORIAL_KEY } from '../../src/lib/tutorial/progress';
import { TutorialStore } from '../../src/lib/tutorial/tutorial.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function storeWith(stored: string | null) {
  const data = new Map<string, string>();
  if (stored !== null) data.set(TUTORIAL_KEY, stored);
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
  const createTable = vi.fn(() => ({ dispose: vi.fn() }));
  const store = new TutorialStore({ storage, createTable });
  store.open();
  return { store, storage, createTable };
}

function render(store: TutorialStore): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(TutorialLessons, { target: host, props: { store } });
  flushSync();
  return host;
}

function byId(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('TutorialLessons', () => {
  it('is its own screen with a heading and five lesson rows in order', () => {
    const { store } = storeWith(null);
    const el = render(store);
    expect(byId(el, 'tutorial-lessons')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Learn to play');
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid^="tutorial-lesson-"]')];
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'tutorial-lesson-1',
      'tutorial-lesson-2',
      'tutorial-lesson-3',
      'tutorial-lesson-4',
      'tutorial-lesson-5',
    ]);
    rows.forEach((row, i) => {
      expect(row.tagName).toBe('BUTTON');
      expect(row.textContent).toContain(String(i + 1));
      expect(row.textContent).toContain(LESSONS[i].title);
      expect(row.textContent).toContain(LESSONS[i].subtitle);
    });
  });

  it('reads progress from storage when it mounts', () => {
    const { store } = storeWith('{"v":1,"done":[1,2]}');
    expect(store.done).toEqual([]);
    const el = render(store);
    expect(store.done).toEqual([1, 2]);
    expect(byId(el, 'tutorial-lesson-1')?.textContent).toContain('done');
  });

  it('marks finished lessons with an ochre check and "done" for screen readers, and no others', () => {
    const { store } = storeWith('{"v":1,"done":[1,3]}');
    const el = render(store);
    for (const n of [1, 2, 3, 4, 5]) {
      const row = byId(el, `tutorial-lesson-${n}`) as HTMLElement;
      const check = row.querySelector('.lessons__check');
      const finished = n === 1 || n === 3;
      expect(check !== null).toBe(finished);
      expect(row.dataset.done).toBe(finished ? 'true' : 'false');
      if (check) {
        expect(check.textContent).toBe('✓');
        expect(check.getAttribute('aria-hidden')).toBe('true');
      }
      expect(/\bdone\b/.test(row.textContent ?? '')).toBe(finished);
    }
  });

  it('every row starts its lesson, finished ones included', () => {
    const { store } = storeWith('{"v":1,"done":[1]}');
    const start = vi.spyOn(store, 'start').mockImplementation(() => {});
    const el = render(store);
    for (const n of [1, 2, 3, 4, 5]) byId(el, `tutorial-lesson-${n}`)?.click();
    expect(start.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('Continue reads "Start" with nothing done and starts lesson 1', () => {
    const { store } = storeWith(null);
    const start = vi.spyOn(store, 'start').mockImplementation(() => {});
    const el = render(store);
    const button = byId(el, 'tutorial-continue');
    expect(button?.textContent?.trim()).toBe('Start');
    button?.click();
    expect(start).toHaveBeenCalledWith(1);
  });

  it('Continue reads "Continue: lesson N" for the first unfinished lesson', () => {
    const { store } = storeWith('{"v":1,"done":[1,2,4]}');
    const start = vi.spyOn(store, 'start').mockImplementation(() => {});
    const el = render(store);
    const button = byId(el, 'tutorial-continue');
    expect(button?.textContent?.trim()).toBe('Continue: lesson 3');
    button?.click();
    expect(start).toHaveBeenCalledWith(3);
  });

  it('Continue reads "Play again from lesson 1" when all five are done', () => {
    const { store } = storeWith('{"v":1,"done":[1,2,3,4,5]}');
    const start = vi.spyOn(store, 'start').mockImplementation(() => {});
    const el = render(store);
    const button = byId(el, 'tutorial-continue');
    expect(button?.textContent?.trim()).toBe('Play again from lesson 1');
    button?.click();
    expect(start).toHaveBeenCalledWith(1);
  });

  it('follows the store when progress changes while mounted', () => {
    const { store } = storeWith(null);
    const el = render(store);
    store.finishLesson(1);
    flushSync();
    expect(byId(el, 'tutorial-continue')?.textContent?.trim()).toBe('Continue: lesson 2');
    expect(byId(el, 'tutorial-lesson-1')?.querySelector('.lessons__check')).not.toBeNull();
  });

  it('Back returns Home', () => {
    const { store } = storeWith(null);
    const exitHome = vi.spyOn(store, 'exitHome');
    const el = render(store);
    const back = byId(el, 'tutorial-lessons-back');
    expect(back?.tagName).toBe('BUTTON');
    expect(back?.textContent).toContain('Home');
    back?.click();
    expect(exitHome).toHaveBeenCalledTimes(1);
    expect(store.active).toBe(false);
  });

  it('Escape returns Home; other keys do not', () => {
    const { store } = storeWith(null);
    const exitHome = vi.spyOn(store, 'exitHome');
    const el = render(store);
    const row = byId(el, 'tutorial-lesson-2') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(exitHome).not.toHaveBeenCalled();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(exitHome).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Escape once unmounted', () => {
    const { store } = storeWith(null);
    const exitHome = vi.spyOn(store, 'exitHome');
    render(store);
    cleanup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(exitHome).not.toHaveBeenCalled();
  });

  it('focuses its heading on arrival', () => {
    const { store } = storeWith(null);
    const el = render(store);
    expect(document.activeElement).toBe(el.querySelector('h1'));
  });

  it('writes nothing to storage just by showing (no "seen" flag, D1)', () => {
    const { store, storage, createTable } = storeWith('{"v":1,"done":[2]}');
    // The component must not reach past its store to the browser's storage either.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    render(store);
    cleanup();
    render(store);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(createTable).not.toHaveBeenCalled();
  });

  it('sizes rows to at least 56 px and the other controls to the 44 px tap floor', () => {
    // jsdom has no layout; the fit check in the hand-back measures the real
    // boxes. This pins the rules that produce them.
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'TutorialLessons.svelte'), 'utf8');
    const rule = (selector: string) => {
      const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source);
      return match?.[1] ?? '';
    };
    expect(rule('.lessons__row')).toMatch(/min-height:\s*56px/);
    expect(rule('.lessons__back')).toMatch(/min-height:\s*var\(--cu-tap-min\)/);
    expect(rule('.lessons__back')).toMatch(/min-width:\s*var\(--cu-tap-min\)/);
    expect(rule('.lessons__continue')).toMatch(/min-height:\s*var\(--cu-tap-min\)/);
  });
});
