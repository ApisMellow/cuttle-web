// SPEC §4 curtain-machine integration at the store level (round-1 review
// carry-overs 4, 5, 6). The pure machine itself is tested in curtain.test.ts;
// this file proves GameStore drives it correctly: privacy during a curtain
// (rule 4), recap constructed with isRecapVisible + lastSeenSeq (§4.6), and
// the persist-before-reactive-update ordering (carry-over 6).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, PlayerId } from '../../src/lib/bridge/schema';
import * as curtainModule from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { Kind, Phase, appliedMove, createFakeEngine, envelope, fakeStorage, playerView, startGame } from './game-test-support';

// Wraps (never replaces) the real machine's `advance`, so a test can see the
// CurtainContext the store hands it — the only window onto the store's
// private pending context (B2: no mover-only `index` in it).
vi.mock('../../src/lib/stores/curtain.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/stores/curtain.svelte')>();
  return { ...actual, advance: vi.fn(actual.advance) };
});

function setup() {
  const storage = fakeStorage();
  const session = new SessionStore();
  return { storage, session };
}

/** Every public surface a component could read, serialized — the "reachable anywhere in the store" probe. */
function reachable(store: GameStore): string {
  return JSON.stringify({
    envelope: store.envelope,
    view: store.view,
    legalMoves: store.legalMoves,
    history: store.history,
    curtain: store.curtain,
    viewer: store.viewer,
    isViewerActive: store.isViewerActive,
    recap0: store.recapFor(0),
    recap1: store.recapFor(1),
  });
}

function cardJson(card: Card): string {
  return JSON.stringify(card);
}

function hasOwnIndex(m: AppliedMove): boolean {
  return Object.prototype.hasOwnProperty.call(m, 'index');
}

// SPEC §4.3/§4.4 "OneOff rank 7, no 2": A (P0) plays a 7, the engine
// auto-resolves to SevenChoosing with Active back on A, so the client stages
// a synthetic ack for O (P1) and then hands the phone BACK to A.
const O_SECRET: Card = { Rank: 13, Suit: 3 }; // only ever in O's own hand
const A_SECRET: Card = { Rank: 12, Suit: 1 }; // only ever in A's own hand
function sevenRoundTrip() {
  const { storage, session } = setup();
  const sevenMoverEntry = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 7, Suit: 2 }, index: 4 });
  const sevenPublicEntry = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 7, Suit: 2 } });
  const handOf = (p: PlayerId) => (p === 0 ? [A_SECRET] : [O_SECRET]);
  const engine = createFakeEngine({
    newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, you: { hand: [A_SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } }) }),
    apply: vi.fn(() =>
      envelope({
        state: playerView({ active: 0, viewer: 0, phase: Phase.SevenChoosing, you: { hand: [A_SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
        lastMove: sevenMoverEntry,
        history: [sevenMoverEntry],
      }),
    ),
    view: vi.fn((p: PlayerId) =>
      envelope({
        state: playerView({ active: 0, viewer: p, phase: Phase.SevenChoosing, you: { hand: handOf(p), frozenHandIndices: [], points: [], permanents: [], watched: false } }),
        history: [p === 0 ? sevenMoverEntry : sevenPublicEntry],
      }),
    ),
  });
  const store = new GameStore({ engine, storage, session });
  return { store, engine, storage };
}

/** Walks the receiving sequence until `kind` (at most 8 steps). */
async function advanceUntil(store: GameStore, pred: () => boolean): Promise<void> {
  for (let i = 0; i < 8 && !pred(); i++) await store.advanceCurtain();
  expect(pred()).toBe(true);
}

describe('carry-over 4: no PlayerView of the previous holder survives across a curtain', () => {
  it('after a turn-passing apply, the store exposes neither envelope nor view until the curtain resolves', async () => {
    const { storage, session } = setup();
    const moverView = playerView({ active: 0, viewer: 0, you: { hand: [{ Rank: 5, Suit: 0 }], frozenHandIndices: [], points: [], permanents: [], watched: false } });
    const postMoveEnvelope = envelope({
      state: playerView({ active: 1, viewer: 0 }), // apply() returns the MOVER's own envelope (§2.4)
      lastMove: appliedMove({ by: 0, kind: Kind.Draw, seq: 1 }),
      history: [appliedMove({ by: 0, kind: Kind.Draw, seq: 1 })],
    });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: moverView }),
      apply: () => postMoveEnvelope,
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);

    // The mover's hand (present in postMoveEnvelope.state.you.hand, since
    // apply() legitimately returns the mover's own data) must not be
    // reachable through the store once a curtain is required.
    expect(store.curtain.kind).not.toBe('none');
    expect(store.envelope).toBeNull();
    expect(store.view).toBeNull();
  });

  it('when the active player does not change (e.g. discard-then-turn), no curtain is raised and the fresh envelope stays visible', async () => {
    const { storage, session } = setup();
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.AwaitingDiscard }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 0, viewer: 0, phase: Phase.Normal }),
          lastMove: appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 }),
          history: [appliedMove({ by: 0, kind: Kind.DiscardPair, seq: 1 })],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);

    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.envelope).not.toBeNull();
    expect(store.view?.active).toBe(0);
  });

  it('a winning move raises no curtain (result) and the mover keeps their own final view', async () => {
    const { storage, session } = setup();
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 0, viewer: 0, phase: Phase.GameOver, winner: 0 }),
          lastMove: appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1 }),
          history: [appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1 })],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);

    expect(store.curtain).toEqual({ kind: 'result' });
    expect(store.envelope).not.toBeNull();
    expect(store.view?.winner).toBe(0);
  });
});

