// SPEC §5.4 — THE public API. Every store and component calls through here;
// nothing outside this module touches a `__cuttle*` global directly (§2.3).
// Returns a validated `BridgeResult` (§2.7) for every call — the schema
// tripwire (schema.ts) runs on every response, not just in tests.
//
// `engine.ts` is the seam A2 exists to create: in v2 this file's
// implementation becomes a WebSocket client speaking the identical
// `Envelope`, with no store or component changes (SPEC §5.4).

import { type BridgeResult, type PlayerId, parseBridgeResult } from './schema';

export interface NewGameOpts {
  /** Decimal uint64 as a string (SPEC §2.6); omitted => crypto-random. */
  seed?: string;
  /** Omitted => random (R1: "first game: random"). */
  dealer?: PlayerId;
  names?: [string, string];
}

type CuttleGlobalFn = (...args: unknown[]) => string;

function bridgeGlobal(name: string): CuttleGlobalFn {
  const fn = (globalThis as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} is not registered — call ensureEngine() (SPEC §2.3) before any bridge call`);
  }
  return fn as CuttleGlobalFn;
}

function call(name: string, ...args: unknown[]): BridgeResult {
  const raw = bridgeGlobal(name)(...args);
  return parseBridgeResult(raw);
}

/** `__cuttleNewGame(optsJson)` — bridge-side dealing (§2.6). Mutates state. */
export function newGame(opts: NewGameOpts): BridgeResult {
  return call('__cuttleNewGame', JSON.stringify(opts));
}

/** `__cuttleLegalMoves()` — envelope for `state.Active`. Does not mutate. */
export function legalMoves(): BridgeResult {
  return call('__cuttleLegalMoves');
}

/**
 * `__cuttleApply(moveIndex)` — an index into the legal-move list of the
 * *current* state (A3). Returns the pre-apply `Active` player's (the
 * mover's) envelope (§2.4, amended 2026-09-26). The caller fetches the
 * incoming actor's view with `view(newActor)` after the curtain reveal
 * (§3.3 rule 4) — this module never does that automatically, because only
 * the curtain/store layer knows when the reveal has happened.
 */
export function apply(moveIndex: number): BridgeResult {
  return call('__cuttleApply', moveIndex);
}

/** `__cuttleDescribe()` — same envelope shape as `legalMoves` (§2.4). */
export function describe(): BridgeResult {
  return call('__cuttleDescribe');
}

/** `__cuttleView(viewerId)` — `viewerId`'s own envelope. Does not mutate. */
export function view(viewerId: PlayerId): BridgeResult {
  return call('__cuttleView', viewerId);
}

/**
 * `__cuttleSnapshot()` — the full, unredacted state (§3.4). Opaque to
 * TypeScript: callers persist the raw string and hand it back to
 * `restore()` verbatim (§5.7). Not schema-validated, deliberately — it is
 * not a `PlayerView` and does not have to be.
 */
export function snapshot(): string {
  const raw = bridgeGlobal('__cuttleSnapshot')();
  if (typeof raw !== 'string') {
    throw new Error('__cuttleSnapshot() must return a JSON string');
  }
  return raw;
}

/**
 * `__cuttleRestore(snapshotJson, viewerId)` — returns `viewerId`'s envelope
 * (§2.4, amended 2026-09-26). `snapshotJson` is `__cuttleSnapshot()`'s
 * output, handed back verbatim (§5.7); `viewerId` is the persisted
 * `Snapshot.viewer`. A `viewerId` that isn't exactly 0 or 1 is
 * `BAD_REQUEST` and the held state is unchanged.
 */
export function restore(snapshotJson: string, viewerId: PlayerId): BridgeResult {
  return call('__cuttleRestore', snapshotJson, viewerId);
}

export type { BridgeResult, EngineError, Envelope, PlayerId } from './schema';
