// Issue #27 — the 5's draw reveal, store half (GameStore, SPEC §4.7).
//
// Strict tier (hidden-information privacy + save/resume). Alice (P0) plays
// a 5; the two cards she draws are shown face up on HER screen only:
//   - before the pass, when her own apply resolved the 5: no counter window
//     opened (Blake held no 2, ruling 2026-09-29, §4.3), or her own 2
//     closed the chain;
//   - otherwise at her next own view, once the 5 has resolved on Blake's
//     Decline and she holds the phone again.
// While Blake holds the phone the store never carries a reveal, and the
// save never carries one at all.

import { describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { Kind, Phase, appliedMove, createFakeEngine, envelope, fakeStorage, passResumeGate, playerView, startGame } from './game-test-support';

const FIVE: Card = { Rank: 5, Suit: 2 };
const KING: Card = { Rank: 13, Suit: 0 };
// The two cards Alice draws. Distinctive, and never in any fixture of Blake's.
const D1: Card = { Rank: 9, Suit: 3 };
const D2: Card = { Rank: 12, Suit: 1 };
const B_CARD: Card = { Rank: 4, Suit: 0 };
const RETURNED: Card = { Rank: 10, Suit: 2 };

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

function you(hand: Card[], frozenHandIndices: number[] = []): PlayerView['you'] {
  return { hand, frozenHandIndices, points: [], permanents: [], watched: false };
}

function opp(handCount: number): PlayerView['opponent'] {
  return { handCount, hand: null, points: [], permanents: [] };
}

const FIVE_DESC = 'play 5♥ as one-off';

function fiveEntry(seq: number, drawn: number | null, withIndex: boolean): AppliedMove {
  return appliedMove({ by: 0, kind: Kind.OneOff, seq, card: FIVE, description: FIVE_DESC, drawn, ...(withIndex ? { index: 0 } : {}) });
}

/** Alice to act, holding the 5 and a King; her only offered move is the 5 as a one-off. */
function aliceOpening(): Envelope {
  return envelope({
    state: playerView({ viewer: 0, active: 0, you: you([FIVE, KING]), opponent: opp(3) }),
    legalMoves: [mv({ Kind: Kind.OneOff, Card: FIVE, HandIndex: 0 })],
    descriptions: [FIVE_DESC],
  });
}

function blakeView(history: AppliedMove[], overrides: Partial<PlayerView> = {}, legal: Move[] = [], descriptions: string[] = []): Envelope {
  return envelope({
    state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(3), ...overrides }),
    history,
    legalMoves: legal,
    descriptions,
  });
}

function aliceView(history: AppliedMove[], hand: Card[], overrides: Partial<PlayerView> = {}): Envelope {
  return envelope({
    state: playerView({ viewer: 0, active: 0, you: you(hand), opponent: opp(1), ...overrides }),
    history,
    legalMoves: [mv({ Kind: Kind.Draw })],
    descriptions: ['draw a card'],
  });
}

function setup() {
  const storage = fakeStorage();
  const session = new SessionStore();
  session.setNames('Alice', 'Blake');
  const engine = createFakeEngine({ newGame: () => aliceOpening() });
  const store = new GameStore({ engine, storage, session });
  return { storage, session, engine, store };
}

function saved(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(SNAPSHOT_KEY);
  if (raw === null) throw new Error('no snapshot');
  return JSON.parse(raw) as Record<string, unknown>;
}

const SNAPSHOT_KEYS = ['curtain', 'dealer', 'engineState', 'history', 'lastSeenSeq', 'names', 'savedAt', 'seed', 'v', 'viewer'];

/** Every identity form of the drawn cards a serializer could write. */
function mentionsDrawn(text: string): boolean {
  return [D1, D2].some((c) => text.includes(JSON.stringify(c)) || text.includes(`"Rank":${c.Rank},"Suit":${c.Suit}`));
}