describe('carry-over 5: recap is built with isRecapVisible + lastSeenSeq, stamped at the transition into curtain kind "none"', () => {
  it('walks handoff -> reveal -> recap -> none via advanceCurtain, fetching the incoming player\'s fresh view', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const history = [drawMove];
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 1, viewer: 0 }),
          lastMove: drawMove,
          history,
        }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });

    await store.advanceCurtain(); // -> reveal
    expect(store.curtain).toEqual({ kind: 'reveal', to: 1 });
    expect(store.envelope).toBeNull(); // still hidden — only the board render exposes a view

    await store.advanceCurtain(); // -> recap (there's 1 unseen entry for P2)
    expect(store.curtain).toMatchObject({ kind: 'recap', to: 1 });
    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries).toEqual([drawMove]);
    }
    // P2 is NOT stamped yet — stamped at 'none', not at reveal/recap. P1
    // (the mover) was stamped by the apply itself (§4.6 amended 2026-09-27).
    expect(store.lastSeenSeq).toEqual({ 0: 1, 1: 0 });

    await store.advanceCurtain(); // -> none, fetches P2's live view
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.envelope).not.toBeNull();
    expect(store.lastSeenSeq[1]).toBe(1); // stamped now, at the 'none' transition
  });

  it('a Decline entry is filtered out of the recap (never recapped, per isRecapVisible / R14)', async () => {
    const { storage, session } = setup();
    const declineMove = appliedMove({ by: 1, kind: Kind.Decline, seq: 1 });
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 2 });
    const history = [declineMove, drawMove];
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    await store.advanceCurtain(); // reveal

    await store.advanceCurtain(); // recap (or straight to none if empty after filtering)

    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries).toEqual([drawMove]);
      expect(store.curtain.entries.some((e) => e.kind === Kind.Decline)).toBe(false);
    } else {
      // Filtering left nothing recap-worthy is not expected here (drawMove
      // is visible), so landing anywhere but 'recap' is a failure — assert
      // explicitly rather than silently passing.
      expect(store.curtain.kind).toBe('recap');
    }
  });

  it('recap is skipped entirely when there is nothing unseen (goes straight to none)', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const history = [drawMove];
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history }),
    });
    const store = new GameStore({ engine, storage, session });
    // Pretend P2 already saw seq 1 (nothing new for them).
    await startGame(store, engine);
    store.lastSeenSeq = { 0: 0, 1: 1 };
    await store.apply(0);

    await store.advanceCurtain(); // reveal
    await store.advanceCurtain(); // straight to none, no recap

    expect(store.curtain).toEqual({ kind: 'none' });
  });
});

describe('R14 synthetic acknowledgment integration', () => {
  it('a one-off with no real counter window raises a synthetic ack for the opponent, then hands control back per post.active', async () => {
    const { storage, session } = setup();
    const oneOffMove = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 2 } });
    const history = [oneOffMove];
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () =>
        envelope({
          state: playerView({ active: 1, viewer: 0, phase: Phase.Normal }), // engine auto-resolved; no AwaitingCounter
          lastMove: oneOffMove,
          history,
        }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);

    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'acknowledge' });

    await store.advanceCurtain(); // reveal
    await store.advanceCurtain(); // recap (1 unseen entry)
    expect(store.curtain.kind).toBe('recap');
    expect(store.lastSeenSeq[1]).toBe(0); // not stamped at reveal or on entering recap
    await store.advanceCurtain(); // recap dismissed -> ack
    expect(store.curtain).toEqual({ kind: 'ack', to: 1, synthetic: true });
    // The ack screen needs pending/lastMove info — a fresh view was fetched for the ack target.
    expect(store.viewer).toBe(1);
    expect(store.envelope).not.toBeNull();
    expect(store.lastSeenSeq[1]).toBe(1); // stamped at recap dismissal (§4.6 amended 2026-09-27)

    await store.advanceCurtain(); // control returns to post.active (player 1, who already holds it) -> none
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.lastSeenSeq[1]).toBe(1);
  });
});

