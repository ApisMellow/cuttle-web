// Learn to play (plan T12, T13): helpers shared by the tutorial e2e specs.
//
// - Navigation: Home -> `learn-to-play` -> `tutorial-lesson-N`.
// - Waits are on the coach bubble's `data-step` / `data-stage` (plan P8),
//   never on fixed timeouts. `settled()` polls requestAnimationFrame until the
//   page's geometry stops changing, which is a state wait too.
// - Cards are found by their accessible name on the container (hand cards and
//   point cards carry it), built from the lesson data with the same
//   `cardSpokenName` the app uses, so no rank or suit is hard-coded here.
// - A move is played with taps only: card, then target (a zone or a point
//   card), then Confirm. The DEV test hook (`window.__cuttleTestHook`) is read
//   to confirm the expected move is legal where the helper is about to play it.

import { expect, type Locator, type Page } from '@playwright/test';

import type { Card } from '../../../src/lib/bridge/schema';
import { cardSpokenName } from '../../../src/lib/theme/names';
import { LESSONS } from '../../../src/lib/tutorial/lessons';
import type { AppearStep, Lesson, MoveStep, NextStep, SpotTarget, Step } from '../../../src/lib/tutorial/types';

export const VIEWPORTS = [
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 393, height: 660 },
] as const;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every testid the tutorial adds (plan §2), matched exactly. */
export const TUTORIAL_TESTIDS = [
  'learn-to-play',
  'tutorial-lessons',
  'tutorial-lessons-back',
  'tutorial-lesson-1',
  'tutorial-lesson-2',
  'tutorial-lesson-3',
  'tutorial-lesson-4',
  'tutorial-lesson-5',
  'tutorial-continue',
  'coach-bubble',
  'coach-next',
  'coach-show-me',
  'coach-leave',
  'coach-restart',
  'coach-lesson-done',
  'coach-next-lesson',
  'coach-lessons',
  'coach-play',
] as const;

export interface Reading {
  step: string;
  stage: string;
  text: string;
  covered: boolean;
  /** The bubble's layout box (transforms ignored), or null when it is not on the page. */
  bubble: Box | null;
  /** Each `[data-coach-hole]` ring's layout box (already padded by the spotlight). */
  holes: Box[];
  /** Boxes the bubble must never cover. */
  avoid: { id: string; box: Box }[];
  /** The counter prompt's own text (heading and played lines), when it is up. */
  promptText: { id: string; box: Box }[];
  scroll: { id: string; scrollWidth: number; clientWidth: number }[];
  /** Each spotlit target (`data-coach-targets`) and whether a hit-test at its centre or near an edge lands inside it. */
  targets: { id: string; ok: boolean; hit: string }[];
  sizes: { id: string; width: number; height: number }[];
  /** False when the geometry never stopped changing. */
  stable: boolean;
}

