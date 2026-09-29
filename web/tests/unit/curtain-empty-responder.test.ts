// No synthetic ack for a responder who holds no cards (SPEC §4.3 "An empty
// hand needs no disguise", ruling 2026-09-29; §4.4). Strict tier: R14 privacy
// and save/resume.
//
// Playtest finding: a "Let it resolve" prompt appeared for a player holding
// 0 cards. The synthetic ack exists only to hide whether the responder held
// a 2 (§4.3). Hand counts are public, so when the responder holds no cards
// the acting player already knows there was no 2; skipping the ack reveals
// nothing.
//
// The decision reads one public count: the responder's hand size in the
// post-apply state (the mover's `opponent.handCount` live; the responder's
// own hand, or the mover's `opponent.handCount`, on restore). No one-off
// takes a card from the responder's hand between the counter check and the
// post state (engine v0.2.0 `engine/apply.go` resolveOneOffWith: the 3, the
// 5 and the 9 only append to a hand; the 4 opens a discard decision instead),
// so an empty hand after the move means an empty hand when the window would
// have opened. The reverse (empty before, a card after, e.g. a 9 sending a
// card home) keeps the ack: safe, since no 2 was possible either way.

import { describe, expect, it, vi } from 'vitest';

import type { AppliedMove, MoveKind, Phase, PlayerId } from '../../src/lib/bridge/schema';
import { advance, next } from '../../src/lib/stores/curtain.svelte';
import type { CurtainContext, CurtainState, CurtainView } from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { Kind, Phase as P, appliedMove, createFakeEngine, envelope, fakeStorage, playerView } from './game-test-support';

const Normal: Phase = 0;
const AwaitingCounter: Phase = 1;
const SevenChoosing: Phase = 2;
const OneOff: MoveKind = 4;
const Counter: MoveKind = 5;
const SevenPick: MoveKind = 7;
const A: PlayerId = 0;
const O: PlayerId = 1;

function mv(kind: MoveKind, by: PlayerId = A, subKind: MoveKind | null = null): AppliedMove {
  return appliedMove({ by, kind, seq: 3, card: { Rank: kind === Counter ? 2 : 9, Suit: 0 }, subKind });
}

const cv = (active: PlayerId, phase: Phase): CurtainView => ({ active, phase });

function walk(pre: CurtainView, m: AppliedMove, post: CurtainView, responderHandEmpty: boolean, recap: AppliedMove[] = []): CurtainState[] {
  const c: CurtainContext = { pre, move: m, post, responderHandEmpty, recapFor: () => recap };
  const states: CurtainState[] = [next(pre, m, post, responderHandEmpty)];
  for (let i = 0; i < 12; i++) {
    const s = states[states.length - 1];
    if (s.kind === 'none' || s.kind === 'result' || (s.kind === 'ack' && !s.synthetic)) return states;
    states.push(advance(s, c));
  }
  throw new Error('did not terminate');
}