describe('carry-over 6: snapshot is written synchronously, before the reactive UI state updates', () => {
  it('storage.setItem observes the NEW history and curtain before store.envelope/store.curtain are updated', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history: [drawMove] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    const preApplyEnvelope = store.envelope;
    expect(preApplyEnvelope).not.toBeNull();

    let envelopeAtWriteTime: unknown = 'not-observed';
    let curtainKindAtWriteTime: string | undefined;
    let persistedHistoryLength = -1;
    const setItemSpy = vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === SNAPSHOT_KEY) {
        envelopeAtWriteTime = store.envelope;
        curtainKindAtWriteTime = store.curtain.kind;
        persistedHistoryLength = JSON.parse(value).history.length;
      }
    });

    await store.apply(0);

    // The write must have happened at all, and with the NEW history...
    expect(persistedHistoryLength).toBe(1);
    // ...while at write time the reactive fields were STILL the PRE-apply
    // ones (envelope unchanged, curtain not yet 'handoff') — proving
    // persist-before-update ordering (SPEC §5.7 "written... synchronously,
    // before the UI updates"; carry-over 6: "a move is not lost if the
    // process dies right after apply"). Only after this call returns are
    // envelope/curtain visibly updated to their post-apply values.
    expect(envelopeAtWriteTime).toBe(preApplyEnvelope);
    expect(curtainKindAtWriteTime).toBe('none');
    expect(store.envelope).toBeNull(); // post-apply: now actually updated
    expect(store.curtain.kind).toBe('handoff');

    setItemSpy.mockRestore();
  });
});

describe('B1: the acknowledger\'s PlayerView does not survive the handoff back to the mover', () => {
  it('7 round trip: after the synthetic ack hands the phone back to A, no O card identity is reachable anywhere in the store', async () => {
    const { store, engine } = sevenRoundTrip();
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    // Sanity: during O's ack, O's own envelope is legitimately exposed.
    expect(store.viewer).toBe(1);
    expect(reachable(store)).toContain(cardJson(O_SECRET));

    await store.advanceCurtain(); // ack -> handoff back to A
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'seven-return' });
    expect(store.envelope).toBeNull();
    expect(store.view).toBeNull();
    expect(store.viewer).toBeNull();
    expect(reachable(store)).not.toContain(cardJson(O_SECRET));

    await store.advanceCurtain(); // -> reveal to A
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });
    expect(store.envelope).toBeNull();
    expect(reachable(store)).not.toContain(cardJson(O_SECRET));
    // And a move cannot be submitted from behind the curtain.
    await expect(store.apply(0)).rejects.toThrow();

    await advanceUntil(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(0);
    expect(reachable(store)).not.toContain(cardJson(O_SECRET));
    expect(reachable(store)).toContain(cardJson(A_SECRET));
  });

  it('odd-chain Counter cancel: the ack hands back to the other player and the acknowledger\'s view is dropped', async () => {
    // P1 played a one-off, P0 counters, P1 holds no second 2 (§4.3 "Counter
    // links need it too"). The store only sees {active, phase}: here the
    // post-state leaves Active on P0, which is not the ack target (P1), so
    // the machine hands the phone back after the ack (docs/assumptions.md
    // "P2 round 01", W1).
    const { storage, session } = setup();
    const counter = appliedMove({ by: 0, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 }, index: 1 });
    const counterPublic = appliedMove({ by: 0, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 } });
    const oneOff = appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 } });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.AwaitingCounter }) }),
      apply: () => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.Normal }), lastMove: counter, history: [oneOff, counter] }),
      view: (p) =>
        envelope({
          state: playerView({ active: 0, viewer: p, you: { hand: p === 1 ? [O_SECRET] : [], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
          history: [oneOff, p === 0 ? counter : counterPublic],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'acknowledge' });
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    expect(reachable(store)).toContain(cardJson(O_SECRET));

    await store.advanceCurtain(); // -> handoff back to P0
    expect(store.curtain).toMatchObject({ kind: 'handoff', to: 0 });
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    expect(reachable(store)).not.toContain(cardJson(O_SECRET));
  });
});