/** Reads the coach and the page's geometry once the page has stopped moving. */
export async function settled(page: Page): Promise<Reading> {
  return page.evaluate(async (testids) => {
    const box = (r: DOMRect): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    // The bubble and hole boxes are LAYOUT boxes (offsetLeft/offsetTop), so a
    // running transform (the bubble's shake or entry, a ring's pulse) never
    // reads as a move. They are viewport boxes only because the bubble and the
    // spotlight are `position: fixed` at inset 0; if either stops being fixed
    // there, switch these to getBoundingClientRect.
    const layout = (el: HTMLElement): Box => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    const byId = (id: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

    const read = (): Omit<Reading, 'stable'> => {
      const bubbleEl = byId('coach-bubble')[0] ?? null;
      const overlay = document.querySelector<HTMLElement>('[data-coach-overlay]');
      const avoid: { id: string; box: Box }[] = [];
      for (const id of ['staging-bar', 'menu-button']) {
        for (const el of byId(id)) avoid.push({ id, box: box(el.getBoundingClientRect()) });
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="counter-option-"]')) {
        avoid.push({ id: el.dataset.testid ?? 'counter-option', box: box(el.getBoundingClientRect()) });
      }
      // What is staged: the bubble's line is about that setup (design §7.3), so it stays visible.
      for (const el of document.querySelectorAll('[data-staged="true"], [data-state="staged"]')) {
        // A staged drop-zone well has no testid of its own: its staged hit
        // button inside it is the zone (`zone-*`). Without this the well's
        // nearest testid ancestor, the whole player zone, counted as staged.
        const holder =
          (el.hasAttribute('data-testid') ? null : el.querySelector<HTMLElement>('[data-testid][data-state="staged"]')) ??
          el.closest<HTMLElement>('[data-testid]');
        if (holder && holder.dataset.testid !== 'staging-bar') {
          avoid.push({ id: `staged ${holder.dataset.testid}`, box: box(holder.getBoundingClientRect()) });
        }
      }
      const promptText: { id: string; box: Box }[] = [];
      const prompt = document.querySelector('[data-testid="counter-prompt"]');
      if (prompt) {
        for (const el of prompt.querySelectorAll<HTMLElement>('h2, li')) {
          promptText.push({ id: el.tagName.toLowerCase(), box: box(el.getBoundingClientRect()) });
        }
      }
      const sizes: { id: string; width: number; height: number }[] = [];
      for (const id of testids) {
        for (const el of byId(id)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) sizes.push({ id, width: r.width, height: r.height });
        }
      }
      const targets = (overlay?.getAttribute('data-coach-targets') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => {
          const el = byId(id)[0];
          if (!el) return { id, ok: false, hit: 'missing' };
          // Hit-test the centre and four points just inside the edges: at 393x660
          // the hand overlaps the lower half of the Permanents zone, which is
          // still a visible, tappable target. Clipped or covered means none hit.
          const r = el.getBoundingClientRect();
          const inset = Math.min(10, r.width / 4, r.height / 4);
          const points: [number, number][] = [
            [r.x + r.width / 2, r.y + r.height / 2],
            [r.x + r.width / 2, r.y + inset],
            [r.x + r.width / 2, r.y + r.height - inset],
            [r.x + inset, r.y + r.height / 2],
            [r.x + r.width - inset, r.y + r.height / 2],
          ];
          const hits = points.map(([x, y]) => document.elementFromPoint(x, y));
          const first = hits[0];
          return {
            id,
            ok: hits.some((hit) => hit !== null && el.contains(hit)),
            hit: first?.getAttribute('data-testid') ?? first?.tagName.toLowerCase() ?? 'none',
          };
        });
      const scrollTargets: [string, Element | null][] = [
        ['html', document.documentElement],
        ['body', document.body],
        ['game-screen', document.querySelector('[data-testid="game-screen"]')],
        ['board', document.querySelector('[data-testid="board"]')],
        ['coach-bubble', bubbleEl],
        ['coach-lesson-done', byId('coach-lesson-done')[0] ?? null],
      ];
      return {
        step: bubbleEl?.getAttribute('data-step') ?? '',
        stage: bubbleEl?.getAttribute('data-stage') ?? '',
        text: bubbleEl?.querySelector('[aria-live]')?.textContent?.trim() ?? '',
        covered: overlay?.getAttribute('data-covered') === 'true',
        bubble: bubbleEl ? layout(bubbleEl) : null,
        holes: Array.from(document.querySelectorAll<HTMLElement>('[data-coach-hole]')).map(layout),
        avoid,
        promptText,
        targets,
        scroll: scrollTargets.flatMap(([id, el]) => (el ? [{ id, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }] : [])),
        sizes,
      };
    };

    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let previous = JSON.stringify(read());
    let same = 0;
    for (let i = 0; i < 300 && same < 5; i++) {
      await frame();
      const current = JSON.stringify(read());
      same = current === previous ? same + 1 : 0;
      previous = current;
    }
    return { ...(JSON.parse(previous) as Omit<Reading, 'stable'>), stable: same >= 5 };
  }, [...TUTORIAL_TESTIDS]);
}

