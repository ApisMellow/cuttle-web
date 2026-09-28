// SPEC §5.7 — the R4 localStorage snapshot shape, plus its pure
// (de)serialization and structural validation. Split out of game.svelte.ts
// so the encode/decode logic — including the R4.4 version-mismatch path —
// is testable without constructing a GameStore, a fake engine, or a fake
// Storage.
//
// `engineState` is opaque end-to-end (SPEC §5.7): this module only ever
// treats it as an already-serialized string produced by `__cuttleSnapshot()`
// and handed back to `__cuttleRestore()` verbatim. Nothing here parses
// inside it — that would be the redaction bypass SPEC §3.3(1) forbids
// through the back door.

import type { AppliedMove, PlayerId } from '../bridge/schema';
import type { CurtainState } from './curtain.svelte';

export const SNAPSHOT_KEY = 'cuttle-web:game';

/** SPEC §5.7: "bump on ANY shape change" — to this shape, or to the engine's state layout. */
export const SNAPSHOT_VERSION = 1 as const;

export interface Snapshot {
  v: typeof SNAPSHOT_VERSION;
  savedAt: string;
  /** Opaque: `__cuttleSnapshot()` output, never inspected by TS (SPEC §5.7). */
  engineState: string;
  history: AppliedMove[];
  lastSeenSeq: Record<PlayerId, number>;
  viewer: PlayerId;
  curtain: CurtainState;
  names: [string, string];
  seed: string;
  dealer: PlayerId;
}

export type DecodeFailureReason = 'empty' | 'invalid-json' | 'version-mismatch' | 'malformed';

export type DecodeResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: DecodeFailureReason; detail?: string };

export function encodeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayerId(value: unknown): value is PlayerId {
  return value === 0 || value === 1;
}

const HANDOFF_REASONS: readonly string[] = ['turn', 'counter', 'discard', 'seven-return', 'acknowledge'];

/** SPEC §4.2: exactly the six variants, each with the fields it requires. */
function isCurtainState(value: unknown): value is CurtainState {
  if (!isPlainObject(value)) return false;
  switch (value.kind) {
    case 'none':
    case 'result':
      return true;
    case 'handoff':
      return isPlayerId(value.to) && typeof value.reason === 'string' && HANDOFF_REASONS.includes(value.reason);
    case 'reveal':
      return isPlayerId(value.to);
    case 'recap':
      return isPlayerId(value.to) && Array.isArray(value.entries);
    case 'ack':
      return isPlayerId(value.to) && typeof value.synthetic === 'boolean';
    default:
      return false;
  }
}

function isLastSeenSeq(value: unknown): value is Record<PlayerId, number> {
  return isPlainObject(value) && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

/**
 * Structural-only validation, mirroring the bridge's own restore() posture
 * (SPEC §2.9): checks shape, never game rules. `engineState` is checked only
 * for being a string; its contents are the bridge restore() call's to
 * validate, not this module's (SPEC §5.7 "opaque... never inspected").
 *
 * Two cross-field checks, both about the store's own bookkeeping rather than
 * the game: a curtain can only be up after at least one applied move, and a
 * curtain addressed to a player is persisted with that player as `viewer`
 * (the store writes it that way; a mismatch would make restore fetch — and,
 * at an `ack`, expose — the wrong player's view).
 */
function isWellFormed(obj: Record<string, unknown>): obj is Record<keyof Snapshot, unknown> {
  const shaped =
    typeof obj.savedAt === 'string' &&
    typeof obj.engineState === 'string' &&
    Array.isArray(obj.history) &&
    isLastSeenSeq(obj.lastSeenSeq) &&
    isPlayerId(obj.viewer) &&
    isCurtainState(obj.curtain) &&
    Array.isArray(obj.names) &&
    obj.names.length === 2 &&
    typeof obj.names[0] === 'string' &&
    typeof obj.names[1] === 'string' &&
    typeof obj.seed === 'string' &&
    isPlayerId(obj.dealer);
  if (!shaped) return false;
  const curtain = obj.curtain as CurtainState;
  if (curtain.kind !== 'none' && (obj.history as unknown[]).length === 0) return false;
  if ('to' in curtain && curtain.to !== obj.viewer) return false;
  return true;
}

/**
 * Decodes a raw localStorage string into a Snapshot.
 *
 * R4.4: a `v` other than SNAPSHOT_VERSION is reported as the
 * 'version-mismatch' failure variant — never thrown, never migrated. The
 * caller (GameStore) is responsible for discarding the stored value and
 * surfacing a notice; this function only classifies.
 */
export function decodeSnapshot(raw: string | null): DecodeResult {
  if (!raw) return { ok: false, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid-json', detail: (err as Error).message };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'malformed', detail: `expected an object, got ${typeof parsed}` };
  }

  // Version check BEFORE any structural check: a v-mismatched record may not
  // even have this shape (SPEC §5.7 "no migration code in v1; a bump means
  // the old game is gone"), so malformed-vs-version-mismatch would otherwise
  // be ambiguous for an old-shaped record that also fails isWellFormed.
  if (parsed.v !== SNAPSHOT_VERSION) {
    return { ok: false, reason: 'version-mismatch', detail: `found v=${JSON.stringify(parsed.v)}` };
  }

  if (!isWellFormed(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'missing or invalid field' };
  }

  return { ok: true, snapshot: parsed as unknown as Snapshot };
}