describe('B2: the mover-only AppliedMove.index never survives behind a curtain', () => {
  beforeEach(() => {
    vi.mocked(curtainModule.advance).mockClear();
  });

  it('after a handoff, nothing in history, curtain/recap entries, recapFor, or the pending context has an own index key', async () => {
    const { storage, session } = setup();
    // A pending-3 style entry: the mover's envelope carries its legal-move index.
    const moverEntry = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 3, Suit: 1 }, index: 7 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () =>
        envelope({ state: playerView({ active: 1, viewer: 0, phase: Phase.AwaitingCounter }), lastMove: moverEntry, history: [moverEntry] }),
      view: (p) =>
        envelope({
          state: playerView({ active: 1, viewer: p, phase: Phase.AwaitingCounter }),
          history: [p === 0 ? moverEntry : appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 3, Suit: 1 } })],
        }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    vi.mocked(curtainModule.advance).mockClear(); // only this move's sequence, not the opening deal's
    await store.apply(0);

    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'counter' });
    expect(store.history.some(hasOwnIndex)).toBe(false);
    expect(store.recapFor(1).some(hasOwnIndex)).toBe(false);
    expect(JSON.stringify(store.history)).not.toContain('"index"');

    await store.advanceCurtain(); // reveal
    await store.advanceCurtain(); // recap
    expect(store.curtain.kind).toBe('recap');
    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries.length).toBe(1);
      expect(store.curtain.entries.some(hasOwnIndex)).toBe(false);
    }
    expect(store.history.some(hasOwnIndex)).toBe(false);

    // The private pending context, observed at the only place it flows: the machine's advance().
    const ctxMoves = vi.mocked(curtainModule.advance).mock.calls.map(([, ctx]) => ctx.move);
    expect(ctxMoves.length).toBeGreaterThan(0);
    expect(ctxMoves.some((m) => m !== null && hasOwnIndex(m))).toBe(false);

    // The persisted curtain/history carry no index either while the curtain is up.
    const persisted = JSON.parse(storage.getItem(SNAPSHOT_KEY) as string);
    expect(JSON.stringify(persisted.history)).not.toContain('"index"');
    expect(JSON.stringify(persisted.curtain)).not.toContain('"index"');
  });

  it('once the incoming viewer\'s own envelope arrives, its (bridge-redacted) history takes over', async () => {
    const { storage, session } = setup();
    const moverEntry = appliedMove({ by: 0, kind: Kind.Draw, seq: 1, index: 0 });
    const ownOlder = appliedMove({ by: 1, kind: Kind.Draw, seq: 0, index: 2 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: moverEntry, history: [moverEntry] }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history: [ownOlder, appliedMove({ by: 0, kind: Kind.Draw, seq: 1 })] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'none');

    expect(store.viewer).toBe(1);
    expect(store.history[0]).toEqual(ownOlder); // P1's own entry keeps its index, as the bridge sent it
    expect(hasOwnIndex(store.history[1])).toBe(false);
  });
});

describe('B3: viewer changes happen only through the curtain machine', () => {
  function simpleGame() {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const view = vi.fn((p: PlayerId) =>
      envelope({ state: playerView({ active: 1, viewer: p, you: { hand: p === 1 ? [O_SECRET] : [A_SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } }), history: [drawMove] }),
    );
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, you: { hand: [A_SECRET], frozenHandIndices: [], points: [], permanents: [], watched: false } }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history: [drawMove] }),
      view,
    });
    return { store: new GameStore({ engine, storage, session }), view, engine };
  }

  it('probe 1: there is no public call that fetches another player\'s view while P0 holds the phone', async () => {
    const { store, view, engine } = simpleGame();
    await startGame(store, engine);
    expect((store as unknown as Record<string, unknown>).setViewer).toBeUndefined();

    await store.refresh(); // the only public re-fetch: the CURRENT viewer, nobody else
    expect(view).toHaveBeenCalledTimes(1);
    expect(view).toHaveBeenCalledWith(0);
    expect(store.viewer).toBe(0);
    expect(reachable(store)).not.toContain(cardJson(O_SECRET));
  });

  it('probe 2: during the reveal to O, no public call restores the mover\'s envelope', async () => {
    const { store, view, engine } = simpleGame();
    await startGame(store, engine);
    await store.apply(0);
    await store.advanceCurtain(); // reveal to P1
    expect(store.curtain).toEqual({ kind: 'reveal', to: 1 });

    await expect(store.refresh()).rejects.toThrow();
    expect(view).not.toHaveBeenCalled();
    expect(store.envelope).toBeNull();
    expect(reachable(store)).not.toContain(cardJson(A_SECRET));
  });

  it('refresh() throws in handoff, recap, synthetic ack and result too', async () => {
    const { store, engine } = simpleGame();
    await startGame(store, engine);
    await store.apply(0);
    expect(store.curtain.kind).toBe('handoff');
    await expect(store.refresh()).rejects.toThrow();
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(store.curtain.kind).toBe('recap');
    await expect(store.refresh()).rejects.toThrow();

    const trip = sevenRoundTrip();
    await startGame(trip.store, trip.engine);
    await trip.store.apply(0);
    await advanceUntil(trip.store, () => trip.store.curtain.kind === 'ack');
    await expect(trip.store.refresh()).rejects.toThrow();
  });
});