const EPS = 0.01;

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS;
}

/** Overlap in px (width x height), for failure messages. */
function overlapOf(a: Box, b: Box): string {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return `${w.toFixed(1)}x${h.toFixed(1)}px`;
}

const fmt = (b: Box): string => `[x ${b.x.toFixed(1)}, y ${b.y.toFixed(1)}, ${b.width.toFixed(1)}x${b.height.toFixed(1)}]`;

/** Every L2 rule for one settled reading; returns the problems (empty = fine). */
export function geometryProblems(r: Reading, viewport: { width: number; height: number }): string[] {
  const out: string[] = [];
  if (!r.stable) out.push('geometry never settled');
  if (r.bubble && !r.covered) {
    const b = r.bubble;
    r.holes.forEach((h, i) => {
      if (intersects(b, h)) out.push(`bubble ${fmt(b)} covers hole ${i} ${fmt(h)} by ${overlapOf(b, h)}`);
    });
    for (const a of r.avoid) {
      if (intersects(b, a.box)) out.push(`bubble ${fmt(b)} covers ${a.id} ${fmt(a.box)} by ${overlapOf(b, a.box)}`);
    }
    for (const t of r.promptText) {
      if (intersects(b, t.box)) out.push(`bubble ${fmt(b)} covers the prompt's ${t.id} ${fmt(t.box)} by ${overlapOf(b, t.box)}`);
    }
    if (b.x < -EPS || b.x + b.width > viewport.width + EPS) out.push(`bubble ${fmt(b)} leaves the viewport sideways`);
    if (b.y < -EPS || b.y + b.height > viewport.height + EPS) out.push(`bubble ${fmt(b)} leaves the viewport vertically`);
  }
  if (!r.covered) {
    for (const t of r.targets) {
      if (!t.ok) out.push(`target ${t.id} is not hit-testable anywhere (clipped or covered; centre hit: ${t.hit})`);
    }
  }
  for (const s of r.scroll) {
    if (s.scrollWidth > s.clientWidth) out.push(`${s.id}: scrollWidth ${s.scrollWidth} > clientWidth ${s.clientWidth}`);
  }
  for (const s of r.sizes) {
    if (s.width < 44 - EPS || s.height < 44 - EPS) out.push(`${s.id} is ${s.width.toFixed(1)}x${s.height.toFixed(1)}, under 44x44`);
  }
  return out;
}

// --- navigation and waits -------------------------------------------------------

export const bubble = (page: Page): Locator => page.getByTestId('coach-bubble');

export async function openLessons(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('learn-to-play').click();
  await expect(page.getByTestId('tutorial-lessons')).toBeVisible();
}

export async function openLesson(page: Page, lesson: number): Promise<void> {
  await openLessons(page);
  await page.getByTestId(`tutorial-lesson-${lesson}`).click();
  await waitStep(page, `${lesson}.1`);
}

/** Beats (a success line, Blake's pause and narration) are timers worth several seconds; `timeout` lets a walk wait them out. */
export async function waitStep(page: Page, id: string, timeout?: number): Promise<void> {
  await expect(bubble(page)).toHaveAttribute('data-step', id, timeout === undefined ? undefined : { timeout });
}

export async function waitStage(page: Page, stage: string | RegExp, timeout?: number): Promise<void> {
  await expect(bubble(page)).toHaveAttribute('data-stage', stage, timeout === undefined ? undefined : { timeout });
}

/** Waits for a stage (and optionally a step), then returns the settled reading. */
export async function reach(page: Page, stage: string | RegExp, step?: string): Promise<Reading> {
  if (step) await waitStep(page, step);
  await waitStage(page, stage);
  return settled(page);
}

// --- finding things on the board ---------------------------------------------------

export function lessonOf(id: number): Lesson {
  return LESSONS[id - 1];
}

export function stepsOf(id: number): readonly Step[] {
  return lessonOf(id).steps;
}

