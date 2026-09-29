// SPEC §5.3 — "game.svelte.ts — the only holder of engine-derived state."
//
// This module drives three things together: the WASM bridge calls (via an
// injectable `GameEngine`, §5.4's `engine.ts` by default), the curtain state
// machine (curtain.svelte.ts, pure), and the R4 localStorage snapshot
// (snapshot.ts, pure). It owns no game rule — every phase/active/legalMoves
// value is read straight from the envelope the bridge returned.
//
// Privacy structure (SPEC §3.3 rule 4, round-1 review carry-over 4): the
// store's `envelope` field is the ONLY place a full `PlayerView` lives.
// Invariant: `envelope` and `viewer` are null whenever `curtain.kind` is
// `handoff`, `reveal` or `recap` — on every path into those states (apply,
// advanceCurtain including the synthetic-ack handoff back, and restore).
// `history`/`seq` are kept separately, because the §4.6 recap needs move
// history while a curtain is up but must never need a hand to compute it;
// behind a curtain that history carries no mover-only `index` key (§3.2).
// `envelope` is repopulated only by a fresh `engine.view(p)` for whoever
// the curtain machine says is due to look next (`#applyViewerChange`), by
// the mover's own apply result when no handoff follows, or by restore for
// the persisted viewer at `none`/`ack`/`result`. There is no public call
// that names a player to view (§2.4).

import type { NewGameOpts } from '../bridge/engine';
import type { AppliedMove, BridgeResult, Envelope, EngineError, PlayerId } from '../bridge/schema';
import {
  apply as bridgeApply,
  newGame as bridgeNewGame,
  restore as bridgeRestore,
  snapshot as bridgeSnapshot,
  view as bridgeView,
} from '../bridge/engine';
import { isRecapVisible } from '../recap';
import {
  type CurtainContext,
  type CurtainState,
  type CurtainView,
  advance as advanceCurtainState,
  next as nextCurtainState,
  opening as openingCurtain,
} from './curtain.svelte';
import { session as defaultSession, type SessionStore } from './session.svelte';
import { SNAPSHOT_KEY, SNAPSHOT_VERSION, type Snapshot, decodeSnapshot, encodeSnapshot } from './snapshot';

/**
 * The bridge calls this store needs, shaped so a test can inject a fake
 * without booting WASM (SPEC §5.3 "inject the engine"). Mirrors a subset of
 * `lib/bridge/engine.ts`'s public API (§5.4) — `legalMoves`/`describe` are
 * not needed here because every envelope already carries `legalMoves` (§2.7).
 */
export interface GameEngine {
  newGame(opts: NewGameOpts): BridgeResult;
  apply(moveIndex: number): BridgeResult;
  view(viewerId: PlayerId): BridgeResult;
  /** Opaque; see the module doc. Never parsed by this store. */
  snapshot(): string;
  restore(snapshotJson: string, viewerId: PlayerId): BridgeResult;
}

const defaultEngine: GameEngine = {
  newGame: bridgeNewGame,
  apply: bridgeApply,
  view: bridgeView,
  snapshot: bridgeSnapshot,
  restore: bridgeRestore,
};

/** A `localStorage`-shaped dependency (SPEC §5.3 "make storage injectable"). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

export interface GameStoreDeps {
  engine?: GameEngine;
  storage?: StorageLike;
  session?: SessionStore;
}

/** A decimal uint64 string from `crypto.getRandomValues` (SPEC §2.6's `seed` shape). */
function randomSeed(): string {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const value = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
  return value.toString(10);
}

interface PersistFields {
  history: AppliedMove[];
  lastSeenSeq: Record<PlayerId, number>;
  viewer: PlayerId;
  curtain: CurtainState;
}

export class GameStore {
  readonly #engine: GameEngine;
  readonly #storage: StorageLike | undefined;
  readonly #session: SessionStore;

