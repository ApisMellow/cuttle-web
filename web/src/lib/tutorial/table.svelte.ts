// Learn to play (R25), docs/tutorial-design.md §6.2 and plan T5: the third
// `TableSource`. It restores a lesson position into the real bridge, gates
// every commit against the current step, and plays Blake's scripted replies
// on timers. It never touches the real game: no storage, no GameStore, no
// session (design §6.5).
//
// Privacy (SPEC §3.3, design §6.2, R25.4 S6):
//   - `envelope` is only ever `view(0)`, Alice's own envelope, checked on
//     every set. The envelope `apply` returns (the mover's) is dropped
//     unread, for Alice's moves and Blake's alike.
//   - Blake's legal-move envelope (`legalMoves()` while he is active, viewer
//     1) lives only in a local variable inside `#blakeMove`. It is never
//     assigned to a field, passed to a hook or rendered.
//   - The motion hooks (T11) get only seat-0 data: Alice's own move and view
//     (`beforeApply`), the seat-0 view on show (`beforeReply`) and the
//     seat-0 log entry for Blake's move (`afterReply`). Each runs inside a
//     try/catch: a motion failure never breaks a lesson.
//
// The gate (R11, design §6.2): the move list GameScreen gets is the engine's,
// unfiltered. Only the commit is checked. A refused commit applies nothing,
// sets the nudge, adds 1 to `refusals` (GameScreen keys the counter prompt on
// it, §5.5.1) and resolves normally, so the board returns to idle and nothing
// is ever stuck.
//
// Beats (plan P3): success line (1200 ms or a tap) -> if Blake replies,
// "Blake's turn." with `pending` true, a think pause (700 ms, 400 ms reduced),
// his move and its narration -> after 1200 ms (or a tap) the next step. A
// reply with no narration hands straight to the next step (lesson 4's 4,
// whose window is step 4.2). `pending` runs from the learner's match until
// Blake's last reply lands (design §6.2). No state path awaits anything:
// every beat is a timer (SPEC §5.9).
//
// Timers: every callback carries the generation it was scheduled in; a
// skip, `dispose`, `restart` or `newGame` bumps the generation, so a stale
// callback is a no-op whether or not the clock managed to cancel it (Review
// focus 3).

import {
  apply as bridgeApply,
  legalMoves as bridgeLegalMoves,
  restore as bridgeRestore,
  snapshot as bridgeSnapshot,
  view as bridgeView,
} from '../bridge/engine';
import type { AppliedMove, BridgeResult, Envelope, Move, PlayerId, PlayerView } from '../bridge/schema';
import { Phase } from '../enums';
import type { CurtainState } from '../stores/curtain.svelte';
import type { TableSource } from '../stores/tableSource';
import { NEXT_FIRST, SNAG_LINE } from './lessons';
import { matchingIndices, moveMatches, nudgeFor } from './match';
import { positionSnapshot } from './position';
import type { BlakeReply, Lesson, MoveStep, Step } from './types';

/** The bridge calls the table makes (plan §5); the production ones by default (P9). */
export interface TutorialEngine {
  restore(json: string, viewer: PlayerId): BridgeResult;
  apply(i: number): BridgeResult;
  view(viewer: PlayerId): BridgeResult;
  legalMoves(): BridgeResult;
  snapshot(): string;
}

/** The beat clock; tests use fake timers through the default. */
export interface TutorialClock {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export type RunPhase = 'step' | 'success' | 'blake' | 'finished' | 'error';

/** What a coach line is, so the bubble can tune its accent. `CoachBubble`'s `CoachTone` is this type. */
export type LineTone = 'main' | 'nudge' | 'success' | 'blake' | 'error';

export interface TutorialTableDeps {
  engine?: TutorialEngine;
  clock?: TutorialClock;
  /** The learner's label (plan B1); never written anywhere. */
  learnerName: string;
  /** Read when Blake's think pause is scheduled. */
  reducedMotion: () => boolean;
  /** The menu's Home. */
  onHome(): void;
  /** Learner moves only: runs before the engine apply, with the matched move and Alice's view (T11). */
  beforeApply?(move: Move, view: PlayerView): void;
  /** Learner moves only: runs after the new state is set (T11). */
  afterApply?(): void;
  /**
   * Blake's replies only (T11): runs just before his move applies, with the
   * table's current seat-0 view, the one on show. Never his Move, his legal
   * list, or anything from seat 1's view.
   */
  beforeReply?(view: PlayerView): void;
  /**
   * Blake's replies only (T11): runs after his move applies and the new state
   * is set, with the new LAST entry of seat 0's history (`by === 1`), already
   * redacted for seat 0 by the bridge.
   */
  afterReply?(entry: AppliedMove): void;
}

export const SUCCESS_BEAT_MS = 1200;
export const BLAKE_THINK_MS = 700;
export const BLAKE_THINK_REDUCED_MS = 400;
export const BLAKE_DONE_BEAT_MS = 1200;

const defaultEngine: TutorialEngine = {
  restore: bridgeRestore,
  apply: bridgeApply,
  view: bridgeView,
  legalMoves: bridgeLegalMoves,
  snapshot: bridgeSnapshot,
};

const defaultClock: TutorialClock = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clear: (handle) => globalThis.clearTimeout(handle),
};

