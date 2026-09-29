import { describe, expect, it } from 'vitest';

import { parseBridgeResult } from '../../src/lib/bridge/schema';
import type { Envelope } from '../../src/lib/bridge/schema';

// Explicit return type (not inferred): without it, TS narrows literal
// fields like `opponent.hand: null` to the type `null` instead of
// `Card[] | null`, which then rejects the deliberate reassignment to `[]`
// later in this file (SPEC §2.8b's null-vs-empty distinction, R7.4).
function envelope(): Envelope {
  return {
    ok: true,
    state: {
      viewer: 0,
      active: 0,
      phase: 0,
      passesInARow: 0,
      winner: null,
      stalemate: false,
      you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
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

function appliedMove(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    by: 1,
    kind: 0,
    card: null,
    description: 'draw a card',
    seq: 1,
    subKind: null,
    targetCard: null,
    ...overrides,
  };
}

describe('parseBridgeResult', () => {
  it('SPEC §2.7: accepts a normalized redacted envelope unchanged', () => {
    expect(parseBridgeResult(JSON.stringify(envelope()))).toEqual(envelope());
  });

  it('SPEC §2.8: rejects raw JackOwners base64 and a nil own-hand array', () => {
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

  it('SPEC §3.2: rejects any full deck field crossing the view boundary', () => {
    const leaked = envelope() as ReturnType<typeof envelope> & { state: { deck?: unknown[] } };
    leaked.state.deck = [{ Rank: 13, Suit: 3 }];
    expect(() => parseBridgeResult(JSON.stringify(leaked))).toThrow(/deck contents/);
  });

  it('R7.4: preserves hidden null versus visible empty opponent hands', () => {
    const hidden = parseBridgeResult(JSON.stringify(envelope()));
    expect(hidden.ok && hidden.state.opponent.hand).toBeNull();

    const visible = envelope();
    visible.state.opponent.hand = [];
    const parsed = parseBridgeResult(JSON.stringify(visible));
    expect(parsed.ok && parsed.state.opponent.hand).toEqual([]);
  });

  it('SPEC §3.2 (amended 2026-09-28): you.watched is a required boolean, passed through verbatim', () => {
    const watched = envelope();
    watched.state.you.watched = true;
    const parsed = parseBridgeResult(JSON.stringify(watched));
    expect(parsed.ok && parsed.state.you.watched).toBe(true);

    const missing = envelope() as unknown as { state: { you: Record<string, unknown> } };
    delete missing.state.you.watched;
    expect(() => parseBridgeResult(JSON.stringify(missing))).toThrow(/state.you.watched/);

    const notBool = envelope() as unknown as { state: { you: Record<string, unknown> } };
    notBool.state.you.watched = 1;
    expect(() => parseBridgeResult(JSON.stringify(notBool))).toThrow(/state.you.watched/);
  });

  it('SPEC §2.7 (amended 2026-09-26): AppliedMove.index is optional — omitted for a non-mover, present for the mover', () => {
    const omitted = envelope();
    omitted.lastMove = appliedMove() as never; // no `index` key at all
    omitted.history = [appliedMove() as never];
    omitted.seq = 1;
    const parsedOmitted = parseBridgeResult(JSON.stringify(omitted));
    expect(parsedOmitted.ok).toBe(true);
    if (parsedOmitted.ok) {
      expect(parsedOmitted.lastMove).not.toBeNull();
      expect('index' in (parsedOmitted.lastMove ?? {})).toBe(false);
    }

    const present = envelope();
    present.lastMove = appliedMove({ index: 2 }) as never;
    present.history = [appliedMove({ index: 2 }) as never];
    present.seq = 1;
    const parsedPresent = parseBridgeResult(JSON.stringify(present));
    expect(parsedPresent.ok && parsedPresent.lastMove?.index).toBe(2);
  });

  it('SPEC §2.7 (amended 2026-09-26): AppliedMove.subKind is always present as a key, and nullable', () => {
    const missingKey = envelope();
    const withoutSubKind: Record<string, unknown> = appliedMove();
    delete withoutSubKind.subKind;
    missingKey.lastMove = withoutSubKind as never;
    missingKey.history = [withoutSubKind as never];
    missingKey.seq = 1;
    expect(() => parseBridgeResult(JSON.stringify(missingKey))).toThrow(/subKind/);

    const nullSubKind = envelope();
    nullSubKind.lastMove = appliedMove({ subKind: null }) as never;
    nullSubKind.history = [appliedMove({ subKind: null }) as never];
    nullSubKind.seq = 1;
    const parsedNull = parseBridgeResult(JSON.stringify(nullSubKind));
    expect(parsedNull.ok && parsedNull.lastMove?.subKind).toBeNull();

    const sevenPickSubKind = envelope();
    sevenPickSubKind.lastMove = appliedMove({ kind: 7, subKind: 1 }) as never;
    sevenPickSubKind.history = [appliedMove({ kind: 7, subKind: 1 }) as never];
    sevenPickSubKind.seq = 1;
    const parsedSeven = parseBridgeResult(JSON.stringify(sevenPickSubKind));
    expect(parsedSeven.ok && parsedSeven.lastMove?.subKind).toBe(1);
  });

  it('SPEC §2.7 (amended 2026-09-27): AppliedMove.targetCard is always present as a key, and nullable', () => {
    const missingKey = envelope();
    const withoutTargetCard: Record<string, unknown> = appliedMove();
    delete withoutTargetCard.targetCard;
    missingKey.lastMove = withoutTargetCard as never;
    missingKey.history = [withoutTargetCard as never];
    missingKey.seq = 1;
    expect(() => parseBridgeResult(JSON.stringify(missingKey))).toThrow(/targetCard/);

    const nullTargetCard = envelope();
    nullTargetCard.lastMove = appliedMove({ targetCard: null }) as never;
    nullTargetCard.history = [appliedMove({ targetCard: null }) as never];
    nullTargetCard.seq = 1;
    const parsedNull = parseBridgeResult(JSON.stringify(nullTargetCard));
    expect(parsedNull.ok && parsedNull.lastMove?.targetCard).toBeNull();

    const realTargetCard = envelope();
    const card = { Rank: 10, Suit: 2 };
    realTargetCard.lastMove = appliedMove({ kind: 3, targetCard: card }) as never;
    realTargetCard.history = [appliedMove({ kind: 3, targetCard: card }) as never];
    realTargetCard.seq = 1;
    const parsedCard = parseBridgeResult(JSON.stringify(realTargetCard));
    expect(parsedCard.ok && parsedCard.lastMove?.targetCard).toEqual(card);

    const wrongType = envelope();
    const withWrongType: Record<string, unknown> = appliedMove({ targetCard: 'J♣' });
    wrongType.lastMove = withWrongType as never;
    wrongType.history = [withWrongType as never];
    wrongType.seq = 1;
    expect(() => parseBridgeResult(JSON.stringify(wrongType))).toThrow(/targetCard/);
  });

  it('SPEC §2.7: legalMoves.length must equal descriptions.length', () => {
    const mismatched = envelope();
    mismatched.legalMoves = [
      { Kind: 0, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null },
    ] as never;
    // descriptions left empty — length mismatch.
    expect(() => parseBridgeResult(JSON.stringify(mismatched))).toThrow(/legalMoves/);
  });

  it('SPEC §2.7: seq must equal history.length', () => {
    const mismatched = envelope();
    mismatched.seq = 5;
    expect(() => parseBridgeResult(JSON.stringify(mismatched))).toThrow(/seq/);
  });

  it("R2.1: scoreboard fields cross verbatim from the engine's helpers, never recomputed in TS", () => {
    const withScore = envelope();
    withScore.state.scoreboard = {
      you: { points: 17, threshold: 14, kings: 2, hasWon: false },
      opponent: { points: 3, threshold: 21, kings: 0, hasWon: false },
    };
    const parsed = parseBridgeResult(JSON.stringify(withScore));
    expect(parsed.ok && parsed.state.scoreboard).toEqual(withScore.state.scoreboard);
  });

  it('R2.2: state.stalemate is passed through verbatim, never independently derived by the schema', () => {
    const trueSpelledOut = envelope();
    trueSpelledOut.state.phase = 4;
    trueSpelledOut.state.winner = null;
    trueSpelledOut.state.stalemate = true;
    const parsedTrue = parseBridgeResult(JSON.stringify(trueSpelledOut));
    expect(parsedTrue.ok && parsedTrue.state.stalemate).toBe(true);

    // The schema validates shape only — it must not recompute or override
    // `stalemate` from `phase`/`winner` itself. That derivation is a Go-side
    // obligation (SPEC §3.2), proven separately by
    // TestR2_2a_StalemateDerivedFromPhaseAndWinner (Go half, requirements.yaml
    // R2.2). If the schema ever started deriving this value, this case would
    // silently start passing for the wrong reason instead of documenting the
    // boundary.
    const falseSpelledOut = envelope();
    falseSpelledOut.state.phase = 4;
    falseSpelledOut.state.winner = null;
    falseSpelledOut.state.stalemate = false;
    const parsedFalse = parseBridgeResult(JSON.stringify(falseSpelledOut));
    expect(parsedFalse.ok && parsedFalse.state.stalemate).toBe(false);
  });
});