  /** Set once a game exists (newGame or a successful restore); needed to fill the Snapshot's seed/dealer without ever reading engineState (carry-over 8). */
  #seed: string | null = null;
  #dealer: PlayerId | null = null;
  /** The (pre, move, post) that produced the current non-'none' curtain — needed by `advance()`/`recapFor` while a curtain is up, since `envelope` is null then. Cleared once the curtain settles back to 'none'. */
  #pendingCtx: { pre: CurtainView; move: AppliedMove | null; post: CurtainView } | null = null;

  /** The only full `PlayerView` (+ legalMoves/descriptions) in memory. `null` whenever nobody's view is currently safe to show (SPEC §3.3 rule 4). */
  envelope = $state<Envelope | null>(null);
  /** Always available, even mid-curtain — the §4.6 recap needs this without ever touching a hand. */
  history = $state<AppliedMove[]>([]);
  seq = $state<number>(0);
  /** Whose view `envelope` currently holds; `null` while nobody's does. */
  viewer = $state<PlayerId | null>(null);
  curtain = $state<CurtainState>({ kind: 'none' });
  lastSeenSeq = $state<Record<PlayerId, number>>({ 0: 0, 1: 0 });
  error = $state<EngineError | null>(null);
  /** R4.4 store-level surface: "an observable state the app shell will render as home, plus a notice value." */
  screen = $state<'home' | 'game'>('home');
  notice = $state<string | null>(null);

  view = $derived(this.envelope?.state ?? null);
  legalMoves = $derived(this.envelope?.legalMoves ?? []);
  isViewerActive = $derived(this.view !== null && this.view.viewer === this.view.active);

  constructor(deps: GameStoreDeps = {}) {
    this.#engine = deps.engine ?? defaultEngine;
    this.#storage = deps.storage ?? defaultStorage();
    this.#session = deps.session ?? defaultSession;
  }