describe('pure machine: an empty-handed responder gets no synthetic ack', () => {
  const rows: Array<{ name: string; pre: CurtainView; m: AppliedMove; post: CurtainView; withCards: CurtainState[]; empty: CurtainState[] }> = [
    {
      name: 'a one-off; the turn passes to the responder',
      pre: cv(A, Normal), m: mv(OneOff), post: cv(O, Normal),
      withCards: [{ kind: 'handoff', to: O, reason: 'acknowledge' }, { kind: 'reveal', to: O }, { kind: 'ack', to: O, synthetic: true }, { kind: 'none' }],
      empty: [{ kind: 'handoff', to: O, reason: 'turn' }, { kind: 'reveal', to: O }, { kind: 'none' }],
    },
    {
      name: 'a 7: no round trip, the actor stays for the reveal',
      pre: cv(A, Normal), m: mv(OneOff), post: cv(A, SevenChoosing),
      withCards: [{ kind: 'handoff', to: O, reason: 'acknowledge' }, { kind: 'reveal', to: O }, { kind: 'ack', to: O, synthetic: true }, { kind: 'handoff', to: A, reason: 'seven-return' }, { kind: 'reveal', to: A }, { kind: 'none' }],
      empty: [{ kind: 'none' }],
    },
    {
      name: 'a one-off through a 7 (SevenPick wrapping OneOff)',
      pre: cv(A, SevenChoosing), m: mv(SevenPick, A, OneOff), post: cv(O, Normal),
      withCards: [{ kind: 'handoff', to: O, reason: 'acknowledge' }, { kind: 'reveal', to: O }, { kind: 'ack', to: O, synthetic: true }, { kind: 'none' }],
      empty: [{ kind: 'handoff', to: O, reason: 'turn' }, { kind: 'reveal', to: O }, { kind: 'none' }],
    },
    {
      name: 'a counter the original player cannot answer, chain cancelled: the counterer plays on',
      pre: cv(O, AwaitingCounter), m: mv(Counter, O), post: cv(O, Normal),
      withCards: [{ kind: 'handoff', to: A, reason: 'acknowledge' }, { kind: 'reveal', to: A }, { kind: 'ack', to: A, synthetic: true }, { kind: 'handoff', to: O, reason: 'turn' }, { kind: 'reveal', to: O }, { kind: 'none' }],
      empty: [{ kind: 'none' }],
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      expect(walk(r.pre, r.m, r.post, false)).toEqual(r.withCards);
      expect(walk(r.pre, r.m, r.post, true)).toEqual(r.empty);
    });
  }

  it('the flag defaults to false: three-argument next() still stages the ack', () => {
    expect(next(cv(A, Normal), mv(OneOff), cv(O, Normal))).toEqual({ kind: 'handoff', to: O, reason: 'acknowledge' });
  });

  it('a real window is unaffected (the engine opens one only for a 2, so never for an empty hand)', () => {
    expect(walk(cv(A, Normal), mv(OneOff), cv(O, AwaitingCounter), false)).toEqual(walk(cv(A, Normal), mv(OneOff), cv(O, AwaitingCounter), true));
  });

  it('the recap still shows the one-off to the empty-handed responder', () => {
    const entry = mv(OneOff);
    const seq = walk(cv(A, Normal), entry, cv(O, Normal), true, [entry]);
    expect(seq).toEqual([{ kind: 'handoff', to: O, reason: 'turn' }, { kind: 'reveal', to: O }, { kind: 'recap', to: O, entries: [entry] }, { kind: 'none' }]);
  });
});

describe('store: the decision is read from public counts, live and on restore, and they agree', () => {
  const oneOffPublic = appliedMove({ by: A, kind: Kind.OneOff, seq: 1, card: { Rank: 1, Suit: 0 } });
  const oneOff = { ...oneOffPublic, index: 0 };

  /** Alice's apply result: the responder (Blake) holds `blakeCards` cards afterwards. */
  function moverResult(blakeCards: number) {
    return envelope({
      state: playerView({ viewer: A, active: O, phase: P.Normal, opponent: { handCount: blakeCards, hand: null, points: [], permanents: [] } }),
      lastMove: oneOff,
      history: [oneOff],
      seq: 1,
    });
  }

  function blakeView(cards: number) {
    return envelope({
      state: playerView({ viewer: O, active: O, phase: P.Normal, you: { hand: Array.from({ length: cards }, () => ({ Rank: 6, Suit: 1 })), frozenHandIndices: [], points: [], permanents: [], watched: false } }),
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
      apply: () => moverResult(blakeCards),
    });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '9' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    expect(store.viewer).toBe(A);
    return { store, storage, engine };
  }

  async function walkStore(store: GameStore): Promise<string[]> {
    const seen = [store.curtain.kind + ('synthetic' in store.curtain ? ':synthetic' : '')];
    for (let i = 0; i < 8 && store.curtain.kind !== 'none'; i++) {
      await store.advanceCurtain();
      seen.push(store.curtain.kind + ('synthetic' in store.curtain ? ':synthetic' : ''));
    }
    return seen;
  }

  it('live: Blake holds no cards -> turn handoff, recap, board; no ack', async () => {
    const { store } = await aliceAtBoard(0);
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'turn' });
    expect(await walkStore(store)).toEqual(['handoff', 'reveal', 'recap', 'none']);
    expect(store.viewer).toBe(O);
  });

  it('live: Blake holds cards -> the synthetic ack is still staged', async () => {
    const { store } = await aliceAtBoard(3);
    await store.apply(0);
    expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'acknowledge' });
    expect(await walkStore(store)).toEqual(['handoff', 'reveal', 'recap', 'ack:synthetic', 'none']);
  });

  for (const cards of [0, 3]) {
    for (const stopAt of ['handoff', 'reveal', 'recap'] as const) {
      it(`restore at ${stopAt} (Blake holds ${cards}) walks the same sequence as the live game`, async () => {
        const live = await aliceAtBoard(cards);
        await live.store.apply(0);
        const reloadedFrom = async (): Promise<string[]> => {
          const engine = createFakeEngine({ restore: () => blakeView(cards), view: () => blakeView(cards) });
          const reloaded = new GameStore({ engine, storage: live.storage, session: new SessionStore() });
          await reloaded.restore();
          return walkStore(reloaded);
        };
        const fullLive = await (async () => {
          const again = await aliceAtBoard(cards);
          await again.store.apply(0);
          return walkStore(again.store);
        })();
        // Advance the live store to the stop point, then reload from its save.
        while (live.store.curtain.kind !== stopAt) await live.store.advanceCurtain();
        expect(JSON.parse(live.storage.getItem(SNAPSHOT_KEY) as string).curtain.kind).toBe(stopAt);
        const tail = await reloadedFrom();
        expect(tail).toEqual(fullLive.slice(fullLive.indexOf(stopAt)));
      });
    }
  }
});

