// R25.2 (docs/tutorial-plan.md T3, design §11 S2): every lesson position is
// a valid engine state, through the real wasm bridge.
//
// Engine v0.2.1 facts this file relies on:
//   - GameState field set and order: engine/state.go:93-102; Deck index 0 is
//     the top (state.go:95), Scrap's last element is the top (state.go:96).
//   - PlayerState fields: engine/state.go:54-59; PointEntry fields:
//     engine/state.go:40-45. A point entry with no Jack has an empty
//     JackStack/JackOwners, so `null` is the authored form.
//   - Suit order C < D < H < S: card/card.go:7-12. Ranks A=1 … K=13:
//     card/card.go:20-34.
//   - Restore checks shape only, never rules or card uniqueness:
//     internal/game/snapshot.go:122-153 (decodeSnapshot) and
//     internal/game/bridge.go:309-379 (validateState). So the 52-unique check
//     lives here.
import { beforeAll, describe, expect, it } from 'vitest';

import { restore } from '../../src/lib/bridge/engine';
import type { Card, Envelope } from '../../src/lib/bridge/schema';
import { LESSONS } from '../../src/lib/tutorial/lessons';
import { c, positionCards, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonId, SuitLetter } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';

beforeAll(async () => {
  await createWasmEngine();
});

const SUITS: Record<SuitLetter, Card['Suit']> = { C: 0, D: 1, H: 2, S: 3 };
const RANKS: Record<string, Card['Rank']> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};

/** "9D" → nine of diamonds; independent of `c()` on purpose. */
function parse(name: string): Card {
  const suit = name.slice(-1) as SuitLetter;
  return { Rank: RANKS[name.slice(0, -1)], Suit: SUITS[suit] };
}
const cards = (names: string): Card[] => (names ? names.split(' ').map(parse) : []);
const key = (x: Card) => `${x.Rank}:${x.Suit}`;

/** Design §5.2–§5.6, transcribed independently of lessons.ts. */
const DESIGN: Record<LessonId, { aliceHand: string; alicePoints: string; blakeHand: string; blakePoints: string; scrap: string; deckTop: string; deck: number }> = {
  1: { aliceHand: '9D 4S 2C', alicePoints: '7H 5C', blakeHand: '3D 6S JC QD 8H', blakePoints: '10S', scrap: 'KC 4H', deckTop: '', deck: 39 },
  2: { aliceHand: '7C 3D', alicePoints: '5S', blakeHand: '6D AC 9S QH 4C', blakePoints: '4H', scrap: '', deckTop: '10D 8S', deck: 43 },
  3: { aliceHand: '10H 8H 4C', alicePoints: '6S', blakeHand: '8C 5D JH 3S', blakePoints: '9D 6C', scrap: 'QC 2S', deckTop: '', deck: 40 },
  4: { aliceHand: 'AS 2H 5C', alicePoints: '3D', blakeHand: '4D 7S KC 9C', blakePoints: '10C 9H', scrap: 'JD 6H', deckTop: '', deck: 40 },
  5: { aliceHand: 'JD JS 8C KH', alicePoints: '8S', blakeHand: 'QS 5H 3C 6D', blakePoints: '7D 3H', scrap: '2D 4S', deckTop: 'AD', deck: 39 },
};

describe('c()', () => {
  it('builds numeric cards from rank and suit letter', () => {
    expect(c(9, 'D')).toEqual({ Rank: 9, Suit: 1 });
    expect(c(1, 'C')).toEqual({ Rank: 1, Suit: 0 });
    expect(c(12, 'H')).toEqual({ Rank: 12, Suit: 2 });
    expect(c(13, 'S')).toEqual({ Rank: 13, Suit: 3 });
  });
});

