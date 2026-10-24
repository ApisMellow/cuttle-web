// @vitest-environment jsdom
// T7: TutorialStore, the learner's name (B1) and the singleton
// (docs/tutorial-design.md §4.1, §4.2, §10; plan §4 B1, §5, T7).
//
// The table factory is injected: T5 owns `table.svelte.ts`, so these tests
// pass a fake that records the deps it was given and its dispose calls.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { session } from '../../src/lib/stores/session.svelte';
import { SETTINGS_KEY, settings } from '../../src/lib/stores/settings.svelte';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { TUTORIAL_KEY } from '../../src/lib/tutorial/progress';
import {
  TutorialStore,
  learnerName,
  tutorial,
  type LessonTableDeps,
} from '../../src/lib/tutorial/tutorial.svelte';
import type { Lesson, LessonId } from '../../src/lib/tutorial/types';

interface FakeTable {
  lesson: Lesson;
  deps: LessonTableDeps;
  dispose: Mock<() => void>;
}

function fakeFactory() {
  const made: FakeTable[] = [];
  const createTable = vi.fn((lesson: Lesson, deps: LessonTableDeps): FakeTable => {
    const table = { lesson, deps, dispose: vi.fn<() => void>() };
    made.push(table);
    return table;
  });
  return { createTable, made };
}

