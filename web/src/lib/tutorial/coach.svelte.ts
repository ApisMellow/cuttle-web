// Learn to play (R25.3, R25.7, R25.10): the coach controller
// (docs/tutorial-design.md §7.1, §7.2, §7.4, §8.3, §5.5.1; plan T9).
//
// It reads two things only: the lesson table's run state (step, phase, line,
// refusals, wrong tries) and the game screen's DOM, through a
// MutationObserver on the GameScreen ROOT and `readStagedPage`. It never
// reads the staging store and never writes the board's DOM: what the learner
// has selected or staged is whatever the page shows (design §7.2).
//
// The stage machine for a move step (design §7.2, plan P8):
//   - `staged-right` / `staged-wrong` only while Confirm is on the page (a
//     staged counter puts its Confirm inside the prompt). The verdict is
//     `classifyStaged` against the table's envelope, read in the same
//     callback; unknown counts as right (the gate decides). While the move
//     is in flight (Confirm disabled, or the table pending) the last verdict
//     is held, so the bubble never flickers before Confirm leaves the DOM.
//   - `refused` is entered when the table's refusal count rises and left at
//     the next page change away from idle (a selection, a stage).
//   - `selected` when a hand card is pressed, else `idle`. Confirm is checked
//     first: the selected card stays pressed while staged.
// Each entry into `staged-wrong` is reported once (`noteStagedWrong`), and
// after two wrong tries the idle and selected line is the tap route (§7.4).
//
// Holes are resolved to testids against Alice's public view at the moment of
// use, and measured once per animation frame, after every change, on resize
// and on any scroll inside the root. Nothing here awaits anything.

import { untrack } from 'svelte';

import type { Card, PlayerView } from '../bridge/schema';
import { testIdForKey } from '../dragDrop';
import { settings } from '../stores/settings.svelte';
import { CANCEL_SUFFIX } from './lessons';
import { classifyStaged, readStagedPage, type StagedPage, type StagedVerdict } from './match';
import { motionOn } from './motion';
import { PLACEMENT, placeBubble, type Box, type BubblePlacement } from './placement';
import type { LineTone, TutorialTable } from './table.svelte';
import type { MoveStep, SpotTarget } from './types';

export type CoachStage =
  | 'idle'
  | 'selected'
  | 'staged-right'
  | 'staged-wrong'
  | 'refused'
  | 'done'
  | 'next'
  | 'appear'
  | 'blake'
  | 'error';

/**
 * While any of these is on the page the overlay fades to 0 and takes no input
 * (design §7.1, plan review focus 1): `.game-screen` is `isolation: isolate`,
 * so the overlay would otherwise paint over every one of them.
 */
export const COVERING_SHEETS = ['game-menu', 'rules-sheet', 'scrap-browser', 'card-detail-popover', 'ambiguity-chooser'] as const;

/** Design §8.3: the demo plays once on step entry, after the bubble lands. */
export const DEMO_ENTRY_MS = 250;
/** ...and again after this long with no pointer or key input. */
export const DEMO_IDLE_MS = 3500;
/** At most this many automatic plays per step (Show me is never limited). */
export const DEMO_AUTO_PLAYS = 3;

/** Room reserved for the bubble: four lines of copy plus the footer (design §7.3). */
export const BUBBLE_RESERVE_PX = 150;
/** Extra room when a headline ("You win!") sits above the copy. */
export const HEADLINE_RESERVE_PX = 34;
const BUBBLE_MAX_WIDTH = 320;