describe('LESSONS', () => {
  it('holds lessons 1 to 5 in order', () => {
    expect(LESSONS.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

interface SnapshotShape {
  ok: boolean;
  v: number;
  state: {
    Players: { Hand: Card[]; Points: { Card: Card; Owner: number; JackStack: null; JackOwners: null }[]; Permanents: null; FrozenIDs: null }[];
    Deck: Card[];
    Scrap: Card[];
    Active: number;
    Phase: number;
    Pending: null;
    PassesInARow: number;
    Winner: null;
  };
  history: unknown[];
  seed: string;
  dealer: number;
}

for (const id of [1, 2, 3, 4, 5] as const) {
  describe(`S2 lesson ${id}: the position is valid`, () => {
    const lesson = () => {
      const found = LESSONS.find((l) => l.id === id);
      if (!found) throw new Error(`lesson ${id} missing`);
      return found;
    };
    const d = DESIGN[id];

    it('is the design position', () => {
      const pos = lesson().position;
      expect(pos.aliceHand).toEqual(cards(d.aliceHand));
      expect(pos.alicePoints).toEqual(cards(d.alicePoints));
      expect(pos.blakeHand).toEqual(cards(d.blakeHand));
      expect(pos.blakePoints).toEqual(cards(d.blakePoints));
      expect(pos.scrap).toEqual(cards(d.scrap));
      expect(pos.deckTop).toEqual(cards(d.deckTop));
    });

    it('positionCards holds all 52 cards, each once', () => {
      const all = positionCards(lesson().position);
      expect(all).toHaveLength(52);
      expect(new Set(all.map(key)).size).toBe(52);
    });

    it('the snapshot is the bridge format with an authored, structurally plain state', () => {
      const pos = lesson().position;
      const snap = JSON.parse(positionSnapshot(pos)) as SnapshotShape;
      expect(Object.keys(snap)).toEqual(['ok', 'v', 'state', 'history', 'seed', 'dealer']);
      expect(snap).toMatchObject({ ok: true, v: 2, history: [], seed: '0', dealer: 1 });
      const s = snap.state;
      expect(Object.keys(s)).toEqual(['Players', 'Deck', 'Scrap', 'Active', 'Phase', 'Pending', 'PassesInARow', 'Winner']);
      expect(s).toMatchObject({ Active: 0, Phase: 0, Pending: null, PassesInARow: 0, Winner: null });
      expect(s.Players).toHaveLength(2);
      const [alice, blake] = s.Players;
      expect(alice.Hand).toEqual(pos.aliceHand);
      expect(blake.Hand).toEqual(pos.blakeHand);
      expect(alice.Points.map((p) => p.Card)).toEqual(pos.alicePoints);
      expect(blake.Points.map((p) => p.Card)).toEqual(pos.blakePoints);
      for (const [seat, player] of s.Players.entries()) {
        expect(Object.keys(player)).toEqual(['Hand', 'Points', 'Permanents', 'FrozenIDs']);
        expect(player.Permanents).toBeNull();
        expect(player.FrozenIDs).toBeNull();
        for (const p of player.Points) {
          expect(p).toEqual({ Card: p.Card, Owner: seat, JackStack: null, JackOwners: null });
        }
      }
      expect(s.Scrap).toEqual(pos.scrap);
      expect(s.Deck).toHaveLength(d.deck);
      expect(s.Deck.slice(0, pos.deckTop.length)).toEqual(pos.deckTop);

      // Every unnamed card follows the named top cards in canonical order:
      // clubs A–K, then diamonds, hearts, spades.
      const rest = s.Deck.slice(pos.deckTop.length);
      const order = (x: Card) => x.Suit * 13 + x.Rank;
      expect(rest.map(order)).toEqual([...rest.map(order)].sort((a, b) => a - b));

      // The snapshot itself carries all 52 cards once.
      const inSnap = [...alice.Hand, ...blake.Hand, ...alice.Points.map((p) => p.Card), ...blake.Points.map((p) => p.Card), ...s.Scrap, ...s.Deck];
      expect(inSnap).toHaveLength(52);
      expect(new Set(inSnap.map(key)).size).toBe(52);
    });

    it('restores through the real bridge: Alice to move, phase 0, empty history, the design deck count', () => {
      const pos = lesson().position;
      const res = restore(positionSnapshot(pos), 0);
      expect(res.ok).toBe(true);
      const env = res as Envelope;
      expect(env.state.viewer).toBe(0);
      expect(env.state.active).toBe(0);
      expect(env.state.phase).toBe(0);
      expect(env.state.winner).toBeNull();
      expect(env.history).toEqual([]);
      expect(env.seq).toBe(0);
      expect(env.state.deckCount).toBe(d.deck);
      expect(env.state.you.hand).toEqual(pos.aliceHand);
      expect(env.state.you.points.map((p) => p.Card)).toEqual(pos.alicePoints);
      expect(env.state.you.permanents).toEqual([]);
      expect(env.state.you.frozenHandIndices).toEqual([]);
      expect(env.state.opponent.handCount).toBe(pos.blakeHand.length);
      expect(env.state.opponent.hand).toBeNull();
      expect(env.state.opponent.points.map((p) => p.Card)).toEqual(pos.blakePoints);
      expect(env.state.scrap).toEqual(pos.scrap);
      expect(env.legalMoves.length).toBeGreaterThan(0);
    });
  });
}
