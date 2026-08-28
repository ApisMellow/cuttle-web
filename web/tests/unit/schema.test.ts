import { describe, expect, it } from 'vitest';

import { parseBridgeResult } from '../../src/lib/bridge/schema';

function envelope() {
  return {
    ok: true,
    state: {
      viewer: 0,
      active: 0,
      phase: 0,
      passesInARow: 0,
      winner: null,
      stalemate: false,
      you: { hand: [], frozenHandIndices: [], points: [], permanents: [] },
      opponent: { handCount: 0, hand: null, points: [], permanents: [] },
      deckCount: 41,
      scrap: [],
      scoreboard: {
        you: { points: 0, threshold: 21, kings: 0, hasWon: false },
        opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
      },
      sevenRevealed: null,
      pending: null,
    },
    legalMoves: [],
    descriptions: [],
    lastMove: null,
    history: [],
    seq: 0,
  };
}

describe('parseBridgeResult', () => {
  it('accepts a normalized redacted envelope', () => {
    expect(parseBridgeResult(JSON.stringify(envelope()))).toEqual(envelope());
  });

  it('rejects raw JackOwners base64 and nil array values', () => {
    const rawJackOwners = envelope();
    rawJackOwners.state.you.points = [{
      Card: { Rank: 10, Suit: 2 },
      Owner: 0,
      JackStack: [{ Rank: 11, Suit: 0 }],
      JackOwners: 'AQA=',
      Controller: 0,
    }] as never;
    expect(() => parseBridgeResult(JSON.stringify(rawJackOwners))).toThrow(/JackOwners/);

    const nilHand = envelope();
    nilHand.state.you.hand = null as never;
    expect(() => parseBridgeResult(JSON.stringify(nilHand))).toThrow(/state.you.hand/);
  });

  it('rejects any full deck field crossing the view boundary', () => {
    const leaked = envelope() as ReturnType<typeof envelope> & { state: { deck?: unknown[] } };
    leaked.state.deck = [{ Rank: 13, Suit: 3 }];
    expect(() => parseBridgeResult(JSON.stringify(leaked))).toThrow(/deck contents/);
  });

  it('preserves hidden null versus visible empty opponent hands', () => {
    const hidden = parseBridgeResult(JSON.stringify(envelope()));
    expect(hidden.ok && hidden.state.opponent.hand).toBeNull();

    const visible = envelope();
    visible.state.opponent.hand = [];
    const parsed = parseBridgeResult(JSON.stringify(visible));
    expect(parsed.ok && parsed.state.opponent.hand).toEqual([]);
  });
});
