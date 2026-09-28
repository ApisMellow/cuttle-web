// SPEC §4.5 — the press-and-hold reveal gate (R13).
//
// Pure and timer-injectable: the component wires pointer events to these
// methods and polls `progress()` (e.g. per animation frame) to draw the ring.

/** The single hold-duration constant (SPEC §4.5). */
export const HOLD_DURATION_MS = 600;

export type TimerHandle = unknown;

export interface HoldScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface HoldGateOptions {
  onReveal: () => void;
  scheduler?: HoldScheduler;
}

export interface HoldGate {
  pointerdown(): void;
  pointerup(): void;
  pointercancel(): void;
  pointerleave(): void;
  /** Ring progress in [0, 1]; 0 when idle or after an abort, 1 once revealed. */
  progress(): number;
  holding(): boolean;
  revealed(): boolean;
  /** Cancels any hold; the gate ignores every later pointerdown. */
  dispose(): void;
}

const defaultScheduler: HoldScheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function createHoldGate(opts: HoldGateOptions): HoldGate {
  const scheduler = opts.scheduler ?? defaultScheduler;
  let startedAt: number | null = null;
  let timer: TimerHandle | null = null;
  let done = false;
  let disposed = false;

  function abort(): void {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    startedAt = null;
  }

  return {
    pointerdown() {
      if (disposed || done || startedAt !== null) return;
      startedAt = scheduler.now();
      timer = scheduler.setTimeout(() => {
        timer = null;
        startedAt = null;
        done = true;
        opts.onReveal();
      }, HOLD_DURATION_MS);
    },
    pointerup: abort,
    pointercancel: abort,
    pointerleave: abort,
    progress() {
      if (done) return 1;
      if (startedAt === null) return 0;
      return Math.min(1, Math.max(0, (scheduler.now() - startedAt) / HOLD_DURATION_MS));
    },
    holding: () => startedAt !== null,
    revealed: () => done,
    dispose() {
      disposed = true;
      abort();
    },
  };
}
