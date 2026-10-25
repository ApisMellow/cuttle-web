// Tutorial T5 (docs/tutorial-plan.md §6 T5; design §6.2, §5.5.1, §7.4):
// TutorialTable, the third TableSource. Real wasm (engine v0.2.1 through
// the production lib/bridge/engine.ts calls), fake timers for the beats.
//
// Ledger map (docs/requirements.yaml):
//   R25.3 S3a  -> 'S3a refuses every wrong move at every move step'
//   R25.3 S3c  -> 'S3c step 4.2 at the store'
//   R25.3 S4   -> 'S4 fuzz finishes every lesson', 'errors are never a dead end'
//   R25.3 "the apply gate is TutorialTable.apply only; the legal-move list is
//              the engine's" -> 'the apply gate is apply only', 'the legal list is the engine's'
//   R25.4 S6   -> 'S6 seat-0 view only'
//   (S5 lives in tutorial-isolation.test.ts.)
// Plus the plan's own red tests: start state, P1 refusals outside a move
// step (Review focus 2), P3 beat order, stale timers (Review focus 3),
// motion hooks, and B6 (PASS in round 1: the post-win view(0) stays on show).
//
// Engine v0.2.1 facts relied on (module github.com/ApisMellow/cuttle):
//   - Legal moves and descriptions go only to the actor: internal/game/envelope.go:245-250,
//     so view(0) carries none while Blake is active.
//   - Blake's 4 opens a counter window because Alice holds an unfrozen 2:
//     engine/apply.go:324-341, hasLegalCounter :489-497; the window offers
//     Decline plus one Counter: apply.go:576-586. The counter cancels the
//     4 and hands the turn back: apply.go:342-365, resolvePending :591-608.
//   - PlayPoint/PlayPermanent win on the spot: apply.go:174-192, :232-242,
//     checkWin :817-826.
//   - Glasses show Blake's hand in Alice's view: internal/game/view.go:78-88.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as bridge from '../../src/lib/bridge/engine';
import type { BridgeResult, Envelope } from '../../src/lib/bridge/schema';
import { MoveKind, Phase } from '../../src/lib/enums';
import { BLAKE_THINKING, LESSONS, NEXT_FIRST, SNAG_LINE } from '../../src/lib/tutorial/lessons';
import { matchingIndices, nudgeFor } from '../../src/lib/tutorial/match';
import { c } from '../../src/lib/tutorial/position';
import {
  BLAKE_DONE_BEAT_MS,
  BLAKE_THINK_MS,
  BLAKE_THINK_REDUCED_MS,
  SUCCESS_BEAT_MS,
  TutorialTable,
  type TutorialClock,
  type TutorialEngine,
  type TutorialTableDeps,
} from '../../src/lib/tutorial/table.svelte';
import type { TableSource } from '../../src/lib/stores/tableSource';
import type { Lesson, LessonId, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import {
  auditHooks,
  driveLesson,
  expectedIndex,
  hiddenCardPaths,
  expectedIndices,
  settleBeats,
  viewerOnePaths,
  walkTo,
  wrongIndices,
} from './tutorial-driver';

beforeAll(async () => {
  await createWasmEngine();
});

const made: TutorialTable[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const t of made.splice(0)) t.dispose();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function lessonOf(id: LessonId): Lesson {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} missing`);
  return l;
}

function make(lesson: Lesson | LessonId, deps: Partial<TutorialTableDeps> = {}): TutorialTable {
  const t = new TutorialTable(typeof lesson === 'number' ? lessonOf(lesson) : lesson, {
    learnerName: 'Alice',
    reducedMotion: () => false,
    onHome: () => {},
    ...deps,
  });
  made.push(t);
  return t;
}

function ok(res: BridgeResult): Envelope {
  if (!res.ok) throw new Error(`bridge error ${res.code}: ${res.message}`);
  return res;
}

const snap = () => bridge.snapshot();
const view0 = () => ok(bridge.view(0));

/** The real engine with call recording. */
function recordingEngine(log: string[], overrides: Partial<TutorialEngine> = {}): TutorialEngine {
  return {
    restore: (json, viewer) => (log.push('restore'), bridge.restore(json, viewer)),
    apply: (i) => (log.push(`apply:${i}`), bridge.apply(i)),
    view: (v) => (log.push(`view:${v}`), bridge.view(v)),
    legalMoves: () => (log.push('legalMoves'), bridge.legalMoves()),
    snapshot: () => bridge.snapshot(),
    ...overrides,
  };
}

const ALL: LessonId[] = [1, 2, 3, 4, 5];
/** Lessons with two expected alternatives (3.1 either target, 5.2 either Jack). */
const PICKS: Record<LessonId, number[]> = { 1: [0], 2: [0], 3: [0, 1], 4: [0], 5: [0, 1] };

describe('starts on Alice\'s view', () => {
  for (const id of ALL) {
    it(`lesson ${id}`, () => {
      const t = make(id, { learnerName: 'Alice' });
      expect(t.viewer).toBe(0);
      expect(t.envelope?.state.viewer).toBe(0);
      expect(t.envelope).toEqual(view0());
      expect(t.curtain).toEqual({ kind: 'none' });
      expect(t.seq).toBe(0);
      expect(t.history).toEqual([]);
      expect(t.names).toEqual(['Alice', 'Blake']);
      expect(t.allowsNewGame).toBe(false);
      expect(t.refusals).toBe(0);
      expect(t.pending).toBe(false);
      expect(t.drawReveal).toBeNull();
      expect((t as TableSource).online ?? null).toBeNull();
      expect(t.stepIndex).toBe(0);
      expect(t.step).toBe(lessonOf(id).steps[0]);
      expect(t.phase).toBe('step');
      expect(t.line).toEqual({ text: lessonOf(id).steps[0].main, tone: 'main' });
      expect(t.lastNudge).toBeNull();
      expect(t.wrongTries).toBe(0);
    });
  }

  it('takes the learner name it is given', () => {
    expect(make(2, { learnerName: 'You' }).names).toEqual(['You', 'Blake']);
  });

  it('the oracle agrees with the lesson predicates on the unmutated code', () => {
    for (const id of ALL) {
      for (const pick of PICKS[id]) {
        const t = make(id);
        driveLesson(t, {
          pick,
          observe: (tt, ev) => {
            if (ev !== 'step' || tt.step?.kind !== 'move') return;
            expect(expectedIndices(tt), `step ${tt.step.id}`).toEqual(matchingIndices(tt.envelope!, tt.step.expect));
          },
        });
        expect(t.phase).toBe('finished');
      }
    }
  });
});

describe('S3a refuses every wrong move at every move step', () => {
  for (const id of ALL) {
    for (const pick of PICKS[id]) {
      it(`lesson ${id}${PICKS[id].length > 1 ? ` (alternative ${pick})` : ''}`, () => {
        const t = make(id);
        let moveSteps = 0;
        for (let guard = 0; guard < 20 && t.phase === 'step'; guard++) {
          const step = t.step!;
          if (step.kind === 'move') {
            moveSteps++;
            const wrongs = wrongIndices(t);
            expect(wrongs.length, `step ${step.id} has a wrong move to try`).toBeGreaterThan(0);
            for (const [k, i] of wrongs.entries()) {
              const before = snap();
              const env = t.envelope!;
              const seq = t.seq;
              const history = t.history;
              const refusals = t.refusals;
              const move = env.legalMoves[i];
              void t.apply(i);
              expect(snap(), `step ${step.id} wrong ${env.descriptions[i]}: bridge unchanged`).toBe(before);
              expect(t.envelope).toBe(env);
              expect(t.seq).toBe(seq);
              expect(t.history).toBe(history);
              expect(t.refusals).toBe(refusals + 1);
              expect(t.wrongTries).toBe(k + 1);
              expect(t.lastNudge).toBe(nudgeFor(move, step as MoveStep, env.state));
              expect(t.line).toEqual({ text: t.lastNudge, tone: 'nudge' });
              expect(t.phase).toBe('step');
              expect(t.step).toBe(step);
              expect(t.pending).toBe(false);
            }
            // The expected move still completes the step.
            const before = snap();
            void t.apply(expectedIndex(t, pick));
            expect(snap()).not.toBe(before);
            expect(t.phase).toBe('success');
            expect(t.lastNudge).toBeNull();
            settleBeats(t);
          } else if (step.kind === 'next') {
            t.next();
          } else {
            t.appeared(step.testId);
          }
        }
        expect(t.phase).toBe('finished');
        expect(moveSteps).toBe(lessonOf(id).steps.filter((s) => s.kind === 'move').length);
      });
    }
  }

  it('an index past the end of the list is refused like a wrong move', () => {
    const t = make(2);
    const before = snap();
    void t.apply(999);
    expect(snap()).toBe(before);
    expect(t.refusals).toBe(1);
    expect(t.lastNudge).toBe((lessonOf(2).steps[0] as MoveStep).generic);
  });

  it('wrongTries counts refused commits and staged-wrong notes; a new step starts clean', () => {
    const t = make(2);
    void t.apply(wrongIndices(t)[0]);
    t.noteStagedWrong();
    expect(t.wrongTries).toBe(2);
    expect(t.refusals).toBe(1);
    void t.apply(expectedIndex(t));
    settleBeats(t);
    expect(t.step?.id).toBe('2.2');
    expect(t.wrongTries).toBe(0);
    expect(t.lastNudge).toBeNull();
    expect(t.line).toEqual({ text: (t.step as MoveStep).main, tone: 'main' });
    // Off a move step, a staged-wrong note counts nothing.
    walkTo(t, '2.3');
    t.noteStagedWrong();
    expect(t.wrongTries).toBe(0);
  });
});

describe('refuses every commit outside a move step (Review focus 2, plan P1)', () => {
  function refuseAll(t: TutorialTable, line: string | null): void {
    const env = t.envelope!;
    const indices = env.legalMoves.map((_, i) => i);
    const beforeLine = t.line;
    const beforeNudge = t.lastNudge;
    for (const i of [...indices, indices.length]) {
      const before = snap();
      const refusals = t.refusals;
      void t.apply(i);
      expect(snap(), `index ${i}`).toBe(before);
      expect(t.envelope).toBe(env);
      expect(t.refusals).toBe(refusals + 1);
      expect(t.wrongTries).toBe(0);
      if (line === null) {
        expect(t.lastNudge).toBe(beforeNudge);
        expect(t.line).toEqual(beforeLine);
      } else {
        expect(t.lastNudge).toBe(line);
        expect(t.line).toEqual({ text: line, tone: 'nudge' });
      }
    }
  }

  it('steps 1.1 to 1.4 (next): every legal move is refused with "Tap Next first."', () => {
    const t = make(1);
    for (const id of ['1.1', '1.2', '1.3', '1.4']) {
      expect(t.step?.id).toBe(id);
      expect(t.envelope!.legalMoves.length, `${id}: the learner can already stage moves`).toBeGreaterThan(0);
      refuseAll(t, NEXT_FIRST);
      t.next();
    }
    expect(t.step?.id).toBe('1.5');
    // Next does nothing at a move step.
    t.next();
    expect(t.step?.id).toBe('1.5');
  });

  it('step 2.3 (next) and lesson 2 finished', () => {
    const t = make(2);
    walkTo(t, '2.3');
    refuseAll(t, NEXT_FIRST);
    t.next();
    expect(t.phase).toBe('finished');
    expect(t.envelope!.legalMoves.length).toBeGreaterThan(0);
    refuseAll(t, null);
  });

  it('step 5.3 (appear): refused with its own line; only the named element completes it', () => {
    const t = make(5);
    walkTo(t, '5.3');
    refuseAll(t, 'First, tap your other Jack.');
    t.appeared('menu-home');
    expect(t.step?.id).toBe('5.3');
    t.next();
    expect(t.step?.id).toBe('5.3');
    t.appeared('card-detail-popover');
    expect(t.step?.id).toBe('5.4');
  });

  for (const id of ALL) {
    it(`lesson ${id} finished: every commit is refused, no copy change`, () => {
      const t = make(id);
      driveLesson(t);
      expect(t.phase).toBe('finished');
      refuseAll(t, null);
    });
  }
});

describe('S3c step 4.2 at the store', () => {
  it('ack on arrival, ack through every refused Decline, none after the counter', () => {
    const t = make(4);
    const curtains: string[] = [];
    walkTo(t, '4.2', {
      observe: (tt, ev) => {
        if (ev === 'blake') {
          // The moment Blake's 4 lands: the counter window is open.
          expect(view0().state.phase).toBe(Phase.AwaitingCounter);
          expect(tt.curtain).toEqual({ kind: 'ack', to: 0 });
          expect(tt.step?.id).toBe('4.2');
          expect(tt.phase).toBe('step');
        }
        curtains.push(tt.curtain.kind);
      },
    });
    expect(curtains).toContain('ack');
    expect(t.curtain).toEqual({ kind: 'ack', to: 0 });
    expect(t.pending).toBe(false);

    const decline = t.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.Decline);
    const counter = t.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.Counter);
    expect(decline).toBeGreaterThanOrEqual(0);
    expect(counter).toBeGreaterThanOrEqual(0);
    for (let n = 1; n <= 3; n++) {
      void t.apply(decline);
      const v = view0().state;
      expect(v.phase).toBe(Phase.AwaitingCounter);
      expect(v.active).toBe(0);
      expect(t.curtain).toEqual({ kind: 'ack', to: 0 });
      expect(t.refusals).toBe(n);
      expect(t.lastNudge).toBe('Letting it happen costs you 2 cards. Use your 2: tap it, then Confirm.');
      vi.advanceTimersByTime(5000);
      expect(t.curtain).toEqual({ kind: 'ack', to: 0 });
    }
    void t.apply(counter);
    const after = view0().state;
    expect(after.phase).toBe(Phase.Normal);
    expect(after.active).toBe(0);
    expect(t.curtain).toEqual({ kind: 'none' });
    expect(t.phase).toBe('success');
    settleBeats(t);
    expect(t.phase).toBe('finished');
    expect(t.curtain).toEqual({ kind: 'none' });
  });

  it('the curtain is ack exactly while view(0) is at phase 1 with Alice active, at every observation', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const t = make(4);
      driveLesson(t, {
        seed,
        wrongFirst: 4,
        observe: (tt) => {
          const v = view0().state;
          const window = v.phase === Phase.AwaitingCounter && v.active === 0;
          expect(tt.curtain).toEqual(window ? { kind: 'ack', to: 0 } : { kind: 'none' });
        },
      });
      expect(t.phase).toBe('finished');
    }
  });
});

describe('S4 fuzz finishes every lesson', () => {
  for (const id of ALL) {
    it(`lesson ${id}, seeds 1-20, up to 6 wrong commits before each right action`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const t = make(id);
        const r = driveLesson(t, { seed, wrongFirst: 6 });
        expect(t.phase, `seed ${seed}`).toBe('finished');
        expect(r.steps).toEqual(lessonOf(id).steps.map((s) => s.id));
        expect(t.refusals, `seed ${seed}: every wrong commit was refused`).toBe(r.wrong);
        t.dispose();
      }
    });
  }

  it('every move step has a non-empty generic line', () => {
    for (const l of LESSONS) {
      for (const s of l.steps) if (s.kind === 'move') expect(s.generic.trim().length, s.id).toBeGreaterThan(0);
    }
  });
});

describe('P3 beat order', () => {
  it('success, then Blake thinking (pending), then his move and done line, then the next step', () => {
    const t = make(2);
    void t.apply(expectedIndex(t));
    const afterAlice = snap();
    const step = lessonOf(2).steps[0] as MoveStep;
    expect(t.phase).toBe('success');
    expect(t.line).toEqual({ text: step.success, tone: 'success' });
    expect(t.pending).toBe(true);
    expect(t.stepIndex).toBe(0);

    vi.advanceTimersByTime(SUCCESS_BEAT_MS - 1);
    expect(t.phase).toBe('success');
    vi.advanceTimersByTime(1);
    expect(t.phase).toBe('blake');
    expect(t.line).toEqual({ text: BLAKE_THINKING, tone: 'blake' });
    expect(t.pending).toBe(true);
    expect(snap()).toBe(afterAlice);

    // A tap during the think pause is ignored: never a double apply.
    t.skipBeat();
    expect(t.phase).toBe('blake');
    expect(snap()).toBe(afterAlice);
    const refusals = t.refusals;
    void t.apply(0);
    expect(t.refusals).toBe(refusals);
    expect(snap()).toBe(afterAlice);

    vi.advanceTimersByTime(BLAKE_THINK_MS - 1);
    expect(snap()).toBe(afterAlice);
    vi.advanceTimersByTime(1);
    expect(snap()).not.toBe(afterAlice);
    expect(t.envelope).toEqual(view0());
    expect(t.envelope!.state.scoreboard.opponent.points).toBe(10);
    expect(t.line).toEqual({ text: 'Blake played a 6. He has 10.', tone: 'blake' });
    expect(t.phase).toBe('blake');
    expect(t.pending).toBe(false);

    vi.advanceTimersByTime(BLAKE_DONE_BEAT_MS - 1);
    expect(t.stepIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(t.stepIndex).toBe(1);
    expect(t.step?.id).toBe('2.2');
    expect(t.phase).toBe('step');
    expect(t.pending).toBe(false);
    expect(t.line).toEqual({ text: (t.step as MoveStep).main, tone: 'main' });
  });

  it('reduced motion shortens the think pause to 400 ms', () => {
    const t = make(2, { reducedMotion: () => true });
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    const before = snap();
    vi.advanceTimersByTime(BLAKE_THINK_REDUCED_MS - 1);
    expect(snap()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(snap()).not.toBe(before);
    expect(BLAKE_THINK_REDUCED_MS).toBe(400);
    expect([SUCCESS_BEAT_MS, BLAKE_THINK_MS, BLAKE_DONE_BEAT_MS]).toEqual([1200, 700, 1200]);
  });

  it('skipBeat during success moves on at once; the old success timer never fires twice', () => {
    const t = make(2);
    void t.apply(expectedIndex(t));
    t.skipBeat();
    expect(t.phase).toBe('blake');
    expect(t.line.text).toBe(BLAKE_THINKING);
    vi.advanceTimersByTime(BLAKE_THINK_MS);
    const afterBlake = snap();
    expect(t.line.text).toBe('Blake played a 6. He has 10.');
    // The original success timer was due at 1200 ms: it must not restart Blake.
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    expect(snap()).toBe(afterBlake);
    expect(t.step?.id).toBe('2.2');
    // skipBeat during Blake's done line goes straight to the next step.
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.line).toEqual({ text: 'Blake drew a card.', tone: 'blake' });
    t.skipBeat();
    expect(t.step?.id).toBe('2.3');
    expect(t.phase).toBe('step');
    vi.runAllTimers();
    expect(t.step?.id).toBe('2.3');
  });

  it('a reply with no done line hands straight to the next step (4.1 -> 4.2)', () => {
    const t = make(4);
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.step?.id).toBe('4.2');
    expect(t.phase).toBe('step');
    expect(t.pending).toBe(false);
    expect(t.curtain).toEqual({ kind: 'ack', to: 0 });
    expect(t.line).toEqual({ text: (t.step as MoveStep).main, tone: 'main' });
  });

  it('a step with no reply: success, then the next step (or finished) after 1200 ms, never pending', () => {
    const t = make(3);
    walkTo(t, '3.2');
    void t.apply(expectedIndex(t));
    expect(t.phase).toBe('success');
    expect(t.pending).toBe(false);
    vi.advanceTimersByTime(SUCCESS_BEAT_MS - 1);
    expect(t.phase).toBe('success');
    vi.advanceTimersByTime(1);
    expect(t.phase).toBe('finished');
    expect(t.line).toEqual({ text: 'Hearts beat clubs. Scuttled.', tone: 'success' });
  });

  it('a commit during a beat ends the beat, then meets the next step\'s gate', () => {
    const t = make(2);
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.line.text).toBe('Blake played a 6. He has 10.');
    expect(t.pending).toBe(false);
    // The learner draws (2.2's expected move) during Blake's done line.
    const draw = t.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.Draw);
    void t.apply(draw);
    expect(t.step?.id).toBe('2.2');
    expect(t.phase).toBe('success');
    expect(t.refusals).toBe(0);
  });

  it('a commit during the success beat of a step Blake answers is ignored: pending holds it (review N2)', () => {
    const t = make(2);
    void t.apply(expectedIndex(t));
    expect(t.pending).toBe(true);
    const afterAlice = snap();
    const env = t.envelope;
    void t.apply(0);
    expect(t.phase).toBe('success');
    expect(t.line.tone).toBe('success');
    expect(t.refusals).toBe(0);
    expect(t.envelope).toBe(env);
    expect(snap()).toBe(afterAlice);
  });

  it('skipBeat during the narration of a NON-last step: one advance only (review B1)', () => {
    const t = make(3);
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.line).toEqual({ text: 'Blake played an 8.', tone: 'blake' });
    t.skipBeat();
    expect(t.step?.id).toBe('3.2');
    expect(t.phase).toBe('step');
    vi.runAllTimers();
    expect(t.step?.id).toBe('3.2');
    expect(t.phase).toBe('step');
    expect(t.line).toEqual({ text: (t.step as MoveStep).main, tone: 'main' });
  });

  it('a commit during the narration of a NON-last step: one advance only (review B1)', () => {
    const t = make(2);
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.line.text).toBe('Blake played a 6. He has 10.');
    const draw = t.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.Draw);
    void t.apply(draw);
    expect(t.step?.id).toBe('2.2');
    expect(t.phase).toBe('success');
    // 2.1's narration timer (due 1200 ms after it began) must not advance 2.2 early.
    vi.advanceTimersByTime(SUCCESS_BEAT_MS - 1);
    expect(t.step?.id).toBe('2.2');
    expect(t.phase).toBe('success');
    vi.runAllTimers();
    expect(t.step?.id).toBe('2.3');
    expect(t.phase).toBe('step');
    // Blake really drew on 2.2 (6 played, then a draw: 5 cards again).
    expect(t.envelope!.state.opponent.handCount).toBe(5);
    expect(t.envelope!.history).toHaveLength(4);
  });
});

describe('stale timers never apply (Review focus 3)', () => {
  function atThinkPause(): { t: TutorialTable; afterAlice: string } {
    const t = make(2);
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    expect(t.phase).toBe('blake');
    expect(t.pending).toBe(true);
    return { t, afterAlice: snap() };
  }

  it('dispose() during the think pause, then a new lesson: Blake never moves on it', () => {
    const { t, afterAlice } = atThinkPause();
    const shown = t.envelope;
    t.dispose();
    vi.runAllTimers();
    expect(snap()).toBe(afterAlice);
    expect(t.envelope).toBe(shown);
    expect(t.phase).toBe('blake');

    const { t: a } = atThinkPause();
    a.dispose();
    const next = make(3);
    const restored = snap();
    vi.runAllTimers();
    expect(snap()).toBe(restored);
    expect(next.envelope).toEqual(view0());
    expect(next.seq).toBe(0);
  });

  it('dispose() during the think pause, then the same lesson again with Blake to move: the old timer stays dead', () => {
    const { t: a } = atThinkPause();
    a.dispose();
    const b = make(2);
    void b.apply(expectedIndex(b));
    const bAfterAlice = snap();
    vi.advanceTimersByTime(BLAKE_THINK_MS);
    expect(snap(), 'the old lesson\'s Blake must not play on the new one').toBe(bAfterAlice);
    expect(b.phase).toBe('success');
  });

  it('restart() during the think pause: the snapshot equals the restored position', () => {
    const { t } = atThinkPause();
    t.restart();
    const restored = snap();
    vi.runAllTimers();
    expect(snap()).toBe(restored);
    expect(t.stepIndex).toBe(0);
    expect(t.phase).toBe('step');
    expect(t.pending).toBe(false);
    expect(t.seq).toBe(0);
    expect(t.envelope).toEqual(view0());
    expect(t.line).toEqual({ text: lessonOf(2).steps[0].main, tone: 'main' });
  });

  it('restart() from a step with refusals clears wrongTries and the nudge (review B3)', () => {
    const t = make(2);
    void t.apply(wrongIndices(t)[0]);
    void t.apply(wrongIndices(t)[1]);
    t.noteStagedWrong();
    expect(t.wrongTries).toBe(3);
    expect(t.lastNudge).not.toBeNull();
    t.restart();
    expect(t.wrongTries).toBe(0);
    expect(t.lastNudge).toBeNull();
    expect(t.line).toEqual({ text: lessonOf(2).steps[0].main, tone: 'main' });
    expect(t.stepIndex).toBe(0);

    // The same from a later step, mid-lesson.
    walkTo(t, '2.2');
    void t.apply(wrongIndices(t)[0]);
    expect(t.wrongTries).toBe(1);
    t.restart();
    expect(t.wrongTries).toBe(0);
    expect(t.lastNudge).toBeNull();
    expect(t.step?.id).toBe('2.1');
  });

  it('newGame() (restart) during the think pause, and during the success and done beats', async () => {
    const { t } = atThinkPause();
    await t.newGame();
    const restored = snap();
    vi.runAllTimers();
    expect(snap()).toBe(restored);
    expect(t.stepIndex).toBe(0);

    void t.apply(expectedIndex(t));
    t.restart();
    const r2 = snap();
    vi.runAllTimers();
    expect(snap()).toBe(r2);
    expect(t.phase).toBe('step');

    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.line.text).toBe('Blake played a 6. He has 10.');
    t.restart();
    vi.runAllTimers();
    expect(t.stepIndex).toBe(0);
    expect(t.phase).toBe('step');
  });

  describe('a clock that cannot cancel: the generation check alone keeps a stale callback a no-op', () => {
    const clock: TutorialClock = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: () => {} };

    it('dispose, then a new table with Blake to move', () => {
      const a = make(2, { clock });
      void a.apply(expectedIndex(a));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      expect(a.phase).toBe('blake');
      a.dispose();
      const b = make(2, { clock });
      void b.apply(expectedIndex(b));
      const bAfterAlice = snap();
      vi.advanceTimersByTime(BLAKE_THINK_MS);
      expect(snap()).toBe(bAfterAlice);
      expect(b.phase).toBe('success');
    });

    it('restart, then the expected move again before the old pause ends', () => {
      const a = make(2, { clock });
      void a.apply(expectedIndex(a));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      a.restart();
      void a.apply(expectedIndex(a));
      const afterAlice = snap();
      vi.advanceTimersByTime(BLAKE_THINK_MS);
      expect(snap()).toBe(afterAlice);
      expect(a.phase).toBe('success');
    });

    it('restart, then run every timer', () => {
      const a = make(2, { clock });
      void a.apply(expectedIndex(a));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      a.restart();
      const restored = snap();
      vi.runAllTimers();
      expect(snap()).toBe(restored);
      expect(a.phase).toBe('step');
      expect(a.stepIndex).toBe(0);
    });

    it('skipBeat during a non-last narration: the skipped timer never advances again (review B1)', () => {
      const t = make(3, { clock });
      void t.apply(expectedIndex(t));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
      expect(t.line.text).toBe('Blake played an 8.');
      t.skipBeat();
      vi.runAllTimers();
      expect(t.step?.id).toBe('3.2');
      expect(t.phase).toBe('step');
    });

    it('a commit during a non-last narration: the old narration timer never advances 2.2 (review B1)', () => {
      const t = make(2, { clock });
      void t.apply(expectedIndex(t));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
      void t.apply(t.envelope!.legalMoves.findIndex((m) => m.Kind === MoveKind.Draw));
      expect(t.step?.id).toBe('2.2');
      vi.advanceTimersByTime(SUCCESS_BEAT_MS - 1);
      expect(t.step?.id).toBe('2.2');
      expect(t.phase).toBe('success');
      vi.runAllTimers();
      expect(t.step?.id).toBe('2.3');
      expect(t.phase).toBe('step');
      expect(t.envelope!.history).toHaveLength(4);
    });

    it('skipBeat: the skipped success timer never starts Blake again', () => {
      const u = make(2, { clock });
      void u.apply(expectedIndex(u));
      u.skipBeat();
      vi.advanceTimersByTime(BLAKE_THINK_MS);
      const once = snap();
      vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS + BLAKE_DONE_BEAT_MS);
      expect(snap()).toBe(once);
      expect(u.step?.id).toBe('2.2');
      expect(u.phase).toBe('step');
      expect(u.line).toEqual({ text: (u.step as MoveStep).main, tone: 'main' });
    });
  });

  it('after dispose nothing applies, advances or calls home', () => {
    const onHome = vi.fn();
    const t = make(1, { onHome });
    t.dispose();
    const before = snap();
    void t.apply(0);
    t.next();
    t.skipBeat();
    expect(snap()).toBe(before);
    expect(t.step?.id).toBe('1.1');
    expect(onHome).not.toHaveBeenCalled();
  });

  it('goHome() ends the lesson (its timers go stale) and calls onHome once', () => {
    const onHome = vi.fn();
    const t = make(2, { onHome });
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    const afterAlice = snap();
    t.goHome();
    vi.runAllTimers();
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(snap()).toBe(afterAlice);
  });
});

describe('errors are never a dead end', () => {
  function withBlake(move: MoveStep['blake'][number]['move']): Lesson {
    const base = lessonOf(2);
    const first = base.steps[0] as MoveStep;
    return { ...base, steps: [{ ...first, blake: [{ ...first.blake[0], move }] }, ...base.steps.slice(1)] };
  }

  it('a Blake predicate matching nothing -> error; restart restores step 0', () => {
    const t = make(withBlake({ kind: MoveKind.PlayPoint, card: c(13, 'S') }));
    void t.apply(expectedIndex(t));
    const afterAlice = snap();
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.phase).toBe('error');
    expect(t.line).toEqual({ text: SNAG_LINE, tone: 'error' });
    expect(t.pending).toBe(false);
    expect(snap()).toBe(afterAlice);
    // Nothing applies from the error state.
    void t.apply(0);
    expect(snap()).toBe(afterAlice);
    t.restart();
    expect(t.phase).toBe('step');
    expect(t.stepIndex).toBe(0);
    expect(t.envelope).toEqual(view0());
    expect(t.seq).toBe(0);
  });

  it('a Blake predicate matching several moves -> error', () => {
    const t = make(withBlake({ kind: MoveKind.PlayPoint }));
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS + BLAKE_THINK_MS);
    expect(t.phase).toBe('error');
    expect(t.line.text).toBe(SNAG_LINE);
  });

  it('an engine apply that returns ok:false -> error; restart restores the position at step 0', () => {
    let fail = true;
    const engine = recordingEngine([], {
      apply: (i) => (fail ? { ok: false, code: 'INTERNAL', message: 'internal error' } : bridge.apply(i)),
    });
    const t = make(1, { engine });
    t.next();
    t.next();
    t.next();
    t.next();
    void t.apply(expectedIndex(t));
    expect(t.phase).toBe('error');
    expect(t.line).toEqual({ text: SNAG_LINE, tone: 'error' });
    expect(t.pending).toBe(false);
    fail = false;
    t.restart();
    expect(t.phase).toBe('step');
    expect(t.stepIndex).toBe(0);
    expect(t.envelope).toEqual(view0());
    expect(t.envelope!.state.scoreboard.you.points).toBe(12);
  });

  describe('in error, Alice\'s stale list is still on show, but no commit reaches the engine (review B2)', () => {
    it('apply ok, then view(0) fails: the expected index again never reaches the engine', () => {
      const log: string[] = [];
      let failNextView = false;
      const engine = recordingEngine(log, {
        apply: (i) => {
          log.push(`apply:${i}`);
          const r = bridge.apply(i);
          failNextView = true;
          return r;
        },
        view: (v) => {
          if (failNextView) {
            failNextView = false;
            return { ok: false, code: 'INTERNAL', message: 'internal error' };
          }
          return bridge.view(v);
        },
      });
      const t = make(2, { engine });
      const i = expectedIndex(t);
      void t.apply(i);
      expect(t.phase).toBe('error');
      expect(t.envelope!.legalMoves.length, 'the pre-move list is still on show').toBeGreaterThan(0);
      const after = snap();
      log.length = 0;
      void t.apply(i);
      for (const j of t.envelope!.legalMoves.keys()) void t.apply(j);
      expect(log.filter((x) => x.startsWith('apply'))).toEqual([]);
      expect(snap()).toBe(after);
      expect(t.phase).toBe('error');
      expect(t.line).toEqual({ text: SNAG_LINE, tone: 'error' });
    });

    it('apply ok, then view(0) is not seat 0\'s: same', () => {
      const log: string[] = [];
      let seatOne = false;
      const engine = recordingEngine(log, {
        apply: (i) => {
          log.push(`apply:${i}`);
          seatOne = true;
          return bridge.apply(i);
        },
        view: (v) => (seatOne ? bridge.view(1) : bridge.view(v)),
      });
      const t = make(2, { engine });
      const i = expectedIndex(t);
      void t.apply(i);
      expect(t.phase).toBe('error');
      expect(t.envelope!.state.viewer).toBe(0);
      const after = snap();
      log.length = 0;
      void t.apply(i);
      expect(log.filter((x) => x.startsWith('apply'))).toEqual([]);
      expect(snap()).toBe(after);
    });

    it('apply returns ok:false: the expected index again never reaches the engine', () => {
      const log: string[] = [];
      const engine = recordingEngine(log, {
        apply: (i) => (log.push(`apply:${i}`), { ok: false, code: 'INTERNAL', message: 'internal error' }),
      });
      const t = make(2, { engine });
      const i = expectedIndex(t);
      void t.apply(i);
      expect(t.phase).toBe('error');
      const after = snap();
      log.length = 0;
      void t.apply(i);
      expect(log.filter((x) => x.startsWith('apply'))).toEqual([]);
      expect(snap()).toBe(after);
      expect(t.phase).toBe('error');
    });
  });

  it('a failed restore, a failed view and a seat-1 view are errors too', () => {
    const bad: BridgeResult = { ok: false, code: 'BAD_REQUEST', message: 'bad' };
    expect(make(1, { engine: recordingEngine([], { restore: () => bad }) }).phase).toBe('error');
    expect(make(1, { engine: recordingEngine([], { view: () => bad }) }).phase).toBe('error');
    const t = make(1, { engine: recordingEngine([], { view: () => bridge.view(1) }) });
    expect(t.phase).toBe('error');
    expect(t.envelope === null || t.envelope.state.viewer === 0).toBe(true);
  });
});

describe('the apply gate is apply only (R25.3)', () => {
  it('next, appeared, skipBeat, noteStagedWrong and restart never apply a learner move', () => {
    const log: string[] = [];
    const t = make(5, { engine: recordingEngine(log) });
    t.next();
    t.appeared('card-detail-popover');
    t.skipBeat();
    t.noteStagedWrong();
    expect(log.filter((x) => x.startsWith('apply'))).toEqual([]);
    walkTo(t, '5.3');
    log.length = 0;
    t.noteStagedWrong();
    t.skipBeat();
    t.next();
    t.appeared('card-detail-popover');
    t.restart();
    expect(log.filter((x) => x.startsWith('apply'))).toEqual([]);
  });

  it('a learner move reaches the engine only through apply(i), by the engine\'s own index', () => {
    const log: string[] = [];
    const t = make(3, { engine: recordingEngine(log) });
    const i = expectedIndex(t, 1);
    log.length = 0;
    void t.apply(i);
    expect(log.slice(0, 2)).toEqual([`apply:${i}`, 'view:0']);
  });
});

describe('the legal list is the engine\'s', () => {
  for (const id of ALL) {
    for (const pick of PICKS[id]) {
      it(`lesson ${id}${PICKS[id].length > 1 ? ` (alternative ${pick})` : ''}: every observation`, () => {
        const t = make(id);
        driveLesson(t, {
          pick,
          wrongFirst: 2,
          observe: (tt) => {
            const v = view0();
            expect(tt.envelope!.legalMoves).toEqual(v.legalMoves);
            expect(tt.envelope!.descriptions).toEqual(v.descriptions);
          },
        });
        expect(t.phase).toBe('finished');
      });
    }
  }
});

describe('motion hooks', () => {
  it('beforeApply runs before engine.apply with the matched move; afterApply after the state is set; neither on a refusal', () => {
    const log: string[] = [];
    const seen: { move: unknown; view: unknown; snapshot: string }[] = [];
    const ref: { t?: TutorialTable } = {};
    const beforeApply = vi.fn((move, view) => {
      log.push('before');
      seen.push({ move, view, snapshot: snap() });
    });
    const afterApply = vi.fn(() => {
      log.push('after');
      expect(ref.t!.envelope).toEqual(view0());
      expect(ref.t!.seq).toBe(ref.t!.envelope!.history.length);
    });
    const t = make(2, { engine: recordingEngine(log), beforeApply, afterApply });
    ref.t = t;
    const env = t.envelope!;
    void t.apply(wrongIndices(t)[0]);
    expect(beforeApply).not.toHaveBeenCalled();
    expect(afterApply).not.toHaveBeenCalled();

    const before = snap();
    const i = expectedIndex(t);
    log.length = 0;
    void t.apply(i);
    expect(log.slice(0, 4)).toEqual(['before', `apply:${i}`, 'view:0', 'after']);
    expect(seen[0].move).toEqual(env.legalMoves[i]);
    expect(seen[0].view).toBe(env.state);
    expect(seen[0].snapshot).toBe(before);
    expect(afterApply).toHaveBeenCalledTimes(1);

    // Blake's replies are not learner moves: the hooks stay learner-only.
    settleBeats(t);
    expect(beforeApply).toHaveBeenCalledTimes(1);
    expect(afterApply).toHaveBeenCalledTimes(1);

    // A refusal outside a move step runs neither.
    walkTo(t, '2.3');
    beforeApply.mockClear();
    afterApply.mockClear();
    void t.apply(0);
    expect(beforeApply).not.toHaveBeenCalled();
    expect(afterApply).not.toHaveBeenCalled();
  });
});

// T11: Blake's flight hooks. `beforeReply(view)` gets the table's seat-0 view
// just before his move applies; `afterReply(entry)` gets the new LAST entry
// of seat 0's history after it. Never his Move, his legal list or anything
// from seat 1's view (design §8.4 privacy; issue #69's class).
describe('Blake flight hooks (T11)', () => {
  /** Blake's hand as hidden from Alice right now ([] while glasses show it). */
  const hiddenNow = () => (view0().state.opponent.hand === null ? ok(bridge.view(1)).state.you.hand : []);

  it('beforeReply runs before Blake\'s apply with the table\'s seat-0 view; afterReply after, with the new last seat-0 history entry', () => {
    const log: string[] = [];
    const ref: { t?: TutorialTable } = {};
    const seen: { before?: unknown; shownBefore?: unknown; snapBefore?: string; entry?: unknown; lastAfter?: unknown } = {};
    const beforeReply = vi.fn((view) => {
      log.push('beforeReply');
      seen.before = view;
      seen.shownBefore = ref.t!.envelope!.state;
      seen.snapBefore = snap();
    });
    const afterReply = vi.fn((entry) => {
      log.push('afterReply');
      seen.entry = entry;
      seen.lastAfter = view0().history.at(-1);
      expect(ref.t!.envelope).toEqual(view0());
    });
    const t = make(2, { engine: recordingEngine(log), beforeReply, afterReply });
    ref.t = t;
    void t.apply(expectedIndex(t)); // 2.1: Blake answers with his 6
    expect(beforeReply).not.toHaveBeenCalled();
    expect(afterReply).not.toHaveBeenCalled();
    const snapAfterAlice = snap();

    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    log.length = 0;
    vi.advanceTimersByTime(BLAKE_THINK_MS);
    expect(beforeReply).toHaveBeenCalledTimes(1);
    expect(afterReply).toHaveBeenCalledTimes(1);
    const k = log.findIndex((l) => l.startsWith('apply:'));
    expect(log).toEqual(['legalMoves', 'beforeReply', log[k], 'view:0', 'afterReply']);
    // Before: the very view the table shows, seat 0's, while the engine is still pre-move.
    expect(seen.before).toBe(seen.shownBefore);
    expect((seen.before as { viewer: number }).viewer).toBe(0);
    expect(seen.snapBefore).toBe(snapAfterAlice);
    // After: the public log entry for his move, as seat 0 sees it.
    expect(seen.entry).toEqual(seen.lastAfter);
    expect(seen.entry).toBe(t.envelope!.history.at(-1));
    const entry = seen.entry as Record<string, unknown>;
    expect(entry.by).toBe(1);
    expect(entry.kind).toBe(MoveKind.PlayPoint);
    expect(entry.card).toEqual(c(6, 'D'));
    expect('index' in entry).toBe(false); // mover-only, omitted for seat 0
    expect('HandIndex' in entry).toBe(false); // never his Move
  });

  it('run once per Blake reply and never on a learner move; the learner hooks never run on Blake\'s', () => {
    for (const id of ALL) {
      const calls: string[] = [];
      const t = make(id, {
        beforeApply: () => calls.push('beforeApply'),
        afterApply: () => calls.push('afterApply'),
        beforeReply: () => calls.push('beforeReply'),
        afterReply: () => calls.push('afterReply'),
      });
      driveLesson(t, { wrongFirst: 2, seed: 7 });
      expect(t.phase, `lesson ${id}`).toBe('finished');
      const moves = lessonOf(id).steps.filter((s) => s.kind === 'move').length;
      const replies = lessonOf(id).steps.reduce((n, s) => n + (s.kind === 'move' ? s.blake.length : 0), 0);
      expect(calls.filter((x) => x === 'beforeApply').length, `lesson ${id}`).toBe(moves);
      expect(calls.filter((x) => x === 'afterApply').length, `lesson ${id}`).toBe(moves);
      expect(calls.filter((x) => x === 'beforeReply').length, `lesson ${id}`).toBe(replies);
      expect(calls.filter((x) => x === 'afterReply').length, `lesson ${id}`).toBe(replies);
      // Pairs, in order: every before is followed by its own after.
      for (let i = 0; i < calls.length; i += 2) {
        expect(calls[i + 1], `lesson ${id} call ${i}`).toBe(calls[i].replace('before', 'after'));
      }
    }
  });

  it('Blake\'s hidden draw (2.2): the entry names no card, and no hook argument reaches the card he drew', () => {
    const audit = auditHooks(hiddenNow);
    const t = make(2, audit.hooks);
    walkTo(t, '2.2');
    const before = ok(bridge.view(1)).state.you.hand.length;
    void t.apply(expectedIndex(t));
    settleBeats(t);
    const blakeHand = ok(bridge.view(1)).state.you.hand;
    expect(blakeHand.length).toBe(before + 1);
    const entry = audit.calls.filter((x) => x.hook === 'afterReply').at(-1)!.args[0] as Record<string, unknown>;
    expect(entry.kind).toBe(MoveKind.Draw);
    expect(entry.card).toBeNull();
    expect(hiddenCardPaths([entry], blakeHand, 'entry')).toEqual([]);
    expect(audit.findings).toEqual([]);
  });

  it('a throwing hook never breaks a lesson: every lesson still finishes, every move still applies', () => {
    for (const id of ALL) {
      const boom = vi.fn(() => {
        throw new Error('motion failed');
      });
      const t = make(id, { beforeApply: boom, afterApply: boom, beforeReply: boom, afterReply: boom });
      const seen: string[] = [];
      expect(() =>
        driveLesson(t, {
          wrongFirst: 1,
          observe: (tt, ev) => {
            seen.push(ev);
            expect(tt.phase).not.toBe('error');
            if (ev === 'move' || ev === 'blake') expect(tt.envelope).toEqual(view0());
          },
        }),
      ).not.toThrow();
      expect(t.phase, `lesson ${id}`).toBe('finished');
      expect(t.line.tone, `lesson ${id}`).not.toBe('error');
      expect(boom).toHaveBeenCalled();
    }
  });

  it('a throwing hook leaves the beat order as it is without hooks (P3)', () => {
    const boom = () => {
      throw new Error('motion failed');
    };
    const t = make(2, { beforeApply: boom, afterApply: boom, beforeReply: boom, afterReply: boom });
    void t.apply(expectedIndex(t));
    expect(t.phase).toBe('success');
    expect(t.pending).toBe(true);
    expect(t.envelope).toEqual(view0());
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    expect(t.phase).toBe('blake');
    expect(t.line.text).toBe(BLAKE_THINKING);
    vi.advanceTimersByTime(BLAKE_THINK_MS);
    expect(t.envelope).toEqual(view0());
    expect(t.envelope!.history.at(-1)!.by).toBe(1);
    expect(t.line.text).toBe('Blake played a 6. He has 10.');
    vi.advanceTimersByTime(BLAKE_DONE_BEAT_MS);
    expect(t.phase).toBe('step');
    expect(t.step?.id).toBe('2.2');
    expect(t.pending).toBe(false);
  });
});

describe('S6 seat-0 view only', () => {
  for (const id of ALL) {
    for (const pick of PICKS[id]) {
      it(`lesson ${id}${PICKS[id].length > 1 ? ` (alternative ${pick})` : ''}`, () => {
        // T11: every motion hook argument gets the same two walks, taken at
        // the moment of the call (Blake's hand as hidden then).
        const audit = auditHooks(() => (view0().state.opponent.hand === null ? ok(bridge.view(1)).state.you.hand : []));
        const t = make(id, audit.hooks);
        let replies = 0;
        let glasses = false;
        driveLesson(t, {
          pick,
          wrongFirst: 2,
          observe: (tt, ev) => {
            expect(tt.envelope!.state.viewer).toBe(0);
            expect(tt.viewer).toBe(0);
            if (id === 5 && ev === 'move' && tt.step?.id === '5.1') glasses = true;
            if (glasses) expect(tt.envelope!.state.opponent.hand).not.toBeNull();
            else expect(tt.envelope!.state.opponent.hand).toBeNull();
            // Review N1: none of Blake's current hidden hand cards is reachable
            // from the table (lesson data excluded), at every observation.
            const hidden = glasses ? [] : ok(bridge.view(1)).state.you.hand;
            expect(hiddenCardPaths(tt, hidden), `${tt.step?.id} ${ev}`).toEqual([]);
            if (ev === 'blake') {
              replies++;
              expect(viewerOnePaths(tt)).toEqual([]);
            }
          },
        });
        expect(t.phase).toBe('finished');
        expect(hiddenCardPaths(t, id === 5 ? [] : ok(bridge.view(1)).state.you.hand)).toEqual([]);
        expect(replies).toBe(lessonOf(id).steps.reduce((n, s) => n + (s.kind === 'move' ? s.blake.length : 0), 0));
        expect(viewerOnePaths(t)).toEqual([]);
        // The hook walk ran on every hook call, Blake's included.
        expect(audit.calls.filter((x) => x.hook === 'afterReply').length).toBe(replies);
        expect(audit.calls.filter((x) => x.hook === 'beforeReply').length).toBe(replies);
        expect(audit.findings).toEqual([]);
        for (const call of audit.calls.filter((x) => x.hook === 'afterReply')) {
          const entry = call.args[0] as Record<string, unknown>;
          expect(entry.by).toBe(1);
          expect('index' in entry || 'HandIndex' in entry).toBe(false);
        }
      });
    }
  }

  it('the hidden-card walk finds a copy of Blake\'s hand but not the lesson data (the walk works)', () => {
    const t = make(2);
    const hidden = ok(bridge.view(1)).state.you.hand;
    expect(hidden.length).toBeGreaterThan(0);
    // The lesson names his starting hand; that alone is not a finding.
    expect(hiddenCardPaths(t, hidden)).toEqual([]);
    const planted = make(2) as unknown as Record<string, unknown>;
    planted.leak = { cards: hidden.map((x) => ({ Rank: x.Rank, Suit: x.Suit })) };
    expect(hiddenCardPaths(planted as unknown as TutorialTable, hidden)).toContain('table.leak.cards.0');
  });

  it('the hook walk finds Blake\'s Move, his legal list or a seat-1 view passed to a hook (the walk works)', () => {
    const t = make(2);
    walkTo(t, '2.2');
    void t.apply(expectedIndex(t));
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    // Blake to move (his draw): his own envelope, as a leaky hook would see it.
    const blakeEnv = ok(bridge.legalMoves());
    expect(blakeEnv.state.viewer).toBe(1);
    const audit = auditHooks(() => blakeEnv.state.you.hand);
    audit.hooks.beforeReply(blakeEnv.state);
    audit.hooks.afterReply(blakeEnv as never);
    audit.hooks.afterReply({ hand: blakeEnv.state.you.hand.map((x) => ({ ...x })) } as never);
    expect(audit.findings.some((f) => f.startsWith('seat-1 object at beforeReply'))).toBe(true);
    expect(audit.findings.some((f) => f.startsWith('hidden card at beforeReply'))).toBe(true);
    expect(audit.findings.some((f) => f.startsWith('seat-1 object at afterReply'))).toBe(true);
    expect(audit.findings.some((f) => f.startsWith('hidden card at afterReply.0.hand'))).toBe(true);
    // An extra argument smuggled into any hook is walked too.
    const smuggle = new Map<string, (...a: unknown[]) => void>([
      ['afterApply', audit.hooks.afterApply as (...a: unknown[]) => void],
      ['beforeApply', audit.hooks.beforeApply as (...a: unknown[]) => void],
    ]);
    for (const [name, hook] of smuggle) {
      const before = audit.findings.length;
      if (name === 'afterApply') hook(blakeEnv);
      else hook(t.envelope!.legalMoves[0], t.envelope!.state, blakeEnv);
      expect(audit.findings.slice(before).some((f) => f.startsWith(`seat-1 object at ${name}.`)), name).toBe(true);
    }
  });

  it('the walk finds a seat-1 envelope planted on a field or behind a getter (the walk works)', () => {
    const t = make(2);
    expect(viewerOnePaths(t)).toEqual([]);
    const blakeEnv = ok(bridge.view(1));
    const planted = make(2) as unknown as Record<string, unknown>;
    planted.leak = blakeEnv;
    expect(viewerOnePaths(planted)).toContain('table.leak.state');
    const viaGetter = make(2);
    Object.defineProperty(Object.getPrototypeOf(viaGetter), 'zzLeak', { configurable: true, get: () => ({ nested: blakeEnv }) });
    try {
      expect(viewerOnePaths(viaGetter)).toContain('table.zzLeak.nested.state');
    } finally {
      delete (Object.getPrototypeOf(viaGetter) as Record<string, unknown>).zzLeak;
    }
  });
});

describe('B6 (T1 PASS): the post-win view(0) stays on show', () => {
  it('lesson 1', () => {
    const t = make(1);
    walkTo(t, '1.5');
    void t.apply(expectedIndex(t));
    const shown = t.envelope!;
    expect(shown).toEqual(view0());
    expect(shown.state.phase).toBe(Phase.GameOver);
    expect(shown.state.winner).toBe(0);
    expect(shown.state.scoreboard.you.points).toBe(21);
    expect(t.curtain).toEqual({ kind: 'none' });
    settleBeats(t);
    expect(t.phase).toBe('finished');
    expect(t.envelope).toBe(shown);
    expect(t.curtain).toEqual({ kind: 'none' });
    expect(t.pending).toBe(false);
  });

  it('lesson 5', () => {
    const t = make(5);
    walkTo(t, '5.4');
    void t.apply(expectedIndex(t));
    const shown = t.envelope!;
    expect(shown).toEqual(view0());
    expect(shown.state.phase).toBe(Phase.GameOver);
    expect(shown.state.winner).toBe(0);
    expect(shown.state.scoreboard.you.threshold).toBe(14);
    settleBeats(t);
    expect(t.phase).toBe('finished');
    expect(t.envelope).toBe(shown);
    expect(t.curtain).toEqual({ kind: 'none' });
  });
});
