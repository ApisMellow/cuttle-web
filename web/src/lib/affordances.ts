// SPEC §6.2–§6.4 — deriving UI affordances from the engine's flat
// legal-move list. Every function here is pure and knows nothing about
// game rules: it only organizes the `Move[]` the engine already decided
// was legal. If a function here ever needs to know whether a play is
// *allowed* (Queen protection, scuttle beats, discard counts), that is a
// sign it has drifted into rule logic and does not belong in this file
// (P2 W2 brief, "Zero rule logic").
//
// MoveKind/Phase values are pinned from SPEC §2.5 via the shared enums
// module (round 2 W7 consolidation; see `lib/enums.ts`).

import type { Card, Move, Phase, Target } from './bridge/schema';
import { MoveKind, Phase as Ph, TargetZone } from './enums';
import type { TargetKey } from './targetKey';

const MOVE_DRAW = MoveKind.Draw;
const MOVE_PLAY_POINT = MoveKind.PlayPoint;
const MOVE_PLAY_PERMANENT = MoveKind.PlayPermanent;
const MOVE_SCUTTLE = MoveKind.Scuttle;
const MOVE_ONE_OFF = MoveKind.OneOff;
const MOVE_COUNTER = MoveKind.Counter;
const MOVE_DECLINE = MoveKind.Decline;
const MOVE_SEVEN_PICK = MoveKind.SevenPick;
const MOVE_DISCARD_PAIR = MoveKind.DiscardPair;
const MOVE_PASS = MoveKind.Pass;

const PHASE_AWAITING_DISCARD = Ph.AwaitingDiscard;

/** Identifies a card for the SevenPick slot key's nested `cardKey` term (SPEC §6.2). */
function cardKey(c: Card): string {
  return `${c.Rank}:${c.Suit}`;
}

function cardKeyOrNull(c: Card | null): string | null {
  return c ? cardKey(c) : null;
}

/** Thrown when a `Move` is structurally incomplete for the `MoveKind` it claims (SPEC §6.2). */
export class SlotKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotKeyError';
  }
}

/**
 * SPEC §6.2 — identifies the affordance a move belongs to. Total over all
 * ten `MoveKind`s: every case is handled explicitly, and the `default`
 * branch is unreachable by construction — TypeScript narrows `m.Kind` to
 * `never` there once all ten literals are covered, so an eleventh
 * `MoveKind` added later fails to *compile*, not just to run.
 */
export function slotKey(m: Move): string {
  switch (m.Kind) {
    case MOVE_DRAW:
      return 'deck';
    case MOVE_PASS:
      return 'pass';
    case MOVE_DECLINE:
      return 'decline';
    case MOVE_COUNTER:
      return `counter:${m.HandIndex}`;
    case MOVE_DISCARD_PAIR:
      return `discard:${m.DiscardA}:${m.DiscardB}`;
    case MOVE_PLAY_POINT:
      return `hand:${m.HandIndex}|zone:points`;
    case MOVE_PLAY_PERMANENT:
      return m.JackTarget
        ? `hand:${m.HandIndex}|jack:${m.JackTarget.Owner}:${m.JackTarget.Index}`
        : `hand:${m.HandIndex}|zone:permanents`;
    case MOVE_SCUTTLE:
      if (!m.Target) {
        throw new SlotKeyError('slotKey: Scuttle move has no Target — SPEC §6.2 assumes one always exists');
      }
      return `hand:${m.HandIndex}|scuttle:${m.Target.Owner}:${m.Target.Index}`;
    case MOVE_ONE_OFF:
      return m.Target
        ? `hand:${m.HandIndex}|oneoff:${m.Target.Owner}:${m.Target.Zone}:${m.Target.Index}`
        : `hand:${m.HandIndex}|zone:oneoff`; // rank-3 ScrapIndex variants collapse here on purpose (§6.2 last para)
    case MOVE_SEVEN_PICK:
      // Amended per orchestrator cycle-1 review (B1): a dead-end SevenPick
      // (no revealed card has any legal play) carries `SubMove: null`
      // (engine/apply.go:535-541; internal/wasm/bridge.go:452-454). The
      // original SPEC §6.2 pseudocode's unconditional `slotKey(m.SubMove!)`
      // crashed on exactly this shape.
      return m.SubMove ? `seven:${cardKey(m.Card!)}|${slotKey(m.SubMove)}` : `seven:${cardKey(m.Card!)}|scrap`;
    default: {
      const exhaustive: never = m.Kind;
      throw new SlotKeyError(`slotKey: unhandled MoveKind ${String(exhaustive)}`);
    }
  }
}

/**
 * SPEC §6.2 — groups a flat legal-move list into affordances, keyed by
 * `slotKey`. Every index in `legalMoves` lands in exactly one slot
 * (guaranteed by iterating the array once and `slotKey` being total);
 * every returned slot has at least one index, because slots are only
 * created when an index is pushed into them.
 */