describe('N5: apply() is guarded by the curtain', () => {
  it('throws before touching the bridge in handoff, reveal, recap and a synthetic ack', async () => {
    const { store, engine } = sevenRoundTrip();
    await startGame(store, engine);
    await store.apply(0);
    vi.mocked(engine.apply).mockClear();
    for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) {
      await expect(store.apply(0)).rejects.toThrow();
      await store.advanceCurtain();
    }
    expect(engine.apply).not.toHaveBeenCalled();
  });

  it('throws at result', async () => {
    const { storage, session } = setup();
    const win = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: vi.fn(() => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.GameOver, winner: 0 }), lastMove: win, history: [win] })),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    expect(store.curtain.kind).toBe('result');
    await expect(store.apply(0)).rejects.toThrow();
    expect(engine.apply).toHaveBeenCalledTimes(1);
  });

  it('is allowed in a real counter window (the decider is the viewer and active)', async () => {
    const { storage, session } = setup();
    const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 } });
    const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: vi
        .fn()
        .mockReturnValueOnce(envelope({ state: playerView({ active: 1, viewer: 0, phase: Phase.AwaitingCounter }), lastMove: oneOff, history: [oneOff] }))
        .mockReturnValueOnce(envelope({ state: playerView({ active: 1, viewer: 1, phase: Phase.Normal }), lastMove: decline, history: [oneOff, decline] })),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p, phase: Phase.AwaitingCounter }), history: [oneOff] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    expect(store.curtain).toEqual({ kind: 'ack', to: 1, synthetic: false });

    await expect(store.apply(0)).resolves.toBeUndefined();
    expect(engine.apply).toHaveBeenCalledTimes(2);
  });

  it('throws when the exposed view is not the active player\'s (viewer !== active)', async () => {
    const { storage, session } = setup();
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 1, viewer: 0 }) }),
      apply: vi.fn(),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await expect(store.apply(0)).rejects.toThrow();
    expect(engine.apply).not.toHaveBeenCalled();
  });
});