const asList = (c: Card | Card[]): Card[] => (Array.isArray(c) ? c : [c]);

/** A hand card by identity (aria-label starts with its spoken name). */
export function handCard(page: Page, card: Card | Card[]): Locator {
  const sel = asList(card)
    .map((c) => `[data-testid^="hand-card-"][aria-label^="${cardSpokenName(c)}"]`)
    .join(', ');
  return page.locator(sel).first();
}

/** An opponent point card by identity. */
export function opponentPoint(page: Page, card: Card | Card[]): Locator {
  const sel = asList(card)
    .map((c) => `[data-testid^="point-1-"][aria-label^="${cardSpokenName(c)}"]`)
    .join(', ');
  return page.locator(sel).first();
}

/** A hand card by rank alone (step 5.3's "your other Jack"). */
export function handRank(page: Page, rank: number): Locator {
  const name = cardSpokenName({ Rank: rank as Card['Rank'], Suit: 0 }).split(' of ')[0];
  return page.locator(`[data-testid^="hand-card-"][aria-label^="${name} of"]`).first();
}

export function locateSpot(page: Page, spot: SpotTarget): Locator {
  switch (spot.kind) {
    case 'testid':
      return page.getByTestId(spot.id);
    case 'hand':
      return handCard(page, spot.card);
    case 'handRank':
      return handRank(page, spot.rank);
    case 'point':
      return opponentPoint(page, spot.card);
    case 'counterOption':
      return page.locator('[data-testid^="counter-option-"]').first();
  }
}

// --- playing moves by taps -----------------------------------------------------------

export function moveStepsOf(lesson: number): MoveStep[] {
  return stepsOf(lesson).filter((s): s is MoveStep => s.kind === 'move');
}

/** Whether the DEV hook lists a legal move of this kind from this hand index (sanity check before playing). */
export async function hookHasMove(page: Page, kind: number, handIndex: number): Promise<boolean> {
  return page.evaluate(
    ([k, h]) => (window.__cuttleTestHook?.moves() ?? []).some((m) => m.kind === k && m.handIndex === h),
    [kind, handIndex] as const,
  );
}

export async function handIndexOf(card: Locator): Promise<number> {
  const id = (await card.getAttribute('data-testid')) ?? '';
  return Number(id.replace('hand-card-', ''));
}

/** Taps the step's source: the card, the deck, or the counter option. */
export async function tapSource(page: Page, step: MoveStep): Promise<void> {
  const el = locateSpot(page, step.source);
  if (step.source.kind === 'hand') {
    expect(await hookHasMove(page, step.expect.kind, await handIndexOf(el))).toBe(true);
  }
  await el.click();
}

/** Taps the step's target: a zone, a point card, the deck again, or (counter) nothing. */
export async function tapTarget(page: Page, step: MoveStep): Promise<void> {
  if (step.source.kind === 'counterOption') return; // staging the option is the whole setup
  if (step.source.kind === 'testid' && step.source.id === 'deck-pile') return; // the first tap staged the draw
  await locateSpot(page, step.target).click();
}

export async function confirm(page: Page): Promise<void> {
  await page.getByTestId('staging-confirm').click();
}

export async function cancel(page: Page): Promise<void> {
  await page.getByTestId('staging-cancel').click();
}

/** A deliberately wrong setup per step: a staged move the coach must call wrong (design §7.2). */
export interface WrongSetup {
  /** The wrong card to tap, or `'deck'`. */
  source: Card | 'deck';
  /** A zone testid, or an opponent point card. */
  target?: string | Card;
}