const NONE: CurtainState = { kind: 'none' };
const ACK_TO_ALICE: CurtainState = { kind: 'ack', to: 0 };

export interface CoachLine {
  readonly text: string;
  readonly tone: LineTone;
}

export class TutorialTable implements TableSource {
  readonly lesson: Lesson;
  readonly #engine: TutorialEngine;
  readonly #clock: TutorialClock;
  readonly #deps: TutorialTableDeps;

  /** Bumped by every skip, dispose, restart and newGame: a callback from an older generation is a no-op. */
  #gen = 0;
  /** The one outstanding beat timer, if any (cleared on a bump; the generation is the guard). */
  #timer: number | null = null;
  #disposed = false;
  /** Within phase `blake`: the think pause (taps ignored) or the narration beat (a tap moves on). */
  #blakeBeat: 'think' | 'done' = 'think';

  #replyIndex = 0;

  // Reactive state lives in private fields behind read-only getters: only
  // the table changes it (plan §5 declares every one `readonly`).
  #envelope = $state.raw<Envelope | null>(null);
  #pending = $state(false);
  #refusals = $state(0);
  #stepIndex = $state(0);
  #phase = $state<RunPhase>('step');
  #line = $state.raw<CoachLine>({ text: '', tone: 'main' });
  #lastNudge = $state<string | null>(null);
  #wrongTries = $state(0);
  #history = $derived(this.#envelope?.history ?? []);
  #curtain = $derived<CurtainState>(
    this.#envelope !== null && this.#envelope.state.phase === Phase.AwaitingCounter && this.#envelope.state.active === 0
      ? ACK_TO_ALICE
      : NONE,
  );
  #step = $derived<Step | null>(this.#stepAt(this.#stepIndex));

  // --- TableSource -------------------------------------------------------

  readonly viewer = 0 as const;
  readonly drawReveal = null;
  readonly names: [string, string];
  readonly allowsNewGame = false;

  /** Always `view(0)`, Alice's own envelope (design §6.2); null only if the lesson failed to load. */
  get envelope(): Envelope | null {
    return this.#envelope;
  }
  /** Already redacted for seat 0 by the bridge. */
  get history(): readonly AppliedMove[] {
    return this.#history;
  }
  get seq(): number {
    return this.#history.length;
  }
  /**
   * `ack` to Alice exactly while the engine waits on her counter decision
   * (lesson 4.2), so GameScreen mounts the real CounterPrompt; refusals
   * included, it never drops to `none` mid-window (§5.5.1). Else `none`.
   */
  get curtain(): CurtainState {
    return this.#curtain;
  }
  /** From the learner's match until Blake's last reply lands: the board is inert. */
  get pending(): boolean {
    return this.#pending;
  }
  /** +1 for every commit the gate refuses (GameScreen's counter-prompt key). */
  get refusals(): number {
    return this.#refusals;
  }

  // --- Lesson run state --------------------------------------------------

  get stepIndex(): number {
    return this.#stepIndex;
  }
  /** The current step; null only past the end. */
  get step(): Step | null {
    return this.#step;
  }
  get phase(): RunPhase {
    return this.#phase;
  }
  /** The table's current coach line (step main, nudge, success, Blake, error). */
  get line(): CoachLine {
    return this.#line;
  }
  /** The last refusal's line in this step, or null. */
  get lastNudge(): string | null {
    return this.#lastNudge;
  }
  /** Wrong commits plus staged-wrong notes in this move step (design §7.4's tap-route count). */
  get wrongTries(): number {
    return this.#wrongTries;
  }

  constructor(lesson: Lesson, deps: TutorialTableDeps) {
    this.lesson = lesson;
    this.#deps = deps;
    this.#engine = deps.engine ?? defaultEngine;
    this.#clock = deps.clock ?? defaultClock;
    this.names = [deps.learnerName, 'Blake'];
    this.#load();
  }

  /**
   * The apply gate. Does all its work in the calling task; the promise only
   * settles what already happened and never rejects.
   */
  apply(moveIndex: number): Promise<void> {
    if (this.#disposed || this.pending) return Promise.resolve();
    // A commit is a tap: it ends a success or narration beat first, then
    // meets the gate of whatever step that leads to.
    if (this.phase === 'success' || (this.phase === 'blake' && this.#blakeBeat === 'done')) this.skipBeat();
    if (this.pending) return Promise.resolve();

    const env = this.envelope;
    const step = this.step;
    const move: Move | undefined = env?.legalMoves[moveIndex];
    if (this.phase === 'step' && env && step?.kind === 'move' && move && moveMatches(move, step.expect, env.state)) {
      this.#accept(moveIndex, move, env.state, step);
    } else {
      this.#refuse(move, env?.state ?? null);
    }
    return Promise.resolve();
  }

  dismissDrawReveal(): void {}

  async advanceCurtain(): Promise<void> {}

  /** The menu's Home: the lesson ends (its timers go stale), then the app goes Home. */
  goHome(): void {
    if (this.#disposed) return;
    this.dispose();
    this.#deps.onHome();
  }

  /** Restarts the lesson (only the DEV test hook calls it). */
  async newGame(): Promise<void> {
    this.restart();
  }

  /** Completes a `next` step. */
  next(): void {
    if (this.#disposed || this.phase !== 'step' || this.step?.kind !== 'next') return;
    this.#advance();
  }

  /** Completes an `appear` step when its element shows. */
  appeared(testId: string): void {
    if (this.#disposed || this.phase !== 'step') return;
    const step = this.step;
    if (step?.kind !== 'appear' || step.testId !== testId) return;
    this.#advance();
  }

  /** A tap during a success or narration beat moves on at once; during Blake's think pause it does nothing. */
  skipBeat(): void {
    if (this.#disposed) return;
    if (this.phase === 'success') {
      this.#bump();
      this.#afterReply(0);
    } else if (this.phase === 'blake' && this.#blakeBeat === 'done') {
      this.#bump();
      this.#afterReply(this.#replyIndex + 1);
    }
  }

  /** The coach saw a wrong move staged; it counts toward the tap route. */
  noteStagedWrong(): void {
    if (this.#disposed || this.phase !== 'step' || this.step?.kind !== 'move') return;
    this.#wrongTries += 1;
  }

  /** Back to the lesson's start position and step 0; from any phase, `error` included. */
  restart(): void {
    if (this.#disposed) return;
    this.#bump();
    this.#load();
  }

  /** Ends the table: every outstanding timer goes stale and nothing applies again. */
  dispose(): void {
    this.#bump();
    this.#disposed = true;
    this.#pending = false;
  }

  // --- internals ---------------------------------------------------------

  #load(): void {
    this.#stepIndex = 0;
    this.#phase = 'step';
    this.#pending = false;
    this.#lastNudge = null;
    this.#wrongTries = 0;
    this.#replyIndex = 0;
    this.#blakeBeat = 'think';
    const restored = this.#engine.restore(positionSnapshot(this.lesson.position), 0);
    if (!restored.ok) return this.#fail();
    // The restore result is dropped: the table's envelope is always a fresh view(0).
    if (!this.#showAliceView()) return;
    this.#line = this.#mainLine();
  }

  /** Sets `envelope` from `view(0)`. False (and phase `error`) on an engine error or a view that isn't seat 0's. */
  #showAliceView(): boolean {
    const v = this.#engine.view(0);
    if (!v.ok || v.state.viewer !== 0) {
      this.#fail();
      return false;
    }
    this.#envelope = v;
    return true;
  }

  #stepAt(index: number): Step | null {
    return this.lesson.steps[index] ?? null;
  }

  #mainLine(): CoachLine {
    return { text: this.step?.main ?? '', tone: 'main' };
  }

  #accept(index: number, move: Move, view: PlayerView, step: MoveStep): void {
    this.#motion(() => this.#deps.beforeApply?.(move, view));
    // The mover's envelope comes back; it is dropped unread (design §6.2 step 3).
    if (!this.#engine.apply(index).ok) return this.#fail();
    if (!this.#showAliceView()) return;
    this.#motion(() => this.#deps.afterApply?.());
    this.#lastNudge = null;
    this.#phase = 'success';
    this.#line = { text: step.success, tone: 'success' };
    if (step.blake.length > 0) this.#pending = true;
    this.#schedule(SUCCESS_BEAT_MS, () => this.#afterReply(0));
  }

  #refuse(move: Move | undefined, view: PlayerView | null): void {
    this.#refusals += 1;
    if (this.phase !== 'step') return; // finished or error: no copy change (plan P1)
    const step = this.step;
    if (!step) return;
    let text: string;
    if (step.kind === 'move') {
      text = move && view ? nudgeFor(move, step, view) : step.generic;
      this.#wrongTries += 1;
    } else if (step.kind === 'next') {
      text = NEXT_FIRST;
    } else {
      text = step.refusal;
    }
    this.#lastNudge = text;
    this.#line = { text, tone: 'nudge' };
  }

  /** Starts reply `k` (its think pause), or moves to the next step when there are no more. */
  #afterReply(k: number): void {
    const step = this.step;
    const replies = step?.kind === 'move' ? step.blake : [];
    if (k >= replies.length) {
      this.#pending = false;
      this.#advance();
      return;
    }
    this.#replyIndex = k;
    this.#blakeBeat = 'think';
    this.#phase = 'blake';
    this.#pending = true;
    this.#line = { text: replies[k].thinking, tone: 'blake' };
    const pause = this.#deps.reducedMotion() ? BLAKE_THINK_REDUCED_MS : BLAKE_THINK_MS;
    this.#schedule(pause, () => this.#blakeMove(replies[k], k, replies.length));
  }

  /** Blake plays reply `k`: resolved against his OWN legal list, held only in a local here (S6). */
  #blakeMove(reply: BlakeReply, k: number, total: number): void {
    const legal = this.#engine.legalMoves();
    if (!legal.ok || legal.state.viewer !== 1) return this.#fail();
    const matches = matchingIndices(legal, reply.move);
    if (matches.length !== 1) return this.#fail();
    // The flight hooks see only what Alice sees: the seat-0 view on show now,
    // then the public log entry for his move. `legal` never leaves this scope.
    const shown = this.#envelope;
    if (shown) this.#motion(() => this.#deps.beforeReply?.(shown.state));
    // Blake's envelope comes back from apply; it is dropped unread.
    if (!this.#engine.apply(matches[0]).ok) return this.#fail();
    if (!this.#showAliceView()) return;
    const entry = this.#envelope?.history.at(-1);
    if (entry?.by === 1) this.#motion(() => this.#deps.afterReply?.(entry));
    if (k === total - 1) this.#pending = false;
    if (reply.done === undefined) {
      this.#afterReply(k + 1);
      return;
    }
    this.#blakeBeat = 'done';
    this.#line = { text: reply.done, tone: 'blake' };
    this.#schedule(BLAKE_DONE_BEAT_MS, () => this.#afterReply(k + 1));
  }

  #advance(): void {
    const nextIndex = this.stepIndex + 1;
    this.#lastNudge = null;
    this.#wrongTries = 0;
    this.#blakeBeat = 'think';
    if (nextIndex >= this.lesson.steps.length) {
      this.#phase = 'finished';
      this.#pending = false;
      // The last line stays (the success line, or 2.3's main line), never a stale nudge.
      if (this.line.tone === 'nudge') this.#line = this.#mainLine();
      return;
    }
    this.#stepIndex = nextIndex;
    this.#phase = 'step';
    this.#line = this.#mainLine();
  }

  /** Runs a motion hook. Motion is decoration: whatever it throws, the lesson goes on (T11). */
  #motion(hook: () => void): void {
    try {
      hook();
    } catch {
      // A failed flight never breaks a lesson.
    }
  }

  #fail(): void {
    this.#bump();
    this.#phase = 'error';
    this.#pending = false;
    this.#line = { text: SNAG_LINE, tone: 'error' };
  }

  /** Makes every outstanding callback stale, and cancels the one we hold. */
  #bump(): void {
    this.#gen += 1;
    if (this.#timer !== null) {
      this.#clock.clear(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * The ONE guard on every beat callback: it runs only if no skip, dispose,
   * restart, newGame or error happened since it was scheduled. The callbacks
   * themselves don't re-check phase, so this check carries the guarantee
   * alone (a test with a clock that can't cancel proves it).
   */
  #schedule(ms: number, fn: () => void): void {
    const gen = this.#gen;
    this.#timer = this.#clock.set(() => {
      if (gen !== this.#gen) return;
      this.#timer = null;
      fn();
    }, ms);
  }
}