describe('B5: carry-over 6 ordering on every curtain transition, not only apply()', () => {
  interface WriteObservation {
    storeCurtainKind: string;
    storeEnvelope: unknown;
    storeViewer: PlayerId | null;
    persistedCurtainKind: string;
    persistedViewer: PlayerId;
  }

  function observeWrites(store: GameStore, storage: Storage): WriteObservation[] {
    const writes: WriteObservation[] = [];
    const original = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === SNAPSHOT_KEY) {
        const parsed = JSON.parse(value);
        writes.push({
          storeCurtainKind: store.curtain.kind,
          storeEnvelope: store.envelope,
          storeViewer: store.viewer,
          persistedCurtainKind: parsed.curtain.kind,
          persistedViewer: parsed.viewer,
        });
      }
      original(key, value);
    });
    return writes;
  }

  /** Advances once and asserts exactly one write, made while the store still showed the PRE-transition state. */
  async function expectPersistBeforeUpdate(store: GameStore, storage: Storage, expectedNewKind: string) {
    const beforeKind = store.curtain.kind;
    const beforeEnvelope = store.envelope;
    const beforeViewer = store.viewer;
    const writes = observeWrites(store, storage);
    await store.advanceCurtain();
    vi.mocked(storage.setItem).mockRestore();

    expect(store.curtain.kind).toBe(expectedNewKind);
    expect(writes).toHaveLength(1);
    expect(writes[0].persistedCurtainKind).toBe(expectedNewKind);
    expect(writes[0].storeCurtainKind).toBe(beforeKind);
    expect(writes[0].storeEnvelope).toBe(beforeEnvelope);
    expect(writes[0].storeViewer).toBe(beforeViewer);
  }

  function counterGame() {
    const { storage, session } = setup();
    const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 } });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0, phase: Phase.AwaitingCounter }), lastMove: oneOff, history: [oneOff] }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p, phase: Phase.AwaitingCounter }), history: [oneOff] }),
    });
    return { store: new GameStore({ engine, storage, session }), storage, engine };
  }

  it('handoff -> reveal', async () => {
    const { store, storage, engine } = counterGame();
    await startGame(store, engine);
    await store.apply(0);
    await expectPersistBeforeUpdate(store, storage, 'reveal');
  });

  it('reveal -> recap', async () => {
    const { store, storage, engine } = counterGame();
    await startGame(store, engine);
    await store.apply(0);
    await store.advanceCurtain();
    await expectPersistBeforeUpdate(store, storage, 'recap');
  });

  it('recap -> ack (real counter window, fetches a view)', async () => {
    const { store, storage, engine } = counterGame();
    await startGame(store, engine);
    await store.apply(0);
    await store.advanceCurtain();
    await store.advanceCurtain();
    await expectPersistBeforeUpdate(store, storage, 'ack');
  });

  it('recap -> none (fetches a view)', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history: [drawMove] }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p }), history: [drawMove] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(store.curtain.kind).toBe('recap');
    await expectPersistBeforeUpdate(store, storage, 'none');
  });

  it('synthetic ack -> handoff back (the 7 round trip), persisted with viewer = the new holder', async () => {
    const { store, storage, engine } = sevenRoundTrip();
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    const writes = observeWrites(store, storage);
    await store.advanceCurtain();
    vi.mocked(storage.setItem).mockRestore();

    expect(writes).toHaveLength(1);
    expect(writes[0].persistedCurtainKind).toBe('handoff');
    expect(writes[0].persistedViewer).toBe(0);
    expect(writes[0].storeCurtainKind).toBe('ack');
    expect(writes[0].storeViewer).toBe(1);
    expect(writes[0].storeEnvelope).not.toBeNull();
  });
});

describe('N2: a handoff persists viewer = curtain.to (not the mover)', () => {
  it('the snapshot written by a turn-passing apply names the incoming player as viewer', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history: [drawMove] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);

    const persisted = JSON.parse(storage.getItem(SNAPSHOT_KEY) as string);
    expect(persisted.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(persisted.viewer).toBe(1);
  });
});

describe('N4: opponent.hand [] (visible, empty) survives a viewer change', () => {
  it('the incoming player\'s [] opponent hand arrives intact at curtain kind "none"', async () => {
    const { storage, session } = setup();
    const drawMove = appliedMove({ by: 0, kind: Kind.Draw, seq: 1 });
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => envelope({ state: playerView({ active: 1, viewer: 0 }), lastMove: drawMove, history: [drawMove] }),
      view: (p) => envelope({ state: playerView({ active: 1, viewer: p, opponent: { handCount: 0, hand: [], points: [], permanents: [] } }), history: [drawMove] }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'none');

    expect(store.view?.opponent.hand).toEqual([]);
    expect(store.view?.opponent.hand).not.toBeNull();
  });
});

