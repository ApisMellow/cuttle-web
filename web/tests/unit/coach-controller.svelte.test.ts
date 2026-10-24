// @vitest-environment jsdom
// T9 CoachController (docs/tutorial-plan.md T9; docs/tutorial-design.md §7.1,
// §7.2, §7.4, §8.3, §5.5.1). The coach's state machine, read from the page:
// the REAL GameScreen on the REAL wasm bridge (engine v0.2.1), driven by the
// REAL TutorialTable. No StagingStore is ever read: the controller sees only
// the game-screen root's DOM and the table.
//
// The table's beats run on vi fake timers (tutorial-driver.ts); the
// controller gets its own manual clock and frame queue, so its demo timers
// and measuring never mix with the table's beats.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import type { Card, Envelope, Move } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { testIdForKey } from '../../src/lib/dragDrop';
import { MoveKind } from '../../src/lib/enums';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import {
  COVERING_SHEETS,
  CoachController,
  DEMO_AUTO_PLAYS,
  DEMO_ENTRY_MS,
  DEMO_IDLE_MS,
  type CoachClock,
  type CoachFrames,
} from '../../src/lib/tutorial/coach.svelte';
import { CANCEL_SUFFIX, LESSONS } from '../../src/lib/tutorial/lessons';
import { intersects, type Box } from '../../src/lib/tutorial/placement';
import { TutorialTable } from '../../src/lib/tutorial/table.svelte';
import type { Lesson, LessonId, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { expectedIndex, walkTo, wrongIndices } from './tutorial-driver';

function lessonOf(id: LessonId): Lesson {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} missing`);
  return l;
}

// ---------------------------------------------------------------------------
// A manual clock and frame queue for the controller
// ---------------------------------------------------------------------------

interface ManualClock extends CoachClock {
  advance(ms: number): void;
  pending(): number;
}

function manualClock(): ManualClock {
  let now = 0;
  let id = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      id += 1;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      queue.delete(handle);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => queue.size,
  };
}

interface ManualFrames extends CoachFrames {
  run(): void;
  pending(): number;
}

function manualFrames(): ManualFrames {
  let id = 0;
  const queue = new Map<number, () => void>();
  return {
    request(fn) {
      id += 1;
      queue.set(id, fn);
      return id;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    run() {
      const fns = [...queue.values()];
      queue.clear();
      for (const fn of fns) fn();
    },
    pending: () => queue.size,
  };
}

// ---------------------------------------------------------------------------
// The mounted page
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let controller: CoachController | undefined;
let clock: ManualClock;
let frames: ManualFrames;

function newTable(id: LessonId): TutorialTable {
  return new TutorialTable(lessonOf(id), { learnerName: 'Alice', reducedMotion: () => false, onHome: vi.fn() });
}

function root(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('[data-testid="game-screen"]');
  if (!el) throw new Error('no game screen');
  return el;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
  }
  flushSync();
}

async function mountWith(table: TutorialTable): Promise<CoachController> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: table } });
  flushSync();
  controller = new CoachController({ table, root: root(), clock, frames });
  await settle();
  return controller;
}

function cleanup(): void {
  controller?.dispose();
  controller = undefined;
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

/** Stages legal move `i` by taps, as a player would (the T6 walk). */
async function stage(env: Envelope, i: number): Promise<void> {
  const m: Move = env.legalMoves[i];
  if (m.Kind === MoveKind.Counter) return click(`counter-option-${i}`);
  if (m.Kind === MoveKind.Draw) return click('deck-pile');
  await click(`hand-card-${m.HandIndex}`);
  const key = boardTargetKey(m);
  if (key === null) throw new Error('a hand move with no board key');
  await click(testIdForKey(key));
  if (q('ambiguity-chooser')) await click(`ambiguity-chooser-option-${i}`);
}

function handIndexOf(table: TutorialTable, card: Card): number {
  const i = table.envelope!.state.you.hand.findIndex((h) => h.Rank === card.Rank && h.Suit === card.Suit);
  if (i < 0) throw new Error('card not in hand');
  return i;
}

function moveStep(table: TutorialTable): MoveStep {
  const step = table.step;
  if (step?.kind !== 'move') throw new Error('not at a move step');
  return step;
}

let errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  settings.revealPreference = 'two-step';
  settings.tableMode = false;
  settings.reducedMotion = false;
  clock = manualClock();
  frames = manualFrames();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

// ---------------------------------------------------------------------------

describe('the stage machine at a board move step (1.5)', () => {
  it('idle → selected → staged-right → Cancel → idle, with its spotlight and lines', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const step = moveStep(table);
    const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
    const four = handIndexOf(table, { Rank: 4, Suit: 3 });

    expect(c.stage).toBe('idle');
    expect(c.text).toBe(step.main);
    expect(c.tone).toBe('main');
    expect(c.targets).toEqual([`hand-card-${nine}`]);

    await click(`hand-card-${nine}`);
    expect(c.stage).toBe('selected');
    expect(c.text).toBe(step.main);
    expect(c.targets).toEqual([`hand-card-${nine}`, 'zone-points']);

    // Choosing another card is never nudged: still the expected card and target.
    await click(`hand-card-${four}`);
    expect(c.stage).toBe('selected');
    expect(c.targets).toEqual([`hand-card-${nine}`, 'zone-points']);

    await click(`hand-card-${nine}`);
    await click('zone-points');
    expect(c.stage).toBe('staged-right');
    expect(c.text).toBe(step.staged);
    expect(c.targets).toEqual(['staging-confirm']);

    await click('staging-cancel');
    expect(c.stage).toBe('idle');
    expect(c.text).toBe(step.main);
  });

  it('reads only its own root: a staged Confirm elsewhere in the document changes nothing', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const decoy = document.createElement('div');
    decoy.innerHTML =
      '<div data-testid="counter-prompt"><button data-testid="staging-confirm">Confirm</button></div>' +
      '<button data-testid="hand-card-0" aria-pressed="true" data-staged="true"></button>';
    document.body.append(decoy);
    root().setAttribute('data-poke', '1'); // a mutation inside the root, so the page is re-read
    await settle();
    expect(c.stage).toBe('idle');
    expect(c.page).toEqual({ selectedHand: null, source: null, target: null, confirm: false, counter: null });
    decoy.remove();
  });
});

describe('staged-wrong, refused and the tap route', () => {
  it('a wrong setup is staged-wrong: the nudge plus the Cancel sentence, Cancel spotlit, noted once per entry', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const step = moveStep(table);
    const noted = vi.spyOn(table, 'noteStagedWrong');
    const env = table.envelope!;
    // 9D on Blake's 10S (a 9 one-off): its own nudge (design §5.2).
    const nineOnTen = env.legalMoves.findIndex((m) => m.Kind === MoveKind.OneOff && m.Card?.Rank === 9);
    expect(nineOnTen).toBeGreaterThanOrEqual(0);

    await stage(env, nineOnTen);
    expect(c.stage).toBe('staged-wrong');
    expect(c.text).toBe(step.nudges[0].text + CANCEL_SUFFIX);
    expect(c.tone).toBe('nudge');
    expect(c.text).not.toContain('Confirm');
    expect(c.targets).toEqual(['staging-cancel']);
    expect(noted).toHaveBeenCalledTimes(1);

    // More page changes while still staged wrong are the same entry.
    root().setAttribute('data-poke', '1');
    await settle();
    expect(noted).toHaveBeenCalledTimes(1);

    await click('staging-cancel');
    expect(c.stage).toBe('idle');
    expect(c.text).toBe(step.main);

    // A second entry: noted again, and two wrong tries switch to the tap route.
    const other = wrongIndices(table).find((i) => i !== nineOnTen)!;
    await stage(env, other);
    expect(c.stage).toBe('staged-wrong');
    expect(c.text).toBe(step.generic + CANCEL_SUFFIX);
    expect(noted).toHaveBeenCalledTimes(2);
    await click('staging-cancel');
    expect(table.wrongTries).toBe(2);
    expect(c.stage).toBe('idle');
    expect(c.text).toBe(step.tapRoute);
    await click(`hand-card-${handIndexOf(table, { Rank: 9, Suit: 1 })}`);
    expect(c.stage).toBe('selected');
    expect(c.text).toBe(step.tapRoute);
  });

  it('a wrong Confirm holds staged-wrong while applying, then refused with the bare nudge, left at the next change', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    const c = await mountWith(table);
    const step = moveStep(table);
    const env = table.envelope!;
    const three = env.legalMoves.findIndex((m) => m.Kind === MoveKind.PlayPoint && m.Card?.Rank === 3);
    await stage(env, three);
    expect(c.stage).toBe('staged-wrong');

    // The gate refuses synchronously inside apply; Confirm is still in the DOM
    // (disabled) until confirm() resolves. The verdict is held meanwhile.
    q('staging-confirm')!.click();
    flushSync();
    expect(table.refusals).toBe(1);
    expect(q('staging-confirm')).not.toBeNull();
    expect(c.stage).toBe('staged-wrong');

    await settle();
    expect(q('staging-confirm')).toBeNull();
    expect(c.stage).toBe('refused');
    expect(c.text).toBe('Your 7 is worth more. Play the 7.');
    expect(c.text).not.toContain(CANCEL_SUFFIX.trim());
    expect(c.tone).toBe('nudge');
    // Refused keeps idle's spotlight (the card to play).
    expect(c.targets).toEqual([`hand-card-${handIndexOf(table, { Rank: 7, Suit: 0 })}`]);

    // Unrelated page churn while idle keeps it.
    root().setAttribute('data-poke', '2');
    await settle();
    expect(c.stage).toBe('refused');

    // The next change away from idle leaves it.
    await click(`hand-card-${handIndexOf(table, { Rank: 7, Suit: 0 })}`);
    expect(c.stage).toBe('selected');
    expect(c.text).toBe(step.tapRoute); // the staged-wrong entry plus the refusal: two tries
  });

  it('a refused commit shakes the bubble and replays the demo once', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    const c = await mountWith(table);
    const env = table.envelope!;
    const three = env.legalMoves.findIndex((m) => m.Kind === MoveKind.PlayPoint && m.Card?.Rank === 3);
    await stage(env, three);
    const shake = c.shake;
    const key = c.playKey;
    await click('staging-confirm');
    expect(c.stage).toBe('refused');
    expect(c.shake).toBeGreaterThan(shake);
    expect(c.playKey).toBe(key + 1);
  });
});

describe('the verdict is held while the move is in flight', () => {
  it('Confirm disabled or the table pending: the last verdict stands; once live again, the page is reclassified', async () => {
    // A hand-built page and a plain table, so the envelope can change under
    // a staged Confirm (in a real lesson the phase change hides this).
    const lesson1 = lessonOf(1);
    const lesson2 = lessonOf(2);
    const envOf = (l: Lesson): Envelope => {
      const t = newTable(l.id);
      return t.envelope!;
    };
    const env9D = envOf(lesson1); // hand 0 is the 9 of diamonds: PlayPoint to the points row is 1.5's move
    const env7C = envOf(lesson2); // hand 0 is the 7 of clubs: the same setup is wrong for 1.5
    const step = lesson1.steps.find((s) => s.id === '1.5') as MoveStep;
    const table = {
      lesson: lesson1,
      step,
      stepIndex: 4,
      phase: 'step' as const,
      line: { text: step.main, tone: 'main' as const },
      lastNudge: null,
      wrongTries: 0,
      refusals: 0,
      pending: false,
      envelope: env9D,
      appeared: vi.fn(),
      noteStagedWrong: vi.fn(),
      skipBeat: vi.fn(),
    };
    host = document.createElement('div');
    host.innerHTML =
      '<div data-testid="game-screen">' +
      '<button data-testid="hand-card-0" aria-pressed="true" data-staged="true"></button>' +
      '<button data-testid="zone-points" data-state="staged"></button>' +
      '<div data-testid="staging-bar"><button data-testid="staging-cancel"></button><button data-testid="staging-confirm"></button></div>' +
      '</div>';
    document.body.append(host);
    const c = new CoachController({ table, root: root(), clock, frames });
    controller = c;
    await settle();
    expect(c.stage).toBe('staged-right');

    const confirm = q('staging-confirm') as HTMLButtonElement;
    confirm.disabled = true;
    table.envelope = env7C;
    root().setAttribute('data-poke', '1');
    await settle();
    expect(c.stage, 'held while Confirm is disabled').toBe('staged-right');

    confirm.disabled = false;
    table.pending = true;
    root().setAttribute('data-poke', '2');
    await settle();
    expect(c.stage, 'held while the table is pending').toBe('staged-right');

    table.pending = false;
    root().setAttribute('data-poke', '3');
    await settle();
    expect(c.stage, 'reclassified once live').toBe('staged-wrong');
    expect(table.noteStagedWrong).toHaveBeenCalledTimes(1);
  });
});

describe('step 4.2: the counter window (design §5.5.1)', () => {
  it('fresh, staged, refused Decline (nudge, then the tap route), counter staged again', async () => {
    const table = newTable(4);
    walkTo(table, '4.2');
    const c = await mountWith(table);
    const step = moveStep(table);
    const option = () => host!.querySelector<HTMLElement>('[data-testid^="counter-option-"]')!.dataset.testid!;
    expect(table.curtain).toEqual({ kind: 'ack', to: 0 });
    expect(c.stage).toBe('idle');
    expect(c.page.counter).toBe('fresh');
    expect(c.targets).toEqual([option()]);
    expect(c.text).toBe(step.main);

    await click(option());
    expect(c.page.counter).toBe('staged');
    expect(c.stage).toBe('staged-right');
    expect(c.text).toBe(step.staged);
    expect(c.targets).toEqual(['staging-confirm']);
    await click('staging-cancel');
    expect(c.stage).toBe('idle');

    await click('counter-resolve');
    expect(table.refusals).toBe(1);
    expect(c.stage).toBe('refused');
    expect(c.text).toBe(step.nudges[0].text);
    expect(c.targets).toEqual([option()]);

    await click('counter-resolve');
    expect(table.refusals).toBe(2);
    expect(c.stage).toBe('refused');
    expect(c.text).toBe(step.tapRoute);

    await click(option());
    expect(c.stage).toBe('staged-right');
    await click('staging-confirm');
    expect(c.stage).toBe('done');
    expect(c.text).toBe(step.success);
  });
});

describe('spotlight targets (design §7.2)', () => {
  it("2.2's source and target are both the deck: one hole", async () => {
    const table = newTable(2);
    walkTo(table, '2.2');
    const c = await mountWith(table);
    expect(c.targets).toEqual(['deck-pile']);
    await click('deck-pile');
    expect(c.stage).toBe('staged-right');
    expect(c.targets).toEqual(['staging-confirm']);
  });

  it("3.1's target is both of Blake's point cards", async () => {
    const table = newTable(3);
    walkTo(table, '3.1');
    const c = await mountWith(table);
    const ten = handIndexOf(table, { Rank: 10, Suit: 2 });
    await click(`hand-card-${ten}`);
    expect(c.targets).toEqual([`hand-card-${ten}`, 'point-1-0', 'point-1-1']);
  });

  it('5.2: both Jacks while idle; the selected Jack and his 7 once one is selected', async () => {
    const table = newTable(5);
    walkTo(table, '5.2', { pick: 0 });
    const c = await mountWith(table);
    const jd = handIndexOf(table, { Rank: 11, Suit: 1 });
    const js = handIndexOf(table, { Rank: 11, Suit: 3 });
    expect(c.targets).toEqual([`hand-card-${jd}`, `hand-card-${js}`]);
    await click(`hand-card-${js}`);
    const seven = table.envelope!.state.opponent.points.findIndex((p) => p.Card.Rank === 7);
    expect(c.targets).toEqual([`hand-card-${js}`, `point-1-${seven}`]);
  });

  it('5.3 resolves the remaining Jack by rank', async () => {
    for (const pick of [0, 1]) {
      const table = newTable(5);
      walkTo(table, '5.3', { pick });
      const c = await mountWith(table);
      const hand = table.envelope!.state.you.hand;
      const jack = hand.findIndex((h) => h.Rank === 11);
      expect(hand.filter((h) => h.Rank === 11)).toHaveLength(1);
      expect(c.stage).toBe('appear');
      expect(c.targets).toEqual([`hand-card-${jack}`]);
      cleanup();
    }
  });

  it('next steps show their spot: 1.1 the score bar', async () => {
    const table = newTable(1);
    const c = await mountWith(table);
    expect(c.stage).toBe('next');
    expect(c.targets).toEqual(['score-bar']);
    expect(c.text).toBe(table.step!.main);
  });

  it('success, Blake and error beats show no hole', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    const c = await mountWith(table);
    q(`hand-card-${handIndexOf(table, { Rank: 7, Suit: 0 })}`)!.click();
    await settle();
    await click('zone-points');
    await click('staging-confirm');
    expect(table.phase).toBe('success');
    expect(c.stage).toBe('done');
    expect(c.targets).toEqual([]);
    vi.advanceTimersByTime(1200);
    await settle();
    expect(table.phase).toBe('blake');
    expect(c.stage).toBe('blake');
    expect(c.text).toBe("Blake's turn.");
    expect(c.targets).toEqual([]);
  });
});

describe('appear steps (5.3)', () => {
  it('complete when the popover appears', async () => {
    const table = newTable(5);
    walkTo(table, '5.3');
    const c = await mountWith(table);
    const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
    await click(`hand-card-${jack}`);
    expect(q('card-detail-popover')).not.toBeNull();
    expect(table.step?.id).toBe('5.4');
    // The popover covers the coach until it closes; then 5.4's coach shows.
    expect(c.covered).toBe(true);
    await click('card-detail-popover-close');
    expect(c.covered).toBe(false);
    expect(c.stage).toBe('idle');
  });

  it("complete at once when the element is already up as the step starts (opened during Blake's narration)", async () => {
    const table = newTable(5);
    walkTo(table, '5.2', { pick: 0 });
    const c = await mountWith(table);
    void table.apply(expectedIndex(table, 0));
    await settle();
    // Run to Blake's Queen narration beat.
    for (let n = 0; n < 10 && !(table.phase === 'blake' && table.line.text === 'Blake played his Queen.'); n++) {
      vi.advanceTimersToNextTimer();
      await settle();
    }
    expect(table.line.text).toBe('Blake played his Queen.');
    const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
    q(`hand-card-${jack}`)!.click(); // a click, not a pointerdown: no skip
    await settle();
    expect(q('card-detail-popover')).not.toBeNull();
    expect(table.step?.id).toBe('5.2'); // ignored during the beat
    vi.advanceTimersByTime(1200);
    await settle();
    expect(table.step?.id).toBe('5.4');
    expect(c.covered).toBe(true);
  });
});

describe('the fade rule: every covering sheet', () => {
  it('lists exactly the five sheets', () => {
    expect([...COVERING_SHEETS].sort()).toEqual(
      ['ambiguity-chooser', 'card-detail-popover', 'game-menu', 'rules-sheet', 'scrap-browser'].sort(),
    );
  });

  it('the menu, Rules, the scrap browser, the popover and the chooser each cover the coach', async () => {
    const table = newTable(5);
    walkTo(table, '5.3');
    const c = await mountWith(table);
    expect(c.covered).toBe(false);

    await click('menu-button');
    expect(q('game-menu')).not.toBeNull();
    expect(c.covered).toBe(true);
    await click('menu-rules');
    expect(q('rules-sheet')).not.toBeNull();
    // Rules opens over the menu; take the menu's own element out of the picture.
    const menu = q('game-menu')!;
    menu.setAttribute('data-testid', 'game-menu-hidden-for-test');
    await settle();
    expect(c.covered).toBe(true);
    menu.setAttribute('data-testid', 'game-menu');
    await click('rules-close');
    await click('menu-close');
    expect(c.covered).toBe(false);

    await click('scrap-pile');
    expect(q('scrap-browser')).not.toBeNull();
    expect(c.covered).toBe(true);
    await click('scrap-browser-close');
    expect(c.covered).toBe(false);

    const chooser = document.createElement('div');
    chooser.setAttribute('data-testid', 'ambiguity-chooser');
    root().append(chooser);
    await settle();
    expect(c.covered).toBe(true);
    chooser.remove();
    await settle();
    expect(c.covered).toBe(false);

    const jack = table.envelope!.state.you.hand.findIndex((h) => h.Rank === 11);
    await click(`hand-card-${jack}`);
    expect(c.covered).toBe(true);
    await click('card-detail-popover-close');
    expect(c.covered).toBe(false);
  });
});

describe('beats: a tap moves on (plan P3)', () => {
  it('a pointerdown during the success beat skips it; during the think pause it does nothing; during narration it moves on', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    await mountWith(table);
    void table.apply(expectedIndex(table));
    await settle();
    expect(table.phase).toBe('success');
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(table.phase).toBe('blake');
    expect(table.line.text).toBe("Blake's turn.");
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(table.line.text).toBe("Blake's turn."); // the think pause ignores taps
    vi.advanceTimersByTime(700);
    await settle();
    expect(table.line.text).toBe('Blake played a 6. He has 10.');
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(table.phase).toBe('step');
    expect(table.step?.id).toBe('2.2');
  });
});

describe('the ghost demo timeline (design §8.3)', () => {
  it('plays on entry, replays after idle up to three times, on Show me, and the drag carries the real card', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    frames.run();
    expect(c.demo).toMatchObject({ kind: 'drag', card: { Rank: 9, Suit: 1 } });
    const start = c.playKey;
    clock.advance(DEMO_ENTRY_MS);
    expect(c.playKey).toBe(start + 1);
    clock.advance(DEMO_IDLE_MS);
    expect(c.playKey).toBe(start + 2);
    // Input resets the idle wait.
    clock.advance(DEMO_IDLE_MS - 100);
    window.dispatchEvent(new Event('keydown'));
    clock.advance(DEMO_IDLE_MS - 100);
    expect(c.playKey).toBe(start + 2);
    clock.advance(200);
    expect(c.playKey).toBe(start + DEMO_AUTO_PLAYS);
    clock.advance(DEMO_IDLE_MS * 4);
    expect(c.playKey).toBe(start + DEMO_AUTO_PLAYS); // at most three automatic plays
    c.showMe();
    expect(c.playKey).toBe(start + DEMO_AUTO_PLAYS + 1);
  });

  it('a tap demo at 2.2 taps the deck twice; at 4.2 the counter option', async () => {
    const t2 = newTable(2);
    walkTo(t2, '2.2');
    const c2 = await mountWith(t2);
    frames.run();
    expect(c2.demo?.kind).toBe('tap');
    expect(c2.demo?.kind === 'tap' && c2.demo.at).toHaveLength(2);
    cleanup();

    const t4 = newTable(4);
    walkTo(t4, '4.2');
    const c4 = await mountWith(t4);
    frames.run();
    expect(c4.demo?.kind === 'tap' && c4.demo.at).toHaveLength(1);
  });

  it('no demo while staged wrong; reduced motion keeps the markers with Confirm once staged right', async () => {
    settings.reducedMotion = true;
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const env = table.envelope!;
    await stage(env, expectedIndex(table));
    frames.run();
    expect(c.stage).toBe('staged-right');
    expect(c.demo?.kind).toBe('drag');
    expect(c.confirmBox).toBeDefined();
    await click('staging-cancel');
    await stage(env, wrongIndices(table)[0]);
    frames.run();
    expect(c.stage).toBe('staged-wrong');
    expect(c.demo).toBeNull();
  });
});

describe('placement (design §7.3, plan B2)', () => {
  it('never covers a hole, the staging bar or the menu button; reserves four lines', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const rects: Record<string, Box> = {
      'score-bar': { x: 0, y: 0, width: 393, height: 44 },
      'menu-button': { x: 339, y: 0, width: 44, height: 44 },
      board: { x: 0, y: 0, width: 393, height: 792 },
      'hand-card-0': { x: 40, y: 690, width: 70, height: 92 },
      'zone-points': { x: 10, y: 520, width: 373, height: 100 },
      'staging-bar': { x: 0, y: 792, width: 393, height: 60 },
      'staging-confirm': { x: 250, y: 800, width: 120, height: 44 },
      'staging-cancel': { x: 20, y: 800, width: 100, height: 44 },
    };
    const origWidth = window.innerWidth;
    const origHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 852 });
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.getAttribute('data-testid') ?? '';
      const b = rects[id] ?? { x: 0, y: 0, width: 0, height: 0 };
      return { ...b, top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height, toJSON: () => b } as DOMRect;
    });
    try {
      for (const action of ['idle', 'selected', 'staged'] as const) {
        if (action === 'selected') await click('hand-card-0');
        if (action === 'staged') await click('zone-points');
        root().setAttribute('data-poke', action);
        await settle();
        frames.run();
        const p = c.placement;
        const bubble: Box = { x: p.x, y: p.y, width: Math.min(320, 393 - 32), height: 150 };
        // Idle and selected: the demo's card and its drop target (the line
        // names both). Staged: the staged card and target, and the bar.
        const extra = action === 'staged' ? ['staging-bar', 'hand-card-0', 'zone-points'] : ['hand-card-0', 'zone-points'];
        for (const id of [...c.targets, 'menu-button', ...extra]) {
          expect(intersects(bubble, rects[id]), `${action}: bubble over ${id}`).toBe(false);
        }
        expect(c.holes.length).toBe(c.targets.length);
      }
    } finally {
      spy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origHeight });
    }
  });
});

describe('dispose', () => {
  it('after dispose, page changes fire no controller callback and nothing stays scheduled', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const noted = vi.spyOn(table, 'noteStagedWrong');
    c.dispose();
    expect(clock.pending()).toBe(0);
    expect(frames.pending()).toBe(0);
    await stage(table.envelope!, wrongIndices(table)[0]);
    expect(q('staging-confirm')).not.toBeNull();
    expect(noted).not.toHaveBeenCalled();
    expect(c.stage).toBe('idle');
    window.dispatchEvent(new Event('pointerdown'));
    clock.advance(DEMO_IDLE_MS * 4);
    expect(clock.pending()).toBe(0);
    expect(frames.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review round 1 (T9): what dispose must tear down, the observer's scope, the
// unknown verdict, and taps on the coach's own controls during a beat.
// ---------------------------------------------------------------------------

/** A table whose run state is reactive and whose `stepIndex` reads are counted (the controller's effect reads it). */
class CountingTable {
  readonly lesson = lessonOf(1);
  readonly step = lessonOf(1).steps.find((s) => s.id === '1.5') as MoveStep;
  #stepIndex = $state(4);
  stepReads = 0;
  phase = $state<'step' | 'success' | 'blake' | 'finished' | 'error'>('step');
  line = { text: this.step.main, tone: 'main' as const };
  lastNudge = null;
  wrongTries = 0;
  refusals = 0;
  pending = false;
  envelope: Envelope;
  appeared = vi.fn();
  noteStagedWrong = vi.fn();
  skipBeat = vi.fn();
  constructor(envelope: Envelope) {
    this.envelope = envelope;
  }
  get stepIndex(): number {
    this.stepReads += 1;
    return this.#stepIndex;
  }
  set stepIndex(n: number) {
    this.#stepIndex = n;
  }
}

/** Mounts a hand-built game-screen root (no GameScreen) for a plain or counting table. */
function handBuiltRoot(inner: string): void {
  host = document.createElement('div');
  host.innerHTML = `<div data-testid="game-screen">${inner}</div>`;
  document.body.append(host);
}

describe('an unknown verdict counts as right (design §7.2 step 4)', () => {
  it('Confirm on the page with no staged source: staged-right with the staged line, never staged-wrong', async () => {
    const table = new CountingTable(newTable(1).envelope!);
    handBuiltRoot('<div data-testid="staging-bar"><button data-testid="staging-cancel"></button><button data-testid="staging-confirm"></button></div>');
    const c = new CoachController({ table, root: root(), clock, frames });
    controller = c;
    await settle();
    expect(c.page.confirm).toBe(true);
    expect(c.page.source).toBeNull();
    expect(c.stage).toBe('staged-right');
    expect(c.text).toBe(table.step.staged);
    expect(table.noteStagedWrong).not.toHaveBeenCalled();
  });
});

describe('the observer watches the game-screen root only', () => {
  it('a mutation outside the root requests no update; one inside does', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    await mountWith(table);
    frames.run();
    await settle();
    frames.run();
    expect(frames.pending()).toBe(0);
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.setAttribute('data-poke', '1');
    outside.append(document.createElement('span'));
    await settle();
    expect(frames.pending(), 'a mutation outside the root').toBe(0);
    outside.remove();
    await settle();
    expect(frames.pending()).toBe(0);
    root().setAttribute('data-poke', '1');
    await settle();
    expect(frames.pending(), 'a mutation inside the root').toBe(1);
  });
});

describe('dispose tears everything down', () => {
  it('disconnects the observer, removes every window and root listener, and stops its effect', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const added: [string, unknown, boolean][] = [];
    const removed: [string, unknown, boolean][] = [];
    const capture = (o: unknown): boolean => (typeof o === 'boolean' ? o : !!(o as AddEventListenerOptions | undefined)?.capture);
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => {
      added.push([type, fn, capture(o)]);
      if (fn) realAdd(type, fn, o);
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) => {
      removed.push([type, fn, capture(o)]);
      if (fn) realRemove(type, fn, o);
    });
    try {
      const table = new CountingTable(newTable(1).envelope!);
      handBuiltRoot('<button data-testid="hand-card-0"></button>');
      const rootAdd = vi.spyOn(root(), 'addEventListener');
      const rootRemove = vi.spyOn(root(), 'removeEventListener');
      const c = new CoachController({ table, root: root(), clock, frames });
      controller = c;
      await settle();
      const observers = observe.mock.contexts.slice();
      expect(observers.length).toBeGreaterThan(0);
      expect(added.length).toBeGreaterThan(0);

      // The effect runs while live: a table change is read.
      const live = table.stepReads;
      table.stepIndex = 5;
      flushSync();
      expect(table.stepReads).toBeGreaterThan(live);

      c.dispose();
      for (const o of observers) expect(disconnect.mock.contexts).toContain(o);
      for (const [type, fn, cap] of added) {
        expect(
          removed.some(([t, f, c2]) => t === type && f === fn && c2 === cap),
          `window ${type} listener removed`,
        ).toBe(true);
      }
      for (const [type, fn, o] of rootAdd.mock.calls) {
        expect(rootRemove.mock.calls.some(([t, f, o2]) => t === type && f === fn && capture(o2) === capture(o))).toBe(true);
      }

      // The effect no longer runs when the old table changes.
      const after = table.stepReads;
      table.stepIndex = 6;
      flushSync();
      table.stepIndex = 4;
      flushSync();
      expect(table.stepReads, 'the effect re-ran after dispose').toBe(after);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      observe.mockRestore();
      disconnect.mockRestore();
    }
  });
});

describe("taps on the coach's own controls never skip a beat (Leave always works)", () => {
  function fakeBubble(): HTMLElement {
    const bubble = document.createElement('section');
    bubble.setAttribute('data-testid', 'coach-bubble');
    bubble.innerHTML =
      '<p aria-live="polite">x</p><button data-testid="coach-show-me">Show me</button><button data-testid="coach-leave">Leave</button>';
    document.body.append(bubble);
    return bubble;
  }

  it('pointerdown on Leave, Show me or the menu button leaves the success and narration beats alone; anywhere else skips', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    await mountWith(table);
    const bubble = fakeBubble();
    try {
      void table.apply(expectedIndex(table));
      await settle();
      expect(table.phase).toBe('success');
      for (const el of [bubble.querySelector('[data-testid="coach-leave"]')!, bubble.querySelector('[data-testid="coach-show-me"]')!, q('menu-button')!]) {
        el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await settle();
        expect(table.phase, `success: ${el.getAttribute('data-testid')}`).toBe('success');
        expect(table.stepIndex).toBe(0);
      }
      q('deck-pile')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(table.phase).toBe('blake');
      vi.advanceTimersByTime(700);
      await settle();
      expect(table.line.text).toBe('Blake played a 6. He has 10.');
      bubble.querySelector('[data-testid="coach-leave"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(table.line.text, 'narration: Leave').toBe('Blake played a 6. He has 10.');
      expect(table.stepIndex).toBe(0);
    } finally {
      bubble.remove();
    }
  });

  it('Enter and Space skip the success and narration beats, not the think pause, and not when they activate a coach control', async () => {
    const table = newTable(2);
    walkTo(table, '2.1');
    await mountWith(table);
    const bubble = fakeBubble();
    const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    try {
      void table.apply(expectedIndex(table));
      await settle();
      key(bubble.querySelector('[data-testid="coach-leave"]')!, 'Enter');
      key(q('menu-button')!, ' ');
      await settle();
      expect(table.phase, 'Enter/Space on a coach control').toBe('success');
      key(document.body, 'Enter');
      await settle();
      expect(table.phase).toBe('blake');
      expect(table.line.text).toBe("Blake's turn.");
      key(document.body, ' ');
      await settle();
      expect(table.line.text, 'the think pause ignores keys').toBe("Blake's turn.");
      vi.advanceTimersByTime(700);
      await settle();
      expect(table.line.text).toBe('Blake played a 6. He has 10.');
      key(document.body, ' ');
      await settle();
      expect(table.phase).toBe('step');
      expect(table.step?.id).toBe('2.2');
    } finally {
      bubble.remove();
    }
  });
});