export function groupAffordances(legalMoves: Move[]): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  legalMoves.forEach((move, index) => {
    const key = slotKey(move);
    const bucket = map[key];
    if (bucket) {
      bucket.push(index);
    } else {
      map[key] = [index];
    }
  });
  return map;
}

/**
 * SPEC §6.2 last paragraph — the rank-3 one-off's `ScrapIndex` variants
 * share a single targetless-one-off slot (`hand:X|zone:oneoff`) but are
 * deliberately NOT the R11 chooser's concern: they are resolved by the
 * scrap-pick browser (§6.3) instead. Detected structurally, from the move
 * shapes alone — every candidate is a targetless `OneOff` for the same
 * hand card, agreeing on every field except a distinct `ScrapIndex` —
 * never by asking which rank the card is (that would be rule logic).
 *
 * Amended per orchestrator cycle-1 review (B2): a rank-3 revealed by a 7
 * replays "exactly as a hand card would" (SPEC §6.3), so its ScrapIndex
 * variants collapse the same way one level down — every candidate is a
 * `SevenPick` for the same revealed card, each wrapping a non-null
 * SubMove, and the SubMoves themselves collapse by this same check.
 */
function isScrapPickCollapse(candidates: Move[]): boolean {
  if (candidates.length < 2) return false;
  const [first, ...rest] = candidates;

  if (first.Kind === MOVE_SEVEN_PICK) {
    if (first.SubMove === null) return false; // a dead-end 7 has nothing to collapse
    const subCandidates: Move[] = [first.SubMove];
    for (const m of rest) {
      if (m.Kind !== MOVE_SEVEN_PICK || m.SubMove === null) return false;
      if (cardKeyOrNull(m.Card) !== cardKeyOrNull(first.Card)) return false;
      subCandidates.push(m.SubMove);
    }
    return isScrapPickCollapse(subCandidates);
  }

  if (first.Kind !== MOVE_ONE_OFF || first.Target !== null || first.JackTarget !== null) return false;
  const scrapIndices = new Set<number>([first.ScrapIndex]);
  for (const m of rest) {
    if (m.Kind !== MOVE_ONE_OFF || m.Target !== null || m.JackTarget !== null) return false;
    if (m.HandIndex !== first.HandIndex) return false;
    if (cardKeyOrNull(m.Card) !== cardKeyOrNull(first.Card)) return false;
    scrapIndices.add(m.ScrapIndex);
  }
  return scrapIndices.size === candidates.length;
}

/**
 * SPEC §6.4 — a slot is ambiguous, and must be resolved by the R11
 * ambiguity chooser, exactly when it holds more than one candidate index
 * — except the rank-3 scrap-pick collapse (§6.2), which resolves via the
 * scrap browser instead and is never ambiguous no matter how many
 * `ScrapIndex` variants it holds.
 */
export function isAmbiguousSlot(indices: number[], legalMoves: Move[]): boolean {
  if (indices.length <= 1) return false;
  const candidates = indices.map((i) => legalMoves[i]);
  return !isScrapPickCollapse(candidates);
}

/**
 * The full set of move indices an affordance map covers — what
 * `window.__cuttleTestHook.affordances()` will expose for the R11
 * completeness/soundness walk (SPEC §6.5). Sorted for a stable, readable
 * comparison against `legalMoves`' own index range in that test.
 */
export function flattenAffordances(map: Record<string, number[]>): number[] {
  const indices: number[] = [];
  for (const bucket of Object.values(map)) {
    indices.push(...bucket);
  }
  return indices.sort((a, b) => a - b);
}

export interface DiscardCandidate {
  moveIndex: number;
  discardA: number;
  discardB: number;
}

export type DiscardPickerModel =
  | { mode: 'preselected'; moveIndex: number; discardA: number; discardB: number }
  | { mode: 'select'; candidates: DiscardCandidate[] };

/**
 * SPEC §6.3 `DiscardPair` row, §4.4 `PhaseAwaitingDiscard` — models what
 * the `DiscardPicker` should show.
 *
 * Returns `null` outside `PhaseAwaitingDiscard` — the picker never renders
 * there. This is the unit-provable half of R15.2.
 *
 * The other half of R15.2 — an empty-hand discarder never reaching this
 * phase at all, because the engine auto-resumes first (`apply.go:621-623`)
 * — is NOT provable by this function: a pure function has no way to
 * observe a phase the engine never produces. That half is exercised
 * against the real WASM engine in `affordances.test.ts` instead.
 */
export function deriveDiscardPicker(phase: Phase, legalMoves: Move[]): DiscardPickerModel | null {
  if (phase !== PHASE_AWAITING_DISCARD) return null;
  if (legalMoves.length === 1) {
    const [only] = legalMoves;
    return { mode: 'preselected', moveIndex: 0, discardA: only.DiscardA, discardB: only.DiscardB };
  }
  return {
    mode: 'select',
    candidates: legalMoves.map((m, moveIndex) => ({ moveIndex, discardA: m.DiscardA, discardB: m.DiscardB })),
  };
}

