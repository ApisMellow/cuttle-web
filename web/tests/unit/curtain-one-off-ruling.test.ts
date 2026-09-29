// Ruling 2026-09-29 (SPEC §4.3, closes #23), store level. Strict tier:
// the curtain flow and save/resume.
//
// A one-off takes effect at once. The opponent gets a chance to answer only
// when they hold a legal 2, which is exactly when the engine opens a
// counter window. With no window there is no acknowledgment step: the move
// is followed like any other resolved move. Supersedes the "empty hand
// needs no disguise" ruling of the same day, which this generalises.
//
// Also: before the counter prompt, the recap drops what the prompt shows,
// and is skipped when nothing else is left.

import { describe, expect, it, vi } from 'vitest';

import type { Envelope, Move, PlayerId } from '../../src/lib/bridge/schema';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { Kind, Phase as P, appliedMove, createFakeEngine, envelope, fakeStorage, passResumeGate, playerView } from './game-test-support';

const A: PlayerId = 0;
const O: PlayerId = 1;

const DECLINE: Move = { Kind: Kind.Decline, Card: null, HandIndex: -1, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null };
const TWO = { Rank: 2 as const, Suit: 1 as const };

function hand(n: number) {
  return Array.from({ length: n }, (_, i) => ({ Rank: (6 + (i % 3)) as 6 | 7 | 8, Suit: 1 as const }));
}

/** What each seat sees, plus a label per step that records who holds the phone. */
async function walkStore(store: GameStore): Promise<string[]> {
  const label = () => store.curtain.kind + ('to' in store.curtain ? `:${store.curtain.to}` : '');
  const seen = [label()];
  for (let i = 0; i < 10 && store.curtain.kind !== 'none' && store.curtain.kind !== 'ack'; i++) {
    await store.advanceCurtain();
    seen.push(label());
  }
  return seen;
}

