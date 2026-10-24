// Test-only driver for TutorialTable (docs/tutorial-plan.md T5). Not a test
// file itself: vitest's `tests/unit/**/*.test.ts` include doesn't pick it up.
//
// The expected move at each step is found by an ORACLE that is independent
// of `lib/tutorial/match.ts`: the engine's own description of the move
// (golden strings, glyphs allowed in tests) plus, where the description
// doesn't name the target, the raw `Target`/`JackTarget` read straight off
// the envelope. A mutant in the predicate (a dropped card or target check)
// therefore can't also move the driver's idea of "right" and "wrong".
//
// Every helper is synchronous: TutorialTable.apply does all its work in the
// calling task, and the beats run on fake timers (`vi.useFakeTimers`).

import { vi } from 'vitest';

import type { Card, Envelope, Move } from '../../src/lib/bridge/schema';
import { c } from '../../src/lib/tutorial/position';
import type { TutorialTable } from '../../src/lib/tutorial/table.svelte';

interface Oracle {
  /** Engine descriptions of the expected move(s). */
  desc: string[];
  /** When the description doesn't name the target: the targeted card, any of. */
  target?: Card[];
}

/** Golden: the expected move(s) at every move step (design §5.2–§5.6). */
export const EXPECTED: Record<string, Oracle> = {
  '1.5': { desc: ['play 9♦ as point card'] },
  '2.1': { desc: ['play 7♣ as point card'] },
  '2.2': { desc: ['draw a card'] },
  '3.1': { desc: ["scuttle opponent's 9♦ with 10♥", "scuttle opponent's 6♣ with 10♥"] },
  '3.2': { desc: ["scuttle opponent's 8♣ with 8♥"] },
  '4.1': { desc: ['play A♠ as one-off'] },
  '4.2': { desc: ['counter with 2♥'] },
  '5.1': { desc: ['play 8♣ as permanent'] },
  // A Jack's description doesn't name what it steals; the raw JackTarget does.
  '5.2': { desc: ['play J♦ (steal opponent point)', 'play J♠ (steal opponent point)'], target: [c(7, 'D')] },
  '5.4': { desc: ['play K♥ as permanent'] },
};

const sameCard = (a: Card, b: Card) => a.Rank === b.Rank && a.Suit === b.Suit;

/** The card a move aims at, read from raw fields (independent of match.ts). */
function rawTarget(m: Move, env: Envelope): Card | null {
  const t = m.Target ?? m.JackTarget;
  if (!t) return null;
  const side = t.Owner === env.state.viewer ? env.state.you : env.state.opponent;
  return t.Zone === 0 ? (side.points[t.Index]?.Card ?? null) : (side.permanents[t.Index] ?? null);
}

/** The oracle's expected indices at the table's current step ([] off a move step). */
export function expectedIndices(table: TutorialTable): number[] {
  const step = table.step;
  const env = table.envelope;
  if (!env || !step || step.kind !== 'move') return [];
  const oracle = EXPECTED[step.id];
  if (!oracle) throw new Error(`no oracle for step ${step.id}`);
  const out: number[] = [];
  env.legalMoves.forEach((m, i) => {
    if (!oracle.desc.includes(env.descriptions[i])) return;
    if (oracle.target) {
      const t = rawTarget(m, env);
      if (!t || !oracle.target.some((x) => sameCard(x, t))) return;
    }
    out.push(i);
  });
  return out;
}

/** One expected index; `pick` chooses among alternatives (3.1, 5.2). */
export function expectedIndex(table: TutorialTable, pick = 0): number {
  const all = expectedIndices(table);
  if (all.length === 0) throw new Error(`no expected move at step ${table.step?.id}`);
  return all[pick % all.length];
}

/** Every legal index that is NOT the expected move (all of them off a move step). */
export function wrongIndices(table: TutorialTable): number[] {
  const env = table.envelope;
  if (!env) return [];
  const right = new Set(expectedIndices(table));
  return env.legalMoves.map((_, i) => i).filter((i) => !right.has(i));
}

/** A small seeded PRNG (mulberry32), so the fuzz is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inBeat = (table: TutorialTable) => table.phase === 'success' || table.phase === 'blake';

/**
 * Runs the fake clock one timer at a time until the table rests (a step,
 * finished or error). `onChange` sees the table after every envelope change
 * (each of Blake's replies).
 */
export function settleBeats(table: TutorialTable, onChange?: (t: TutorialTable) => void): void {
  let last = table.envelope;
  for (let n = 0; n < 50 && inBeat(table); n++) {
    vi.advanceTimersToNextTimer();
    if (table.envelope !== last) {
      last = table.envelope;
      onChange?.(table);
    }
  }
  if (inBeat(table)) throw new Error(`stuck in a beat at step ${table.step?.id}`);
}

export type DriveEvent = 'step' | 'refused' | 'move' | 'blake';