export interface CoachClock {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface CoachFrames {
  request(fn: () => void): number;
  cancel(handle: number): void;
}

/** The slice of `TutorialTable` the coach reads and calls. */
export type CoachTable = Pick<
  TutorialTable,
  | 'lesson'
  | 'step'
  | 'stepIndex'
  | 'phase'
  | 'line'
  | 'lastNudge'
  | 'wrongTries'
  | 'refusals'
  | 'pending'
  | 'envelope'
  | 'appeared'
  | 'noteStagedWrong'
  | 'skipBeat'
>;

export interface CoachDeps {
  table: CoachTable;
  /** The GameScreen root (`[data-testid="game-screen"]`), never the document. */
  root: HTMLElement;
  /** The bubble element, for its measured height. */
  bubble?: () => HTMLElement | null;
  /** True for the calm variant; defaults to the media query or the setting (`motionOn`). */
  reducedMotion?: () => boolean;
  /** Headline shown above the copy, if any (reserves extra room). */
  headline?: () => string | undefined;
  clock?: CoachClock;
  frames?: CoachFrames;
}

/** GhostDemo's input: viewport boxes, re-measured every frame. */
export type CoachDemo = { kind: 'drag'; from: Box; to: Box; card: Card } | { kind: 'tap'; at: Box[] } | null;

const EMPTY_PAGE: StagedPage = { selectedHand: null, source: null, target: null, confirm: false, counter: null };
const START_PLACEMENT: BubblePlacement = { x: PLACEMENT.gutter, y: 56, notch: null, notchX: PLACEMENT.gutter + BUBBLE_MAX_WIDTH / 2 };

const defaultClock: CoachClock = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clear: (handle) => globalThis.clearTimeout(handle),
};

const defaultFrames: CoachFrames = {
  request: (fn) =>
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(() => fn())
      : (globalThis.setTimeout(fn, 16) as unknown as number),
  cancel: (handle) => {
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
    else globalThis.clearTimeout(handle);
  },
};

const sameCard = (a: Card, b: Card): boolean => a.Rank === b.Rank && a.Suit === b.Suit;
const anyOf = (x: Card, wanted: Card | Card[]): boolean => (Array.isArray(wanted) ? wanted.some((w) => sameCard(x, w)) : sameCard(x, wanted));

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * Keeps a hole's padded ring inside the viewport: a full-width target (the
 * score bar, a zone) would otherwise lose its ring at the screen edges.
 */