/** An in-memory storage whose calls are all spied. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
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

function throwingStorage() {
  return {
    getItem: vi.fn((): string | null => {
      throw new Error('storage blocked');
    }),
    setItem: vi.fn((): void => {
      throw new Error('storage blocked');
    }),
    removeItem: vi.fn((): void => {
      throw new Error('storage blocked');
    }),
  };
}

function makeStore(storage = memoryStorage(), learner?: () => string) {
  const factory = fakeFactory();
  const store = new TutorialStore({ storage, createTable: factory.createTable, learnerName: learner });
  return { store, storage, ...factory };
}

beforeEach(() => {
  localStorage.clear();
  settings.lastNames = null;
  settings.reducedMotion = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TutorialStore: routing', () => {
  it('starts closed with nothing done', () => {
    const { store } = makeStore();
    expect(store.active).toBe(false);
    expect(store.lessonId).toBeNull();
    expect(store.table).toBeNull();
    expect(store.done).toEqual([]);
  });

  it('open shows the lessons screen', () => {
    const { store, createTable } = makeStore();
    store.open();
    expect(store.active).toBe(true);
    expect(store.lessonId).toBeNull();
    expect(store.table).toBeNull();
    expect(createTable).not.toHaveBeenCalled();
  });

  it('start(3) runs lesson 3 on a table from the factory', () => {
    const { store, createTable, made } = makeStore();
    store.open();
    store.start(3);
    expect(store.active).toBe(true);
    expect(store.lessonId).toBe(3);
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(made[0].lesson).toBe(LESSONS[2]);
    expect(made[0].lesson.id).toBe(3);
    expect(store.table).toBe(made[0]);
  });

  it('start from Home (no open first) still routes into the tutorial', () => {
    const { store } = makeStore();
    store.start(1);
    expect(store.active).toBe(true);
    expect(store.lessonId).toBe(1);
  });

  it('start disposes the previous table before making the next', () => {
    const { store, made } = makeStore();
    store.start(3);
    store.start(4);
    expect(made).toHaveLength(2);
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(made[1].dispose).not.toHaveBeenCalled();
    expect(store.lessonId).toBe(4);
    expect(store.table).toBe(made[1]);
  });

  it('leave disposes the table and shows the lessons screen', () => {
    const { store, made } = makeStore();
    store.open();
    store.start(3);
    store.leave();
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(store.table).toBeNull();
    expect(store.lessonId).toBeNull();
    expect(store.active).toBe(true);
  });

  it('exitHome disposes the table and closes the tutorial', () => {
    const { store, made } = makeStore();
    store.start(2);
    store.exitHome();
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(store.table).toBeNull();
    expect(store.lessonId).toBeNull();
    expect(store.active).toBe(false);
  });

  it('exitHome from the lessons screen closes it', () => {
    const { store } = makeStore();
    store.open();
    store.exitHome();
    expect(store.active).toBe(false);
  });

  it("the table's onHome (menu Home) is exitHome (R25.6 routing half)", () => {
    const { store, made } = makeStore();
    store.start(2);
    made[0].deps.onHome();
    expect(store.active).toBe(false);
    expect(store.lessonId).toBeNull();
    expect(store.table).toBeNull();
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('a stale onHome from a replaced table does nothing', () => {
    const { store, made } = makeStore();
    store.start(2);
    store.start(3);
    made[0].deps.onHome();
    expect(store.active).toBe(true);
    expect(store.lessonId).toBe(3);
    expect(made[1].dispose).not.toHaveBeenCalled();
  });

  it('open from inside a lesson disposes the table', () => {
    const { store, made } = makeStore();
    store.start(2);
    store.open();
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(store.lessonId).toBeNull();
    expect(store.table).toBeNull();
  });

  it('nextLesson starts the lesson after the current one', () => {
    const { store, made } = makeStore();
    store.start(2);
    store.nextLesson();
    expect(store.lessonId).toBe(3);
    expect(made[1].lesson.id).toBe(3);
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('nextLesson does nothing after lesson 5 or outside a lesson', () => {
    const { store, createTable } = makeStore();
    store.open();
    store.nextLesson();
    expect(createTable).not.toHaveBeenCalled();
    store.start(5);
    store.nextLesson();
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(store.lessonId).toBe(5);
  });

  it('ignores a lesson number outside 1-5', () => {
    const { store, createTable } = makeStore();
    store.open();
    store.start(6 as LessonId);
    store.start(0 as LessonId);
    expect(createTable).not.toHaveBeenCalled();
    expect(store.lessonId).toBeNull();
  });

  it('accepts a factory typed against plan §5 TutorialTableDeps (the T9 wiring)', () => {
    // Plan §5's TutorialTableDeps, field for field; its extras are optional.
    interface PlanDeps {
      engine?: unknown;
      clock?: unknown;
      learnerName: string;
      reducedMotion: () => boolean;
      onHome(): void;
      beforeApply?(move: unknown, view: unknown): void;
      afterApply?(): void;
    }
    const planFactory = (lesson: Lesson, deps: PlanDeps) => ({ lesson, deps, dispose: () => {} });
    const store = new TutorialStore({ storage: memoryStorage(), createTable: planFactory });
    store.start(1);
    expect(store.table?.lesson.id).toBe(1);
    expect(store.table?.deps.learnerName).toBe('You');
  });

  it('passes reducedMotion through from settings', () => {
    const { store, made } = makeStore();
    store.start(1);
    expect(made[0].deps.reducedMotion()).toBe(false);
    settings.reducedMotion = true;
    expect(made[0].deps.reducedMotion()).toBe(true);
  });
});

describe('TutorialStore: progress', () => {
  it('reload reads done from storage', () => {
    const { store } = makeStore(memoryStorage({ [TUTORIAL_KEY]: '{"v":1,"done":[3,1]}' }));
    store.reload();
    expect(store.done).toEqual([1, 3]);
  });

  it('finishLesson adds the lesson and writes only cuttle-web:tutorial', () => {
    const { store, storage } = makeStore();
    store.finishLesson(2);
    expect(store.done).toEqual([2]);
    store.finishLesson(1);
    expect(store.done).toEqual([1, 2]);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    for (const call of storage.setItem.mock.calls) expect(call[0]).toBe(TUTORIAL_KEY);
    expect(storage.data.get(TUTORIAL_KEY)).toBe('{"v":1,"done":[1,2]}');
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('finishing a lesson twice keeps it once, and rewrites a malformed value', () => {
    const { store, storage } = makeStore(memoryStorage({ [TUTORIAL_KEY]: '{"v":9,"junk":true}' }));
    store.reload();
    expect(store.done).toEqual([]);
    store.finishLesson(4);
    store.finishLesson(4);
    expect(store.done).toEqual([4]);
    expect(storage.data.get(TUTORIAL_KEY)).toBe('{"v":1,"done":[4]}');
  });

  it('ignores finishLesson for a number outside 1-5', () => {
    const { store, storage } = makeStore();
    store.finishLesson(6 as LessonId);
    expect(store.done).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('open, start, leave, nextLesson and exitHome write nothing (no "seen" flag, D1)', () => {
    const { store, storage } = makeStore();
    store.reload();
    store.open();
    store.start(1);
    store.nextLesson();
    store.leave();
    store.start(5);
    store.exitHome();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('with storage that throws, progress lives in memory and nothing throws', () => {
    const storage = throwingStorage();
    const { store } = makeStore(storage as never);
    expect(() => store.reload()).not.toThrow();
    expect(store.done).toEqual([]);
    expect(() => store.finishLesson(1)).not.toThrow();
    expect(() => store.finishLesson(3)).not.toThrow();
    expect(store.done).toEqual([1, 3]);
    // Home or the lessons screen mounting again must not wipe the memory copy.
    expect(() => store.reload()).not.toThrow();
    expect(store.done).toEqual([1, 3]);
    expect(store.nextUnfinished).toBe(2);
    store.open();
    store.start(2);
    expect(store.lessonId).toBe(2);
  });

  it('a storage that reads but cannot write keeps the memory copy across reloads', () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    const { store } = makeStore(storage);
    store.finishLesson(2);
    store.reload();
    expect(store.done).toEqual([2]);
  });

  it('reload keeps lessons finished in memory and adds ones finished elsewhere', () => {
    const storage = memoryStorage();
    const { store } = makeStore(storage);
    store.finishLesson(1);
    storage.data.set(TUTORIAL_KEY, '{"v":1,"done":[1,4]}');
    store.reload();
    expect(store.done).toEqual([1, 4]);
  });

  it('nextUnfinished is the first missing number, null when all five are done', () => {
    const { store } = makeStore();
    expect(store.nextUnfinished).toBe(1);
    store.finishLesson(1);
    store.finishLesson(2);
    store.finishLesson(4);
    expect(store.nextUnfinished).toBe(3);
    store.finishLesson(3);
    expect(store.nextUnfinished).toBe(5);
    store.finishLesson(5);
    expect(store.nextUnfinished).toBeNull();
  });

  it('uses localStorage when no storage is injected', () => {
    localStorage.setItem(TUTORIAL_KEY, '{"v":1,"done":[5]}');
    const factory = fakeFactory();
    const store = new TutorialStore({ createTable: factory.createTable });
    store.reload();
    expect(store.done).toEqual([5]);
    store.finishLesson(2);
    expect(localStorage.getItem(TUTORIAL_KEY)).toBe('{"v":1,"done":[2,5]}');
  });
});

describe('learnerName (B1, review focus 5)', () => {
  it('is "You" with no saved names, a blank name or the "Player 1" default', () => {
    expect(learnerName(null)).toBe('You');
    expect(learnerName(['', 'x'])).toBe('You');
    expect(learnerName(['   ', 'x'])).toBe('You');
    expect(learnerName(['Player 1', 'x'])).toBe('You');
    expect(learnerName([' Player 1 ', 'x'])).toBe('You');
  });

  it('passes a real name through, trimmed', () => {
    expect(learnerName(['Alice', 'Blake'])).toBe('Alice');
    expect(learnerName(['  Alice ', 'Blake'])).toBe('Alice');
  });

  it('passes a 40-character name and an emoji name through', () => {
    const long = 'A'.repeat(40);
    expect(learnerName([long, 'x'])).toBe(long);
    expect(learnerName(['Alice 🦑', 'x'])).toBe('Alice 🦑');
    expect(learnerName(['👩‍💻', 'x'])).toBe('👩‍💻');
  });

  it('only player 1 counts', () => {
    expect(learnerName(['', 'Blake'])).toBe('You');
    expect(learnerName(['Player 2', 'Player 1'])).toBe('Player 2');
  });
});

describe('TutorialStore: the learner name reaches the table, and settings are never written', () => {
  it('reads settings.lastNames once, when the lesson starts', () => {
    const { store, made } = makeStore();
    settings.lastNames = ['Alice', 'Blake'];
    store.start(1);
    expect(made[0].deps.learnerName).toBe('Alice');
    settings.lastNames = ['Player 1', 'Player 2'];
    store.start(2);
    expect(made[1].deps.learnerName).toBe('You');
    settings.lastNames = null;
    store.start(3);
    expect(made[2].deps.learnerName).toBe('You');
    const long = 'A'.repeat(40);
    settings.lastNames = [long, ''];
    store.start(4);
    expect(made[3].deps.learnerName).toBe(long);
    settings.lastNames = ['Alice 🦑', ''];
    store.start(5);
    expect(made[4].deps.learnerName).toBe('Alice 🦑');
  });

  it('an injected learnerName wins', () => {
    const { store, made } = makeStore(memoryStorage(), () => 'Alice');
    store.start(1);
    expect(made[0].deps.learnerName).toBe('Alice');
  });

  it('never calls settings.setLastNames or writes cuttle-web:settings through a whole run', () => {
    // Arrange the session's names first: setNames itself persists the tally.
    session.setNames('Alice', 'Blake');
    const setNames = vi.spyOn(session, 'setNames');
    const setLastNames = vi.spyOn(settings, 'setLastNames');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    settings.lastNames = ['Player 1', 'Player 2'];
    const namesBefore = [...session.names];
    const factory = fakeFactory();
    const store = new TutorialStore({ createTable: factory.createTable });
    store.reload();
    store.open();
    for (const id of [1, 2, 3, 4, 5] as const) {
      store.start(id);
      store.finishLesson(id);
    }
    factory.made[4].deps.onHome();
    expect(setLastNames).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    for (const call of setItem.mock.calls) expect(call[0]).toBe(TUTORIAL_KEY);
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    expect(settings.lastNames).toEqual(['Player 1', 'Player 2']);
    // The session's names (the real game's) are untouched.
    expect(setNames).not.toHaveBeenCalled();
    expect([...session.names]).toEqual(namesBefore);
    expect([...session.names]).toEqual(['Alice', 'Blake']);
  });
});

describe('the tutorial singleton', () => {
  afterEach(() => {
    tutorial.exitHome();
  });

  it('opens and closes with no table factory wired yet', () => {
    tutorial.open();
    expect(tutorial.active).toBe(true);
    expect(tutorial.lessonId).toBeNull();
    tutorial.exitHome();
    expect(tutorial.active).toBe(false);
  });

  it('refuses to start a lesson until T9 wires the factory, and stays on the lessons screen', () => {
    tutorial.open();
    expect(() => tutorial.start(1)).toThrow();
    expect(tutorial.lessonId).toBeNull();
    expect(tutorial.table).toBeNull();
    expect(tutorial.active).toBe(true);
  });
});
