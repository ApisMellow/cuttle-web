// Two-phone W10: an asynchronous TableSource test double, shaped like the
// planned online store (docs/two-phone-plan.md §7). Not a test file itself.
//
// `apply` records the index and enters `pending`. With `settle: 'on-send'`
// (the online store's plan: the promise settles once the move is sent) the
// promise resolves at once and `pending` stays true until `respond()`; with
// `settle: 'on-state'` the promise itself waits for `respond()` or `fail()`.
// `push()` is an unrequested "opponent moved" state.

import type { AppliedMove, EngineError, Envelope, PlayerId } from '../../src/lib/bridge/schema';
import type { DrawReveal } from '../../src/lib/drawReveal';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import type { TableSource } from '../../src/lib/stores/tableSource';

export class FakeTableSource implements TableSource {
  envelope = $state<Envelope | null>(null);
  history = $state<AppliedMove[]>([]);
  seq = $state(0);
  viewer = $state<PlayerId | null>(null);
  curtain = $state<CurtainState>({ kind: 'none' });
  drawReveal = $state<DrawReveal | null>(null);
  error = $state<EngineError | null>(null);
  pending = $state(false);

  /** Every index passed to apply, in order. */
  readonly applied: number[] = [];
  readonly #settle: 'on-send' | 'on-state';
  #inflight: { resolve: () => void; reject: (err: unknown) => void } | null = null;

  constructor(opts: { settle?: 'on-send' | 'on-state' } = {}) {
    this.#settle = opts.settle ?? 'on-send';
  }

  apply(moveIndex: number): Promise<void> {
    this.applied.push(moveIndex);
    this.pending = true;
    if (this.#settle === 'on-send') return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#inflight = { resolve, reject };
    });
  }

  /** A state the server sent without being asked (the opponent moved). */
  push(env: Envelope): void {
    this.envelope = env;
    this.history = env.history;
    this.seq = env.seq;
    this.viewer = env.state.viewer;
  }

  /** The answer to the move in flight: the new state, then `pending` clears. */
  respond(env: Envelope): void {
    this.push(env);
    this.pending = false;
    const inflight = this.#inflight;
    this.#inflight = null;
    inflight?.resolve();
  }

  /** The move in flight failed (a dropped socket, a STALE). */
  fail(err: unknown): void {
    this.pending = false;
    const inflight = this.#inflight;
    this.#inflight = null;
    inflight?.reject(err);
  }

  dismissDrawReveal(): void {
    this.drawReveal = null;
  }

  async advanceCurtain(): Promise<void> {}

  goHome(): void {}

  async newGame(): Promise<void> {}
}