// ---------------------------------------------------------------------------
// P2 W11 additions — board target keys and the staging test-hook data.
// Additive only: nothing above this line changes behaviour.
// ---------------------------------------------------------------------------

function ownerZoneKey(t: Target): TargetKey {
  return t.Zone === TargetZone.Points ? (`point:${t.Owner}:${t.Index}` as const) : (`perm:${t.Owner}:${t.Index}` as const);
}

/**
 * P2 W11 contract — maps a legal move to the board key its target step
 * resolves to (the `StagingStore`'s `tap(key)` vocabulary), built only from
 * `Move` fields: `Target`/`JackTarget` Owner/Zone/Index, and the kind's fixed
 * zone (SPEC §6.3). Distinct from `slotKey` (§6.2), which identifies the
 * *affordance* (fine enough to separate a Scuttle from a same-target OneOff);
 * this identifies the *board location* a tap resolves against, which is
 * coarser — a Scuttle and a targeted OneOff at the same point card share one
 * board key (`point:O:I`) even though they are different slots, because
 * they're the same tap on the board.
 *
 * Total over all ten `MoveKind`s so it stays safe to call on any legal move,
 * including the ones the current round doesn't route to a target step:
 * - `Pass`, `Decline`, `Counter`, `DiscardPair` have no board location at all
 *   (Pass and Decline are phase controls; Counter is "not a board
 *   interaction", SPEC §6.3; DiscardPair is a picker, not a tap-a-target
 *   affordance) — `null`.
 * - `Draw`'s target step *is* the deck itself — `'deck'`.
 * - `SevenPick` recurses into `SubMove`; a dead-end SevenPick (§6.2 amended)
 *   has no sub-move to recurse into and scraps the revealed card instead —
 *   `'scrap'`, the only kind that produces that key.
 */
export function boardTargetKey(m: Move): TargetKey | null {
  switch (m.Kind) {
    case MOVE_PASS:
    case MOVE_DECLINE:
    case MOVE_COUNTER:
    case MOVE_DISCARD_PAIR:
      return null;
    case MOVE_DRAW:
      return 'deck';
    case MOVE_PLAY_POINT:
      return 'zone:points';
    case MOVE_PLAY_PERMANENT:
      return m.JackTarget ? ownerZoneKey(m.JackTarget) : 'zone:permanents';
    case MOVE_SCUTTLE:
      if (!m.Target) {
        throw new SlotKeyError('boardTargetKey: Scuttle move has no Target — SPEC §6.2 assumes one always exists');
      }
      return ownerZoneKey(m.Target);
    case MOVE_ONE_OFF:
      return m.Target ? ownerZoneKey(m.Target) : 'zone:oneoff';
    case MOVE_SEVEN_PICK:
      return m.SubMove ? boardTargetKey(m.SubMove) : 'scrap';
    default: {
      const exhaustive: never = m.Kind;
      throw new SlotKeyError(`boardTargetKey: unhandled MoveKind ${String(exhaustive)}`);
    }
  }
}

/**
 * P2 W11 contract, last bullet — the pure function a later round's
 * GameScreen wires up verbatim as `window.__cuttleTestHook.affordances()`
 * (SPEC §6.5, §7.4), scoped to the `MoveKind`s THIS round's `StagingStore`
 * can actually carry to `staged`: `Draw`, `Pass`, `PlayPoint`,
 * `PlayPermanent` (including a Jack steal), `Scuttle`, and `OneOff` — except
 * a rank-3 ScrapIndex group, which needs the round-4 `ScrapBrowser` and is
 * excluded here the same way `isAmbiguousSlot` excludes it from the R11
 * chooser (§6.2's last paragraph). `Counter`, `Decline`, `SevenPick`, and
 * `DiscardPair` are round-4 UI and never appear in the result.
 *
 * Reuses `groupAffordances`/`isAmbiguousSlot` rather than re-deriving
 * grouping or the collapse check, so this can never disagree with them about
 * what counts as a genuine ambiguity versus a scrap-pick collapse.
 */
export function stagingAffordances(legalMoves: Move[]): Record<string, number[]> {
  const grouped = groupAffordances(legalMoves);
  const result: Record<string, number[]> = {};
  for (const [key, indices] of Object.entries(grouped)) {
    const kind = legalMoves[indices[0]].Kind;
    if (kind !== MOVE_DRAW && kind !== MOVE_PASS && kind !== MOVE_PLAY_POINT && kind !== MOVE_PLAY_PERMANENT &&
        kind !== MOVE_SCUTTLE && kind !== MOVE_ONE_OFF) {
      continue; // Counter, Decline, SevenPick, DiscardPair — round 4
    }
    if (indices.length > 1 && !isAmbiguousSlot(indices, legalMoves)) {
      continue; // scrap-pick collapse (rank-3 ScrapIndex variants) — round 4
    }
    result[key] = indices;
  }
  return result;
}
