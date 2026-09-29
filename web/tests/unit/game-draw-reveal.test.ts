// Issue #27 — the 5's draw reveal, store half (GameStore, SPEC §4.7).
//
// Strict tier (hidden-information privacy + save/resume). Alice (P0) plays
// a 5; the two cards she draws are shown face up on HER screen only:
//   - before the pass, when her own apply resolved the 5 and no curtain has
//     to hide whether Blake could answer (Blake holds no cards, §4.3);
//   - otherwise at her next board, once the 5 has resolved (after Blake's
//     synthetic ack or his Decline) and she holds the phone again.
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
// Before the pass: Alice's own apply resolved the 5 and Blake holds no cards
// ---------------------------------------------------------------------------

/** Alice plays the 5; Blake holds 0 cards, so there is no ack (§4.3) and the turn handoff follows. */
async function playFiveBlakeEmpty() {
  const ctx = setup();
  await startGame(ctx.store, ctx.engine, { seed: '7' });
  const played = fiveEntry(1, 2, true);
  ctx.engine.apply = vi.fn(() =>
    envelope({
      state: playerView({ viewer: 0, active: 1, you: you([KING, D1, D2]), opponent: opp(0) }),
      lastMove: played,
      history: [played],
    }),
  );
  await ctx.store.apply(0);
  return ctx;
}

describe('before the pass: the drawer sees the draw on their own screen, then the handoff', () => {
  it('the reveal comes up on the mover\'s own board, naming the last `drawn` hand indices', async () => {
    const { store } = await playFiveBlakeEmpty();
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: true });
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.envelope?.state.viewer).toBe(0);
    expect(store.legalMoves).toEqual([]);
  });

  it('the save already holds the handoff to Blake, never the reveal (a reload mid-reveal comes back to the pass)', async () => {
    const { storage } = await playFiveBlakeEmpty();
    const snap = saved(storage);
    expect(Object.keys(snap).sort()).toEqual(SNAPSHOT_KEYS);
    expect(snap.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(snap.viewer).toBe(1);
    for (const h of snap.history as AppliedMove[]) expect(Object.prototype.hasOwnProperty.call(h, 'index')).toBe(false);
    expect(mentionsDrawn(JSON.stringify({ ...snap, engineState: '' }))).toBe(false);
  });

  it('continuing raises the handoff: no envelope, no viewer, no reveal, no mover-only index', async () => {
    const { store, storage } = await playFiveBlakeEmpty();
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
    const { store, engine } = await playFiveBlakeEmpty();
    store.dismissDrawReveal();
    store.dismissDrawReveal();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(engine.view).not.toHaveBeenCalled();
  });

  it('while the reveal is up nothing else moves: apply, refresh and advanceCurtain all refuse', async () => {
    const { store, engine, storage } = await playFiveBlakeEmpty();
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
    const { store, engine } = await playFiveBlakeEmpty();
    store.dismissDrawReveal();
    engine.view = vi.fn((p: PlayerId) => (p === 1 ? blakeView([fiveEntry(1, 2, false)], { opponent: opp(3), you: you([]) }) : aliceOpening()));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(1);
    expect(store.drawReveal).toBeNull();
  });

  it('and Alice is not shown the same draw again at her next board', async () => {
    const { store, engine } = await playFiveBlakeEmpty();
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

  it('Home mid-reveal drops it; Resume comes back to the handoff to Blake, with no reveal', async () => {
    const { store, storage, session, engine } = await playFiveBlakeEmpty();
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
    const { store } = await playFiveBlakeEmpty();
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
// After resolution: the synthetic ack and the real counter window (R14)
// ---------------------------------------------------------------------------

/** Alice plays the 5; Blake holds cards but no 2, so the engine resolves it and a synthetic ack is staged. */
async function playFiveSynthetic() {
  const ctx = setup();
  await startGame(ctx.store, ctx.engine, { seed: '7' });
  const played = fiveEntry(1, 2, true);
  ctx.engine.apply = vi.fn(() =>
    envelope({ state: playerView({ viewer: 0, active: 1, you: you([KING, D1, D2]), opponent: opp(3) }), lastMove: played, history: [played] }),
  );
  await ctx.store.apply(0);
  return ctx;
}

/** Blake's side after the 5, up to his board, then his Draw handing the phone back to Alice. */
async function blakeTurnThenBack(store: GameStore, engine: ReturnType<typeof createFakeEngine>, history: AppliedMove[], seq: number) {
  engine.view = vi.fn(() => blakeView(history, {}, [mv({ Kind: Kind.Draw })], ['draw a card']));
  const blakeSeen: (typeof store.drawReveal)[] = [];
  for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) {
    await store.advanceCurtain();
    blakeSeen.push(store.drawReveal);
  }
  expect(store.viewer).toBe(1);
  blakeSeen.push(store.drawReveal);
  const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq, index: 0 });
  const next = [...history, blakeDraw];
  engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history: next }));
  await store.apply(0);
  blakeSeen.push(store.drawReveal);
  return { blakeSeen, next };
}

