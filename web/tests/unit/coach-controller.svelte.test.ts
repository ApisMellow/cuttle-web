// @vitest-environment jsdom
// T9 CoachController (docs/tutorial-plan.md T9; docs/tutorial-design.md §7.1,
// §7.2, §7.4, §8.3, §5.5.1). The coach's state machine, read from the page:
// the REAL GameScreen on the REAL wasm bridge (engine v0.3.0), driven by the
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
  OWN_CONTROLS,
  ownsInput,
  type CoachClock,
  type CoachDeps,
  type CoachFlights,
  type CoachFrames,
} from '../../src/lib/tutorial/coach.svelte';
import { CANCEL_SUFFIX, LESSONS } from '../../src/lib/tutorial/lessons';
import { PLACEMENT, intersects, type Box } from '../../src/lib/tutorial/placement';
import { BLAKE_DONE_BEAT_MS, SUCCESS_BEAT_MS, TutorialTable } from '../../src/lib/tutorial/table.svelte';
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

async function mountWith(table: TutorialTable, extra: Partial<CoachDeps> = {}): Promise<CoachController> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: table } });
  flushSync();
  controller = new CoachController({ table, root: root(), clock, frames, ...extra });
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
  if (m.Kind === MoveKind.DiscardPair) {
    await click(`hand-card-${m.DiscardA}`);
    return click(`hand-card-${m.DiscardB}`);
  }
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
    // T14: the very first move lights the Points row too (the line names it).
    expect(c.targets).toEqual([`hand-card-${nine}`, 'zone-points']);

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
    expect(c.page).toEqual({ selectedHand: null, source: null, target: null, confirm: false, pair: null });
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

