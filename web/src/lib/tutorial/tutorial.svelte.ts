// Learn to play (R25.1, R25.5, R25.6): where the tutorial is, and which
// lessons are done (docs/tutorial-design.md §4.1, §4.2, §10; plan §5 T7).
//
// Memory only, apart from progress: a reload lands on Home, because a lesson
// is a minute long and isn't saved mid-way (design §4.3). Progress is written
// through `saveProgress` to `cuttle-web:tutorial` and nowhere else; a storage
// that throws keeps the memory copy for the tab.
//
// Never a prompt (D1, R25.12): nothing here opens the tutorial on its own,
// and there is no "seen" flag. The only way in is Home's `learn-to-play`
// control calling `open()`.
//
// The lesson table is built by an injected factory, typed against the slice
// of `TutorialTable` the store uses, so tests can pass a fake. The exported
// singleton builds the real `TutorialTable` (plan T9). A factory that throws
// (no engine, a broken lesson) never escapes `start()`: the lessons screen
// shows the snag line instead.

import { settings } from '../stores/settings.svelte';
import { LESSONS } from './lessons';
import { motionOn } from './motion';
import {
  defaultProgressStorage,
  isLessonId,
  loadProgress,
  normalizeProgress,
  saveProgress,
  type ProgressStorage,
} from './progress';
import { TutorialTable } from './table.svelte';
import type { Lesson, LessonId } from './types';

/** The part of `TutorialTable` (plan §5) the store relies on. */
export interface LessonTable {
  dispose(): void;
}

/**
 * The deps the store hands the table: the required fields of plan §5's
 * `TutorialTableDeps`. Its other fields are optional, so a factory taking
 * the full `TutorialTableDeps` fits `TableFactory` as is.
 */
export interface LessonTableDeps {
  learnerName: string;
  reducedMotion: () => boolean;
  /** Menu Home (design §4.3 exit 2). */
  onHome(): void;
}

export type TableFactory<T extends LessonTable = LessonTable> = (lesson: Lesson, deps: LessonTableDeps) => T;

export interface TutorialStoreDeps<T extends LessonTable> {
  /** Defaults to `localStorage`, looked up at each access. */
  storage?: ProgressStorage;
  createTable: TableFactory<T>;
  /** Defaults to B1 over `settings.lastNames`, read once per lesson start. */
  learnerName?: () => string;
  /** Defaults to `settings.reducedMotion` or the OS media query (`motionOn`, the one reduced-motion rule). */
  reducedMotion?: () => boolean;
}

/** The "Player 1" default HomeScreen treats as no name (its `prefill`). */
const DEFAULT_PLAYER_1 = 'Player 1';

/**
 * B1: the learner's on-screen name. The last-used Player 1 name, trimmed,
 * unless it is blank or the "Player 1" default; then "You". Read only:
 * nothing in the tutorial writes settings.
 */
export function learnerName(lastNames: readonly [string, string] | null): string {
  const name = lastNames?.[0]?.trim() ?? '';
  return name === '' || name === DEFAULT_PLAYER_1 ? 'You' : name;
}

export class TutorialStore<T extends LessonTable = LessonTable> {
  /** True from `open()` (or `start()`) until `exitHome()`. */
  active = $state(false);
  /** The running lesson; null = the lessons screen. */
  lessonId = $state<LessonId | null>(null);
  /** Finished lessons, sorted and unique. */
  done = $state.raw<readonly LessonId[]>([]);
  table = $state.raw<T | null>(null);
  /** The last `start()` could not build its lesson: the lessons screen shows the snag line. */
  snag = $state(false);

  readonly nextUnfinished: LessonId | null = $derived(([1, 2, 3, 4, 5] as const).find((id) => !this.done.includes(id)) ?? null);

  readonly #storage: ProgressStorage | undefined;
  readonly #createTable: TableFactory<T>;
  readonly #learnerName: () => string;
  readonly #reducedMotion: () => boolean;

  constructor(deps: TutorialStoreDeps<T>) {
    this.#storage = deps.storage;
    this.#createTable = deps.createTable;
    this.#learnerName = deps.learnerName ?? (() => learnerName(settings.lastNames));
    this.#reducedMotion = deps.reducedMotion ?? (() => !motionOn(settings.reducedMotion));
  }

  #storageNow(): ProgressStorage | undefined {
    return this.#storage ?? defaultProgressStorage();
  }

  /**
   * Home and the lessons screen call this when they mount. Stored progress
   * joins the memory copy rather than replacing it, so a storage that throws
   * or refused a write never loses a lesson finished in this tab.
   */
  reload(): void {
    this.done = normalizeProgress([...this.done, ...loadProgress(this.#storageNow())]);
  }

  /** Home's Learn to play: the lessons screen. */
  open(): void {
    this.#dropTable();
    this.active = true;
    this.lessonId = null;
    this.snag = false;
  }

  start(id: LessonId): void {
    const lesson = LESSONS.find((candidate) => candidate.id === id);
    if (!isLessonId(id) || !lesson) return;
    this.#dropTable();
    this.lessonId = null;
    this.active = true;
    this.snag = false;
    let table: T | null = null;
    const onHome = (): void => {
      // A replaced or disposed table's late call must not close a newer lesson.
      if (table !== null && this.table === table) this.exitHome();
    };
    try {
      table = this.#createTable(lesson, {
        learnerName: this.#learnerName(),
        reducedMotion: this.#reducedMotion,
        onHome,
      });
    } catch {
      // Never an uncaught error from a tap: stay on the lessons screen and say so.
      this.snag = true;
      return;
    }
    this.table = table;
    this.lessonId = id;
  }

  /** Leave (coach footer) or Lessons (done sheet): back to the lessons screen. */
  leave(): void {
    this.#dropTable();
    this.lessonId = null;
    this.snag = false;
  }

  /** Menu Home, Back on the lessons screen, or Play a game: out to Home. */
  exitHome(): void {
    this.#dropTable();
    this.lessonId = null;
    this.active = false;
    this.snag = false;
  }

  /** Called when a lesson's done sheet appears (design §4.4, §10). */
  finishLesson(id: LessonId): void {
    if (!isLessonId(id)) return;
    this.done = normalizeProgress([...this.done, id]);
    saveProgress(this.done, this.#storageNow());
  }

  /** Next lesson on the done sheet. Lesson 5 has none (its sheet offers Play a game). */
  nextLesson(): void {
    const current = this.lessonId;
    if (current === null || current === 5) return;
    this.start((current + 1) as LessonId);
  }

  #dropTable(): void {
    const table = this.table;
    this.table = null;
    table?.dispose();
  }
}

/** The app's tutorial: each lesson runs on a real `TutorialTable` over the production bridge (plan P9). */
export const tutorial = new TutorialStore<TutorialTable>({
  createTable: (lesson, deps) => new TutorialTable(lesson, deps),
});
