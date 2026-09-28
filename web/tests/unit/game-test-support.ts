// Test-only fixtures shared across the game.svelte.ts test files (W5).
// Not a *.test.ts file itself — vitest's `tests/unit/**/*.test.ts` include
// (vite.config.ts) does not pick it up as its own suite.
//
// Per the round's parallel-work note: another developer is adding
// `targetCard: Card | null` to `AppliedMove` in schema.ts this round. Every
// AppliedMove built for these tests goes through the ONE factory below
// (`appliedMove`) so that field lands in exactly one place at integration.

import { vi } from 'vitest';

import type { AppliedMove, EngineError, Envelope, MoveKind, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import type { GameEngine } from '../../src/lib/stores/game.svelte';

// SPEC §2.5, pinned locally for fixtures (private copies per-module is the
// round-1 convention; round 2 consolidates them — docs/assumptions.md).
export const Phase = {
  Normal: 0,
  AwaitingCounter: 1,
  SevenChoosing: 2,
  AwaitingDiscard: 3,
  GameOver: 4,
} as const;

export const Kind = {
  Draw: 0,
  PlayPoint: 1,
  PlayPermanent: 2,
  Scuttle: 3,
  OneOff: 4,
  Counter: 5,
  Decline: 6,
  SevenPick: 7,
  DiscardPair: 8,
  Pass: 9,
} as const satisfies Record<string, MoveKind>;

/**
 * THE factory: every AppliedMove in these tests is built through this.
 * `targetCard` (SPEC §2.7, amended 2026-09-27) defaults to null (an
 * untargeted move); pass `targetCard: { Rank, Suit }` to override.
 */
export function appliedMove(overrides: Partial<AppliedMove> & { by: PlayerId; kind: MoveKind }): AppliedMove {
  return {
    card: null,
    description: 'fixture move',
    seq: 1,
    subKind: null,
    targetCard: null,
    ...overrides,
  };
}

export function playerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    passesInARow: 0,
    winner: null,
    stalemate: false,
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [] },
    opponent: { handCount: 0, hand: null, points: [], permanents: [] },
    deckCount: 30,
    scrap: [],
    scoreboard: {
      you: { points: 0, threshold: 21, kings: 0, hasWon: false },
      opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
    },
    sevenRevealed: null,
    pending: null,
    ...overrides,
  };
}

export function envelope(overrides: Partial<Envelope> & { state: PlayerView } = { state: playerView() }): Envelope {
  const history = overrides.history ?? [];
  return {
    ok: true,
    legalMoves: [],
    descriptions: [],
    lastMove: null,
    seq: history.length,
    ...overrides,
    history,
  };
}

/** A fully-stubbed fake engine; every method throws until a test overrides it, so an unstubbed call fails loudly instead of silently returning undefined. */
export function createFakeEngine(overrides: Partial<GameEngine> = {}): GameEngine {
  return {
    newGame: vi.fn(() => {
      throw new Error('fakeEngine.newGame not stubbed for this test');
    }),
    apply: vi.fn(() => {
      throw new Error('fakeEngine.apply not stubbed for this test');
    }),
    view: vi.fn(() => {
      throw new Error('fakeEngine.view not stubbed for this test');
    }),
    snapshot: vi.fn(() => '"fake-engine-state"'),
    restore: vi.fn(() => {
      throw new Error('fakeEngine.restore not stubbed for this test');
    }),
    ...overrides,
  };
}

export function engineError(code: EngineError['code'], message = 'fixture error'): EngineError {
  return { ok: false, code, message };
}

/** A minimal fake `localStorage`-shaped Storage for injection (SPEC §5.3 "make storage injectable"). */
export function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}