describe('step 4.2: countering from the board (design §5.5.1, issue #93)', () => {
  it('fresh, selected (the marker lights), staged by tap, Cancel, then the counter', async () => {
    const table = newTable(4);
    walkTo(table, '4.2');
    const c = await mountWith(table);
    const step = moveStep(table);
    const two = handIndexOf(table, { Rank: 2, Suit: 2 });
    expect(table.curtain).toEqual({ kind: 'none' });
    expect(q('board')).not.toBeNull();
    expect(q('counter-prompt')).toBeNull();
    expect(q('discard-picker')).not.toBeNull();
    expect(c.stage).toBe('idle');
    expect(c.page).toEqual({ selectedHand: null, source: null, target: null, confirm: false, pair: null });
    expect(c.targets).toEqual([`hand-card-${two}`]);
    expect(c.text).toBe(step.main);

    await click(`hand-card-${two}`);
    expect(c.stage).toBe('selected');
    expect(q('counter-link')!.dataset.state).toBe('highlighted');
    expect(c.targets).toEqual([`hand-card-${two}`, 'counter-link']);
    expect(c.text).toBe(step.main);

    await click('counter-link');
    expect(c.page.target).toBe('counter-link');
    expect(c.stage).toBe('staged-right');
    expect(c.text).toBe(step.staged);
    expect(c.targets).toEqual(['staging-confirm']);
    await click('staging-cancel');
    expect(c.stage).toBe('idle');

    await click(`hand-card-${two}`);
    await click('counter-link');
    await click('staging-confirm');
    expect(table.refusals).toBe(0);
    expect(c.stage).toBe('done');
    expect(c.text).toBe(step.success);
  });

  it('a discard is staged-wrong, then refused with the nudge; the board stays usable and two tries bring the tap route', async () => {
    const table = newTable(4);
    walkTo(table, '4.2');
    const c = await mountWith(table);
    const step = moveStep(table);
    const env = table.envelope!;
    const two = handIndexOf(table, { Rank: 2, Suit: 2 });
    const discard = env.legalMoves.findIndex((m) => m.Kind === MoveKind.DiscardPair);
    expect(discard).toBeGreaterThanOrEqual(0);

    await stage(env, discard);
    expect(c.page.pair).not.toBeNull();
    expect(c.stage).toBe('staged-wrong');
    expect(c.text).toBe(step.nudges[0].text + CANCEL_SUFFIX);
    expect(c.targets).toEqual(['staging-cancel']);

    await click('staging-confirm');
    expect(table.refusals).toBe(1);
    expect(table.lastNudge).toBe(step.nudges[0].text);
    expect(c.stage).toBe('refused');
    expect(c.text).toBe(step.nudges[0].text);
    expect(c.targets).toEqual([`hand-card-${two}`]);
    // Nothing applied: Alice still owes the discard, and every control is live.
    expect(table.envelope!.state.you.hand).toHaveLength(2);
    expect(table.curtain).toEqual({ kind: 'none' });
    expect(q('staging-confirm')).toBeNull();
    for (const i of [0, 1]) expect((q(`hand-card-${i}`) as HTMLButtonElement).disabled).toBe(false);

    await click(`hand-card-${two}`);
    expect(table.wrongTries).toBe(2);
    expect(c.stage).toBe('selected');
    expect(c.text).toBe(step.tapRoute);
    await click('counter-link');
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
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
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
    vi.advanceTimersByTime(BLAKE_DONE_BEAT_MS);
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

  it('a tap demo at 2.2 taps the deck twice; at 4.2 a drag of the 2 onto the last-turn marker', async () => {
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
    expect(c4.demo).toMatchObject({ kind: 'drag', card: { Rank: 2, Suit: 2 } });
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

// ---------------------------------------------------------------------------
// T12b: what the bubble keeps clear of, and scrolling every target into view
// ---------------------------------------------------------------------------

/** Fixes the layout boxes (jsdom has none) by testid, at a 393x852 viewport, for the length of `fn`. */
async function withLayout(rects: Record<string, Box>, fn: () => Promise<void>): Promise<void> {
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
    await fn();
  } finally {
    spy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: origWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: origHeight });
  }
}

/** The bubble's box from its placement (width as at 393 wide, the reserved height). */
function bubbleBox(c: CoachController): Box {
  return { x: c.placement.x, y: c.placement.y, width: 320, height: 150 };
}

/** The 393x852 board, measured from the real app (lesson 5, before the 8). */
const BOARD_852: Record<string, Box> = {
  'score-bar': { x: 0, y: 0, width: 393, height: 44 },
  'menu-button': { x: 339, y: 0, width: 44, height: 44 },
  board: { x: 0, y: 0, width: 393, height: 792 },
  'opponent-zone': { x: 0, y: 48, width: 393, height: 197 },
  'opp-hand': { x: 10, y: 48, width: 373, height: 42 },
  'point-1-0': { x: 14, y: 175, width: 60, height: 70 },
  'point-1-1': { x: 78, y: 175, width: 60, height: 70 },
  'deck-pile': { x: 10, y: 340, width: 60, height: 84 },
  'zone-oneoff': { x: 84, y: 340, width: 225, height: 84 },
  'scrap-pile': { x: 323, y: 340, width: 60, height: 84 },
  'zone-points': { x: 10, y: 519, width: 373, height: 84 },
  'zone-permanents': { x: 10, y: 607, width: 373, height: 84 },
  'hand-card-0': { x: 70, y: 705, width: 60, height: 78 },
  'hand-card-1': { x: 134, y: 705, width: 60, height: 78 },
  'hand-card-2': { x: 198, y: 705, width: 60, height: 78 },
  'hand-card-3': { x: 262, y: 705, width: 60, height: 78 },
  'staging-bar': { x: 0, y: 792, width: 393, height: 60 },
};

describe("T12b: the bubble stays off Blake's hand during the beats", () => {
  it("success beat: clear of his hand (the glasses flip plays there); Blake's think pause and narration: clear of his hand and his rows", async () => {
    const table = newTable(5);
    walkTo(table, '5.1');
    const c = await mountWith(table);
    await withLayout(BOARD_852, async () => {
      void table.apply(expectedIndex(table));
      await settle();
      frames.run();
      expect(c.stage).toBe('done');
      expect(intersects(bubbleBox(c), BOARD_852['opp-hand']), 'success beat over his hand').toBe(false);

      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      await settle();
      frames.run();
      expect(c.stage).toBe('blake');
      expect(table.line.text).toBe("Blake's turn.");
      expect(intersects(bubbleBox(c), BOARD_852['opponent-zone']), 'think pause over his side').toBe(false);
      // His draw starts at the deck: that stays in sight too.
      expect(intersects(bubbleBox(c), BOARD_852['deck-pile']), 'think pause over the deck').toBe(false);

      vi.advanceTimersByTime(700);
      await settle();
      frames.run();
      expect(c.stage).toBe('blake');
      expect(table.line.text).toBe('Blake drew an Ace. You saw it.');
      expect(intersects(bubbleBox(c), BOARD_852['opponent-zone']), 'narration over his side').toBe(false);
      expect(intersects(bubbleBox(c), BOARD_852['deck-pile']), 'narration over the deck (his drawn card flies from it)').toBe(false);
      // Still above the action bar: the bubble isn't pushed off the board.
      expect(c.placement.y + 150).toBeLessThanOrEqual(792 - 12);
    });
  });
});

describe('T12b: at `selected` the bubble stays off every lit target of the selected card', () => {
  it('5.1, the 8 selected: neither the lit Points zone nor his lit point cards are covered', async () => {
    const table = newTable(5);
    walkTo(table, '5.1');
    const c = await mountWith(table);
    const eight = handIndexOf(table, { Rank: 8, Suit: 0 });
    await withLayout(BOARD_852, async () => {
      await click(`hand-card-${eight}`);
      frames.run();
      expect(c.stage).toBe('selected');
      const lit = [...root().querySelectorAll('[data-state="highlighted"]')]
        .map((el) => el.closest('[data-testid]')?.getAttribute('data-testid') ?? '')
        .filter((id) => /^(zone-|point-|perm-)/.test(id));
      // The page really lights them (the precondition for the test to mean anything).
      expect(lit).toContain('zone-points');
      expect(lit).toContain('point-1-0');
      for (const id of new Set(lit)) expect(intersects(bubbleBox(c), BOARD_852[id]), `bubble over lit ${id}`).toBe(false);
      for (const id of c.targets) expect(intersects(bubbleBox(c), BOARD_852[id]), `bubble over hole ${id}`).toBe(false);
    });
  });
});

describe('T12b: every spotlit target is scrolled into view', () => {
  function stubScroll(el: HTMLElement): ReturnType<typeof vi.fn> {
    const scrollBy = vi.fn();
    Object.defineProperty(el, 'scrollBy', { configurable: true, value: scrollBy });
    return scrollBy;
  }

  it('scrolls the board by the union of the targets, below the sticky score bar, when they fit', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
    const board = q('board')!;
    const scrollBy = stubScroll(board);
    const intoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: intoView });
    try {
      await withLayout(
        {
          ...BOARD_852,
          board: { x: 0, y: 0, width: 393, height: 600 },
          // The Points zone is half under the sticky score bar; the 9 is in view.
          'zone-points': { x: 10, y: 20, width: 373, height: 84 },
          [`hand-card-${nine}`]: { x: 40, y: 480, width: 60, height: 78 },
        },
        async () => {
          // 1.5 at rest already lights the 9 and the Points row (T14).
          frames.run();
          expect(c.targets).toEqual([`hand-card-${nine}`, 'zone-points']);
          // Up by 24 px: the zone's top (20) to the score bar's bottom (44).
          expect(scrollBy).toHaveBeenCalledTimes(1);
          expect(scrollBy.mock.calls[0][0]).toMatchObject({ top: -24 });
          expect(intoView).not.toHaveBeenCalled();
        },
      );
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('does not scroll when every target is already in view', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
    const scrollBy = stubScroll(q('board')!);
    await withLayout({ ...BOARD_852, [`hand-card-${nine}`]: { x: 40, y: 705, width: 60, height: 78 } }, async () => {
      frames.run();
      await click(`hand-card-${nine}`);
      frames.run();
      expect(c.targets).toHaveLength(2);
      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  it('when the targets cannot all fit, brings the first one into view (nearest)', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
    const scrollBy = stubScroll(q('board')!);
    const calls: Element[] = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        calls.push(this);
      },
    });
    try {
      await withLayout(
        {
          ...BOARD_852,
          board: { x: 0, y: 0, width: 393, height: 300 },
          'zone-points': { x: 10, y: -400, width: 373, height: 84 },
          [`hand-card-${nine}`]: { x: 40, y: 200, width: 60, height: 78 },
        },
        async () => {
          // 1.5 at rest already lights the 9 and the Points row (T14).
          frames.run();
          expect(c.targets[0]).toBe(`hand-card-${nine}`);
          expect(calls.map((el) => el.getAttribute('data-testid'))).toEqual([`hand-card-${nine}`]);
          expect(scrollBy).not.toHaveBeenCalled();
        },
      );
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('T12b: the spotlight rings are keyed by target', () => {
  it('holeIds names each measured hole, in the holes order', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
    await withLayout(BOARD_852, async () => {
      await click(`hand-card-${nine}`);
      frames.run();
      expect(c.holeIds).toEqual([`hand-card-${nine}`, 'zone-points']);
      expect(c.holes).toHaveLength(2);
    });
  });
});

describe("T12b: one definition of the coach's own controls", () => {
  it('ownsInput is true inside the bubble and done sheet buttons and the menu button, false elsewhere', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<section data-testid="coach-bubble"><button id="a">Leave</button><p id="b">x</p></section>' +
      '<div data-testid="coach-lesson-done"><button id="c">Next</button></div>' +
      '<button data-testid="menu-button" id="d"><span id="e"></span></button><button data-testid="deck-pile" id="f"></button>';
    document.body.append(wrap);
    try {
      const at = (id: string) => wrap.querySelector(`#${id}`);
      expect(['a', 'c', 'd', 'e'].map((id) => ownsInput(at(id)))).toEqual([true, true, true, true]);
      expect(['b', 'f'].map((id) => ownsInput(at(id)))).toEqual([false, false]);
      expect(ownsInput(null)).toBe(false);
      expect(OWN_CONTROLS).toContain('[data-testid="menu-button"]');
    } finally {
      wrap.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// T14 judge M1: a dragged card eases back into the hand after the drop
// (HandCard's `translate` transition). The page changes no attribute when it
// lands, so the coach must re-measure when the transition ends, or the bubble
// keeps avoiding where the card was mid-flight and covers where it settled.
// ---------------------------------------------------------------------------

describe('T14 M1: the bubble re-places once a dragged card settles', () => {
  for (const type of ['transitionend', 'transitioncancel'] as const) {
    it(`a ${type} inside the root re-measures: staged-right never covers the settled staged card`, async () => {
      const table = newTable(1);
      walkTo(table, '1.5');
      const c = await mountWith(table);
      const nine = handIndexOf(table, { Rank: 9, Suit: 1 });
      const card = `hand-card-${nine}`;
      const rects: Record<string, Box> = {
        ...BOARD_852,
        'staging-confirm': { x: 250, y: 800, width: 120, height: 44 },
        'staging-cancel': { x: 130, y: 800, width: 110, height: 44 },
        // Released over the Points row: the card is still there as the coach first measures.
        [card]: { x: 150, y: 525, width: 60, height: 78 },
      };
      await withLayout(rects, async () => {
        await click(card);
        await click('zone-points');
        frames.run();
        expect(c.stage).toBe('staged-right');

        // The card eases back to its lifted hand slot; only a transition event says so.
        rects[card] = { x: 70, y: 693, width: 60, height: 78 };
        expect(frames.pending(), 'nothing is scheduled before the event').toBe(0);
        q(card)!.dispatchEvent(new Event(type, { bubbles: true }));
        expect(frames.pending(), `a ${type} schedules a measure`).toBe(1);
        frames.run();
        expect(intersects(bubbleBox(c), rects[card]), 'bubble over the settled staged card').toBe(false);
        for (const id of c.targets) expect(intersects(bubbleBox(c), rects[id]), `bubble over hole ${id}`).toBe(false);
      });
    });
  }

  it('dispose removes the transition listeners too (the same function, capture: true)', async () => {
    const table = newTable(1);
    walkTo(table, '1.5');
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    try {
      const c = await mountWith(table);
      const capture = (o: unknown): boolean => (typeof o === 'boolean' ? o : !!(o as AddEventListenerOptions | undefined)?.capture);
      const types = ['transitionend', 'transitioncancel'];
      const fns = types.map((type) => {
        const mine = add.mock.calls.findIndex(([t, , o], i) => t === type && capture(o) && add.mock.contexts[i] === root());
        expect(mine, `${type} listener added on the root`).toBeGreaterThanOrEqual(0);
        return add.mock.calls[mine][1];
      });
      const removed = (type: string, fn: unknown) =>
        remove.mock.calls.some(([t, f, o], i) => t === type && f === fn && capture(o) && remove.mock.contexts[i] === root());
      types.forEach((type, k) => expect(removed(type, fns[k]), `${type} still live before dispose`).toBe(false));
      c.dispose();
      types.forEach((type, k) => expect(removed(type, fns[k]), `${type} removed with capture: true`).toBe(true));
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T14 judge M4: Show me is offered only when it would show something. The
// demo plays at idle, selected and refused; with motion off its markers also
// stay at staged-right (design §8.3). Never on next or appear steps, beats,
// staged-wrong, staged-right with motion, or an error.
// ---------------------------------------------------------------------------

describe('T14 M4: canShowMe', () => {
  it('lesson 2: idle, selected and refused yes; staged-right, staged-wrong, the success and Blake beats and next steps no', async () => {
    const table = newTable(2);
    const c = await mountWith(table);
    const seen: [string, boolean][] = [];
    const note = () => seen.push([c.stage, c.canShowMe]);
    note(); // 2.1 idle
    const env = table.envelope!;
    const seven = handIndexOf(table, { Rank: 7, Suit: 0 });
    await click(`hand-card-${seven}`);
    note(); // selected
    await click('zone-points');
    note(); // staged-right
    await click('staging-cancel');
    await stage(env, wrongIndices(table)[0]);
    note(); // staged-wrong
    await click('staging-confirm');
    note(); // refused
    void table.apply(expectedIndex(table));
    await settle();
    note(); // done
    vi.advanceTimersByTime(SUCCESS_BEAT_MS);
    await settle();
    note(); // blake
    for (let n = 0; n < 20 && table.step?.id !== '2.3'; n++) {
      if (table.phase === 'step') void table.apply(expectedIndex(table));
      vi.advanceTimersToNextTimer();
      await settle();
    }
    await settle();
    note(); // 2.3 next
    expect(seen).toEqual([
      ['idle', true],
      ['selected', true],
      ['staged-right', false],
      ['staged-wrong', false],
      ['refused', true],
      ['done', false],
      ['blake', false],
      ['next', false],
    ]);
  });

  it('reduced motion keeps Show me at staged-right (the numbered markers re-show)', async () => {
    settings.reducedMotion = true;
    const table = newTable(1);
    walkTo(table, '1.5');
    const c = await mountWith(table);
    await stage(table.envelope!, expectedIndex(table));
    expect(c.stage).toBe('staged-right');
    expect(c.canShowMe).toBe(true);
  });

  it('an appear step (5.3) has no demo', async () => {
    const table = newTable(5);
    walkTo(table, '5.3');
    const c = await mountWith(table);
    expect(c.stage).toBe('appear');
    expect(c.canShowMe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T14 judge M2: during the success beat the learner's move is in flight (3.1's
// scuttle hits Blake's 9 and both cards fly to the scrap), and during Blake's
// beat his reply is. The overlay hands the coach those boxes; the bubble keeps
// clear of them, but only during their own beat.
// ---------------------------------------------------------------------------

describe('T14 M2: the bubble keeps clear of the cards in flight during a beat', () => {
  const hit = BOARD_852['point-1-0'];
  const scrap = BOARD_852['scrap-pile'];
  const source = { x: 70, y: 705, width: 60, height: 78 };

  it("3.1's scuttle: at `done` the bubble covers neither the hit card nor the scrap; a learner box is ignored in Blake's beat", async () => {
    let flights: CoachFlights | null = null;
    const table = newTable(3);
    walkTo(table, '3.1');
    const c = await mountWith(table, { flights: () => flights });
    await withLayout(BOARD_852, async () => {
      // Without flight boxes the success beat docks over Blake's points row (the judge's finding).
      void table.apply(expectedIndex(table));
      await settle();
      frames.run();
      expect(c.stage).toBe('done');
      expect(intersects(bubbleBox(c), hit), 'precondition: the plain dock covers the hit card').toBe(true);

      flights = { beat: 'done', boxes: [hit, scrap, source] };
      c.relayout();
      expect(frames.pending()).toBe(1);
      frames.run();
      for (const b of [hit, scrap, source, BOARD_852['opp-hand']]) expect(intersects(bubbleBox(c), b), JSON.stringify(b)).toBe(false);
      expect(c.placement.y + 150).toBeLessThanOrEqual(792 - 12);

      // Blake's beat reads only Blake's flights.
      flights = { beat: 'done', boxes: [{ x: 0, y: 430, width: 393, height: 200 }] };
      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      await settle();
      frames.run();
      expect(c.stage).toBe('blake');
      const ignoring = bubbleBox(c);
      flights = null;
      c.relayout();
      frames.run();
      expect(bubbleBox(c)).toEqual(ignoring);
    });
  });

  it("Blake's beat: his flight boxes are kept clear of", async () => {
    let flights: CoachFlights | null = null;
    const table = newTable(3);
    walkTo(table, '3.1');
    const c = await mountWith(table, { flights: () => flights });
    await withLayout(BOARD_852, async () => {
      void table.apply(expectedIndex(table));
      vi.advanceTimersByTime(SUCCESS_BEAT_MS);
      await settle();
      frames.run();
      expect(c.stage).toBe('blake');
      const box = { x: 16, y: 440, width: 361, height: 60 };
      expect(intersects(bubbleBox(c), box), 'precondition: the plain placement covers the box').toBe(true);
      flights = { beat: 'blake', boxes: [box] };
      c.relayout();
      frames.run();
      expect(intersects(bubbleBox(c), box)).toBe(false);
    });
  });
});

// T14 judge nice-to-have 3: at 4.2 Blake's 4 crosses the middle spot on its
// way to the scrap; the entry demo waits until it has landed (the overlay
// says how long).
describe('T14: the entry demo can wait for a flight to land', () => {
  it('entryDelay holds the first demo back; it never shortens it', async () => {
    let hold = 990;
    const table = newTable(4);
    walkTo(table, '4.2');
    const c = await mountWith(table, { entryDelay: () => hold });
    frames.run();
    // GhostDemo plays as soon as a demo appears, so none is offered until then.
    expect(c.demo, 'no demo while the flight lands').toBeNull();
    const start = c.playKey;
    clock.advance(DEMO_ENTRY_MS);
    frames.run();
    expect(c.playKey, 'not at the usual 250 ms').toBe(start);
    expect(c.demo).toBeNull();
    clock.advance(990 - DEMO_ENTRY_MS);
    expect(c.playKey).toBe(start + 1);
    expect(frames.pending(), 'the demo is measured again once the hold ends').toBe(1);
    frames.run();
    expect(c.demo?.kind).toBe('drag');
    cleanup();

    hold = 10;
    const t2 = newTable(4);
    walkTo(t2, '4.2');
    const c2 = await mountWith(t2, { entryDelay: () => hold });
    frames.run();
    expect(c2.demo?.kind, 'a short hold holds nothing back').toBe('drag');
    const s2 = c2.playKey;
    clock.advance(DEMO_ENTRY_MS - 1);
    expect(c2.playKey).toBe(s2);
    clock.advance(1);
    expect(c2.playKey).toBe(s2 + 1);
  });
});

// T14 judge nice-to-have 8: at staged-wrong the nudge points at the step's
// real target ("Drop the 10 on his cards"); the bubble keeps it in sight when
// there is room (a soft box: never at the cost of a hole or the staged move).
describe('T14: staged-wrong keeps the step’s real target in sight', () => {
  it("3.1, the 10 staged on her own Points row: the bubble covers neither of Blake's point cards", async () => {
    const table = newTable(3);
    walkTo(table, '3.1');
    const c = await mountWith(table);
    const ten = handIndexOf(table, { Rank: 10, Suit: 2 });
    const rects: Record<string, Box> = {
      ...BOARD_852,
      'staging-confirm': { x: 290, y: 800, width: 90, height: 44 },
      'staging-cancel': { x: 200, y: 800, width: 84, height: 44 },
      [`hand-card-${ten}`]: { x: 102, y: 693, width: 60, height: 78 },
    };
    await withLayout(rects, async () => {
      await click(`hand-card-${ten}`);
      await click('zone-points');
      frames.run();
      expect(c.stage).toBe('staged-wrong');
      for (const id of ['point-1-0', 'point-1-1']) expect(intersects(bubbleBox(c), rects[id]), `bubble over ${id}`).toBe(false);
      for (const id of [...c.targets, `hand-card-${ten}`, 'zone-points', 'staging-bar', 'menu-button']) {
        expect(intersects(bubbleBox(c), rects[id]), `bubble over ${id}`).toBe(false);
      }
    });
  });
});

// T14 review B1: Show me during the 4.2 entry hold plays the demo at once.
describe('T14 review B1: Show me releases the entry hold', () => {
  it('at 4.2, held for 990 ms: Show me before the clock moves offers the demo and plays it', async () => {
    const table = newTable(4);
    walkTo(table, '4.2');
    const c = await mountWith(table, { entryDelay: () => 990 });
    frames.run();
    expect(c.demo, 'held').toBeNull();
    const before = c.playKey;
    c.showMe();
    frames.run();
    expect(c.demo?.kind).toBe('drag');
    expect(c.playKey).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// The 393x660 lesson 3 geometry flake (CI, after T14fix). At 3.1 `selected`
// the holes are the 10 and Blake's two point cards, and the lit Points row
// (a legal but wrong drop) fills the only gap between them. With the lit
// targets as hard boxes no spot was clear, so the dock gave up at the top and
// covered his point cards whenever the board sat scrolled by 22 px (the
// browser's focus scroll to the 10; at 0 px it missed them by 7 px). The
// rects below are the failing run's, measured in Chromium at 393x660.
// ---------------------------------------------------------------------------

describe('393x660, 3.1 selected with the board scrolled 22 px: no hole is covered', () => {
  const RECTS_660: Record<string, Box> = {
    'score-bar': { x: 0, y: 0, width: 393, height: 44 },
    'menu-button': { x: 339, y: 0, width: 44, height: 44 },
    board: { x: 0, y: 0, width: 393, height: 599 },
    'opp-hand': { x: 10, y: 26, width: 373, height: 42 },
    'point-1-0': { x: 14, y: 152, width: 52, height: 68 },
    'point-1-1': { x: 72, y: 152, width: 52, height: 68 },
    'deck-pile': { x: 10, y: 233, width: 60, height: 84 },
    'zone-oneoff': { x: 82, y: 233, width: 229, height: 84 },
    'scrap-pile': { x: 323, y: 233, width: 60, height: 78 },
    'zone-points': { x: 10, y: 327, width: 373, height: 84 },
    'zone-permanents': { x: 10, y: 415, width: 373, height: 84 },
    'hand-card-0': { x: 103, y: 509, width: 60, height: 78 },
    'hand-card-1': { x: 167, y: 509, width: 60, height: 78 },
    'hand-card-2': { x: 231, y: 509, width: 60, height: 78 },
  };

  it('the bubble keeps clear of every hole (a lit target may be covered when nothing else fits)', async () => {
    const table = newTable(3);
    walkTo(table, '3.1');
    const c = await mountWith(table);
    const ten = handIndexOf(table, { Rank: 10, Suit: 2 });
    expect(ten).toBe(0);
    const origWidth = window.innerWidth;
    const origHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 660 });
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const b = RECTS_660[this.getAttribute('data-testid') ?? ''] ?? { x: 0, y: 0, width: 0, height: 0 };
      return { ...b, top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height, toJSON: () => b } as DOMRect;
    });
    try {
      await click('hand-card-0');
      frames.run();
      expect(c.stage).toBe('selected');
      expect(c.targets).toEqual(['hand-card-0', 'point-1-0', 'point-1-1']);
      const pad = PLACEMENT.holePad;
      const bubble = bubbleBox(c);
      for (const id of c.targets) {
        const h = RECTS_660[id];
        const padded = { x: h.x - pad, y: h.y - pad, width: h.width + pad * 2, height: h.height + pad * 2 };
        expect(intersects(bubble, padded), `bubble ${JSON.stringify(bubble)} over hole ${id}`).toBe(false);
      }
      // ...and it stays on the board, above the action bar.
      expect(bubble.y).toBeGreaterThanOrEqual(44);
      expect(bubble.y + bubble.height).toBeLessThanOrEqual(599 - PLACEMENT.clearance);
      for (const id of ['menu-button']) expect(intersects(bubble, RECTS_660[id])).toBe(false);
    } finally {
      spy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origHeight });
    }
  });
});