/** One wrong staged setup for every board step. Step 4.2 has none (design §5.5.1). */
export function wrongSetup(stepId: string): WrongSetup | null {
  const L = (rank: number, suit: 0 | 1 | 2 | 3): Card => ({ Rank: rank as Card['Rank'], Suit: suit });
  const [C, D, H, S] = [0, 1, 2, 3] as const;
  switch (stepId) {
    case '1.5':
      return { source: L(9, D), target: L(10, S) }; // the 9 as a one-off on Blake's 10
    case '2.1':
    case '2.2':
      return { source: L(3, D), target: 'zone-points' };
    case '3.1':
      return { source: L(10, H), target: 'zone-points' };
    case '3.2':
      return { source: L(8, H), target: 'zone-points' };
    case '4.1':
      return { source: L(1, S), target: 'zone-points' };
    case '5.1':
      return { source: L(8, C), target: 'zone-points' };
    case '5.2':
      return { source: L(13, H), target: 'zone-permanents' };
    case '5.4':
      return { source: 'deck' };
    default:
      return null;
  }
}

/**
 * Taps a wrong setup up to the staging bar (the coach should then be
 * `staged-wrong`). `via: 'tap'` uses touch taps on a touch context.
 */
export async function stageWrong(page: Page, setup: WrongSetup, via: 'click' | 'tap' = 'click'): Promise<void> {
  const press = (target: Locator): Promise<void> => (via === 'tap' ? target.tap() : target.click());
  if (setup.source === 'deck') {
    await press(page.getByTestId('deck-pile'));
    return;
  }
  await press(handCard(page, setup.source));
  // A real tap: the wrong target is not spotlit, but it is lit (a legal place
  // for the selected card), and at `selected` the bubble keeps clear of every
  // lit target (T12b), so nothing covers it.
  if (typeof setup.target === 'string') await press(page.getByTestId(setup.target));
  else if (setup.target) await press(opponentPoint(page, setup.target));
}

/** The learner closes the card popover opened by step 5.3. */
export async function closePopover(page: Page): Promise<void> {
  await page.getByTestId('card-detail-popover-close').click();
}

/**
 * The expected move of `step`, by taps, up to and including Confirm. Returns
 * with the success beat started (the caller waits for what follows).
 */
export async function playExpected(page: Page, step: MoveStep): Promise<void> {
  await tapSource(page, step);
  await tapTarget(page, step);
  await confirm(page);
}

/** Skips straight to a step by playing every earlier step's expected move, waiting out each beat. */
export async function playThrough(page: Page, lesson: number, upToStepId: string): Promise<void> {
  for (const step of stepsOf(lesson)) {
    if (step.id === upToStepId) return;
    // A step can follow a success beat, Blake's think pause and his narration.
    await waitStep(page, step.id, BEAT_MS);
    if (step.kind === 'next') {
      await waitStage(page, 'next');
      await page.getByTestId('coach-next').click();
    } else if (step.kind === 'appear') {
      await waitStage(page, 'appear');
      await handRank(page, 11).click();
      await expect(page.getByTestId(step.testId)).toBeVisible();
      await closePopover(page);
    } else {
      await waitStage(page, /^(idle|selected|refused)$/);
      await playExpected(page, step);
    }
  }
}

// =====================================================================================
// T13: whole-lesson walkthroughs. The three specs (touch, keyboard, reduced motion)
// share one walker and differ only in how the learner's input is made.
// =====================================================================================

/** A beat (success line, Blake's pause and narration) is a few seconds of timers. */
export const BEAT_MS = 20_000;

export const TUTORIAL_KEY = 'cuttle-web:tutorial';
export const SETTINGS_KEY = 'cuttle-web:settings';
export const GAME_KEY = 'cuttle-web:game';

// --- storage -------------------------------------------------------------------------

/** Every localStorage entry, raw. */
export async function storageDump(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) out[key] = localStorage.getItem(key) ?? '';
    }
    return out;
  });
}

/** Parsed JSON with every `savedAt` stamp removed, so a rewrite that only moves a clock still compares equal; non-JSON stays a string. */
function withoutTimestamps(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw, (k, v) => (k === 'savedAt' ? undefined : v));
  } catch {
    return raw;
  }
}

/**
 * The tutorial's storage contract (plan §2): nothing but `cuttle-web:tutorial`
 * is written. Every key that existed before the run is byte-identical after it,
 * and the only key that may be new is the tutorial's.
 */
