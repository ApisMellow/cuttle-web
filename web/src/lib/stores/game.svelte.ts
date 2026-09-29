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
// the mover's own apply result when no handoff follows, by restore for the
// persisted viewer at `result`, or by the resume gate once its viewer has
// passed it (`#passResumeGate`). There is no public call that names a
// player to view (§2.4).
//
// Resume gate (SPEC §5.7, ruling 2026-09-29): a restore into a resting
// curtain (`none`, or an `ack`, real or synthetic) raises
// `handoff(to: viewer, reason: 'resume')` -> `reveal` first, so whoever taps
// Resume never sees that player's hand or counter options. The gate is
// memory only; the save keeps the resting position.
//
// Draw reveal (SPEC §4.7, issue #27): when a 5 resolves, the drawer is shown
// the drawn cards on their own screen, `drawReveal` = { to, indices }. It is
// memory only and never saved. It holds hand INDICES, never cards: the
// identities are read from the drawer's own envelope when rendered. It is
// raised only while the exposed envelope is the drawer's own: right after
// the drawer's own apply resolved the 5 with no ack to stage (the handoff
// that follows is already saved and is raised on dismissal), or at the
// drawer's next own view (`none`, or an `ack` of either kind). While it is
// up, nothing else moves the store.

import type { NewGameOpts } from '../bridge/engine';
import type { AppliedMove, BridgeResult, Envelope, EngineError, PlayerId } from '../bridge/schema';
import {
  apply as bridgeApply,
  newGame as bridgeNewGame,
  restore as bridgeRestore,
  snapshot as bridgeSnapshot,
  view as bridgeView,
} from '../bridge/engine';
import { type DrawReveal, drawnHandIndices, unseenDrawFor } from '../drawReveal';
import { Phase } from '../enums';
import { fiveDrawer, isRecapVisible } from '../recap';
import {
  type CurtainContext,
  type CurtainState,
  type CurtainView,
  advance as advanceCurtainState,
  needsSyntheticAck,
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
  #pendingCtx: { pre: CurtainView; move: AppliedMove | null; post: CurtainView; responderHandEmpty: boolean } | null = null;
  /**
   * The resting curtain a resume gate leads to (`none` or an `ack`), while
   * the gate is up; `null` otherwise. Memory only: never saved (SPEC §5.7).
   */
  #resumeTo: ResumeTarget | null = null;
  /**
   * SPEC §4.7: per player, the seq of the last 5-draw that player has been
   * shown (or that needs no showing). Memory only. On restore it starts one
   * below the saved `lastSeenSeq`, so a draw resolved by that player's own
   * last move, not yet shown, is still shown at their next board.
   */
  #drawSeen: Record<PlayerId, number> = { 0: 0, 1: 0 };
  /** SPEC §4.7: the handoff a before-the-pass reveal gives way to (already saved); null otherwise. */
  #afterDrawReveal: WithheldCurtain | null = null;

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
  /** SPEC §4.7: the 5's draw reveal on the drawer's own board, or null. Memory only, never saved. */
  drawReveal = $state<DrawReveal | null>(null);

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
    this.#resumeTo = null;
    this.#clearDrawReveal({ 0: 0, 1: 0 });
    this.#pendingCtx = { pre: firstView, move: null, post: firstView, responderHandEmpty: false };
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
    this.#refuseDuringDrawReveal('apply');
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
    // SPEC §4.3 (ruling 2026-09-29): the envelope is the mover's (§2.4), so
    // its `opponent` is the would-be responder. A public count, read as is.
    const responderHandEmpty = result.state.opponent.handCount === 0;
    const curtainState = nextCurtainState(preView, mv, postView, responderHandEmpty);
    const beforePass = this.#drawRevealBeforePass(result, preView, postView, curtainState, responderHandEmpty);

    // 'result' needs no viewer switch either — post.active is meaningless at
    // game over (§4.1), so the current holder simply keeps their own
    // already-fetched envelope; only a real handoff clears it (carry-over 4).
    const settled = curtainState.kind === 'none' || curtainState.kind === 'result';
    // B2: the mover's envelope carries `index` on the mover's entries (§3.2);
    // behind a curtain none of that may be held, so it is stripped from
    // everything this store keeps. Deleting a key computes no rule.
    const nextHistory = settled ? result.history : result.history.map(withoutIndex);
    const nextPendingCtx = settled ? null : { pre: preView, move: withoutIndex(mv), post: postView, responderHandEmpty };
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
    this.lastSeenSeq = nextLastSeenSeq;
    this.#pendingCtx = nextPendingCtx;
    this.seq = result.seq;
    if (beforePass !== null) {
      // SPEC §4.7: the mover is still holding the phone and the save already
      // holds the handoff. The mover's own board stays up (no legal moves:
      // the turn has passed) under the reveal; dismissDrawReveal() raises
      // the saved handoff exactly as the line below would have.
      this.#drawSeen = { ...this.#drawSeen, [mv.by]: mv.seq };
      this.#afterDrawReveal = beforePass.after;
      this.history = result.history;
      this.envelope = result;
      this.viewer = result.state.viewer;
      this.curtain = { kind: 'none' };
      this.drawReveal = beforePass.reveal;
      return;
    }
    this.history = nextHistory;
    // Carry-over 4: this is the ONLY line in apply() that can populate
    // `envelope` with the mover's own view, and only when no handoff follows.
    this.envelope = settled ? result : null;
    this.viewer = settled ? result.state.viewer : null;
    this.curtain = curtainState;
    if (curtainState.kind === 'none') this.#revealUnseenDraw(result);
  }

  /**
   * SPEC §4.7: ends the draw reveal (a tap, a key, or the 3 s timer). Before
   * the pass it raises the handoff the save already holds, dropping the
   * mover's envelope, viewer and mover-only `index` keys (carry-over 4, B2);
   * at the drawer's next board it just leaves the board up. Writes nothing.
   * A second call, or a call with no reveal up, does nothing.
   */
  dismissDrawReveal(): void {
    if (this.drawReveal === null) return;
    const after = this.#afterDrawReveal;
    this.#afterDrawReveal = null;
    this.drawReveal = null;
    if (after === null) return;
    this.envelope = null;
    this.viewer = null;
    this.history = this.history.map(withoutIndex);
    this.curtain = after;
  }

  /**
   * SPEC §4.7 before the pass: the mover's own apply resolved their own 5
   * and drew, no synthetic ack is staged (the responder holds no cards,
   * §4.3), and a handoff follows. Only then may the draw show before the
   * pass: with an ack pending, showing it would tell the mover that the
   * responder held no 2 (R14), so it waits for the mover's next board.
   */
  #drawRevealBeforePass(
    result: Envelope,
    pre: CurtainView,
    post: CurtainView,
    curtainState: CurtainState,
    responderHandEmpty: boolean,
  ): { reveal: DrawReveal; after: WithheldCurtain } | null {
    const mv = result.lastMove;
    if (mv === null || mv.drawn === null || mv.drawn <= 0) return null;
    if (curtainState.kind !== 'handoff') return null;
    if (!responderHandEmpty && needsSyntheticAck(pre, mv, post)) return null;
    const history = result.history;
    if (fiveDrawer(history, history.length - 1) !== mv.by || result.state.viewer !== mv.by) return null;
    const indices = drawnHandIndices(result.state.you, mv.drawn, false);
    if (indices.length === 0) return null;
    return { reveal: { to: mv.by, indices }, after: curtainState };
  }

  /**
   * SPEC §4.7 at the drawer's next own view: `env` is the envelope just
   * exposed at curtain `none` or an `ack` (either kind: the same step on
   * both R14 paths). If its viewer drew with a 5 that they have not been
   * shown, show it now, before anything they do can change their hand. On
   * the viewer's own normal turn a frozen tail is a 9's returned card and is
   * skipped; see lib/drawReveal.ts.
   */
  #revealUnseenDraw(env: Envelope): void {
    const view = env.state;
    const p = view.viewer;
    const unseen = unseenDrawFor(env.history, p, this.#drawSeen[p]);
    if (unseen === null) return;
    this.#drawSeen = { ...this.#drawSeen, [p]: unseen.seq };
    const ownTurn = view.phase === Phase.Normal && view.active === p;
    const indices = drawnHandIndices(view.you, unseen.count, ownTurn);
    if (indices.length === 0) return;
    this.drawReveal = { to: p, indices };
  }

  #refuseDuringDrawReveal(call: string): void {
    if (this.drawReveal !== null) {
      throw new Error(`GameStore.${call}() is not allowed while the draw reveal is up; dismiss it first (SPEC §4.7)`);
    }
  }

  #clearDrawReveal(seen: Record<PlayerId, number>): void {
    this.drawReveal = null;
    this.#afterDrawReveal = null;
    this.#drawSeen = seen;
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
    this.#refuseDuringDrawReveal('refresh');
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
    this.#refuseDuringDrawReveal('advanceCurtain');
    if (this.#resumeTo !== null) {
      await this.#passResumeGate(this.#resumeTo);
      return;
    }
    const ctx = this.#requireCurtainContext();
    const leavingRecap = this.curtain.kind === 'recap';
    const newState = advanceCurtainState(this.curtain, ctx);

    switch (newState.kind) {
      case 'none': {
        const ok = await this.#applyViewerChange(ctx.post.active, { stamp: true, curtain: newState });
        if (ok) {
          this.#pendingCtx = null;
          if (this.envelope !== null) this.#revealUnseenDraw(this.envelope);
        }
        return;
      }
      case 'ack': {
        // SPEC §4.6 (amended 2026-09-27): dismissing a recap stamps its
        // viewer, so an acknowledger who hands the phone back without ever
        // reaching 'none' is not shown the same entries again. The ack
        // target is the recap's viewer (afterRecap keeps `to`), and the
        // stamp lands in #applyViewerChange's persist-first write.
        const ok = await this.#applyViewerChange(newState.to, { stamp: leavingRecap, curtain: newState });
        // SPEC §4.7: an ack (real or synthetic alike, R14) is the drawer's
        // first own view when the opponent's turn ended in a one-off; the
        // draw shows here, before a counter can change the hand.
        if (ok && this.envelope !== null) this.#revealUnseenDraw(this.envelope);
        return;
      }
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
   * The result screen's Home button (W25) and the in-game menu's Home.
   * Allowed at every curtain kind: the snapshot is written synchronously on
   * every apply and curtain transition, so the save already holds exactly
   * this position, and Resume (`restore()`) brings it back the way a reload
   * would, curtain first. Home itself writes nothing and calls no engine
   * function. It drops every view-bearing field (the envelope, the viewer,
   * the history with its mover-only `index` keys) and the pending curtain
   * context, since the home screen needs none of them.
   */
  goHome(): void {
    this.#clearDrawReveal({ 0: 0, 1: 0 });
    this.envelope = null;
    this.viewer = null;
    this.#pendingCtx = null;
    this.#resumeTo = null;
    this.history = [];
    this.seq = 0;
    this.curtain = { kind: 'none' };
    this.screen = 'home';
  }

  /** §4.6: unseen, recap-visible history for one viewer. */
  recapFor(viewer: PlayerId): AppliedMove[] {
    return this.history.filter((h) => h.seq > this.lastSeenSeq[viewer]).filter(isRecapVisible);
  }

  /**
   * SPEC §5.7 restore. R4.4: a snapshot whose `v` is outside {1, 2} (or that
   * is otherwise malformed) is discarded without a crash, straight to the
   * home screen with a brief notice — `engine.restore()` is never even
   * called in that case. A v1 save is migrated to v2 by `decodeSnapshot`
   * (ruling 2026-09-28) and the bridge migrates its engine state. Carry-over 3: a valid snapshot's `dealer`/`names`
   * are pushed back into the session store. Carry-over 7: the persisted
   * `curtain` is re-raised before any view is exposed.
   *
   * B4, amended 2026-09-29 (resume gate, SPEC §5.7): nothing view-bearing
   * is exposed at any restored curtain but `result`. `handoff`/`reveal`/
   * `recap` come back as they were (the next holder has not passed the
   * reveal gate). `none` and `ack` (real or synthetic) come back behind a
   * resume gate for the persisted viewer, since whoever taps Resume may not
   * be that player; the view is fetched fresh once the gate is passed, and
   * the real counter window is then usable as before (R4.2). `result` is
   * public (no hand renders) and is exposed at once.
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
    this.#clearDrawReveal({ 0: Math.max(0, snap.lastSeenSeq[0] - 1), 1: Math.max(0, snap.lastSeenSeq[1] - 1) });
    this.#session.recordDealer(snap.dealer);
    this.#session.recordSeed(snap.seed);
    this.#seed = snap.seed;
    this.#dealer = snap.dealer;

    const persisted = withoutRecapIndices(snap.curtain);
    const resumeTo = isResumeTarget(persisted) ? persisted : null;
    const exposed = persisted.kind === 'result';
    // Carry-over 7: the curtain goes up first, before any view field is set.
    this.curtain = resumeTo === null ? persisted : { kind: 'handoff', to: snap.viewer, reason: 'resume' };
    this.#resumeTo = resumeTo;
    this.error = null;
    this.history = exposed ? result.history : result.history.map(withoutIndex);
    this.seq = result.seq;
    this.lastSeenSeq = { 0: snap.lastSeenSeq[0], 1: snap.lastSeenSeq[1] };
    this.notice = null;
    this.screen = 'game';
    this.envelope = exposed ? result : null;
    this.viewer = exposed ? snap.viewer : null;

    const lastMove = result.history.at(-1);
    const restoredView: CurtainView = { active: result.state.active, phase: result.state.phase };
    this.#pendingCtx =
      persisted.kind === 'none' || persisted.kind === 'result'
        ? null
        : lastMove === undefined
          ? // W25: a curtain with no move behind it is the opening deal's.
            { pre: restoredView, move: null, post: restoredView, responderHandEmpty: false }
          : {
            // `pre.active` is exactly `mv.by` (§2.7: "by: pre-state Active");
            // `pre.phase` is never read by `advance()`/`afterRecap()` (only
            // a fresh `next()` call consults it, and restore never replays
            // `next()` for an already-applied move) — see docs/assumptions.md.
            pre: { active: lastMove.by, phase: result.state.phase },
            move: withoutIndex(lastMove),
            post: { active: result.state.active, phase: result.state.phase },
            // SPEC §4.3 (ruling 2026-09-29): the same public count the live
            // apply read, from the restored viewer's seat. The would-be
            // responder is `other(mv.by)`; the machine consults the flag only
            // for a curtain addressed to them, whose own hand this is.
            responderHandEmpty:
              snap.viewer === lastMove.by
                ? result.state.opponent.handCount === 0
                : result.state.you.hand.length === 0,
          };
  }

  /**
   * The resume gate's two steps (SPEC §5.7, ruling 2026-09-29): handoff ->
   * reveal, then reveal -> the saved resting curtain with a freshly fetched
   * view. Writes nothing: the save already holds exactly that position. A
   * failed fetch sets `error` and keeps the gate at reveal, so a retry can
   * pass it.
   */
  async #passResumeGate(target: ResumeTarget): Promise<void> {
    const gate = this.curtain;
    if (gate.kind === 'handoff') {
      this.curtain = { kind: 'reveal', to: gate.to };
      return;
    }
    if (gate.kind !== 'reveal') {
      throw new Error(`GameStore.advanceCurtain(): the resume gate is at '${gate.kind}' (SPEC §5.7)`);
    }
    const result = this.#engine.view(gate.to);
    if (!result.ok) {
      this.error = result;
      return;
    }
    this.error = null;
    this.#resumeTo = null;
    this.history = result.history;
    this.seq = result.seq;
    this.envelope = result;
    this.viewer = gate.to;
    this.curtain = target;
    this.#revealUnseenDraw(result);
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
    return {
      pre: pending.pre,
      move: pending.move,
      post: pending.post,
      responderHandEmpty: pending.responderHandEmpty,
      recapFor: (viewer) => this.recapFor(viewer),
    };
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
    this.#resumeTo = null;
    this.#clearDrawReveal({ 0: 0, 1: 0 });
  }
}

type WithheldCurtain = Extract<CurtainState, { kind: 'handoff' | 'reveal' | 'recap' }>;

/** The resting curtains a restore puts behind a resume gate (SPEC §5.7, ruling 2026-09-29). */
type ResumeTarget = Extract<CurtainState, { kind: 'none' | 'ack' }>;

function isResumeTarget(curtain: CurtainState): curtain is ResumeTarget {
  return curtain.kind === 'none' || curtain.kind === 'ack';
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