describe('SPEC §4.6 (amended 2026-09-27): a successful apply stamps lastSeenSeq[mover]', () => {
  // P0 draws (seq 1), P1 draws (seq 2), P0 draws (seq 3).
  function twoRounds() {
    const { storage, session } = setup();
    const moves = [
      appliedMove({ by: 0, kind: Kind.Draw, seq: 1 }),
      appliedMove({ by: 1, kind: Kind.Draw, seq: 2 }),
      appliedMove({ by: 0, kind: Kind.Draw, seq: 3 }),
    ];
    let applied = 0;
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => {
        applied += 1;
        const mover = moves[applied - 1].by;
        return envelope({ state: playerView({ active: (1 - mover) as PlayerId, viewer: mover }), lastMove: moves[applied - 1], history: moves.slice(0, applied) });
      },
      view: (p) => envelope({ state: playerView({ active: p, viewer: p }), history: moves.slice(0, applied) }),
    });
    return { store: new GameStore({ engine, storage, session }), storage, moves, engine };
  }

  it('the snapshot written by that apply already carries the mover\'s stamp', async () => {
    const { store, storage, engine } = twoRounds();
    await startGame(store, engine);
    await store.apply(0);
    expect(store.lastSeenSeq).toEqual({ 0: 1, 1: 0 });
    const persisted = JSON.parse(storage.getItem(SNAPSHOT_KEY) as string);
    expect(persisted.lastSeenSeq).toEqual({ 0: 1, 1: 0 });
    expect(persisted.curtain.kind).toBe('handoff');
  });

  it('after one full round, the incoming player\'s recap contains only the opponent\'s move', async () => {
    const { store, moves, engine } = twoRounds();
    await startGame(store, engine);
    await store.apply(0); // P0 draws
    await advanceUntil(store, () => store.curtain.kind === 'none'); // P1 sees seq 1
    await store.apply(0); // P1 draws
    await store.advanceCurtain(); // reveal to P0
    await store.advanceCurtain();
    expect(store.curtain.kind).toBe('recap');
    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries).toEqual([moves[1]]);
    }
  });

  it('a mover\'s recap on their next turn never includes their own previous move', async () => {
    const { store, moves, engine } = twoRounds();
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'none');
    await store.apply(0); // P1 draws
    await advanceUntil(store, () => store.curtain.kind === 'none'); // P0 back
    expect(store.viewer).toBe(0);
    await store.apply(0); // P0 draws seq 3
    await store.advanceCurtain(); // reveal to P1
    await store.advanceCurtain();
    expect(store.curtain.kind).toBe('recap');
    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries).toEqual([moves[2]]);
      expect(store.curtain.entries.some((e) => e.by === 1)).toBe(false);
    }
  });

  it('a failed apply stamps nothing', async () => {
    const { storage, session } = setup();
    const engine = createFakeEngine({
      newGame: () => envelope({ state: playerView({ active: 0, viewer: 0 }) }),
      apply: () => ({ ok: false, code: 'ILLEGAL_MOVE', message: 'no' }),
    });
    const store = new GameStore({ engine, storage, session });
    await startGame(store, engine);
    await store.apply(0);
    expect(store.lastSeenSeq).toEqual({ 0: 0, 1: 0 });
  });
});

// Odd-chain Counter cancel with real per-viewer redaction: every viewer's
// history carries `index` on that viewer's OWN entries only (§3.2). P1 played
// a one-off (seq 1), P0 counters (seq 2, applied here), P1 has no second 2,
// the chain cancels and Active lands on P0: P1 synthetic-acks, then the
// phone goes back to P0. A later P0 Draw (seq 3) hands the phone to P1 again.
function oddChainRun(opts: { failViewOnce?: PlayerId } = {}) {
  const { storage, session } = setup();
  const full = [
    appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 }, index: 5 }),
    appliedMove({ by: 0, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 }, index: 1 }),
    appliedMove({ by: 0, kind: Kind.Draw, seq: 3, index: 0 }),
  ];
  const redactedFor = (p: PlayerId, upTo: number): AppliedMove[] =>
    full.slice(0, upTo).map((m) => {
      if (m.by === p) return m;
      const copy = { ...m };
      delete copy.index;
      return copy;
    });
  let applied = 1; // seq 1 (P1's one-off) is already applied when the game starts
  let failPending = opts.failViewOnce;
  const view = vi.fn((p: PlayerId) => {
    if (failPending === p) {
      failPending = undefined;
      return { ok: false as const, code: 'INTERNAL' as const, message: 'transient' };
    }
    const active: PlayerId = applied <= 2 ? 0 : 1;
    return envelope({ state: playerView({ active, viewer: p }), history: redactedFor(p, applied) });
  });
  const engine = createFakeEngine({
    newGame: () => envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.AwaitingCounter }), history: redactedFor(0, 1) }),
    apply: vi.fn(() => {
      if (applied === 1) {
        applied = 2; // P0's counter
        return envelope({ state: playerView({ active: 0, viewer: 0, phase: Phase.Normal }), lastMove: full[1], history: redactedFor(0, 2) });
      }
      applied = 3;
      return envelope({ state: playerView({ active: 1, viewer: 0, phase: Phase.Normal }), lastMove: full[2], history: redactedFor(0, 3) });
    }),
    view,
  });
  const store = new GameStore({ engine, storage, session });
  return { store, storage, view, full, engine };
}

function persisted(storage: Storage) {
  return JSON.parse(storage.getItem(SNAPSHOT_KEY) as string);
}