async function walk(store: GameStore, until: () => boolean): Promise<void> {
  for (let i = 0; i < 6 && !until(); i++) await store.advanceCurtain();
  expect(until()).toBe(true);
}

// ---------------------------------------------------------------------------
// Before the pass: Alice's own apply resolved the 5 (no counter window)
// ---------------------------------------------------------------------------

/**
 * Alice plays the 5; Blake holds no 2 (`blakeCards` cards, none of them a
 * 2), so the engine resolves it at once: no counter window, no ack (§4.3,
 * ruling 2026-09-29), and the turn handoff follows the reveal.
 */
async function playFiveNoWindow(blakeCards = 3) {
  const ctx = setup();
  await startGame(ctx.store, ctx.engine, { seed: '7' });
  const played = fiveEntry(1, 2, true);
  ctx.engine.apply = vi.fn(() =>
    envelope({
      state: playerView({ viewer: 0, active: 1, you: you([KING, D1, D2]), opponent: opp(blakeCards) }),
      lastMove: played,
      history: [played],
    }),
  );
  await ctx.store.apply(0);
  return ctx;
}

describe('before the pass: the drawer sees the draw on their own screen, then the handoff', () => {
  for (const blakeCards of [0, 3]) {
    it(`the reveal comes up on the mover's own board, naming the last \`drawn\` hand indices (Blake holds ${blakeCards} cards, no 2)`, async () => {
      const { store } = await playFiveNoWindow(blakeCards);
      expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: true });
      expect(store.curtain).toEqual({ kind: 'none' });
      expect(store.viewer).toBe(0);
      expect(store.envelope?.state.viewer).toBe(0);
      expect(store.legalMoves).toEqual([]);
    });
  }

  it('the save already holds the handoff to Blake, never the reveal (a reload mid-reveal comes back to the pass)', async () => {
    const { storage } = await playFiveNoWindow();
    const snap = saved(storage);
    expect(Object.keys(snap).sort()).toEqual(SNAPSHOT_KEYS);
    expect(snap.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(snap.viewer).toBe(1);
    for (const h of snap.history as AppliedMove[]) expect(Object.prototype.hasOwnProperty.call(h, 'index')).toBe(false);
    expect(mentionsDrawn(JSON.stringify({ ...snap, engineState: '' }))).toBe(false);
  });

  it('continuing raises the handoff: no envelope, no viewer, no reveal, no mover-only index', async () => {
    const { store, storage } = await playFiveNoWindow();
    const before = storage.getItem(SNAPSHOT_KEY);
    store.dismissDrawReveal();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    for (const h of store.history) expect(Object.prototype.hasOwnProperty.call(h, 'index')).toBe(false);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(before); // nothing new to save
  });

  it('a second continue (tap after the timer) is a no-op: it never advances the handoff', async () => {
    const { store, engine } = await playFiveNoWindow();
    store.dismissDrawReveal();
    store.dismissDrawReveal();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(engine.view).not.toHaveBeenCalled();
  });

  it('while the reveal is up nothing else moves: apply, refresh and advanceCurtain all refuse', async () => {
    const { store, engine, storage } = await playFiveNoWindow();
    const before = storage.getItem(SNAPSHOT_KEY);
    await expect(store.apply(0)).rejects.toThrow(/reveal/i);
    await expect(store.refresh()).rejects.toThrow(/reveal/i);
    await expect(store.advanceCurtain()).rejects.toThrow(/reveal/i);
    expect(engine.apply).toHaveBeenCalledTimes(1);
    expect(engine.view).not.toHaveBeenCalled();
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(before);
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: true });
  });

  it('Blake never gets a reveal: after the handoff his board carries none', async () => {
    const { store, engine } = await playFiveNoWindow();
    store.dismissDrawReveal();
    engine.view = vi.fn((p: PlayerId) => (p === 1 ? blakeView([fiveEntry(1, 2, false)], { opponent: opp(3), you: you([]) }) : aliceOpening()));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(1);
    expect(store.drawReveal).toBeNull();
  });

  it('and Alice is not shown the same draw again at her next board', async () => {
    const { store, engine } = await playFiveNoWindow();
    store.dismissDrawReveal();
    const five = fiveEntry(1, 2, false);
    engine.view = vi.fn(() => blakeView([five], { you: you([]) }, [mv({ Kind: Kind.Draw })], ['draw a card']));
    await walk(store, () => store.curtain.kind === 'none');
    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 2, index: 0 });
    engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history: [five, blakeDraw] }));
    await store.apply(0);
    engine.view = vi.fn(() => aliceView([fiveEntry(1, 2, true), appliedMove({ by: 1, kind: Kind.Draw, seq: 2 })], [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(0);
    expect(store.drawReveal).toBeNull();
  });

  it('a reload after the reveal, while Blake holds the phone, does not show the same draw again at Alice\'s next board', async () => {
    const { store, storage, session, engine } = await playFiveNoWindow();
    store.dismissDrawReveal();
    const five = fiveEntry(1, 2, false);
    const again = new GameStore({ engine, storage, session });
    engine.restore = vi.fn(() => blakeView([five], {}, [mv({ Kind: Kind.Draw })], ['draw a card']));
    engine.view = vi.fn(() => blakeView([five], {}, [mv({ Kind: Kind.Draw })], ['draw a card']));
    await again.restore();
    await walk(again, () => again.curtain.kind === 'none');
    expect(again.viewer).toBe(1);
    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 2, index: 0 });
    engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history: [five, blakeDraw] }));
    await again.apply(0);
    engine.view = vi.fn(() => aliceView([fiveEntry(1, 2, true), appliedMove({ by: 1, kind: Kind.Draw, seq: 2 })], [KING, D1, D2]));
    await walk(again, () => again.curtain.kind === 'none');
    expect(again.viewer).toBe(0);
    expect(again.drawReveal).toBeNull();
  });

  it('Home mid-reveal drops it; Resume comes back to the handoff to Blake, with no reveal', async () => {
    const { store, storage, session, engine } = await playFiveNoWindow();
    store.goHome();
    expect(store.drawReveal).toBeNull();
    const again = new GameStore({ engine, storage, session });
    engine.restore = vi.fn(() => blakeView([fiveEntry(1, 2, false)], { you: you([]) }));
    await again.restore();
    expect(again.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(again.drawReveal).toBeNull();
    expect(again.envelope).toBeNull();
  });

  it('a new game drops a reveal that is up', async () => {
    const { store } = await playFiveNoWindow();
    await store.newGame({ seed: '8' });
    expect(store.drawReveal).toBeNull();
  });
});

