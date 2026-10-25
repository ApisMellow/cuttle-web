// Learn to play (R25), design §6.1: a lesson position is one snapshot string
// in the bridge's own format, restored through the existing
// `__cuttleRestore` (SPEC §2.4). Authoring a position is writing, not
// reading: nothing here reads an engine state that came back from the
// bridge (SPEC §3.3).
//
// Engine v0.2.1 shapes this writes:
//   - GameState fields and order: engine/state.go:93-102. Deck index 0 is the
//     top (state.go:95); Scrap's last element is the top (state.go:96).
//   - PlayerState: engine/state.go:54-59. PointEntry: engine/state.go:40-45.
//     No lesson starts with a Jack, so JackStack and JackOwners are null:
//     `[]PlayerID` would marshal as base64 (AGENTS "WASM bridge landmines").
//   - Suit order C < D < H < S: card/card.go:7-12.
//   - The snapshot envelope (ok, v 2, state, history, seed, dealer):
//     internal/game/snapshot.go:80-93. Restore checks shape only
//     (snapshot.go:122-153, bridge.go:309-379), so card uniqueness is the
//     tests' job (design §11 S2).

import type { Card, Rank, Suit } from '../bridge/schema';
import type { LessonPosition, SuitLetter } from './types';

const SUIT: Record<SuitLetter, Suit> = { C: 0, D: 1, H: 2, S: 3 };

/** A card by rank and suit initial: `c(9, 'D')` is the nine of diamonds. */
export function c(rank: Rank, suit: SuitLetter): Card {
  return { Rank: rank, Suit: SUIT[suit] };
}

const cardKey = (x: Card) => `${x.Rank}:${x.Suit}`;

/** Every card in canonical order: clubs A–K, then diamonds, hearts, spades. */
function canonicalDeck(): Card[] {
  const out: Card[] = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 1; rank <= 13; rank++) out.push({ Rank: rank as Rank, Suit: suit as Suit });
  }
  return out;
}

function namedCards(pos: LessonPosition): Card[] {
  return [...pos.aliceHand, ...pos.alicePoints, ...pos.blakeHand, ...pos.blakePoints, ...pos.scrap, ...pos.deckTop];
}

/** The full deck: the named top cards, then every unnamed card in canonical order. */
function deckOf(pos: LessonPosition): Card[] {
  const named = new Set(namedCards(pos).map(cardKey));
  return [...pos.deckTop, ...canonicalDeck().filter((x) => !named.has(cardKey(x)))];
}

/** All 52 cards of the position: hands, points, scrap and the filled deck. */
export function positionCards(pos: LessonPosition): Card[] {
  return [...pos.aliceHand, ...pos.alicePoints, ...pos.blakeHand, ...pos.blakePoints, ...pos.scrap, ...deckOf(pos)];
}

const copy = (x: Card): Card => ({ Rank: x.Rank, Suit: x.Suit });

function points(cards: Card[], owner: 0 | 1) {
  return cards.map((x) => ({ Card: copy(x), Owner: owner, JackStack: null, JackOwners: null }));
}

/**
 * The bridge snapshot JSON for a lesson start: Alice (seat 0) to move,
 * phase 0, no pending one-off, no winner, empty history, seed "0", dealer 1.
 */
export function positionSnapshot(pos: LessonPosition): string {
  return JSON.stringify({
    ok: true,
    v: 2,
    state: {
      Players: [
        { Hand: pos.aliceHand.map(copy), Points: points(pos.alicePoints, 0), Permanents: null, FrozenIDs: null },
        { Hand: pos.blakeHand.map(copy), Points: points(pos.blakePoints, 1), Permanents: null, FrozenIDs: null },
      ],
      Deck: deckOf(pos),
      Scrap: pos.scrap.map(copy),
      Active: 0,
      Phase: 0,
      Pending: null,
      PassesInARow: 0,
      Winner: null,
    },
    history: [],
    seed: '0',
    dealer: 1,
  });
}