export function expectStorageUntouched(before: Record<string, string>, after: Record<string, string>): void {
  for (const [key, value] of Object.entries(before)) {
    expect(withoutTimestamps(after[key]), `${key} must be unchanged after the run`).toEqual(withoutTimestamps(value));
  }
  const added = Object.keys(after).filter((key) => !(key in before));
  expect(added.filter((key) => key !== TUTORIAL_KEY), 'no key but the tutorial\'s may appear').toEqual([]);
}

/** The finished lessons as saved, sorted, or null when nothing is saved. */
export async function readProgress(page: Page): Promise<number[] | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), TUTORIAL_KEY);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as { v: number; done: number[] };
  return [...parsed.done].sort((a, b) => a - b);
}

/**
 * Seeds `cuttle-web:settings` before the page loads (and only if nothing is
 * there yet). The init script runs on EVERY navigation and reload, so once
 * the key is missing it is written again: don't rely on it across a reload
 * when a test checks that the key was deleted.
 */
export async function seedSettings(page: Page, value: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(value);
  await page.addInitScript(
    ([key, text]) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, text);
      } catch {
        // storage unavailable: the app falls back to defaults
      }
    },
    [SETTINGS_KEY, raw] as const,
  );
  return raw;
}

/**
 * A real saved pass-and-play game, left at Home: the golden deal, revealed,
 * then menu -> Home (which keeps the save). A walkthrough that finishes with
 * this save and the settings (names) byte-identical has proved the tutorial
 * never touches either.
 */
export async function seedSavedGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await page.evaluate(() => window.__cuttleTestHook?.newGame('42', 1));
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('game-menu')).toBeVisible();
  await page.getByTestId('menu-home').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('resume')).toBeVisible();
}

// --- copy checks (read from LESSONS, never hard-coded) -----------------------------------

/** Appended to a nudge while a wrong move is staged (lessons.ts CANCEL_SUFFIX). */
export { CANCEL_SUFFIX } from '../../../src/lib/tutorial/lessons';

/** The step's nudge texts and its generic line: whatever a wrong move can be told. */
export function nudgeTexts(step: MoveStep): string[] {
  return [...step.nudges.map((n) => n.text), step.generic];
}

/** The coach's live line, trimmed. */
export async function coachText(page: Page): Promise<string> {
  return ((await bubble(page).locator('[aria-live]').textContent()) ?? '').trim();
}

/** The overlay's spotlit testids (`data-coach-targets`). */
export async function coachTargets(page: Page): Promise<string[]> {
  const raw = (await page.locator('[data-coach-overlay]').getAttribute('data-coach-targets')) ?? '';
  return raw.split(' ').filter(Boolean);
}

// --- the walker -------------------------------------------------------------------------

export interface WalkIO {
  /** Activates Next on a `next` step. */
  next(page: Page, step: NextStep): Promise<void>;
  /** The learner's right move on a `move` step, through its commit (Confirm, or the deck's second tap). */
  move(page: Page, step: MoveStep): Promise<void>;
  /** Step 5.3: the learner taps the other Jack and closes the popover. */
  appear(page: Page, step: AppearStep): Promise<void>;
  /** A step at rest: stage `next`, `appear` or `idle`. */
  atRest?(page: Page, lesson: Lesson, step: Step): Promise<void>;
  /** A move step at rest, just before the right move (the wrong stagings go here). */
  beforeMove?(page: Page, lesson: Lesson, step: MoveStep): Promise<void>;
  /** The done sheet is up and its heading, line and saved progress have been checked. */
  atDone?(page: Page, lesson: Lesson): Promise<void>;
}

/** The done sheet's heading (LessonDoneSheet): the final lesson reads "You've learned Cuttle". */
export function doneHeading(lessonId: number): string {
  return lessonId === 5 ? "You've learned Cuttle" : `Lesson ${lessonId} done`;
}