describe('B-R1: the acknowledger\'s own indexed history does not survive the synthetic-ack handback', () => {
  it('odd-chain cancel: at the handoff back and the reveal, no own index key in history, curtain, the persisted snapshot, or recapFor', async () => {
    const { store, storage, engine } = oddChainRun();
    await startGame(store, engine);
    await store.apply(0); // P0 counters
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    expect(store.viewer).toBe(1);
    // Sanity: the acknowledger's own envelope legitimately carries their own index.
    expect(store.history.some(hasOwnIndex)).toBe(true);

    await store.advanceCurtain(); // ack -> handoff back to P0
    expect(store.curtain).toMatchObject({ kind: 'handoff', to: 0 });
    const assertNoIndex = () => {
      expect(store.history.some(hasOwnIndex)).toBe(false);
      expect(JSON.stringify(store.curtain)).not.toContain('"index"');
      expect(store.recapFor(0).some(hasOwnIndex)).toBe(false);
      expect(store.recapFor(1).some(hasOwnIndex)).toBe(false);
      const snap = persisted(storage);
      expect(JSON.stringify(snap.history)).not.toContain('"index"');
      expect(JSON.stringify(snap.curtain)).not.toContain('"index"');
    };
    assertNoIndex();

    await store.advanceCurtain(); // -> reveal to P0
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });
    assertNoIndex();
  });
});

describe('R2: a failed view() fetch leaves the sequence resumable', () => {
  it('reveal -> none fails once, the curtain stays put with the error, and a retry reaches the resting state', async () => {
    const { store, view, engine } = oddChainRun({ failViewOnce: 0 });
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    await store.advanceCurtain(); // handoff back to P0
    await store.advanceCurtain(); // reveal to P0 (nothing unseen for P0: recap is skipped next)
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });

    await store.advanceCurtain(); // -> none, but view(0) fails
    expect(store.error).toMatchObject({ code: 'INTERNAL' });
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });
    expect(store.envelope).toBeNull();

    await expect(store.advanceCurtain()).resolves.toBeUndefined(); // retry
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.error).toBeNull();
    expect(view).toHaveBeenLastCalledWith(0);
  });

  it('recap -> ack fails once, then the retry reaches the ack', async () => {
    const { store, engine } = oddChainRun({ failViewOnce: 1 });
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'recap');
    await store.advanceCurtain(); // fails
    expect(store.curtain.kind).toBe('recap');
    expect(store.error).toMatchObject({ code: 'INTERNAL' });
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: 1, synthetic: true });
  });
});

describe('R3: SPEC §4.6 (amended again 2026-09-27): leaving recap stamps lastSeenSeq[viewer]', () => {
  it('the acknowledger is stamped at recap dismissal, in that transition\'s write, before the store updates', async () => {
    const { store, storage, engine } = oddChainRun();
    await startGame(store, engine);
    await store.apply(0);
    expect(store.lastSeenSeq).toEqual({ 0: 2, 1: 0 }); // mover stamped by apply
    await advanceUntil(store, () => store.curtain.kind === 'recap');
    expect(store.lastSeenSeq[1]).toBe(0); // not at reveal or recap entry

    const writes: Array<{ storeCurtain: string; storeSeen1: number; persistedSeen1: number; persistedCurtain: string }> = [];
    const original = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      const parsed = JSON.parse(value);
      writes.push({ storeCurtain: store.curtain.kind, storeSeen1: store.lastSeenSeq[1], persistedSeen1: parsed.lastSeenSeq[1], persistedCurtain: parsed.curtain.kind });
      original(key, value);
    });
    await store.advanceCurtain(); // recap -> ack (synthetic)
    vi.mocked(storage.setItem).mockRestore();

    expect(store.curtain).toEqual({ kind: 'ack', to: 1, synthetic: true });
    expect(store.lastSeenSeq[1]).toBe(2);
    expect(writes).toEqual([{ storeCurtain: 'recap', storeSeen1: 0, persistedSeen1: 2, persistedCurtain: 'ack' }]);
  });

  it('end state after the odd-chain run, and the acknowledger\'s next recap does not repeat what they already saw', async () => {
    const { store, storage, full, engine } = oddChainRun();
    await startGame(store, engine);
    await store.apply(0);
    await advanceUntil(store, () => store.curtain.kind === 'ack');
    await store.advanceCurtain(); // handoff back to P0 — P1 never reaches 'none'
    expect(store.lastSeenSeq).toEqual({ 0: 2, 1: 2 });
    expect(persisted(storage).lastSeenSeq).toEqual({ 0: 2, 1: 2 });
    await advanceUntil(store, () => store.curtain.kind === 'none');
    expect(store.lastSeenSeq).toEqual({ 0: 2, 1: 2 });

    await store.apply(0); // P0 draws, seq 3
    await store.advanceCurtain(); // reveal to P1
    await store.advanceCurtain(); // recap
    expect(store.curtain.kind).toBe('recap');
    if (store.curtain.kind === 'recap') {
      expect(store.curtain.entries.map((e) => e.seq)).toEqual([3]);
      expect(store.curtain.entries[0].kind).toBe(full[2].kind);
    }
  });
});
