// @vitest-environment jsdom
// R25.3 S3b at the matcher (docs/tutorial-plan.md T6, design §7.2, §5.5.1):
// every staging at every lesson move step, through the REAL GameScreen on the
// REAL wasm bridge (engine v0.2.1).
//
// For each move step (and each predicate alternative's own positions: 3.2
// after either 3.1 target, 5.4 after either Jack), the engine is walked
// there directly (no TutorialTable), `view(0)` goes into a FakeTableSource,
// and ONE GameScreen is mounted. Then, for each legal move: tap its hand card
// (or the deck, or its counter option), tap its `boardTargetKey`'s testid,
// pick it in the ambiguity chooser if one opens, read the page with
// `readStagedPage`, classify with `classifyStaged`, and Cancel.
//
// The oracle comes from the page, not from the classifier's own grouping:
// the candidates for a setup are the chooser's options when the chooser
// opened (or every counter option in the counter prompt), else the move
// alone. Verdict is right exactly when every candidate `moveMatches` the
// step, wrong exactly when none does (with the step's nudge), and unknown
// only for a mixed chooser group.
//
// Engine facts this walk relies on, beyond those cited in
// tutorial-lessons-wasm.test.ts: a 9 one-off targets opponent points
// (engine/apply.go:70-87) and a 9 cannot scuttle a 10 (card/card.go:49-56),
// so 1.5's 9-on-10 is a single-move slot; a 2 one-off targets only
// permanents and Jacks (apply.go:44-69), so no lesson 2 shares a point card
// with a scuttle; the counter window offers Decline plus one Counter per 2
// (apply.go:576-586).
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import { apply, legalMoves, restore, view } from '../../src/lib/bridge/engine';
import type { BridgeResult, Envelope, Move } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { testIdForKey } from '../../src/lib/dragDrop';
import { MoveKind } from '../../src/lib/enums';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { classifyStaged, matchingIndices, moveMatches, readStagedPage, type StagedPage } from '../../src/lib/tutorial/match';
import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { Lesson, LessonId, MovePredicate, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { FakeTableSource } from './fake-table-source.svelte';

function ok(res: BridgeResult): Envelope {
  if (!res.ok) throw new Error(`bridge error ${res.code}: ${res.message}`);
  return res;
}

function lessonOf(id: LessonId): Lesson {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} missing`);
  return l;
}

type Alternatives = Partial<Record<string, MovePredicate>>;

/** The predicate alternatives the design allows (same lines as tutorial-lessons-wasm.test.ts). */
const ALTERNATIVES: Record<LessonId, { name: string; alt: Alternatives }[]> = {
  1: [{ name: 'the only line', alt: {} }],
  2: [{ name: 'the only line', alt: {} }],
  3: [
    { name: '3.1 took the 9 of diamonds', alt: { '3.1': { kind: MoveKind.Scuttle, card: c(10, 'H'), target: c(9, 'D') } } },
    { name: '3.1 took the 6 of clubs', alt: { '3.1': { kind: MoveKind.Scuttle, card: c(10, 'H'), target: c(6, 'C') } } },
  ],
  4: [{ name: 'the only line', alt: {} }],
  5: [
    { name: '5.2 stole with the Jack of diamonds', alt: { '5.2': { kind: MoveKind.PlayPermanent, card: c(11, 'D'), target: c(7, 'D') } } },
    { name: '5.2 stole with the Jack of spades', alt: { '5.2': { kind: MoveKind.PlayPermanent, card: c(11, 'S'), target: c(7, 'D') } } },
  ],
};

/** Restores the lesson and plays every step before `stepId` (the alternative's choice, then Blake's replies). */
function arriveAt(lesson: Lesson, alt: Alternatives, stepId: string): { step: MoveStep; env: Envelope } {
  ok(restore(positionSnapshot(lesson.position), 0));
  for (const st of lesson.steps) {
    const env = ok(view(0));
    if (st.id === stepId) {
      if (st.kind !== 'move') throw new Error(`step ${stepId} is not a move step`);
      return { step: st, env };
    }
    if (st.kind !== 'move') continue;
    let matches = matchingIndices(env, st.expect);
    const narrow = alt[st.id];
    if (narrow) matches = matches.filter((i) => moveMatches(env.legalMoves[i], narrow, env.state));
    expect(matches, `step ${st.id}: one move to play on the way`).toHaveLength(1);
    ok(apply(matches[0]));
    for (const reply of st.blake) {
      const blakeEnv = ok(legalMoves());
      const idx = matchingIndices(blakeEnv, reply.move);
      expect(idx, `step ${st.id}: Blake's reply`).toHaveLength(1);
      ok(apply(idx[0]));
    }
  }
  throw new Error(`step ${stepId} not found`);
}