describe('a one-off the opponent cannot answer (no 2): no ack, the turn simply passes', () => {
  const oneOffPublic = appliedMove({ by: A, kind: Kind.OneOff, seq: 1, card: { Rank: 1, Suit: 0 }, description: 'play A♣ as one-off' });
  const oneOff = { ...oneOffPublic, index: 0 };

  function blakeView(cards: number): Envelope {
    return envelope({
      state: playerView({ viewer: O, active: O, phase: P.Normal, you: { hand: hand(cards), frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      history: [oneOffPublic],
      seq: 1,
    });
  }

  async function aliceAtBoard(blakeCards: number) {
    const storage = fakeStorage();
    const opening = envelope({ state: playerView({ viewer: A, active: A, opponent: { handCount: blakeCards, hand: null, points: [], permanents: [] } }) });
    const engine = createFakeEngine({
      newGame: () => opening,
      view: vi.fn((p: PlayerId) => (p === A ? opening : blakeView(blakeCards))),
      apply: () =>
        envelope({
          state: playerView({ viewer: A, active: O, phase: P.Normal, opponent: { handCount: blakeCards, hand: null, points: [], permanents: [] } }),
          lastMove: oneOff,
          history: [oneOff],
          seq: 1,
        }),
    });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '9' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    expect(store.viewer).toBe(A);
    return { store, storage };
  }

  for (const cards of [0, 3]) {
    it(`live (Blake holds ${cards} cards, no 2): turn handoff, reveal, recap, board; never an ack`, async () => {
      const { store } = await aliceAtBoard(cards);
      await store.apply(0);
      expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'turn' });
      expect(await walkStore(store)).toEqual(['handoff:1', 'reveal:1', 'recap:1', 'none']);
      expect(store.viewer).toBe(O);
    });

    for (const stopAt of ['handoff', 'reveal', 'recap'] as const) {
      it(`restore at ${stopAt} (Blake holds ${cards}) walks the same sequence as the live game`, async () => {
        const full = await (async () => {
          const again = await aliceAtBoard(cards);
          await again.store.apply(0);
          return walkStore(again.store);
        })();
        const live = await aliceAtBoard(cards);
        await live.store.apply(0);
        while (live.store.curtain.kind !== stopAt) await live.store.advanceCurtain();
        expect(JSON.parse(live.storage.getItem(SNAPSHOT_KEY) as string).curtain.kind).toBe(stopAt);
        const engine = createFakeEngine({ restore: () => blakeView(cards), view: () => blakeView(cards) });
        const reloaded = new GameStore({ engine, storage: live.storage, session: new SessionStore() });
        await reloaded.restore();
        const tail = await walkStore(reloaded);
        expect(tail).toEqual(full.slice(full.findIndex((s) => s.startsWith(stopAt))));
      });
    }
  }
});

// Blake (1) played a one-off; Alice (0) counters; Blake holds no 2, so the
// chain cancels at once (engine v0.2.0 resolvePending: Active = PlayedBy,
// then endTurn, so Active is Alice). Alice keeps the phone and plays on.
describe('a counter the original player cannot answer: the counterer plays on, no curtain', () => {
  const oneOff = appliedMove({ by: O, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 }, description: 'play 9♣ as one-off' });
  const counter = appliedMove({ by: A, kind: Kind.Counter, seq: 2, card: TWO, description: 'counter with 2♦' });

  function after(viewer: PlayerId): Envelope {
    return envelope({
      state: playerView({
        viewer,
        active: A,
        phase: P.Normal,
        you: { hand: viewer === O ? hand(3) : hand(1), frozenHandIndices: [], points: [], permanents: [], watched: false },
        opponent: { handCount: viewer === O ? 1 : 3, hand: null, points: [], permanents: [] },
      }),
      legalMoves: viewer === A ? [{ ...DECLINE, Kind: Kind.Draw }] : [],
      descriptions: viewer === A ? ['draw a card'] : [],
      history: viewer === A ? [oneOff, { ...counter, index: 1 }] : [oneOff, counter],
      seq: 2,
    });
  }

  async function aliceCounters() {
    const storage = fakeStorage();
    let countered = false;
    const window = envelope({
      state: playerView({ viewer: A, active: A, phase: P.AwaitingCounter, you: { hand: [TWO, ...hand(1)], frozenHandIndices: [], points: [], permanents: [], watched: false }, opponent: { handCount: 3, hand: null, points: [], permanents: [] } }),
      legalMoves: [DECLINE, { ...DECLINE, Kind: Kind.Counter, Card: TWO, HandIndex: 0 }],
      descriptions: ['decline', 'counter with 2♦'],
      history: [oneOff],
      seq: 1,
    });
    const engine = createFakeEngine({
      newGame: () => window,
      view: vi.fn((p: PlayerId) => (countered ? after(p) : window)),
      apply: () => {
        countered = true;
        return { ...after(A), lastMove: { ...counter, index: 1 } };
      },
    });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '3' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'ack'; i++) await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: A });
    await store.apply(1);
    return { store, storage, engine };
  }

  it('live: no handoff to Blake, Alice stays on her own board with her own moves', async () => {
    const { store, storage } = await aliceCounters();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(A);
    expect(store.envelope?.state.viewer).toBe(A);
    expect(store.legalMoves.length).toBe(1);
    expect(JSON.parse(storage.getItem(SNAPSHOT_KEY) as string).curtain).toEqual({ kind: 'none' });
  });

  it('restore: the resume gate, then Alice\'s board; Blake is never handed the phone', async () => {
    const { storage } = await aliceCounters();
    const engine = createFakeEngine({ restore: vi.fn((_s: string, v: PlayerId) => after(v)), view: vi.fn((p: PlayerId) => after(p)) });
    const reloaded = new GameStore({ engine, storage, session: new SessionStore() });
    await reloaded.restore();
    expect(reloaded.curtain).toEqual({ kind: 'handoff', to: A, reason: 'resume' });
    await passResumeGate(reloaded);
    expect(reloaded.curtain).toEqual({ kind: 'none' });
    expect(reloaded.viewer).toBe(A);
    expect(engine.view).toHaveBeenCalledWith(A);
    expect(engine.view).not.toHaveBeenCalledWith(O);
  });
});

describe('a one-off the opponent can answer (they hold a 2): the counter prompt, with no duplicate recap', () => {
  const oneOffPublic = appliedMove({ by: A, kind: Kind.OneOff, seq: 1, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off' });

  function blakeWindow(history = [oneOffPublic]): Envelope {
    return envelope({
      state: playerView({ viewer: O, active: O, phase: P.AwaitingCounter, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      legalMoves: [DECLINE, { ...DECLINE, Kind: Kind.Counter, Card: TWO, HandIndex: 0 }],
      descriptions: ['decline', 'counter with 2♦'],
      history,
      seq: history.length,
    });
  }

  async function aliceFive(history = [oneOffPublic]) {
    const storage = fakeStorage();
    const opening = envelope({ state: playerView({ viewer: A, active: A }) });
    const last = history[history.length - 1];
    const engine = createFakeEngine({
      newGame: () => opening,
      view: vi.fn((p: PlayerId) => (p === A ? opening : blakeWindow(history))),
      apply: () =>
        envelope({
          state: playerView({ viewer: A, active: O, phase: P.AwaitingCounter, opponent: { handCount: 1, hand: null, points: [], permanents: [] } }),
          lastMove: { ...last, index: 0 },
          history: history.map((h) => (h.by === A ? { ...h, index: 0 } : h)),
          seq: history.length,
        }),
    });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '5' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    return { store, storage };
  }

  it('handoff, reveal, then straight to the prompt: the recap would only repeat the 5', async () => {
    const { store } = await aliceFive();
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'counter' });
    expect(await walkStore(store)).toEqual(['handoff:1', 'reveal:1', 'ack:1']);
    expect(store.legalMoves.some((m) => m.Kind === Kind.Counter)).toBe(true);
  });

  it('a move the prompt does not show (Alice\'s discard before her 5) still gets a recap, without the 5', async () => {
    const discard = appliedMove({ by: A, kind: Kind.DiscardPair, seq: 1, description: 'discard hand[0] and hand[1]' });
    const five = { ...oneOffPublic, seq: 2 };
    const { store } = await aliceFive([discard, five]);
    await store.apply(0);
    await store.advanceCurtain(); // reveal
    await store.advanceCurtain(); // recap
    expect(store.curtain.kind).toBe('recap');
    const entries = store.curtain.kind === 'recap' ? store.curtain.entries : [];
    expect(entries.map((e) => e.kind)).toEqual([Kind.DiscardPair]);
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: O });
  });
});