/**
 * Plays one lesson from its first step to its done sheet. Every wait is on
 * `data-step` / `data-stage` or the sheet; beats are waited out, never slept.
 * `expectedDone` is the saved progress the sheet must have written.
 */
export async function walkLesson(page: Page, lessonId: number, io: WalkIO, expectedDone: number[]): Promise<void> {
  const lesson = lessonOf(lessonId);
  for (const step of lesson.steps) {
    await waitStep(page, step.id, BEAT_MS);
    if (step.kind === 'next') {
      await waitStage(page, 'next', BEAT_MS);
      await io.atRest?.(page, lesson, step);
      await io.next(page, step);
    } else if (step.kind === 'appear') {
      await waitStage(page, 'appear', BEAT_MS);
      await io.atRest?.(page, lesson, step);
      await io.appear(page, step);
    } else {
      await waitStage(page, 'idle', BEAT_MS);
      await io.atRest?.(page, lesson, step);
      await io.beforeMove?.(page, lesson, step);
      await io.move(page, step);
    }
  }
  const sheet = page.getByTestId('coach-lesson-done');
  await expect(sheet).toBeVisible({ timeout: BEAT_MS });
  await expect(sheet.getByRole('heading')).toHaveText(doneHeading(lessonId));
  await expect(sheet).toContainText(lesson.done);
  // R25.5: progress is written when the sheet appears.
  await expect.poll(() => readProgress(page)).toEqual(expectedDone);
  await io.atDone?.(page, lesson);
}

/** After the final lesson's "Play a game": Home reports all five done. */
export async function expectHomeAllDone(page: Page): Promise<void> {
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('learn-to-play')).toBeVisible();
  await expect(page.getByText('All 5 lessons done', { exact: true })).toBeVisible();
  await expect(page.getByTestId('coach-bubble')).toHaveCount(0);
}

// --- touch ----------------------------------------------------------------------------

export interface Finger {
  start(p: { x: number; y: number }): Promise<void>;
  move(p: { x: number; y: number }): Promise<void>;
  end(): Promise<void>;
}

