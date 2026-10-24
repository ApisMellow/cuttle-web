// Learn to play (R25.5): which lessons are finished, and nothing else
// (docs/tutorial-design.md §10, plan §5 T7).
//
// One key, `cuttle-web:tutorial`, holding exactly `{"v":1,"done":[…]}`: the
// lesson numbers finished, sorted, unique, 1-5. There is no "seen" flag of
// any kind (D1). A malformed value, a wrong `v` or unknown lesson numbers
// read as "nothing done" (unknown numbers dropped) and are rewritten on the
// next completion. Never part of the game snapshot, the settings key or the
// session tally.
//
// Every storage access is wrapped: a storage that throws (private browsing,
// quota, disabled storage) reads as nothing done and a failed write returns
// false, so the tutorial and the game work with no storage at all.

import type { LessonId } from './types';

export const TUTORIAL_KEY = 'cuttle-web:tutorial';

/** The only storage calls the tutorial makes. It never removes a key. */
export type ProgressStorage = Pick<Storage, 'getItem' | 'setItem'>;

const VERSION = 1;
const LESSON_IDS: readonly LessonId[] = [1, 2, 3, 4, 5];

export function isLessonId(value: unknown): value is LessonId {
  return typeof value === 'number' && (LESSON_IDS as readonly number[]).includes(value);
}

/** Sorted, unique, only 1-5. */
export function normalizeProgress(done: Iterable<unknown>): LessonId[] {
  const seen = new Set<LessonId>();
  for (const value of done) if (isLessonId(value)) seen.add(value);
  return LESSON_IDS.filter((id) => seen.has(id));
}

export function decodeProgress(raw: string | null): LessonId[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.v !== VERSION || !Array.isArray(record.done)) return [];
  return normalizeProgress(record.done);
}

export function encodeProgress(done: Iterable<LessonId>): string {
  return JSON.stringify({ v: VERSION, done: normalizeProgress(done) });
}

/** `localStorage`, or undefined where it is missing or reading it throws. */
export function defaultProgressStorage(): ProgressStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadProgress(storage: Pick<Storage, 'getItem'> | undefined = defaultProgressStorage()): LessonId[] {
  if (!storage) return [];
  try {
    return decodeProgress(storage.getItem(TUTORIAL_KEY));
  } catch {
    return [];
  }
}

/** True when the write landed; false (never a throw) when storage refused it. */
export function saveProgress(
  done: Iterable<LessonId>,
  storage: Pick<Storage, 'setItem'> | undefined = defaultProgressStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TUTORIAL_KEY, encodeProgress(done));
    return true;
  } catch {
    return false;
  }
}
