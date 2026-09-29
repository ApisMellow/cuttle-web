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

/**
 * SPEC §5.7: "bump on ANY shape change" — to this shape, or to the engine's
 * state layout. 2 since AppliedMove gained `drawn` (SPEC §2.7, amended
 * 2026-09-28). A v1 save is migrated on read (`decodeSnapshot`, ruling
 * 2026-09-28: the engine state layout is unchanged), so family-beta games
 * survive; the next write is v2.
 */
export const SNAPSHOT_VERSION = 2 as const;

/** The one older version `decodeSnapshot` upgrades (SPEC §5.7, ruling 2026-09-28). */
const MIGRATABLE_VERSION = 1;

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

const HANDOFF_REASONS: readonly string[] = ['turn', 'counter', 'discard', 'seven-return'];

/**
 * Ruling 2026-09-29 (SPEC §4.3, §5.7): the client no longer stages an
 * acknowledgment for a one-off the engine resolved at once, and the `ack`
 * curtain lost its `synthetic` flag. The written shape only loses a field,
 * so there is no `v` bump; a save written before the ruling is read like
 * this:
 *   - `ack` with `synthetic: false` is the counter window: the flag is dropped.
 *   - `ack` with `synthetic: true` becomes `reveal` for the same player: the
 *     step just before it. Passing that gate fetches their view fresh, or
 *     hands the phone on when the turn is not theirs (curtain machine,
 *     `afterRecap`), so nothing new is shown to anyone.
 *   - a `handoff` with the retired reason `acknowledge` becomes `turn`.
 * An `ack` whose `synthetic` is not a boolean is malformed.
 */
function withoutLegacyAck(curtain: unknown): unknown {
  if (!isPlainObject(curtain)) return curtain;
  if (curtain.kind === 'handoff' && curtain.reason === 'acknowledge') return { ...curtain, reason: 'turn' };
  if (curtain.kind !== 'ack' || !('synthetic' in curtain)) return curtain;
  if (curtain.synthetic === true) return { kind: 'reveal', to: curtain.to };
  if (curtain.synthetic === false) return { kind: 'ack', to: curtain.to };
  return curtain; // a non-boolean flag: isCurtainState rejects it
}

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
      return isPlayerId(value.to) && !('synthetic' in value);
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
 * the game: a curtain can only be up after at least one applied move (except
 * the opening deal's handoff 'turn' and its reveal, W25), and a
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
  const opening = (curtain.kind === 'handoff' && curtain.reason === 'turn') || curtain.kind === 'reveal';
  if (curtain.kind !== 'none' && !opening && (obj.history as unknown[]).length === 0) return false;
  if ('to' in curtain && curtain.to !== obj.viewer) return false;
  return true;
}

/**
 * Decodes a raw localStorage string into a Snapshot.
 *
 * R4.4: a `v` other than SNAPSHOT_VERSION (or the migratable v1) is
 * reported as the 'version-mismatch' failure variant — never thrown. The
 * caller (GameStore) is responsible for discarding the stored value and
 * surfacing a notice; this function only classifies.
 *
 * v1 -> v2 (ruling 2026-09-28): v1 history and recap entries lack
 * `drawn`; each gets `drawn: null` (a v1 save predates the count, and null
 * is what v2 holds where no 5 resolved). The opaque `engineState` keeps its
 * own v1 tag; the bridge's restore migrates it the same way (§5.7) and never
 * a TS reader. An entry that already carries `drawn` is not a real v1 save:
 * malformed.
 */
function withNullDrawn(entries: unknown): unknown[] | null {
  if (!Array.isArray(entries)) return null;
  const out: unknown[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      out.push(entry); // shape errors are isWellFormed's to report
      continue;
    }
    if ('drawn' in entry) return null;
    out.push({ ...entry, drawn: null });
  }
  return out;
}

function migrateV1(v1: Record<string, unknown>): Record<string, unknown> | null {
  const history = Array.isArray(v1.history) ? withNullDrawn(v1.history) : v1.history;
  if (history === null) return null;
  let curtain = v1.curtain;
  if (isPlainObject(curtain) && curtain.kind === 'recap' && Array.isArray(curtain.entries)) {
    const entries = withNullDrawn(curtain.entries);
    if (entries === null) return null;
    curtain = { ...curtain, entries };
  }
  return { ...v1, v: SNAPSHOT_VERSION, history, curtain };
}

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
  // even have this shape, so malformed-vs-version-mismatch would otherwise
  // be ambiguous for an old-shaped record that also fails isWellFormed. v1
  // is the one older version that migrates (SPEC §5.7, ruling 2026-09-28).
  if (parsed.v !== SNAPSHOT_VERSION && parsed.v !== MIGRATABLE_VERSION) {
    return { ok: false, reason: 'version-mismatch', detail: `found v=${JSON.stringify(parsed.v)}` };
  }
  const migrated = parsed.v === MIGRATABLE_VERSION ? migrateV1(parsed) : parsed;
  if (migrated === null) return { ok: false, reason: 'malformed', detail: 'v1 entry already carries drawn' };
  const current = { ...migrated, curtain: withoutLegacyAck(migrated.curtain) };

  if (!isWellFormed(current)) {
    return { ok: false, reason: 'malformed', detail: 'missing or invalid field' };
  }

  return { ok: true, snapshot: current as unknown as Snapshot };
}
