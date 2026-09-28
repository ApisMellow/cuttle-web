// SPEC §2.5 — enum values, pinned from source. Every enum crosses the wire
// as a plain JSON number (the Go types are `uint8`-based with no
// `MarshalJSON` and no string tags); this module is the single, shared
// TypeScript mirror of those constants.
//
// Round 1 shipped two private copies of these constants, one each in
// `stores/curtain.svelte.ts` and `affordances.ts`, because a shared module
// was out of scope for that round (see AGENTS.md, and each file's own
// "shared enums module" comment). Round 2 W7 consolidates them here; the
// two call sites migrate onto this module with no behavior change.

import type {
  Phase as PhaseT,
  MoveKind as MoveKindT,
  PlayerId as PlayerIdT,
  TargetZone as TargetZoneT,
  Suit as SuitT,
} from './bridge/schema';

/** `engine/state.go:60-68`. Exhaustive; `LegalMoves` branches on `Phase` first (`engine/apply.go:15-31`). */
export const Phase = {
  Normal: 0,
  AwaitingCounter: 1,
  SevenChoosing: 2,
  AwaitingDiscard: 3,
  GameOver: 4,
} as const satisfies Record<string, PhaseT>;

/** `engine/moves.go:9-22`. */
export const MoveKind = {
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
} as const satisfies Record<string, MoveKindT>;

/** `engine/state.go:26-31`. `P1 = 0`, `P2 = 1`. `Other()` is `1 - p` (`state.go:33-35`). */
export const PlayerID = {
  P1: 0,
  P2: 1,
} as const satisfies Record<string, PlayerIdT>;

/** `engine/state.go:70-75`. */
export const TargetZone = {
  Points: 0,
  Permanents: 1,
} as const satisfies Record<string, TargetZoneT>;

/**
 * `card/card.go:5-12`. This ordering is also the scuttle tiebreak order
 * (`card/card.go:51-56`, RULES.md §Legal Actions 3): equal rank, higher
 * suit wins. The UI must render suits in this order wherever suits are
 * ordered.
 */
export const Suit = {
  Clubs: 0,
  Diamonds: 1,
  Hearts: 2,
  Spades: 3,
} as const satisfies Record<string, SuitT>;