export interface DriveOptions {
  /** Up to this many wrong commits before each right action (0 = none). */
  wrongFirst?: number;
  /** PRNG seed for the wrong commits and the alternative picked. */
  seed?: number;
  /** Fixed alternative at 3.1 and 5.2 (else seeded). */
  pick?: number;
  /** Called at each step arrival, after each refusal, after the learner's move and after each Blake reply. */
  observe?: (table: TutorialTable, event: DriveEvent) => void;
}

export interface DriveResult {
  /** Wrong commits made (each must have been refused). */
  wrong: number;
  /** Step ids in the order they were completed. */
  steps: string[];
}

/** Plays one step: optional wrong commits, then the right action, then the beats. */
export function driveStep(table: TutorialTable, opts: DriveOptions = {}, rand: () => number = mulberry32(opts.seed ?? 1)): number {
  const step = table.step;
  if (!step || table.phase !== 'step') throw new Error(`not at a step (phase ${table.phase})`);
  const observe = opts.observe;
  observe?.(table, 'step');
  let wrong = 0;
  const max = opts.wrongFirst ?? 0;
  const n = max > 0 ? Math.floor(rand() * (max + 1)) : 0;
  for (let k = 0; k < n; k++) {
    const wrongs = wrongIndices(table);
    if (wrongs.length === 0) break;
    void table.apply(wrongs[Math.floor(rand() * wrongs.length)]);
    wrong++;
    observe?.(table, 'refused');
  }
  if (step.kind === 'move') {
    const pick = opts.pick ?? Math.floor(rand() * 2);
    void table.apply(expectedIndex(table, pick));
    observe?.(table, 'move');
    settleBeats(table, (t) => observe?.(t, 'blake'));
  } else if (step.kind === 'next') {
    table.next();
  } else {
    table.appeared(step.testId);
  }
  return wrong;
}

/** Drives a fresh table to the end of its lesson. */
export function driveLesson(table: TutorialTable, opts: DriveOptions = {}): DriveResult {
  const rand = mulberry32(opts.seed ?? 1);
  const result: DriveResult = { wrong: 0, steps: [] };
  for (let guard = 0; guard < 20 && table.phase === 'step'; guard++) {
    const id = table.step!.id;
    result.wrong += driveStep(table, opts, rand);
    result.steps.push(id);
  }
  return result;
}

/** Drives a fresh table up to (not through) the given step. */
export function walkTo(table: TutorialTable, stepId: string, opts: DriveOptions = {}): void {
  const rand = mulberry32(opts.seed ?? 1);
  for (let guard = 0; guard < 20 && table.phase === 'step' && table.step?.id !== stepId; guard++) {
    driveStep(table, opts, rand);
  }
  if (table.step?.id !== stepId || table.phase !== 'step') {
    throw new Error(`could not reach step ${stepId} (at ${table.step?.id}, phase ${table.phase})`);
  }
}

/** Every own-enumerable and prototype-getter child of `value`, with its key. */
function children(value: object): [string, unknown][] {
  const out: [string, unknown][] = [];
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) out.push([key, rec[key]]);
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype && proto !== Array.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc?.get) continue;
      try {
        out.push([key, desc.get.call(value)]);
      } catch {
        // an accessor that throws holds nothing we can reach
      }
    }
  }
  return out;
}

/**
 * S6 (review N1): every path from the table to a card object that is one of
 * Blake's CURRENT hidden hand cards (`hidden`, from `view(1)`; pass [] once
 * glasses show his hand). The authored lesson data is excluded wholesale:
 * it names Blake's starting hand by design and is bundled text, not engine
 * output. A stored copy of his hand, or of his legal list, is found.
 */
export function hiddenCardPaths(table: TutorialTable, hidden: readonly Card[]): string[] {
  const found: string[] = [];
  const seen = new Set<object>();
  const exclude = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const [, child] of children(v)) exclude(child);
  };
  exclude(table.lesson);
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 14 || seen.has(value)) return;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    if (typeof rec.Rank === 'number' && typeof rec.Suit === 'number' && hidden.some((h) => h.Rank === rec.Rank && h.Suit === rec.Suit)) {
      found.push(path);
    }
    for (const [key, child] of children(value)) visit(child, `${path}.${key}`, depth + 1);
  };
  visit(table, 'table', 0);
  return found;
}

/**
 * S6: every path from `root` to an object that looks like a seat-1 view
 * (`viewer === 1`, or `state.viewer === 1`). Walks own enumerable fields AND
 * every getter on the prototype chain (Svelte 5 compiles `$state` class
 * fields to private storage behind prototype accessors), recursively.
 */
export function viewerOnePaths(root: object): string[] {
  const found: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    if (rec.viewer === 1) found.push(path);
    const state = rec.state as Record<string, unknown> | undefined;
    if (state && typeof state === 'object' && state.viewer === 1) found.push(`${path}.state`);
    for (const key of Object.keys(rec)) visit(rec[key], `${path}.${key}`, depth + 1);
    for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype && proto !== Array.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc?.get) continue;
        let got: unknown;
        try {
          got = desc.get.call(value);
        } catch {
          continue;
        }
        visit(got, `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(root, 'table', 0);
  return found;
}