describe('after resolution, synthetic path: the reveal waits for Alice\'s next board', () => {
  it('no reveal before the pass: the ack handoff comes up at once, with nothing held', async () => {
    const { store } = await playFiveSynthetic();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'acknowledge' });
    expect(store.envelope).toBeNull();
  });

  it('Blake acks, plays, and passes back: no reveal at any step of his; then Alice\'s board reveals the draw', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { blakeSeen, next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    expect(blakeSeen.every((r) => r === null)).toBe(true);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.viewer).toBe(0);
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('continuing leaves Alice on her own board, curtain none, able to play', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    store.dismissDrawReveal();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.legalMoves.length).toBe(1);
  });

  it('the reveal is shown once: a refresh after it does not bring it back', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    store.dismissDrawReveal();
    await store.refresh();
    expect(store.drawReveal).toBeNull();
  });

  it('a card Blake\'s 9 sent back to Alice (frozen, at the end of her hand) is not taken for a drawn one', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2, RETURNED], { you: you([KING, D1, D2, RETURNED], [3]) }));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('Alice\'s first board is a 4\'s discard: the draw is the end of her hand, a stale freeze there is ignored', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    engine.view = vi.fn(() =>
      aliceView(next, [KING, D1, D2], { phase: Phase.AwaitingDiscard, you: you([KING, D1, D2], [2]) }),
    );
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('while the reveal is up Alice cannot move until she continues', async () => {
    const { store, engine } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    const applies = (engine.apply as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(store.apply(0)).rejects.toThrow(/reveal/i);
    expect((engine.apply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(applies);
  });

  it('a reload before Alice\'s board still shows her the draw there (the save holds no reveal state)', async () => {
    const { store, engine, storage, session } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
    expect(store.curtain.kind).toBe('handoff');
    const again = new GameStore({ engine, storage, session });
    engine.restore = vi.fn(() => aliceView(next, [KING, D1, D2]));
    engine.view = vi.fn(() => aliceView(next, [KING, D1, D2]));
    await again.restore();
    expect(again.drawReveal).toBeNull();
    await walk(again, () => again.curtain.kind === 'none');
    expect(again.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('a reload at Alice\'s board after she saw the draw does not show it again', async () => {
    const { store, engine, storage, session } = await playFiveSynthetic();
    const { next } = await blakeTurnThenBack(store, engine, [fiveEntry(1, 2, false)], 2);
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

describe('after resolution: Blake\'s turn ends in a one-off, so Alice\'s first own view is an ack', () => {
  // Blake plays a 6 as a one-off after acking Alice's 5. Alice's first own
  // view is then the ack for it: a real window if she holds a 2, a synthetic
  // ack if not. The reveal comes first on BOTH (R14: same step, same state),
  // before a counter could take a drawn 2 out of her hand.
  async function toAliceAck(real: boolean) {
    const { store, engine } = await playFiveSynthetic();
    const five = fiveEntry(1, 2, false);
    engine.view = vi.fn(() => blakeView([five], {}, [mv({ Kind: Kind.OneOff, Card: { Rank: 6, Suit: 0 } })], ['play 6♣ as one-off']));
    await walk(store, () => store.curtain.kind === 'none');
    const sixFields = { by: 1, kind: Kind.OneOff, seq: 2, card: { Rank: 6, Suit: 0 }, description: 'play 6♣ as one-off' } as const;
    const six = appliedMove({ ...sixFields, index: 0 });
    const history = [five, appliedMove(sixFields)];
    engine.apply = vi.fn(() =>
      envelope({
        state: playerView({ viewer: 1, active: 0, phase: real ? Phase.AwaitingCounter : Phase.Normal, you: you([B_CARD]), opponent: opp(3) }),
        lastMove: six,
        history: [five, six],
      }),
    );
    await store.apply(0);
    const aliceHand = real ? [KING, D1, { Rank: 2, Suit: 3 } as Card] : [KING, D1, D2];
    engine.view = vi.fn(() =>
      aliceView(history, aliceHand, real ? { phase: Phase.AwaitingCounter, pending: { playedBy: 1, card: { Rank: 6, Suit: 0 }, target: null, counterChain: [] } } : {}),
    );
    await walk(store, () => store.curtain.kind === 'ack');
    return { store, engine };
  }

  for (const real of [true, false]) {
    it(`${real ? 'real window' : 'synthetic ack'}: the reveal is up at the ack, and nothing moves until it is dismissed`, async () => {
      const { store, engine } = await toAliceAck(real);
      expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: !real });
      expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
      const applies = (engine.apply as ReturnType<typeof vi.fn>).mock.calls.length;
      await expect(store.apply(0)).rejects.toThrow(/reveal/i);
      await expect(store.advanceCurtain()).rejects.toThrow(/reveal/i);
      expect((engine.apply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(applies);
      store.dismissDrawReveal();
      expect(store.drawReveal).toBeNull();
      expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: !real });
    });
  }
});

describe('after resolution, real counter window: Blake declines, the draw is Alice\'s', () => {
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

  it('the counter handoff comes up with no reveal (the 5 has not resolved)', async () => {
    const { store } = await playFiveRealWindow();
    expect(store.drawReveal).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'counter' });
  });

  it('Blake\'s Decline resolves the draw on his own apply: his board shows no reveal; Alice\'s next board does', async () => {
    const { store, engine } = await playFiveRealWindow();
    const five = fiveEntry(1, null, false);
    engine.view = vi.fn(() =>
      blakeView([five], { phase: Phase.AwaitingCounter, pending: { playedBy: 0, card: FIVE, target: null, counterChain: [] } }, [mv({ Kind: Kind.Decline })], ['decline']),
    );
    await walk(store, () => store.curtain.kind === 'ack');
    expect(store.drawReveal).toBeNull();
    const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2, index: 0, drawn: 2 });
    engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(3) }), lastMove: decline, history: [five, decline], legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.drawReveal).toBeNull();

    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 3, index: 0 });
    const history = [five, { ...decline, index: undefined }, blakeDraw];
    engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history }));
    await store.apply(0);
    expect(store.drawReveal).toBeNull();
    engine.view = vi.fn(() => aliceView(history, [KING, D1, D2]));
    await walk(store, () => store.curtain.kind === 'none');
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
  });

  it('a cancelled 5 (Blake countered, Alice held no 2) reveals nothing, on any of Alice\'s screens', async () => {
    const { store, engine } = await playFiveRealWindow();
    const five = fiveEntry(1, null, false);
    const counter = appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 } });
    engine.view = vi.fn(() =>
      blakeView([five], { phase: Phase.AwaitingCounter, pending: { playedBy: 0, card: FIVE, target: null, counterChain: [] } }, [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 0 } }), mv({ Kind: Kind.Decline })], ['counter', 'decline']),
    );
    await walk(store, () => store.curtain.kind === 'ack');
    // Alice holds no 2: the engine cancels the 5 at once and the turn passes to Blake.
    engine.apply = vi.fn(() =>
      envelope({ state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(1) }), lastMove: { ...counter, index: 0 }, history: [five, { ...counter, index: 0 }] }),
    );
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'acknowledge' });
    const seen: (typeof store.drawReveal)[] = [];
    engine.view = vi.fn((p: PlayerId) => (p === 0 ? aliceView([five, counter], [KING], { active: 1 }) : blakeView([five, counter], {}, [mv({ Kind: Kind.Draw })], ['draw a card'])));
    for (let i = 0; i < 8 && !(store.curtain.kind === 'none' && store.viewer === 1); i++) {
      await store.advanceCurtain();
      seen.push(store.drawReveal);
    }
    expect(store.viewer).toBe(1);
    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 3, index: 0 });
    const history = [five, counter, blakeDraw];
    engine.apply = vi.fn(() => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(1) }), lastMove: blakeDraw, history }));
    await store.apply(0);
    engine.view = vi.fn(() => aliceView(history, [KING]));
    await walk(store, () => store.curtain.kind === 'none');
    seen.push(store.drawReveal);
    expect(seen.every((r) => r === null)).toBe(true);
  });
});
