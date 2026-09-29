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
 * `drawn` (SPEC §2.7, amended 2026-09-28) defaults to null (no 5 resolved).
 */
export function appliedMove(overrides: Partial<AppliedMove> & { by: PlayerId; kind: MoveKind }): AppliedMove {
  return {
    card: null,
    description: 'fixture move',
    seq: 1,
    subKind: null,
    targetCard: null,
    drawn: null,
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
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
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

/**
 * W25: `newGame()` now starts behind the opening curtain (handoff -> reveal
 * -> none, addressed to the first actor). Suites that use `newGame` only as
 * setup call this instead: it walks the store's REAL opening sequence, with
 * `engine.view` answering from the deal's own envelope for just that walk,
 * so a suite's `view` stub and its call counts are untouched. It stops at
 * the first resting state (`none`, or a real counter window when the deal
 * fixture sits at AwaitingCounter).
 */
export async function startGame(
  store: { newGame(opts?: { seed?: string; dealer?: PlayerId }): Promise<void>; advanceCurtain(): Promise<void>; curtain: { kind: string } },
  engine: GameEngine,
  opts?: { seed?: string; dealer?: PlayerId },
): Promise<void> {
  const originalNewGame = engine.newGame;
  const originalView = engine.view;
  let dealt: ReturnType<GameEngine['newGame']> | null = null;
  engine.newGame = (o) => {
    dealt = originalNewGame(o);
    return dealt;
  };
  try {
    await store.newGame(opts);
    if (dealt === null) return;
    const deal = dealt;
    engine.view = () => deal;
    for (let i = 0; i < 4 && ['handoff', 'reveal', 'recap'].includes(store.curtain.kind); i++) {
      await store.advanceCurtain();
    }
  } finally {
    engine.newGame = originalNewGame;
    engine.view = originalView;
  }
}

interface MockFn {
  mockImplementation(fn: (...args: never[]) => unknown): unknown;
  getMockImplementation(): ((...args: never[]) => unknown) | undefined;
  mockReset(): unknown;
  mockClear(): unknown;
}

/**
 * W25: `startGame` for suites that mock the `lib/bridge/engine` module
 * (the store's default engine) instead of injecting a fake. Deals `deal`,
 * then walks the store's real opening sequence with `view` answering from
 * `deal`, and leaves `view` as it found it with no calls recorded.
 */
export async function startGameMocked(
  store: { newGame(opts?: { seed?: string; dealer?: PlayerId }): Promise<void>; advanceCurtain(): Promise<void>; curtain: { kind: string } },
  bridge: { newGame: MockFn; view: MockFn },
  deal: Envelope,
  opts?: { seed?: string; dealer?: PlayerId },
): Promise<void> {
  bridge.newGame.mockImplementation(() => deal);
  const prior = bridge.view.getMockImplementation();
  bridge.view.mockImplementation(() => deal);
  try {
    await store.newGame(opts);
    for (let i = 0; i < 4 && ['handoff', 'reveal', 'recap'].includes(store.curtain.kind); i++) {
      await store.advanceCurtain();
    }
  } finally {
    if (prior) bridge.view.mockImplementation(prior);
    else bridge.view.mockReset();
    bridge.view.mockClear();
  }
}