describe('a save from before the ruling (SPEC §5.7): an old acknowledgment never shows the wrong hand', () => {
  // Alice (0) played a 7 and Blake (1) held no 2: the old client staged a
  // synthetic ack for Blake, then handed the phone back to Alice for the
  // seven panel. The save rests at Blake's ack.
  const seven = appliedMove({ by: A, kind: Kind.OneOff, seq: 1, card: { Rank: 7, Suit: 0 }, description: 'play 7♣ as one-off' });

  function sevenView(viewer: PlayerId): Envelope {
    return envelope({
      state: playerView({ viewer, active: A, phase: P.SevenChoosing }),
      history: [seven],
      seq: 1,
    });
  }

  function oldSave(curtain: object, viewer: PlayerId): string {
    return JSON.stringify({
      v: 2,
      savedAt: '2026-09-28T12:00:00.000Z',
      engineState: '"old"',
      history: [seven],
      lastSeenSeq: { 0: 1, 1: 1 },
      viewer,
      curtain,
      names: ['Alice', 'Blake'],
      seed: '7',
      dealer: 1,
    });
  }

  it('a synthetic ack comes back as Blake\'s reveal; passing it hands the phone to Alice, whose view is fetched only then', async () => {
    const storage = fakeStorage();
    storage.setItem(SNAPSHOT_KEY, oldSave({ kind: 'ack', to: O, synthetic: true }, O));
    const engine = createFakeEngine({ restore: vi.fn((_s: string, v: PlayerId) => sevenView(v)), view: vi.fn((p: PlayerId) => sevenView(p)) });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.restore();
    expect(store.curtain).toEqual({ kind: 'reveal', to: O });
    expect(store.envelope).toBeNull();
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'handoff', to: A, reason: 'seven-return' });
    expect(store.envelope).toBeNull();
    expect(engine.view).not.toHaveBeenCalled();
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(A);
    expect(engine.view).toHaveBeenCalledTimes(1);
    expect(engine.view).toHaveBeenCalledWith(A);
  });

  it('an old "acknowledge" handoff comes back as a turn handoff to the same player', async () => {
    const storage = fakeStorage();
    storage.setItem(SNAPSHOT_KEY, oldSave({ kind: 'handoff', to: O, reason: 'acknowledge' }, O));
    const engine = createFakeEngine({ restore: vi.fn((_s: string, v: PlayerId) => sevenView(v)), view: vi.fn((p: PlayerId) => sevenView(p)) });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.restore();
    expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'turn' });
    await store.advanceCurtain(); // reveal to Blake
    await store.advanceCurtain(); // not his turn: on to Alice
    expect(store.curtain).toEqual({ kind: 'handoff', to: A, reason: 'seven-return' });
    expect(engine.view).not.toHaveBeenCalled();
  });

  it('an old real-window ack (synthetic: false) comes back as the counter window behind the resume gate', async () => {
    const storage = fakeStorage();
    const window = envelope({
      state: playerView({ viewer: O, active: O, phase: P.AwaitingCounter, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      legalMoves: [DECLINE, { ...DECLINE, Kind: Kind.Counter, Card: TWO, HandIndex: 0 }],
      descriptions: ['decline', 'counter with 2♦'],
      history: [seven],
      seq: 1,
    });
    storage.setItem(SNAPSHOT_KEY, oldSave({ kind: 'ack', to: O, synthetic: false }, O));
    const engine = createFakeEngine({ restore: () => window, view: () => window });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.restore();
    await passResumeGate(store);
    expect(store.curtain).toEqual({ kind: 'ack', to: O });
  });
});