describe('before the pass: a 5 that drew one card, or none', () => {
  async function playFive(drawn: number, hand: Card[]) {
    const ctx = setup();
    await startGame(ctx.store, ctx.engine, { seed: '7' });
    const played = fiveEntry(1, drawn, true);
    ctx.engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 0, active: 1, you: you(hand), opponent: opp(0), deckCount: 0 }), lastMove: played, history: [played] }),
    );
    await ctx.store.apply(0);
    return ctx;
  }

  it('one card left in the deck: one card is shown', async () => {
    const { store } = await playFive(1, [KING, D1]);
    expect(store.drawReveal).toEqual({ to: 0, indices: [1], beforePass: true });
  });

  it('nothing drawn: no reveal, the handoff comes up at once', async () => {
    const { store } = await playFive(0, [KING]);
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A counter-back: Alice's own 2 closes the chain, so the draw is hers at once
// ---------------------------------------------------------------------------

describe('before the pass: Alice\'s own Counter resolves her 5 (Blake countered, Alice countered back, Blake has no 2)', () => {
  it('the reveal comes up on Alice\'s board after her Counter, then the turn handoff', async () => {
    const ctx = setup();
    await startGame(ctx.store, ctx.engine, { seed: '7' });
    const five = fiveEntry(1, null, false);
    const blakeCounter = appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 }, description: 'counter with 2♣' });
    const aliceCounter = appliedMove({ by: 0, kind: Kind.Counter, seq: 3, card: { Rank: 2, Suit: 3 }, description: 'counter with 2♠', drawn: 2 });
    const pending = { playedBy: 0 as PlayerId, card: FIVE, target: null, counterChain: [] };
    // Alice plays the 5 into Blake's window; Blake counters (Alice's window).
    ctx.engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 0, active: 1, phase: Phase.AwaitingCounter, you: you([KING, { Rank: 2, Suit: 3 }]), opponent: opp(3) }), lastMove: fiveEntry(1, null, true), history: [fiveEntry(1, null, true)] }),
    );
    await ctx.store.apply(0);
    ctx.engine.view = vi.fn(() => blakeView([five], { phase: Phase.AwaitingCounter, pending }, [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 0 } })], ['counter with 2♣']));
    await walk(ctx.store, () => ctx.store.curtain.kind === 'ack');
    ctx.engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 1, active: 0, phase: Phase.AwaitingCounter, you: you([B_CARD]), opponent: opp(2) }), lastMove: { ...blakeCounter, index: 0 }, history: [five, { ...blakeCounter, index: 0 }] }),
    );
    await ctx.store.apply(0);
    ctx.engine.view = vi.fn(() =>
      envelope({
        state: playerView({ viewer: 0, active: 0, phase: Phase.AwaitingCounter, you: you([KING, { Rank: 2, Suit: 3 }]), opponent: opp(1), pending }),
        history: [fiveEntry(1, null, true), blakeCounter],
        legalMoves: [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 3 }, HandIndex: 1 }), mv({ Kind: Kind.Decline })],
        descriptions: ['counter with 2♠', 'decline'],
      }),
    );
    await walk(ctx.store, () => ctx.store.curtain.kind === 'ack');
    expect(ctx.store.curtain).toEqual({ kind: 'ack', to: 0 });
    expect(ctx.store.drawReveal).toBeNull(); // nothing drawn yet
    // Alice counters back; Blake holds no 2, so the chain (two 2s) resolves the 5 on her apply.
    ctx.engine.apply = vi.fn(() =>
      envelope({
        state: playerView({ viewer: 0, active: 1, you: you([KING, D1, D2]), opponent: opp(1) }),
        lastMove: { ...aliceCounter, index: 0 },
        history: [fiveEntry(1, null, true), blakeCounter, { ...aliceCounter, index: 0 }],
      }),
    );
    await ctx.store.apply(0);
    expect(ctx.store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: true });
    expect(ctx.store.curtain).toEqual({ kind: 'none' });
    expect(saved(ctx.storage).curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    ctx.store.dismissDrawReveal();
    expect(ctx.store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(ctx.store.envelope).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// After resolution on Blake's apply: the real counter window, Blake declines
// ---------------------------------------------------------------------------

/** Alice plays the 5 into Blake's counter window (the 5 has not resolved). */
async function playFiveRealWindow() {
  const ctx = setup();
  await startGame(ctx.store, ctx.engine, { seed: '7' });
  const played = fiveEntry(1, null, true);
  ctx.engine.apply = vi.fn(() =>
    envelope({
      state: playerView({ viewer: 0, active: 1, phase: Phase.AwaitingCounter, you: you([KING]), opponent: opp(3) }),
      lastMove: played,
      history: [played],
    }),
  );
  await ctx.store.apply(0);
  return ctx;
}

/**
 * Blake declines, so the 5 resolves on HIS apply (`drawn` on the Decline)
 * and his turn follows with no curtain. Records every reveal state while he
 * holds the phone. `blakeNext` is the move Blake is offered on his board.
 */
async function blakeDeclines(blakeNext: Move = mv({ Kind: Kind.Draw }), blakeNextText = 'draw a card') {
  const ctx = await playFiveRealWindow();
  const { store, engine } = ctx;
  const five = fiveEntry(1, null, false);
  const blakeSeen: (typeof store.drawReveal)[] = [store.drawReveal];
  engine.view = vi.fn(() =>
    blakeView([five], { phase: Phase.AwaitingCounter, pending: { playedBy: 0, card: FIVE, target: null, counterChain: [] } }, [mv({ Kind: Kind.Decline }), mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 0 } })], ['decline', 'counter with 2♣']),
  );
  for (let i = 0; i < 6 && store.curtain.kind !== 'ack'; i++) {
    await store.advanceCurtain();
    blakeSeen.push(store.drawReveal);
  }
  expect(store.curtain).toEqual({ kind: 'ack', to: 1 });
  const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2, index: 0, drawn: 2 });
  engine.apply = vi.fn(() =>
    envelope({ state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(3) }), lastMove: decline, history: [five, decline], legalMoves: [blakeNext], descriptions: [blakeNextText] }),
  );
  await store.apply(0);
  blakeSeen.push(store.drawReveal);
  expect(store.curtain).toEqual({ kind: 'none' });
  expect(store.viewer).toBe(1);
  const declinePublic = appliedMove({ by: 1, kind: Kind.Decline, seq: 2, drawn: 2 });
  return { ...ctx, five, declinePublic, blakeSeen };
}