// Review N1: a cancelled chain where the counterer played their last card.
// Blake (1) played a one-off; Alice (0) counters with her only card; Blake
// holds cards but no 2, so the chain cancels (engine v0.2.0 resolvePending:
// Active = PlayedBy, then endTurn, so Active is Alice). The responder is
// Blake, and he holds cards: live and restored games must both stage the
// synthetic ack for him, although the engine's Active player (Alice) holds
// none. Keying the flag on the engine's Active seat would skip it on restore.
describe('store: cancelled chain, the counterer holds no cards, the responder does', () => {
  const oneOff = appliedMove({ by: O, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 } });
  const counter = appliedMove({ by: A, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 1 } });
  const TWO = { Rank: 2 as const, Suit: 1 as const };
  const DECLINE = { Kind: Kind.Decline, Card: null, HandIndex: -1, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null };

  /** After the counter: Active = Alice, Normal. Alice holds 0 cards, Blake 3. */
  function after(viewer: PlayerId) {
    return envelope({
      state: playerView({
        viewer,
        active: A,
        phase: P.Normal,
        you: { hand: viewer === O ? [{ Rank: 6, Suit: 0 }, { Rank: 7, Suit: 0 }, { Rank: 8, Suit: 0 }] : [], frozenHandIndices: [], points: [], permanents: [], watched: false },
        opponent: { handCount: viewer === O ? 0 : 3, hand: null, points: [], permanents: [] },
      }),
      history: [oneOff, counter],
      seq: 2,
    });
  }

  async function aliceCounters() {
    const storage = fakeStorage();
    let countered = false;
    const window = envelope({
      state: playerView({ viewer: A, active: A, phase: P.AwaitingCounter, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false }, opponent: { handCount: 3, hand: null, points: [], permanents: [] } }),
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
        return { ...after(A), lastMove: counter };
      },
    });
    const store = new GameStore({ engine, storage, session: new SessionStore() });
    await store.newGame({ seed: '3' });
    for (let i = 0; i < 4 && store.curtain.kind !== 'ack'; i++) await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: A, synthetic: false });
    await store.apply(1);
    return { store, storage };
  }

  async function walkStore(store: GameStore): Promise<string[]> {
    const label = () => store.curtain.kind + ('to' in store.curtain ? `:${store.curtain.to}` : '');
    const seen = [label()];
    for (let i = 0; i < 10 && store.curtain.kind !== 'none'; i++) {
      await store.advanceCurtain();
      seen.push(label());
    }
    return seen;
  }

  it('live: the ack is staged for Blake, then the phone goes back to Alice', async () => {
    const { store } = await aliceCounters();
    expect(store.curtain).toEqual({ kind: 'handoff', to: O, reason: 'acknowledge' });
    const seen = await walkStore(store);
    expect(seen).toContain('ack:1');
    expect(seen.at(-1)).toBe('none');
  });

  for (const stopAt of ['handoff', 'reveal', 'recap'] as const) {
    it(`restore at ${stopAt}: the same sequence as the live game, ack included`, async () => {
      const full = await walkStore((await aliceCounters()).store);
      const live = await aliceCounters();
      while (live.store.curtain.kind !== stopAt) await live.store.advanceCurtain();
      const engine = createFakeEngine({ restore: vi.fn((_s: string, v: PlayerId) => after(v)), view: vi.fn((p: PlayerId) => after(p)) });
      const reloaded = new GameStore({ engine, storage: live.storage, session: new SessionStore() });
      await reloaded.restore();
      expect(reloaded.curtain.kind).toBe(stopAt);
      const tail = await walkStore(reloaded);
      expect(tail).toEqual(full.slice(full.findIndex((s) => s.startsWith(stopAt))));
      expect(tail).toContain('ack:1');
    });
  }
});