/**
 * The (step, alternative) pairs to walk: every move step on the first line;
 * on a later line only the steps after its own alternative, since the
 * positions before it are the first line's.
 */
function walkPlan(lesson: Lesson): { stepId: string; line: string; alt: Alternatives }[] {
  const out: { stepId: string; line: string; alt: Alternatives }[] = [];
  ALTERNATIVES[lesson.id].forEach(({ name, alt }, n) => {
    const altIds = Object.keys(alt);
    let after = n === 0;
    for (const st of lesson.steps) {
      if (st.kind === 'move' && after) out.push({ stepId: st.id, line: name, alt });
      if (!after && altIds.includes(st.id)) after = true;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The mounted page
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(source: FakeTableSource): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source } });
  flushSync();
  return host;
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

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

/** Engine indices named by a testid family on the page, e.g. `counter-option-` → [1]. */
function indicesOf(prefix: string): number[] {
  return [...(host?.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`) ?? [])]
    .map((el) => /(\d+)$/.exec(el.dataset.testid ?? '')?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number);
}

const IDLE_BOARD: StagedPage = { selectedHand: null, source: null, target: null, confirm: false, counter: null };
const FRESH_COUNTER: StagedPage = { ...IDLE_BOARD, counter: 'fresh' };

type Verdict = 'right' | 'wrong' | 'unknown';
type Tally = Record<Verdict | 'unstaged', number>;

const tallies = new Map<LessonId, Tally>();
function tallyFor(id: LessonId): Tally {
  let t = tallies.get(id);
  if (!t) {
    t = { right: 0, wrong: 0, unknown: 0, unstaged: 0 };
    tallies.set(id, t);
  }
  return t;
}

/** The step's line for a wrong candidate group: the first candidate with a specific nudge, else the generic. */
function expectedNudge(group: Move[], step: MoveStep, env: Envelope): string {
  for (const m of group) {
    const rule = step.nudges.find((r) => moveMatches(m, r.when, env.state));
    if (rule) return rule.text;
  }
  return step.generic;
}

/** Stages legal move `i` on the mounted page; returns the candidate group the page showed for that setup. */
async function stage(env: Envelope, i: number, label: string): Promise<Move[]> {
  const m = env.legalMoves[i];
  if (m.Kind === MoveKind.Counter) {
    const options = indicesOf('counter-option-');
    expect(options, `${label}: the counter option is on the page`).toContain(i);
    await click(`counter-option-${i}`);
    return options.map((k) => env.legalMoves[k]);
  }
  if (m.Kind === MoveKind.Draw) {
    await click('deck-pile');
    return [m];
  }
  await click(`hand-card-${m.HandIndex}`);
  // Selected is not staged: the coach never nudges a selection.
  const selected = readStagedPage(host!);
  expect(selected, `${label}: selected`).toEqual({ ...IDLE_BOARD, selectedHand: m.HandIndex });
  const key = boardTargetKey(m);
  if (key === null) throw new Error(`${label}: a hand move with no board key`);
  await click(testIdForKey(key));
  if (q('ambiguity-chooser') !== null) {
    const options = indicesOf('ambiguity-chooser-option-');
    expect(options, `${label}: the chooser offers it`).toContain(i);
    expect(readStagedPage(host!).confirm, `${label}: nothing staged while the chooser is open`).toBe(false);
    await click(`ambiguity-chooser-option-${i}`);
    return options.map((k) => env.legalMoves[k]);
  }
  return [m];
}

function expectedPage(m: Move): Partial<StagedPage> {
  if (m.Kind === MoveKind.Counter) return { source: null, target: null, confirm: true, counter: 'staged' };
  if (m.Kind === MoveKind.Draw) return { source: 'deck', target: 'deck', confirm: true, counter: null };
  return { source: { hand: m.HandIndex }, target: boardTargetKey(m), confirm: true, counter: null };
}

async function walkStep(lessonId: LessonId, step: MoveStep, env: Envelope, line: string): Promise<void> {
  const counterWindow = env.state.phase === 1;
  const source = new FakeTableSource();
  source.push(env);
  if (counterWindow) source.curtain = { kind: 'ack', to: 0 };
  render(source);
  await settle();
  const idle = counterWindow ? FRESH_COUNTER : IDLE_BOARD;
  expect(readStagedPage(host!), `${step.id}: idle on arrival`).toEqual(idle);
  expect(classifyStaged(idle, env, step), `${step.id}: idle is unknown`).toEqual({ verdict: 'unknown' });

  const tally = tallyFor(lessonId);
  let expectedSeen = 0;
  for (let i = 0; i < env.legalMoves.length; i++) {
    const m = env.legalMoves[i];
    const label = `${step.id} (${line}) move ${i} "${env.descriptions[i]}"`;
    if (m.Kind === MoveKind.Decline || m.Kind === MoveKind.Pass) {
      // Decline is one-tap ("Let it resolve") and never staged, so the page
      // has no setup to judge. Pass does stage (tap('pass') → #stage, with
      // Confirm present) but reads as no source, which classifies unknown
      // too; no lesson offers it. The gate handles both at commit.
      expect(classifyStaged(readStagedPage(host!), env, step), label).toEqual({ verdict: 'unknown' });
      tally.unstaged++;
      continue;
    }
    if (m.Kind === MoveKind.SevenPick || m.Kind === MoveKind.DiscardPair) throw new Error(`${label}: no lesson stages this kind`);

    const group = await stage(env, i, label);
    const page = readStagedPage(host!);
    expect(page, `${label}: the page shows what was staged`).toMatchObject(expectedPage(m));

    const hits = group.filter((g) => moveMatches(g, step.expect, env.state)).length;
    const verdict = classifyStaged(page, env, step);
    if (hits === group.length) {
      expect(verdict, `${label}: right`).toEqual({ verdict: 'right' });
    } else if (hits === 0) {
      expect(verdict, `${label}: wrong`).toEqual({ verdict: 'wrong', nudge: expectedNudge(group, step, env) });
    } else {
      expect(group.length, `${label}: unknown only for a chooser group`).toBeGreaterThan(1);
      expect(verdict, `${label}: unknown`).toEqual({ verdict: 'unknown' });
    }
    // Expected setups are never unknown (design §7.2 data rule).
    if (moveMatches(m, step.expect, env.state)) {
      expectedSeen++;
      expect(verdict, `${label}: the expected setup`).toEqual({ verdict: 'right' });
    }
    tally[verdict.verdict]++;

    await click('staging-cancel');
    expect(readStagedPage(host!), `${label}: Cancel returns to idle`).toEqual(idle);
  }
  expect(expectedSeen, `${step.id}: the expected move was staged`).toBeGreaterThan(0);
  // A FakeTableSource apply would mean a staging committed: nothing may.
  expect(source.applied, `${step.id}: nothing applied`).toEqual([]);
  cleanup();
}

let errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  settings.revealPreference = 'two-step';
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

/**
 * Verdict counts per lesson, derived by hand from the legal-move lists the
 * T3 golden tables record (tutorial-lessons-wasm.test.ts WRONG_NUDGES): one
 * right setup per expected move (two at 3.1 and 5.2), every other legal move
 * wrong, no mixed chooser group in any lesson, and step 4.2's Decline the
 * one setup that never stages. WRONG_NUDGES is keyed by description, so it
 * collapses lesson 5's duplicate Jack-steal rows (each Jack on 7D and on
 * 3H); lesson 5's 15 wrong is cross-checked against the engine's legal-move
 * generation instead (engine/apply.go:40-135 @ v0.2.1).
 */
const COUNTS: Record<LessonId, Tally> = {
  1: { right: 1, wrong: 5, unknown: 0, unstaged: 0 },
  2: { right: 2, wrong: 5, unknown: 0, unstaged: 0 },
  3: { right: 4, wrong: 18, unknown: 0, unstaged: 0 },
  4: { right: 2, wrong: 5, unknown: 0, unstaged: 1 },
  5: { right: 5, wrong: 15, unknown: 0, unstaged: 0 },
};

for (const id of [1, 2, 3, 4, 5] as const) {
  describe(`S3b lesson ${id}: every staging at every move step`, () => {
    const lesson = lessonOf(id);
    for (const { stepId, line, alt } of walkPlan(lesson)) {
      it(`step ${stepId} (${line})`, async () => {
        const { step, env } = arriveAt(lesson, alt, stepId);
        await walkStep(id, step, env, line);
      });
    }

    it('verdict counts', () => {
      expect(tallies.get(id)).toEqual(COUNTS[id]);
    });
  });
}

describe('expected setups are never unknown', () => {
  it('every move step of every lesson was walked, each alternative included', () => {
    const walked = LESSONS.flatMap((l) => walkPlan(l).map((p) => `${p.stepId}|${p.line}`));
    expect(walked).toEqual([
      '1.5|the only line',
      '2.1|the only line',
      '2.2|the only line',
      '3.1|3.1 took the 9 of diamonds',
      '3.2|3.1 took the 9 of diamonds',
      '3.2|3.1 took the 6 of clubs',
      '4.1|the only line',
      '4.2|the only line',
      '5.1|5.2 stole with the Jack of diamonds',
      '5.2|5.2 stole with the Jack of diamonds',
      '5.4|5.2 stole with the Jack of diamonds',
      '5.4|5.2 stole with the Jack of spades',
    ]);
  });
});