/** From `blakeDeclines`: Blake draws, handing the phone back to Alice (curtain up to her). */
async function deferredToAlice() {
  const ctx = await blakeDeclines();
  const { store, engine, five, declinePublic, blakeSeen } = ctx;
  const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 3, index: 0 });
  const next = [five, declinePublic, appliedMove({ by: 1, kind: Kind.Draw, seq: 3 })];
  engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history: [five, { ...declinePublic, index: 0 }, blakeDraw] }));
  await store.apply(0);
  blakeSeen.push(store.drawReveal);
  expect(store.curtain.kind).toBe('handoff');
  return { ...ctx, next };
}

describe('after resolution on Blake\'s Decline: the reveal waits for Alice\'s next own view', () => {
  it('the counter handoff comes up with no reveal (the 5 has not resolved)', async () => {
    const { store } = await playFiveRealWindow();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'counter' });
  });

  it('Blake declines, plays, and passes back: no reveal at any step of his; then Alice\'s board reveals the draw', async () => {
    const { store, engine, next, blakeSeen } = await deferredToAlice();
    expect(blakeSeen.every((r) => r === null)).toBe(true);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(0);
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('continuing leaves Alice on her own board, curtain none, able to play', async () => {
    const { store, engine, next } = await deferredToAlice();
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    store.dismissDrawReveal();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.legalMoves.length).toBe(1);
  });

  it('the reveal is shown once: a refresh after it does not bring it back', async () => {
    const { store, engine, next } = await deferredToAlice();
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    store.dismissDrawReveal();
    await store.refresh();
    expect(store.drawReveal).toBeNull();
  });

  it('a card Blake\'s 9 sent back to Alice (frozen, at the end of her hand) is not taken for a drawn one', async () => {
    const { store, engine, next } = await deferredToAlice();
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2, RETURNED], { you: you([KING, D1, D2, RETURNED], [3]) }));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('Alice\'s first board is a 4\'s discard: the draw is the end of her hand, a stale freeze there is ignored', async () => {
    const { store, engine, next } = await deferredToAlice();
    engine.view = vi.fn(() =>
      aliceView(next, [KING, D1, D2], { phase: Phase.AwaitingDiscard, you: you([KING, D1, D2], [2]) }),
    );
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('while the reveal is up Alice cannot move until she continues', async () => {
    const { store, engine, next } = await deferredToAlice();
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    const applies = (engine.apply as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(store.apply(0)).rejects.toThrow(/reveal/i);
    expect((engine.apply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(applies);
  });

  it('a reload before Alice\'s board still shows her the draw there (the save holds no reveal state)', async () => {
    const { engine, storage, session, next } = await deferredToAlice();
    const again = new GameStore({ engine, storage, session });
    engine.restore = vi.fn(() => aliceView(next, [KING, D1, D2]));
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await again.restore();
    expect(again.drawReveal).toBeNull();
    await walk(again, () => again.curtain.kind === 'none');
    expect(again.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('a reload at Alice\'s board after she saw the draw does not show it again', async () => {
    const { store, engine, storage, session, next } = await deferredToAlice();
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).not.toBeNull();
    const again = new GameStore({ engine, storage, session });
    engine.restore = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await again.restore();
    await passResumeGate(again);
    expect(again.curtain).toEqual({ kind: 'none' });
    expect(again.drawReveal).toBeNull();
  });
});

describe('after resolution: Blake\'s turn ends in a one-off Alice can answer, so her first own view is the counter window', () => {
  // Blake declines Alice's 5, then plays a 6 as a one-off. Alice holds a 2,
  // so her first own view is the counter window for it. The reveal comes
  // first, before a counter could take a drawn 2 out of her hand.
  it('the reveal is up at the ack, and nothing moves until it is dismissed', async () => {
    const { store, engine, five, declinePublic } = await blakeDeclines(mv({ Kind: Kind.OneOff, Card: { Rank: 6, Suit: 0 } }), 'play 6♣ as one-off');
    const sixFields = { by: 1, kind: Kind.OneOff, seq: 3, card: { Rank: 6, Suit: 0 }, description: 'play 6♣ as one-off' } as const;
    const six = appliedMove({ ...sixFields, index: 0 });
    const history = [five, declinePublic, appliedMove(sixFields)];
    engine.apply = vi.fn(() =>
      envelope({
        state: playerView({ viewer: 1, active: 0, phase: Phase.AwaitingCounter, you: you([B_CARD]), opponent: opp(3) }),
        lastMove: six,
        history: [five, { ...declinePublic, index: 0 }, six],
      }),
    );
    await store.apply(0);
    const TWO_S: Card = { Rank: 2, Suit: 3 };
    engine.view = vi.fn(() =>
      aliceView(history, [KING, D1, TWO_S], { phase: Phase.AwaitingCounter, pending: { playedBy: 1, card: { Rank: 6, Suit: 0 }, target: null, counterChain: [] } }),
    );
    await walk(store, () => store.curtain.kind === 'ack');
    expect(store.curtain).toEqual({ kind: 'ack', to: 0 });
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
    const applies = (engine.apply as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(store.apply(0)).rejects.toThrow(/reveal/i);
    await expect(store.advanceCurtain()).rejects.toThrow(/reveal/i);
    expect((engine.apply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(applies);
    store.dismissDrawReveal();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'ack', to: 0 });
  });
});

describe('a cancelled 5: nothing to reveal', () => {
  it('Blake counters and Alice holds no 2: the 5 is cancelled at once, Blake plays on, and no screen of Alice\'s shows a reveal', async () => {
    const { store, engine } = await playFiveRealWindow();
    const five = fiveEntry(1, null, false);
    const counter = appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 } });
    engine.view = vi.fn(() =>
      blakeView([five], { phase: Phase.AwaitingCounter, pending: { playedBy: 0, card: FIVE, target: null, counterChain: [] } }, [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 0 } }), mv({ Kind: Kind.Decline })], ['counter', 'decline']),
    );
    await walk(store, () => store.curtain.kind === 'ack');
    // Alice holds no 2: the engine cancels the 5 at once and the turn passes to Blake.
    engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(1) }), lastMove: { ...counter, index: 0 }, history: [five, { ...counter, index: 0 }], legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    await store.apply(0);
    // No handoff to Alice for a prompt she could not use: Blake plays on.
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.drawReveal).toBeNull();
    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 3, index: 0 });
    const history = [five, counter, blakeDraw];
    engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(1) }), lastMove: blakeDraw, history }));
    await store.apply(0);
    engine.view = vi.fn(() => aliceView(history, [KING]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(0);
    expect(store.drawReveal).toBeNull();
  });
});