  /**
   * SPEC §2.6 / carry-over 1&2: the first game of a session passes no
   * `dealer` key at all (the bridge assigns one randomly); a rematch passes
   * `session.nextDealer`. A `seed` is always supplied explicitly — even when
   * the caller gives none, this store generates one itself — so `engineState`
   * can stay genuinely opaque end-to-end (§5.7): the seed is never learned by
   * reading inside the bridge's snapshot, because this store is the one
   * party that chose it.
   */
  async newGame(opts: { seed?: string; dealer?: PlayerId } = {}): Promise<void> {
    const seed = opts.seed ?? randomSeed();
    const composed: NewGameOpts = { seed };
    // P2 W13: an explicit dealer (the e2e hook's reproducible deal, SPEC
    // §7.4) wins over the session's alternation; omitted, nothing changes.
    const dealer = opts.dealer ?? this.#session.nextDealer;
    if (dealer !== undefined) composed.dealer = dealer;

    const result = this.#engine.newGame(composed);
    if (!result.ok) {
      this.error = result;
      return;
    }

    // Carry-over 1: the envelope has no dealer field — the non-dealer acts first.
    const dealerAssigned = (1 - result.state.active) as PlayerId;
    this.#session.recordDealer(dealerAssigned);
    this.#session.recordSeed(seed);
    this.#seed = seed;
    this.#dealer = dealerAssigned;

    // W25 (privacy, SPEC §3.3 rule 4, §4.5): the game starts behind the
    // curtain, addressed to the first actor. Whoever tapped "New game" may
    // not be that player, so the deal's envelope is dropped here, unread,
    // and the first actor's view is fetched fresh at `none` like any turn.
    const first = result.state.active;
    const curtain = openingCurtain(first);
    const firstView: CurtainView = { active: first, phase: result.state.phase };
    const history = result.history.map(withoutIndex);
    const freshLastSeenSeq: Record<PlayerId, number> = { 0: 0, 1: 0 };

    this.#writeSnapshot({
      history,
      lastSeenSeq: freshLastSeenSeq,
      viewer: first,
      curtain,
    });

    this.error = null;
    this.#pendingCtx = { pre: firstView, move: null, post: firstView };
    this.history = history;
    this.seq = result.seq;
    this.lastSeenSeq = freshLastSeenSeq;
    this.curtain = curtain;
    this.envelope = null;
    this.viewer = null;
    this.screen = 'game';
    this.notice = null;
  }

  /**
   * `engine.apply(moveIndex)` then feeds the curtain machine (SPEC §5.3).
   *
   * Guarded (N5): a move may be submitted only while the curtain is `none`
   * or a real counter window (`ack`, synthetic: false), and only when the
   * exposed view is the active player's own. Anything else throws before
   * the bridge is touched.
   *
   * Persists synchronously before any reactive field changes (carry-over 6),
   * and clears `envelope` immediately whenever a curtain is required —
   * before returning — so the mover's hand is never reachable a moment
   * after the phone starts changing hands (carry-over 4). The mover's own
   * `lastSeenSeq` is stamped to the post-apply `seq` in that same write
   * (SPEC §4.6, amended 2026-09-27: a player's own moves are seen).
   */
  async apply(moveIndex: number): Promise<void> {
    const current = this.envelope;
    const curtain = this.curtain;
    const curtainAllowsMove = curtain.kind === 'none' || (curtain.kind === 'ack' && !curtain.synthetic);
    if (!current || !curtainAllowsMove || current.state.viewer !== current.state.active) {
      throw new Error(
        `GameStore.apply() needs the active player's own view with no curtain up (curtain: ${curtain.kind}) (SPEC §3.3, §4.2)`,
      );
    }
    const preView: CurtainView = { active: current.state.active, phase: current.state.phase };

    const result = this.#engine.apply(moveIndex);
    if (!result.ok) {
      this.error = result;
      return;
    }
    const mv = result.lastMove;
    if (!mv) {
      throw new Error('bridge contract violation: apply() succeeded with lastMove null (SPEC §2.7)');
    }
    const postView: CurtainView = { active: result.state.active, phase: result.state.phase };
    const curtainState = nextCurtainState(preView, mv, postView);

    // 'result' needs no viewer switch either — post.active is meaningless at
    // game over (§4.1), so the current holder simply keeps their own
    // already-fetched envelope; only a real handoff clears it (carry-over 4).
    const settled = curtainState.kind === 'none' || curtainState.kind === 'result';
    // B2: the mover's envelope carries `index` on the mover's entries (§3.2);
    // behind a curtain none of that may be held, so it is stripped from
    // everything this store keeps. Deleting a key computes no rule.
    const nextHistory = settled ? result.history : result.history.map(withoutIndex);
    const nextPendingCtx = settled ? null : { pre: preView, move: withoutIndex(mv), post: postView };
    const nextLastSeenSeq: Record<PlayerId, number> = { ...this.lastSeenSeq, [mv.by]: result.seq };

    // Carry-over 6: write BEFORE the reactive fields change, so a crash
    // right after apply() cannot lose the move (or the mover's stamp).
    this.#writeSnapshot({
      history: nextHistory,
      lastSeenSeq: nextLastSeenSeq,
      viewer: persistedViewerFor(curtainState, result.state.viewer),
      curtain: curtainState,
    });

    this.error = null;
    this.history = nextHistory;
    this.seq = result.seq;
    this.lastSeenSeq = nextLastSeenSeq;
    this.#pendingCtx = nextPendingCtx;
    // Carry-over 4: this is the ONLY line in apply() that can populate
    // `envelope` with the mover's own view, and only when no handoff follows.
    this.envelope = settled ? result : null;
    this.viewer = settled ? result.state.viewer : null;
    this.curtain = curtainState;
  }

  /**
   * Re-fetches the CURRENT viewer's own envelope (e.g. after the rules
   * overlay closes). Replaces §5.3's sketched `setViewer(p)`: a viewer change
   * happens only through the curtain machine (§2.4, §3.3 rule 4), so this
   * takes no player argument and is allowed only while that viewer is
   * legitimately looking — curtain `none` or a real counter window. Any
   * other curtain state throws without touching the bridge. Does not stamp
   * `lastSeenSeq`.
   */
  async refresh(): Promise<void> {
    const curtain = this.curtain;
    const looking = curtain.kind === 'none' || (curtain.kind === 'ack' && !curtain.synthetic);
    if (!looking || this.viewer === null) {
      throw new Error(`GameStore.refresh() is not allowed while curtain is '${curtain.kind}' (SPEC §2.4, §3.3 rule 4)`);
    }
    await this.#applyViewerChange(this.viewer, { stamp: false, curtain });
  }

  /**
   * Advances the current curtain sequence one step (§4.2:
   * handoff → reveal → [recap] → [ack | counter-prompt] → none). Fetches a
   * fresh `PlayerView` — via `engine.view`, never by reusing a stale one
   * (SPEC §3.3 rule 4) — exactly when the machine reaches a state that needs
   * one: the final `none` (the board) or an `ack` (the counter-prompt needs
   * `pending`). Every transition into `handoff`/`reveal`/`recap` drops
   * whatever view was held — including an acknowledger's, when a synthetic
   * ack hands the phone back (B1). `lastSeenSeq[viewer]` is stamped when the
   * viewer leaves `recap` (recap dismissal, §4.6 amended 2026-09-27) and at
   * the transition into `none`; never at `handoff`, `reveal`, or on entering
   * `recap`. (A successful `apply()` separately stamps the mover.)
   */
  async advanceCurtain(): Promise<void> {
    const ctx = this.#requireCurtainContext();
    const leavingRecap = this.curtain.kind === 'recap';
    const newState = advanceCurtainState(this.curtain, ctx);

    switch (newState.kind) {
      case 'none': {
        const ok = await this.#applyViewerChange(ctx.post.active, { stamp: true, curtain: newState });
        if (ok) this.#pendingCtx = null;
        return;
      }
      case 'ack':
        // SPEC §4.6 (amended 2026-09-27): dismissing a recap stamps its
        // viewer, so an acknowledger who hands the phone back without ever
        // reaching 'none' is not shown the same entries again. The ack
        // target is the recap's viewer (afterRecap keeps `to`), and the
        // stamp lands in #applyViewerChange's persist-first write.
        await this.#applyViewerChange(newState.to, { stamp: leavingRecap, curtain: newState });
        return;
      case 'handoff':
      case 'reveal':
      case 'recap':
        this.#enterWithheldCurtain(newState);
        return;
      case 'result':
        throw new Error('GameStore.advanceCurtain(): the machine never advances into result (SPEC §4.2)');
    }
  }

  /**
   * W25: the result screen's Home button. Allowed only at `result`: the game
   * is over and already persisted, so Home can Resume it (to see the
   * result) or start a new one. Drops every view-bearing field on the way
   * out, since the home screen needs none of them.
   */
  goHome(): void {
    if (this.curtain.kind !== 'result') {
      throw new Error(`GameStore.goHome() is only allowed at result (curtain: ${this.curtain.kind})`);
    }
    this.envelope = null;
    this.viewer = null;
    this.#pendingCtx = null;
    this.curtain = { kind: 'none' };
    this.screen = 'home';
  }

  /** §4.6: unseen, recap-visible history for one viewer. */
  recapFor(viewer: PlayerId): AppliedMove[] {
    return this.history.filter((h) => h.seq > this.lastSeenSeq[viewer]).filter(isRecapVisible);
  }

  /**
   * SPEC §5.7 restore. R4.4: a `v !== 1` (or otherwise malformed) snapshot is
   * discarded without a crash, straight to the home screen with a brief
   * notice, and no migration is attempted — `engine.restore()` is never even
   * called in that case. Carry-over 3: a valid snapshot's `dealer`/`names`
   * are pushed back into the session store. Carry-over 7: the persisted
   * `curtain` is re-raised before any view is exposed.
   *
   * B4: what is exposed depends on the curtain kind. `handoff`/`reveal`/
   * `recap` withhold the fetched view (the next holder has not passed the
   * reveal gate). `none`, `ack` and `result` expose the persisted viewer's
   * envelope: that viewer is already past the gate (a real counter window
   * must stay usable, R4.2) or the game is over.
   */
  async restore(): Promise<void> {
    const raw = this.#storage?.getItem(SNAPSHOT_KEY) ?? null;
    const decoded = decodeSnapshot(raw);
    if (!decoded.ok) {
      if (decoded.reason !== 'empty') this.#discardSnapshot(noticeFor(decoded.reason));
      return;
    }
    const snap = decoded.snapshot;

    const result = this.#engine.restore(snap.engineState, snap.viewer);
    if (!result.ok) {
      this.#discardSnapshot(`Your saved game could not be restored (${result.code}).`);
      return;
    }

    this.#session.setNames(snap.names[0], snap.names[1]);
    this.#session.recordDealer(snap.dealer);
    this.#session.recordSeed(snap.seed);
    this.#seed = snap.seed;
    this.#dealer = snap.dealer;

    const curtain = withoutRecapIndices(snap.curtain);
    const withheld = isWithheldCurtain(curtain);
    // Carry-over 7: the curtain goes up first, before any view field is set.
    this.curtain = curtain;
    this.error = null;
    this.history = withheld ? result.history.map(withoutIndex) : result.history;
    this.seq = result.seq;
    this.lastSeenSeq = { 0: snap.lastSeenSeq[0], 1: snap.lastSeenSeq[1] };
    this.notice = null;
    this.screen = 'game';
    this.envelope = withheld ? null : result;
    this.viewer = withheld ? null : snap.viewer;

    const lastMove = result.history.at(-1);
    const restoredView: CurtainView = { active: result.state.active, phase: result.state.phase };
    this.#pendingCtx =
      curtain.kind === 'none' || curtain.kind === 'result'
        ? null
        : lastMove === undefined
          ? // W25: a curtain with no move behind it is the opening deal's.
            { pre: restoredView, move: null, post: restoredView }
          : {
            // `pre.active` is exactly `mv.by` (§2.7: "by: pre-state Active");
            // `pre.phase` is never read by `advance()`/`afterRecap()` (only
            // a fresh `next()` call consults it, and restore never replays
            // `next()` for an already-applied move) — see docs/assumptions.md.
            pre: { active: lastMove.by, phase: result.state.phase },
            move: withoutIndex(lastMove),
            post: { active: result.state.active, phase: result.state.phase },
          };
  }

  /**
   * The single path into `handoff`/`reveal`/`recap`: persist first
   * (carry-over 6), then drop every view-bearing field (B1) and strip
   * mover-only `index` keys from what is kept (B2).
   */
  #enterWithheldCurtain(state: WithheldCurtain): void {
    const history = this.history.map(withoutIndex);
    const curtain = withoutRecapIndices(state) as WithheldCurtain;
    this.#writeSnapshot({
      history,
      lastSeenSeq: this.lastSeenSeq,
      viewer: state.to,
      curtain,
    });
    this.envelope = null;
    this.viewer = null;
    this.history = history;
    this.curtain = curtain;
  }

  async #applyViewerChange(p: PlayerId, opts: { stamp: boolean; curtain: CurtainState }): Promise<boolean> {
    const result = this.#engine.view(p);
    if (!result.ok) {
      this.error = result;
      return false;
    }
    const nextLastSeenSeq: Record<PlayerId, number> = opts.stamp
      ? { ...this.lastSeenSeq, [p]: result.seq }
      : this.lastSeenSeq;

    this.#writeSnapshot({
      history: result.history,
      lastSeenSeq: nextLastSeenSeq,
      viewer: p,
      curtain: opts.curtain,
    });

    this.error = null;
    this.history = result.history;
    this.seq = result.seq;
    this.lastSeenSeq = nextLastSeenSeq;
    this.envelope = result;
    this.viewer = p;
    this.curtain = opts.curtain;
    return true;
  }

  #requireCurtainContext(): CurtainContext {
    const pending = this.#pendingCtx;
    if (pending === null) {
      throw new Error(`GameStore.advanceCurtain(): no pending curtain context to advance from (curtain: ${this.curtain.kind})`);
    }
    return { pre: pending.pre, move: pending.move, post: pending.post, recapFor: (viewer) => this.recapFor(viewer) };
  }

  #writeSnapshot(fields: PersistFields): void {
    if (this.#seed === null || this.#dealer === null || !this.#storage) return;
    const snapshot: Snapshot = {
      v: SNAPSHOT_VERSION,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain, one-shot timestamp string for a serialized field, never held as reactive state.
      savedAt: new Date().toISOString(),
      // Carry-over 8: verbatim, unparsed. Never inspect inside this.
      engineState: this.#engine.snapshot(),
      history: fields.history,
      lastSeenSeq: fields.lastSeenSeq,
      viewer: fields.viewer,
      curtain: fields.curtain,
      names: [...this.#session.names],
      seed: this.#seed,
      dealer: this.#dealer,
    };
    try {
      this.#storage.setItem(SNAPSHOT_KEY, encodeSnapshot(snapshot));
    } catch {
      // Best-effort, matching settings.svelte.ts's posture: persistence is a
      // convenience, never a hard dependency of play continuing this run.
    }
  }

  #discardSnapshot(message: string): void {
    try {
      this.#storage?.removeItem(SNAPSHOT_KEY);
    } catch {
      // best-effort
    }
    this.screen = 'home';
    this.notice = message;
    this.error = null;
    this.envelope = null;
    this.viewer = null;
    this.curtain = { kind: 'none' };
    this.history = [];
    this.seq = 0;
    this.#pendingCtx = null;
  }
}