/** A finger on Chromium's real touch pipeline (CDP `Input.dispatchTouchEvent`), as the drag-drop spec does. */
export async function newFinger(page: Page): Promise<Finger> {
  const cdp = await page.context().newCDPSession(page);
  let last = { x: 0, y: 0 };
  return {
    async start(p) {
      last = p;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    },
    async move(p) {
      const steps = 8; // several small moves, as a finger reports them
      for (let i = 1; i <= steps; i++) {
        const x = last.x + ((p.x - last.x) * i) / steps;
        const y = last.y + ((p.y - last.y) * i) / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      last = p;
    },
    async end() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('no box to aim at');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A press that lasts, as a real finger does: touchstart, `holdMs`, touchend,
 * on the target's centre. The hold is the point of the test (a tap handler
 * that acts on `pointerdown` or `click` must also survive a press that
 * lingers), so it is the one fixed delay in these specs.
 */
export async function press(page: Page, finger: Finger, target: Locator, holdMs = 100): Promise<void> {
  await finger.start(await centreOf(target));
  await page.waitForTimeout(holdMs);
  await finger.end();
}

/**
 * Drags a hand card onto a target: grab the always-visible left slice, move
 * past the 8 px threshold (which selects the card, as a tap would), wait for
 * the coach to follow, aim at the target where it is NOW, and release.
 */
export async function dragCardTo(page: Page, finger: Finger, card: Locator, target: Locator): Promise<void> {
  const box = await card.boundingBox();
  if (!box) throw new Error('hand card has no box');
  const grip = { x: box.x + 16, y: box.y + box.height / 2 };
  await finger.start(grip);
  await finger.move({ x: grip.x, y: grip.y - 30 });
  await expect(card).toHaveAttribute('data-dragging', 'true');
  await waitStage(page, 'selected');
  await finger.move(await centreOf(target));
  await finger.end();
}

/** The learner's right move on a touch screen: drag a hand card, tap the deck or the counter option, then commit. */
export async function touchMove(page: Page, finger: Finger, step: MoveStep): Promise<void> {
  const source = locateSpot(page, step.source);
  if (step.source.kind === 'hand') {
    expect(await hookHasMove(page, step.expect.kind, await handIndexOf(source))).toBe(true);
    await dragCardTo(page, finger, source, locateSpot(page, step.target));
    await waitStage(page, 'staged-right');
    await page.getByTestId('staging-confirm').tap();
  } else if (step.source.kind === 'testid' && step.source.id === 'deck-pile') {
    await source.tap(); // stages the draw
    await waitStage(page, 'staged-right');
    await source.tap(); // the second tap commits it (issue #24)
  } else {
    await source.tap(); // the counter option: staging it is the whole setup
    await waitStage(page, 'staged-right');
    await page.getByTestId('staging-confirm').tap();
  }
}

// --- keyboard -------------------------------------------------------------------------

export const activeTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

/** Presses Tab until `testId` has focus (focus never jumps by script here); returns how many presses it took. */
export async function focusByKeys(page: Page, testId: string, max = 80): Promise<number> {
  if ((await activeTestId(page)) === testId) return 0;
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    if ((await activeTestId(page)) === testId) return i;
  }
  throw new Error(`Tab never reached ${testId} in ${max} presses (focus is on ${await activeTestId(page)})`);
}

export type ActivateKey = 'Enter' | 'Space';

/**
 * The learner's right move from the keyboard: Tab to the source, activate it
 * (focus then lands on a lit target), Tab to the step's target if it is not
 * the one focused, activate it, then activate Confirm (the deck takes a second
 * activation of the staged draw, a hand card or the counter option goes via
 * Confirm).
 */
export async function keyMove(page: Page, step: MoveStep, select: ActivateKey, confirmKey: ActivateKey): Promise<void> {
  const source = locateSpot(page, step.source);
  const sourceId = (await source.getAttribute('data-testid')) ?? '';
  expect(sourceId).not.toBe('');
  await focusByKeys(page, sourceId);
  await page.keyboard.press(select);
  if (step.source.kind === 'hand') {
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    const targetId = step.target.kind === 'testid' ? step.target.id : ((await locateSpot(page, step.target).getAttribute('data-testid')) ?? '');
    expect(targetId).not.toBe('');
    await focusByKeys(page, targetId);
    await page.keyboard.press(select);
  }
  await waitStage(page, 'staged-right');
  await focusByKeys(page, 'staging-confirm');
  await page.keyboard.press(confirmKey);
}

// --- reduced motion ---------------------------------------------------------------------

/** Every Web Animation or CSS transition/animation still alive on the page, described. */
export async function animationsNow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document.getAnimations().map((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target ?? null;
      const where = target?.closest('[data-testid]')?.getAttribute('data-testid') ?? target?.className?.toString() ?? target?.tagName ?? 'nowhere';
      const kind =
        'transitionProperty' in a ? `transition ${String((a as { transitionProperty: unknown }).transitionProperty)}` :
        'animationName' in a ? `animation ${String((a as { animationName: unknown }).animationName)}` :
        'script animation';
      return `${kind} on ${where} (${a.playState})`;
    }),
  );
}

/** The numbered reduced-motion markers on screen, in order. */
export async function markers(page: Page): Promise<string[]> {
  const texts = await page.locator('[data-part="marker"]').allTextContents();
  return texts.map((t) => t.trim()).sort();
}

/** Waits for the geometry to settle, then for every animation to be gone. */
export async function settledCalm(page: Page): Promise<void> {
  await settled(page);
  await expect.poll(() => animationsNow(page), { message: 'no animation may be running once a step has settled' }).toEqual([]);
}

/** Writes a screenshot when `TUTORIAL_SHOTS_DIR` is set (before/after evidence for placement work). */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.TUTORIAL_SHOTS_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${process.env.TUTORIAL_SHOTS_PREFIX ?? ''}${name}.png` });
}
