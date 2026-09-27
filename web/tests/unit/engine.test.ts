import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Card, Envelope } from '../../src/lib/bridge/schema';
import { apply, describe as engineDescribe, legalMoves, newGame, restore, snapshot, view } from '../../src/lib/bridge/engine';

const error = JSON.stringify({ ok: false, code: 'NO_GAME', message: 'none' });

function envelope(overrides: { opponentHand?: Card[] | null } = {}): Envelope {
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
      opponent: {
        handCount: 0,
        hand: overrides.opponentHand === undefined ? null : overrides.opponentHand,
        points: [],
        permanents: [],
      },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engine bridge boundary (SPEC §5.4)', () => {
  it('SPEC §2.4/§2.6: newGame serializes NewGameOpts as JSON, bridge owns dealing', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleNewGame', fn);
    newGame({ seed: '42', dealer: 1, names: ['Alice', 'Bob'] });
    expect(fn).toHaveBeenCalledWith('{"seed":"42","dealer":1,"names":["Alice","Bob"]}');
  });

  it('SPEC §2.4/A3: apply takes an index into the current legal-move list, never a Move object', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleApply', fn);
    apply(3);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('SPEC §2.4: view requests a named redacted viewer', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleView', fn);
    view(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('SPEC §2.4: legalMoves and describe take no arguments', () => {
    const legalMovesFn = vi.fn(() => error);
    const describeFn = vi.fn(() => error);
    vi.stubGlobal('__cuttleLegalMoves', legalMovesFn);
    vi.stubGlobal('__cuttleDescribe', describeFn);
    legalMoves();
    engineDescribe();
    expect(legalMovesFn).toHaveBeenCalledWith();
    expect(describeFn).toHaveBeenCalledWith();
  });

  it('SPEC §2.4 (amended 2026-09-26): restore takes (snapshotJson, viewerId) and returns viewerId\'s envelope', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleRestore', fn);
    restore('{"v":1,"state":{}}', 1);
    expect(fn).toHaveBeenCalledWith('{"v":1,"state":{}}', 1);
  });

  it('SPEC §3.4/§5.7: snapshot returns the opaque unredacted string verbatim, unvalidated', () => {
    // Deliberately NOT a valid PlayerView envelope — snapshot() must not run
    // it through the §2.7 schema, because it is the full unredacted
    // GameState (§3.4), not a redacted view.
    const rawSnapshot = '{"ok":true,"v":1,"state":{"Players":[]},"history":[],"seed":"42","dealer":0}';
    vi.stubGlobal('__cuttleSnapshot', vi.fn(() => rawSnapshot));
    expect(snapshot()).toBe(rawSnapshot);
  });

  it('SPEC §2.3: a bridge call throws a clear error before ensureEngine() has registered the globals', () => {
    expect(() => newGame({})).toThrow(/ensureEngine/);
  });

  it("R7.4: opponent.hand null-vs-empty distinction survives engine.restore()'s round trip", () => {
    const hiddenEnvelope = envelope({ opponentHand: null });
    const visibleEnvelope = envelope({ opponentHand: [] });

    vi.stubGlobal('__cuttleRestore', vi.fn(() => JSON.stringify(hiddenEnvelope)));
    const hidden = restore('{"v":1}', 0);
    expect(hidden.ok && hidden.state.opponent.hand).toBeNull();

    vi.unstubAllGlobals();
    vi.stubGlobal('__cuttleRestore', vi.fn(() => JSON.stringify(visibleEnvelope)));
    const visible = restore('{"v":1}', 0);
    expect(visible.ok && visible.state.opponent.hand).toEqual([]);
  });
});