type WithheldCurtain = Extract<CurtainState, { kind: 'handoff' | 'reveal' | 'recap' }>;

/** The curtain kinds during which no `PlayerView` may be held (SPEC §3.3 rule 4, §4.5). */
function isWithheldCurtain(curtain: CurtainState): curtain is WithheldCurtain {
  return curtain.kind === 'handoff' || curtain.kind === 'reveal' || curtain.kind === 'recap';
}

/** The persisted `viewer` for a curtain: its addressee when it has one (N2), else whoever holds the exposed view. */
function persistedViewerFor(curtain: CurtainState, exposed: PlayerId): PlayerId {
  return 'to' in curtain ? curtain.to : exposed;
}

/**
 * B2: drops the mover-only `index` key (SPEC §3.2, amended 2026-09-26). A
 * pure deletion — it reads nothing and computes no rule.
 */
function withoutIndex(move: AppliedMove): AppliedMove {
  if (!Object.prototype.hasOwnProperty.call(move, 'index')) return move;
  const copy = { ...move };
  delete copy.index;
  return copy;
}

function withoutRecapIndices(curtain: CurtainState): CurtainState {
  return curtain.kind === 'recap' ? { ...curtain, entries: curtain.entries.map(withoutIndex) } : curtain;
}

function noticeFor(reason: 'invalid-json' | 'version-mismatch' | 'malformed'): string {
  switch (reason) {
    case 'version-mismatch':
      return 'Your saved game was from an older version and could not be restored.';
    case 'invalid-json':
    case 'malformed':
      return 'Your saved game could not be read and was discarded.';
  }
}

export const game = new GameStore();