function clampHole(b: Box, viewport: Box): Box {
  const pad = PLACEMENT.holePad;
  if (viewport.width <= pad * 2 || viewport.height <= pad * 2) return b;
  const left = Math.max(b.x, viewport.x + pad);
  const top = Math.max(b.y, viewport.y + pad);
  const right = Math.min(b.x + b.width, viewport.x + viewport.width - pad);
  const bottom = Math.min(b.y + b.height, viewport.y + viewport.height - pad);
  if (right <= left || bottom <= top) return b;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Controls that act on their own first tap or key press: the bubble's and the done sheet's buttons, and the menu button. */
const OWN_CONTROLS = '[data-testid="coach-bubble"] button, [data-testid="coach-lesson-done"] button, [data-testid="menu-button"]';

function ownsInput(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(OWN_CONTROLS) !== null;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

export class CoachController {
  readonly #table: CoachTable;
  readonly #root: HTMLElement;
  readonly #bubble: () => HTMLElement | null;
  readonly #reduced: () => boolean;
  readonly #headline: () => string | undefined;
  readonly #clock: CoachClock;
  readonly #frames: CoachFrames;
  readonly #win: Window | null;
  readonly #observer: MutationObserver;
  readonly #stopEffects: () => void;

  #disposed = false;
  #frame: number | null = null;
  #entryTimer: number | null = null;
  #idleTimer: number | null = null;

  // Per-step bookkeeping. Plain fields: only #update reads and writes them.
  #runKey = '';
  #refusalsSeen = 0;
  #refused = false;
  /** The page has been idle since the refusal; the next non-idle page leaves `refused`. */
  #refusedArmed = false;
  #lastVerdict: StagedVerdict | null = null;
  #inStagedWrong = false;
  #autoPlays = 0;
  #scrolledFor = '';

  // What the overlay renders.
  #stage = $state<CoachStage>('idle');
  #text = $state('');
  #tone = $state<LineTone>('main');
  #targets = $state.raw<readonly string[]>([]);
  #holes = $state.raw<readonly Box[]>([]);
  #covered = $state(false);
  #shake = $state(0);
  #playKey = $state(0);
  #demo = $state.raw<CoachDemo>(null);
  #confirmBox = $state.raw<Box | undefined>(undefined);
  #placement = $state.raw<BubblePlacement>(START_PLACEMENT);
  #page = $state.raw<StagedPage>(EMPTY_PAGE);
  #blockTop = $state(0);

  get stage(): CoachStage {
    return this.#stage;
  }
  /** The bubble's line. */
  get text(): string {
    return this.#text;
  }
  get tone(): LineTone {
    return this.#tone;
  }
  /** The spotlit elements' testids, in order. */
  get targets(): readonly string[] {
    return this.#targets;
  }
  /** Their measured viewport boxes (unpadded). */
  get holes(): readonly Box[] {
    return this.#holes;
  }
  /** A menu, sheet, popover or chooser is open: fade out, take no input. */
  get covered(): boolean {
    return this.#covered;
  }
  /** Bumped on every refusal and staged-wrong entry; the bubble shakes once per bump. */
  get shake(): number {
    return this.#shake;
  }
  /** Bumped for every intended demo play. */
  get playKey(): number {
    return this.#playKey;
  }
  get demo(): CoachDemo {
    return this.#demo;
  }
  /** Confirm's box once a right move is staged (the reduced-motion "3" marker). */
  get confirmBox(): Box | undefined {
    return this.#confirmBox;
  }
  get placement(): BubblePlacement {
    return this.#placement;
  }
  /** What the page shows of staging, as last read. */
  get page(): StagedPage {
    return this.#page;
  }
  /** Top of the board blocker in the error phase: under the score bar, so the menu stays live. */
  get blockTop(): number {
    return this.#blockTop;
  }

  constructor(deps: CoachDeps) {
    this.#table = deps.table;
    this.#root = deps.root;
    this.#bubble = deps.bubble ?? (() => null);
    this.#reduced = deps.reducedMotion ?? (() => !motionOn(settings.reducedMotion));
    this.#headline = deps.headline ?? (() => undefined);
    this.#clock = deps.clock ?? defaultClock;
    this.#frames = deps.frames ?? defaultFrames;
    this.#win = this.#root.ownerDocument.defaultView;
    this.#refusalsSeen = this.#table.refusals;

    this.#observer = new MutationObserver(() => this.#update());
    this.#observer.observe(this.#root, { attributes: true, childList: true, subtree: true });

    const win = this.#win;
    win?.addEventListener('pointerdown', this.#onPointer, { capture: true, passive: true });
    win?.addEventListener('keydown', this.#onKey, true);
    win?.addEventListener('resize', this.#onLayout);
    // Scroll doesn't bubble; capturing on the root sees the board's own scroll.
    this.#root.addEventListener('scroll', this.#onLayout, { capture: true, passive: true });

    // The table's run state changes without touching the page (a beat timer,
    // a refusal at the counter prompt), so it is watched too.
    this.#stopEffects = $effect.root(() => {
      $effect(() => {
        const t = this.#table;
        void t.stepIndex;
        void t.phase;
        void t.refusals;
        void t.pending;
        void t.envelope;
        void t.wrongTries;
        void t.line;
        void t.lastNudge;
        untrack(() => this.#update());
      });
    });

    this.#update();
  }

  /** Show me: replay the demo now. */
  showMe(): void {
    if (this.#disposed) return;
    this.#playKey += 1;
  }

  /** Disconnects the observer and every listener, timer and frame. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer.disconnect();
    this.#stopEffects();
    const win = this.#win;
    win?.removeEventListener('pointerdown', this.#onPointer, { capture: true });
    win?.removeEventListener('keydown', this.#onKey, true);
    win?.removeEventListener('resize', this.#onLayout);
    this.#root.removeEventListener('scroll', this.#onLayout, { capture: true });
    if (this.#frame !== null) this.#frames.cancel(this.#frame);
    this.#frame = null;
    this.#clearTimers();
  }

  // --- input ---------------------------------------------------------------

  /**
   * A tap during a success or narration beat moves on (plan P3); the table
   * ignores it during the think pause. A tap on the coach's own controls or
   * the menu button never skips: it must act on its first tap (Leave always
   * works), and a skip would move the bubble out from under the finger.
   */
  #onPointer = (event: Event): void => {
    if (this.#disposed) return;
    this.#input();
    if (!ownsInput(event.target)) this.#skipBeat();
  };

  /** Enter and Space skip a beat too, unless they are activating one of those controls. */
  #onKey = (event: KeyboardEvent): void => {
    if (this.#disposed) return;
    this.#input();
    if ((event.key === 'Enter' || event.key === ' ') && !ownsInput(event.target)) this.#skipBeat();
  };

  #onLayout = (): void => {
    this.#schedule();
  };

  #skipBeat(): void {
    const phase = this.#table.phase;
    if (phase === 'success' || phase === 'blake') this.#table.skipBeat();
  }

  /** Any pointer or key input restarts the idle wait before the next automatic demo. */
  #input(): void {
    if (this.#idleTimer === null) return;
    this.#clock.clear(this.#idleTimer);
    this.#idleTimer = this.#clock.set(this.#autoPlay, DEMO_IDLE_MS);
  }

  // --- the demo timeline (design §8.3) ---------------------------------------

  #autoPlay = (): void => {
    this.#entryTimer = null;
    this.#idleTimer = null;
    if (this.#disposed || this.#autoPlays >= DEMO_AUTO_PLAYS) return;
    this.#autoPlays += 1;
    this.#playKey += 1;
    if (this.#autoPlays < DEMO_AUTO_PLAYS) this.#idleTimer = this.#clock.set(this.#autoPlay, DEMO_IDLE_MS);
  };

  #clearTimers(): void {
    if (this.#entryTimer !== null) this.#clock.clear(this.#entryTimer);
    if (this.#idleTimer !== null) this.#clock.clear(this.#idleTimer);
    this.#entryTimer = null;
    this.#idleTimer = null;
  }

  /** A new step (or a restart): forget the last step's coach state, and queue the entry demo. */
  #beginStep(): void {
    this.#refused = false;
    this.#refusedArmed = false;
    this.#lastVerdict = null;
    this.#inStagedWrong = false;
    this.#autoPlays = 0;
    this.#refusalsSeen = this.#table.refusals;
    this.#clearTimers();
    const step = this.#table.step;
    if (this.#table.phase === 'step' && step?.kind === 'move' && step.demo.kind !== 'none') {
      this.#entryTimer = this.#clock.set(this.#autoPlay, DEMO_ENTRY_MS);
    }
  }

  // --- the stage machine -----------------------------------------------------

  #update(): void {
    if (this.#disposed) return;
    const t = this.#table;
    const root = this.#root;

    const runKey = `${t.stepIndex}|${t.phase === 'error' ? 'error' : ''}`;
    if (runKey !== this.#runKey) {
      this.#runKey = runKey;
      this.#beginStep();
    }

    // An appear step completes as its element shows, including one already
    // up when the step starts (opened during Blake's narration).
    const step = t.step;
    if (t.phase === 'step' && step?.kind === 'appear' && root.querySelector(`[data-testid="${step.testId}"]`) !== null) {
      t.appeared(step.testId);
      if (t.step !== step) {
        this.#update();
        return;
      }
    }

    const page = readStagedPage(root);
    this.#page = page;
    this.#covered = COVERING_SHEETS.some((id) => root.querySelector(`[data-testid="${id}"]`) !== null);

    if (t.refusals !== this.#refusalsSeen) {
      const rose = t.refusals > this.#refusalsSeen;
      this.#refusalsSeen = t.refusals;
      if (rose && t.phase === 'step') {
        this.#shake += 1;
        if (step?.kind === 'move') {
          this.#refused = true;
          this.#refusedArmed = false;
          this.#playKey += 1; // the demo replays once (design §7.2)
        }
      }
    }

    const view = t.envelope?.state ?? null;
    let stage: CoachStage;
    let text = t.line.text;
    let tone: LineTone = t.line.tone;
    let ids: string[] = [];

    if (t.phase === 'error') {
      stage = 'error';
    } else if (t.phase === 'success' || t.phase === 'finished' || step === null) {
      stage = 'done';
    } else if (t.phase === 'blake') {
      stage = 'blake';
    } else if (step.kind === 'next' || step.kind === 'appear') {
      stage = step.kind;
      ids = step.spot.flatMap((s) => this.#resolve(s, view, null));
    } else {
      ({ stage, text, tone, ids } = this.#moveStage(step, page, view));
    }

    // One noteStagedWrong per entry into staged-wrong (design §7.4).
    const wrongNow = stage === 'staged-wrong';
    if (wrongNow && !this.#inStagedWrong) {
      this.#shake += 1;
      t.noteStagedWrong();
    }
    this.#inStagedWrong = wrongNow;

    this.#stage = stage;
    this.#text = text;
    this.#tone = tone;
    const next = unique(ids);
    if (next.join(' ') !== this.#targets.join(' ')) this.#targets = next;
    this.#schedule();
  }

  #moveStage(
    step: MoveStep,
    page: StagedPage,
    view: PlayerView | null,
  ): { stage: CoachStage; text: string; tone: LineTone; ids: string[] } {
    const t = this.#table;
    const env = t.envelope;
    const staged = page.confirm || page.counter === 'staged';
    const idle = page.selectedHand === null && !staged;

    if (this.#refused) {
      if (idle) this.#refusedArmed = true;
      else if (this.#refusedArmed) this.#refused = false;
    }

    if (staged) {
      const confirm = this.#root.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]');
      const inFlight = t.pending || confirm?.disabled === true;
      const verdict: StagedVerdict =
        inFlight && this.#lastVerdict !== null ? this.#lastVerdict : env ? classifyStaged(page, env, step) : { verdict: 'unknown' };
      this.#lastVerdict = verdict;
      if (verdict.verdict === 'wrong') {
        return { stage: 'staged-wrong', text: verdict.nudge + CANCEL_SUFFIX, tone: 'nudge', ids: ['staging-cancel'] };
      }
      return { stage: 'staged-right', text: step.staged, tone: 'main', ids: ['staging-confirm'] };
    }
    this.#lastVerdict = null;

    const route = t.wrongTries >= 2 ? step.tapRoute : step.main;
    const source = this.#resolve(step.source, view, null);
    if (this.#refused) {
      // On the board the refusal shows its own nudge, without the Cancel
      // sentence. At the counter prompt the refused state IS the fresh prompt
      // (§5.5.1 "Fresh again"), so two tries there bring the tap route.
      const nudge = t.lastNudge ?? step.generic;
      const text = page.counter !== null && t.wrongTries >= 2 ? step.tapRoute : nudge;
      return { stage: 'refused', text, tone: 'nudge', ids: source };
    }
    if (page.selectedHand !== null) {
      const card = this.#resolve(step.source, view, page.selectedHand);
      return { stage: 'selected', text: route, tone: 'main', ids: [...card, ...this.#resolve(step.target, view, null)] };
    }
    return { stage: 'idle', text: route, tone: 'main', ids: source };
  }

  /** A lesson's spotlight target as testids, against Alice's public view now. */
  #resolve(spot: SpotTarget, view: PlayerView | null, selected: number | null): string[] {
    switch (spot.kind) {
      case 'testid':
        return [spot.id];
      case 'hand': {
        if (!view) return [];
        const idx = view.you.hand.flatMap((card, i) => (anyOf(card, spot.card) ? [i] : []));
        if (selected !== null && idx.includes(selected)) return [`hand-card-${selected}`];
        return idx.map((i) => `hand-card-${i}`);
      }
      case 'handRank': {
        if (!view) return [];
        return view.you.hand.flatMap((card, i) => (card.Rank === spot.rank ? [`hand-card-${i}`] : []));
      }
      case 'point': {
        if (!view) return [];
        const wanted = Array.isArray(spot.card) ? spot.card : [spot.card];
        const out: string[] = [];
        for (const card of wanted) {
          const mine = view.you.points.findIndex((p) => sameCard(p.Card, card));
          if (mine >= 0) out.push(`point-${view.viewer}-${mine}`);
          const theirs = view.opponent.points.findIndex((p) => sameCard(p.Card, card));
          if (theirs >= 0) out.push(`point-${1 - view.viewer}-${theirs}`);
        }
        return out;
      }
      case 'counterOption': {
        const el = this.#root.querySelector('[data-testid^="counter-option-"]');
        const id = el?.getAttribute('data-testid');
        return id ? [id] : [];
      }
    }
  }

  // --- measuring ---------------------------------------------------------------

  #schedule(): void {
    if (this.#disposed || this.#frame !== null) return;
    this.#frame = this.#frames.request(() => this.#measure());
  }

  #el(id: string): HTMLElement | null {
    return this.#root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  #measure(): void {
    this.#frame = null;
    if (this.#disposed) return;
    const t = this.#table;
    const win = this.#win;
    const ids = this.#targets;

    // Bring the first target into view once per new target set (design §7.2:
    // the board scrolls at 393×660). Instant under reduced motion.
    const key = ids.join(' ');
    if (key !== this.#scrolledFor) {
      this.#scrolledFor = key;
      const first = ids.length > 0 ? this.#el(ids[0]) : null;
      if (first && typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ block: 'nearest', behavior: this.#reduced() ? 'instant' : 'smooth' });
      }
    }

    const viewport: Box = { x: 0, y: 0, width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 };
    const holes = ids.flatMap((id) => {
      const el = this.#el(id);
      return el ? [clampHole(boxOf(el), viewport)] : [];
    });

    // The demo: shown while the learner is still to make the move; with motion
    // off it stays as static markers, Confirm's "3" included once staged right.
    const step = t.step;
    const view = t.envelope?.state ?? null;
    let demo: CoachDemo = null;
    /** What the demo points at: the card it moves and where it goes, or the spots it taps. */
    const demoBoxes: Box[] = [];
    let confirmBox: Box | undefined;
    const stage = this.#stage;
    const showDemo = stage === 'idle' || stage === 'selected' || stage === 'refused' || (stage === 'staged-right' && this.#reduced());
    if (step?.kind === 'move' && showDemo && step.demo.kind !== 'none') {
      const spec = step.demo;
      if (spec.kind === 'drag') {
        const fromId = this.#resolve(spec.from, view, null)[0];
        const toId = this.#resolve(spec.to, view, null)[0];
        const fromEl = fromId ? this.#el(fromId) : null;
        const toEl = toId ? this.#el(toId) : null;
        const handIndex = fromId ? /^hand-card-(\d+)$/.exec(fromId)?.[1] : undefined;
        const card = handIndex !== undefined ? view?.you.hand[Number(handIndex)] : undefined;
        if (fromEl && toEl && card) {
          demo = { kind: 'drag', from: boxOf(fromEl), to: boxOf(toEl), card };
          demoBoxes.push(demo.from, demo.to);
        }
      } else {
        const at = spec.at.flatMap((s) => {
          const id = this.#resolve(s, view, null)[0];
          const el = id ? this.#el(id) : null;
          return el ? [boxOf(el)] : [];
        });
        if (at.length > 0) {
          demo = { kind: 'tap', at };
          demoBoxes.push(...at);
        }
      }
      if (stage === 'staged-right') {
        const confirm = this.#el('staging-confirm');
        if (confirm) confirmBox = boxOf(confirm);
      }
    }
    this.#demo = demo;
    this.#confirmBox = confirmBox;

    // The bubble never covers a hole, the demonstrated card or its target,
    // the staging bar, the menu button or the counter options (design §7.3),
    // nor what is staged: the line is about that setup.
    const avoid: Box[] = [...demoBoxes];
    for (const id of ['staging-bar', 'menu-button']) {
      const el = this.#el(id);
      if (el) avoid.push(boxOf(el));
    }
    for (const el of this.#root.querySelectorAll('[data-testid^="counter-option-"], [data-testid="counter-resolve"]')) avoid.push(boxOf(el));
    const page = this.#page;
    if (page.confirm) {
      const staged = [
        ...(typeof page.source === 'object' && page.source !== null ? [`hand-card-${page.source.hand}`] : []),
        ...(page.target !== null ? [testIdForKey(page.target)] : []),
      ];
      for (const id of staged) {
        const el = this.#el(id);
        if (el) avoid.push(boxOf(el));
      }
    }

    const board = this.#el('board');
    const scoreBar = this.#el('score-bar') ?? this.#el('menu-button');
    const scoreBarBottom = scoreBar ? scoreBar.getBoundingClientRect().bottom : 0;
    const actionBarTop = board ? board.getBoundingClientRect().bottom : viewport.height;
    const measured = this.#bubble()?.getBoundingClientRect().height ?? 0;
    const reserve = BUBBLE_RESERVE_PX + (this.#headline() ? HEADLINE_RESERVE_PX : 0);
    const bubble = {
      width: Math.min(BUBBLE_MAX_WIDTH, viewport.width - PLACEMENT.gutter * 2),
      height: Math.max(reserve, measured),
    };

    this.#holes = holes;
    this.#blockTop = scoreBarBottom;
    this.#placement = placeBubble({
      viewport,
      holes,
      avoid,
      actionBarTop,
      scoreBarBottom,
      bubble,
      dock: page.counter !== null ? 'under-menu' : undefined,
    });
  }
}
