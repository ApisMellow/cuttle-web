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
import type { Lesson, MoveStep, SpotTarget, Step } from '../../../src/lib/tutorial/types';

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
  /** Each spotlit target (`data-coach-targets`) and whether a hit-test at its centre lands inside it. */
  targets: { id: string; ok: boolean; hit: string }[];
  sizes: { id: string; width: number; height: number }[];
  /** False when the geometry never stopped changing. */
  stable: boolean;
}

/** Reads the coach and the page's geometry once the page has stopped moving. */
export async function settled(page: Page): Promise<Reading> {
  return page.evaluate(async (testids) => {
    const box = (r: DOMRect): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height });
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
        const holder = el.closest<HTMLElement>('[data-testid]');
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

export async function waitStep(page: Page, id: string): Promise<void> {
  await expect(bubble(page)).toHaveAttribute('data-step', id);
}

export async function waitStage(page: Page, stage: string | RegExp): Promise<void> {
  await expect(bubble(page)).toHaveAttribute('data-stage', stage);
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

function locateSpot(page: Page, spot: SpotTarget): Locator {
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
async function hookHasMove(page: Page, kind: number, handIndex: number): Promise<boolean> {
  return page.evaluate(
    ([k, h]) => (window.__cuttleTestHook?.moves() ?? []).some((m) => m.kind === k && m.handIndex === h),
    [kind, handIndex] as const,
  );
}

async function handIndexOf(card: Locator): Promise<number> {
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

/** Taps a wrong setup up to the staging bar (the coach should then be `staged-wrong`). */
export async function stageWrong(page: Page, setup: WrongSetup): Promise<void> {
  if (setup.source === 'deck') {
    await page.getByTestId('deck-pile').click();
    return;
  }
  await handCard(page, setup.source).click();
  // The wrong target is, by definition, not spotlit, and the bubble may sit
  // over unspotlit board (design §7.3), so it is activated the way a key press
  // would, not by a pointer hit-test.
  if (typeof setup.target === 'string') await page.getByTestId(setup.target).dispatchEvent('click');
  else if (setup.target) await opponentPoint(page, setup.target).dispatchEvent('click');
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
    await waitStep(page, step.id);
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

/** Writes a screenshot when `TUTORIAL_SHOTS_DIR` is set (before/after evidence for placement work). */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.TUTORIAL_SHOTS_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${process.env.TUTORIAL_SHOTS_PREFIX ?? ''}${name}.png` });
}
