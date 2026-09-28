import { describe, expect, it } from 'vitest';

import {
  boardTargetKey,
  deriveDiscardPicker,
  flattenAffordances,
  groupAffordances,
  isAmbiguousSlot,
  slotKey,
  stagingAffordances,
} from '../../src/lib/affordances';
import type { BridgeResult, Envelope, Move, Phase } from '../../src/lib/bridge/schema';
import {
  apply as engineApply,
  legalMoves as engineLegalMoves,
  newGame as engineNewGame,
} from '../../src/lib/bridge/engine';
import { createWasmEngine } from '../scenario/wasm-engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Full `Move` shape with sensible "unused" defaults, overridable per case.
 * `ScrapIndex`/`DiscardA`/`DiscardB` default to `0`, matching the engine's
 * Go zero value — `normalizeMove` (internal/wasm/envelope.go:113-129)
 * copies these fields verbatim with no "unused" sentinel of its own.
 * `DiscardB: -1` is a real, deliberate value the engine emits only for the
 * 1-card discarding-hand case (apply.go:493) — tests that need it set it
 * explicitly, never via this default.
 */
function move(overrides: Partial<Move>): Move {
  return {
    Kind: 0,
    Card: null,
    HandIndex: 0,
    Target: null,
    JackTarget: null,
    ScrapIndex: 0,
    DiscardA: 0,
    DiscardB: 0,
    SubMove: null,
    ...overrides,
  };
}

// SPEC §2.6 golden scenario: seed "42", dealer P2 (P1 non-dealer, goes
// first). P1 hand: 2♥ 3♣ A♥ K♦ Q♣ (hand indices 0..4). Suits per §2.5:
// Clubs=0, Diamonds=1, Hearts=2, Spades=3. Ranks: A=1 … K=13.
const TWO_HEARTS = { Rank: 2, Suit: 2 } as const;
const THREE_CLUBS = { Rank: 3, Suit: 0 } as const;
const ACE_HEARTS = { Rank: 1, Suit: 2 } as const;
const KING_DIAMONDS = { Rank: 13, Suit: 1 } as const;
const QUEEN_CLUBS = { Rank: 12, Suit: 0 } as const;

const GOLDEN_MOVES: Move[] = [
  move({ Kind: 0 }), // [0] draw a card
  move({ Kind: 1, HandIndex: 0, Card: TWO_HEARTS }), // [1] play 2♥ as point card
  move({ Kind: 1, HandIndex: 1, Card: THREE_CLUBS }), // [2] play 3♣ as point card
  move({ Kind: 4, HandIndex: 2, Card: ACE_HEARTS, Target: null }), // [3] play A♥ as one-off
  move({ Kind: 1, HandIndex: 2, Card: ACE_HEARTS }), // [4] play A♥ as point card
  move({ Kind: 2, HandIndex: 3, Card: KING_DIAMONDS, JackTarget: null }), // [5] play K♦ as permanent
  move({ Kind: 2, HandIndex: 4, Card: QUEEN_CLUBS, JackTarget: null }), // [6] play Q♣ as permanent
];

// ---------------------------------------------------------------------------
// slotKey — SPEC §6.2, totality over all 10 MoveKinds
// ---------------------------------------------------------------------------

describe('slotKey', () => {
  it('SPEC §6.2: Draw always maps to the fixed "deck" slot', () => {
    expect(slotKey(move({ Kind: 0 }))).toBe('deck');
  });

  it('SPEC §6.2: Pass always maps to the fixed "pass" slot', () => {
    expect(slotKey(move({ Kind: 9 }))).toBe('pass');
  });

  it('SPEC §6.2: Decline always maps to the fixed "decline" slot', () => {
    expect(slotKey(move({ Kind: 6 }))).toBe('decline');
  });

  it('SPEC §6.2: Counter keys off the countering hand index', () => {
    expect(slotKey(move({ Kind: 5, HandIndex: 3 }))).toBe('counter:3');
  });

  it('SPEC §6.2: DiscardPair keys off the DiscardA/DiscardB pair', () => {
    expect(slotKey(move({ Kind: 8, DiscardA: 1, DiscardB: 4 }))).toBe('discard:1:4');
  });

  it('SPEC §6.2: PlayPoint keys off hand index and the points zone', () => {
    expect(slotKey(move({ Kind: 1, HandIndex: 2 }))).toBe('hand:2|zone:points');
  });

  it('SPEC §6.2: PlayPermanent with no JackTarget keys off the permanents zone', () => {
    expect(slotKey(move({ Kind: 2, HandIndex: 3, JackTarget: null }))).toBe('hand:3|zone:permanents');
  });

  it('SPEC §6.2: PlayPermanent Jack keys off the specific steal target, not a zone', () => {
    const m = move({ Kind: 2, HandIndex: 5, JackTarget: { Owner: 1, Zone: 0, Index: 2 } });
    expect(slotKey(m)).toBe('hand:5|jack:1:2');
  });

  it('SPEC §6.2: Scuttle keys off the specific point card it beats', () => {
    const m = move({ Kind: 3, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 0 } });
    expect(slotKey(m)).toBe('hand:1|scuttle:1:0');
  });

  it('SPEC §6.2: targetless OneOff keys off the one-off zone (no target/scrap distinction)', () => {
    expect(slotKey(move({ Kind: 4, HandIndex: 2, Target: null }))).toBe('hand:2|zone:oneoff');
  });

  it('SPEC §6.2: targeted OneOff keys off owner, zone, and index', () => {
    const m = move({ Kind: 4, HandIndex: 6, Target: { Owner: 0, Zone: 1, Index: 3 } });
    expect(slotKey(m)).toBe('hand:6|oneoff:0:1:3');
  });

  it('SPEC §6.2: SevenPick recurses single-level, prefixed by the revealed card', () => {
    const inner = move({ Kind: 1, HandIndex: 7, Card: TWO_HEARTS });
    const m = move({ Kind: 7, Card: TWO_HEARTS, SubMove: inner });
    expect(slotKey(m)).toBe(`seven:2:2|${slotKey(inner)}`);
    expect(slotKey(m)).toBe('seven:2:2|hand:7|zone:points');
  });

  it('SPEC §6.2 (amended — orchestrator cycle 1, B1): a dead-end SevenPick (SubMove: null) keys off the revealed card and a fixed "scrap" tag', () => {
    // engine/apply.go:535-541 — when no revealed card has any legal play,
    // the engine emits `SevenPick{Card: c, SubMove: nil}` per revealed
    // card, meaning "scrap this one." The old `slotKey(m.SubMove!)` threw
    // a TypeError on exactly this shape.
    const deadEnd = move({ Kind: 7, Card: THREE_CLUBS, SubMove: null });
    expect(slotKey(deadEnd)).toBe('seven:3:0|scrap');
  });

  it('SPEC §6.2 (amended, B1): two distinct dead-end revealed cards group into two distinct, non-ambiguous slots', () => {
    const moves = [
      move({ Kind: 7, Card: THREE_CLUBS, SubMove: null }),
      move({ Kind: 7, Card: TWO_HEARTS, SubMove: null }),
    ];
    const grouped = groupAffordances(moves);
    expect(grouped).toEqual({
      'seven:3:0|scrap': [0],
      'seven:2:2|scrap': [1],
    });
    expect(isAmbiguousSlot(grouped['seven:3:0|scrap'], moves)).toBe(false);
    expect(isAmbiguousSlot(grouped['seven:2:2|scrap'], moves)).toBe(false);
  });

  it('SPEC §6.2: is total over all 10 MoveKinds — none throw on a well-formed move of that kind, including a dead-end SevenPick', () => {
    // Scuttle's slotKey dereferences `m.Target!` per SPEC §6.2's own
    // pseudocode (a Scuttle with no Target is not a shape the engine
    // produces); every other kind tolerates a fully-null move.
    for (let kind = 0; kind <= 9; kind++) {
      const m = move({
        Kind: kind as Move['Kind'],
        Card: kind === 7 ? TWO_HEARTS : null,
        Target: kind === 3 ? { Owner: 0, Zone: 0, Index: 0 } : null,
        SubMove: kind === 7 ? move({ Kind: 0 }) : null,
      });
      expect(() => slotKey(m)).not.toThrow();
    }
    // The null-SubMove SevenPick shape (B1) is a distinct branch from the
    // loop above (which always gives kind-7 a non-null SubMove) — cover it
    // explicitly so totality includes both SevenPick shapes.
    expect(() => slotKey(move({ Kind: 7, Card: TWO_HEARTS, SubMove: null }))).not.toThrow();
  });

  it('SPEC §6.2: an unrecognized MoveKind is a totality violation, not a silent guess', () => {
    const bogus = move({ Kind: 99 as unknown as Move['Kind'] });
    expect(() => slotKey(bogus)).toThrow(/unhandled MoveKind/);
  });

  it('SPEC §6.2 (B6, optional): a null-Target Scuttle throws a named, diagnostic error rather than a raw TypeError', () => {
    const bogus = move({ Kind: 3, Target: null });
    expect(() => slotKey(bogus)).toThrow(/Scuttle/);
  });
});

// ---------------------------------------------------------------------------
// groupAffordances — SPEC §6.2, and the golden-deal fixture
// ---------------------------------------------------------------------------

describe('groupAffordances', () => {
  it('SPEC §6.2: the golden seed-42 deal groups into 7 slots, one legal move each', () => {
    const grouped = groupAffordances(GOLDEN_MOVES);
    expect(grouped).toEqual({
      deck: [0],
      'hand:0|zone:points': [1],
      'hand:1|zone:points': [2],
      'hand:2|zone:oneoff': [3],
      'hand:2|zone:points': [4],
      'hand:3|zone:permanents': [5],
      'hand:4|zone:permanents': [6],
    });
  });

  it('SPEC §6.2: every legal index lands in exactly one slot (totality of the grouping)', () => {
    const grouped = groupAffordances(GOLDEN_MOVES);
    const seen = new Map<number, string>();
    for (const [key, indices] of Object.entries(grouped)) {
      for (const i of indices) {
        expect(seen.has(i)).toBe(false);
        seen.set(i, key);
      }
    }
    expect(seen.size).toBe(GOLDEN_MOVES.length);
  });

  it('SPEC §6.2: every slot has at least one index', () => {
    const grouped = groupAffordances(GOLDEN_MOVES);
    for (const indices of Object.values(grouped)) {
      expect(indices.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('SPEC §6.2: an empty legal-move list groups to an empty map', () => {
    expect(groupAffordances([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// flattenAffordances — the full index set behind window.__cuttleTestHook (SPEC §6.5)
// ---------------------------------------------------------------------------

describe('flattenAffordances', () => {
  it('SPEC §6.5: flattens back to the full legalMoves index range for the golden deal', () => {
    const grouped = groupAffordances(GOLDEN_MOVES);
    expect(flattenAffordances(grouped)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// isAmbiguousSlot — SPEC §6.4 (the R11 chooser trigger) and its scrap-pick exception
// ---------------------------------------------------------------------------

describe('isAmbiguousSlot', () => {
  it("R11: the golden deal's A♥ lands in two DIFFERENT slots — neither is ambiguous", () => {
    const grouped = groupAffordances(GOLDEN_MOVES);
    expect(grouped['hand:2|zone:oneoff']).toEqual([3]);
    expect(grouped['hand:2|zone:points']).toEqual([4]);
    expect(isAmbiguousSlot(grouped['hand:2|zone:oneoff'], GOLDEN_MOVES)).toBe(false);
    expect(isAmbiguousSlot(grouped['hand:2|zone:points'], GOLDEN_MOVES)).toBe(false);
  });

  it('R11: a singleton slot is never ambiguous', () => {
    expect(isAmbiguousSlot([0], GOLDEN_MOVES)).toBe(false);
  });

  it('R11: a slot with >1 unrelated candidates is ambiguous', () => {
    const moves = [move({ Kind: 0 }), move({ Kind: 0 })]; // two Draws collapse to one slot
    expect(isAmbiguousSlot([0, 1], moves)).toBe(true);
  });

  it('R11: two PlayPoint moves sharing a hand index are ambiguous (synthetic — real engine never offers this)', () => {
    const moves = [
      move({ Kind: 1, HandIndex: 0, Card: TWO_HEARTS }),
      move({ Kind: 1, HandIndex: 0, Card: TWO_HEARTS }),
    ];
    expect(isAmbiguousSlot([0, 1], moves)).toBe(true);
  });

  it('R11: the rank-3 one-off ScrapIndex variants collapse to ONE non-ambiguous slot (SPEC §6.2 last paragraph)', () => {
    const three = { Rank: 3, Suit: 3 } as const;
    const moves = [
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 0 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 1 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 2 }),
    ];
    const grouped = groupAffordances(moves);
    expect(grouped).toEqual({ 'hand:1|zone:oneoff': [0, 1, 2] });
    expect(isAmbiguousSlot(grouped['hand:1|zone:oneoff'], moves)).toBe(false);
  });

  it('R11: a scrap-pick-shaped group is still ambiguous if it does NOT differ only by ScrapIndex', () => {
    const moves = [
      move({ Kind: 4, HandIndex: 1, Card: { Rank: 3, Suit: 3 }, Target: null, ScrapIndex: 0 }),
      // Same slot key, but a different hand card entirely (structurally not a
      // scrap-pick collapse — collapsing here would hide a real ambiguity).
      move({ Kind: 4, HandIndex: 1, Card: { Rank: 4, Suit: 1 }, Target: null, ScrapIndex: 0 }),
    ];
    const grouped = groupAffordances(moves);
    expect(isAmbiguousSlot(grouped['hand:1|zone:oneoff'], moves)).toBe(true);
  });

  it('R11: duplicate ScrapIndex values in a same-card group are NOT a clean collapse (ambiguous)', () => {
    const three = { Rank: 3, Suit: 3 } as const;
    const moves = [
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 0 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 0 }), // duplicate, not distinct
    ];
    const grouped = groupAffordances(moves);
    expect(isAmbiguousSlot(grouped['hand:1|zone:oneoff'], moves)).toBe(true);
  });

  it('R11 (orchestrator cycle 1, B2): a rank-3 revealed by a SevenPick also collapses to ONE non-ambiguous slot', () => {
    // §6.3: a 7's sub-move "replays on the real board exactly as a hand
    // card would" — so a revealed 3's ScrapIndex variants must collapse
    // the same way a hand-played 3's do, just one level down through the
    // SevenPick wrapper. Both the outer SevenPick.Card and the inner
    // OneOff.Card are the revealed 3 (engine/apply.go:107, legalForCard
    // injects the revealed card as HandIndex 0 for the inner enumeration).
    const revealedThree = { Rank: 3, Suit: 1 } as const;
    const moves = [
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 0 }),
      }),
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 1 }),
      }),
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 2 }),
      }),
    ];
    const grouped = groupAffordances(moves);
    const key = 'seven:3:1|hand:0|zone:oneoff';
    expect(grouped).toEqual({ [key]: [0, 1, 2] });
    expect(isAmbiguousSlot(grouped[key], moves)).toBe(false);
  });

  it('R11 (round 2 repair, task 4): a SevenPick group with the same outer card AND the same inner card but a duplicate ScrapIndex stays ambiguous, not collapsed', () => {
    // Real-shape fixture: both candidates reveal the same 3 and both wrap an
    // inner OneOff for that same revealed card (as legalForCard produces),
    // but the engine never actually emits two SevenPicks with an identical
    // ScrapIndex for the same revealed card — si ranges over distinct scrap
    // positions (engine/apply.go:98-111). This guards the structural check
    // itself: it must not collapse on card-identity alone and must still
    // notice when the ScrapIndex sets aren't actually distinct.
    const revealedThree = { Rank: 3, Suit: 1 } as const;
    const moves = [
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 0 }),
      }),
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 0 }), // duplicate, not distinct
      }),
    ];
    const grouped = groupAffordances(moves);
    const key = 'seven:3:1|hand:0|zone:oneoff';
    expect(grouped).toEqual({ [key]: [0, 1] });
    expect(isAmbiguousSlot(grouped[key], moves)).toBe(true);
  });

  it('R11 (B2 guard): a SevenPick group is still ambiguous when the SubMoves do not collapse on their own', () => {
    // `slotKey` never encodes a targetless OneOff's `Card` (only its
    // HandIndex and target-null-ness), so two SubMoves that differ ONLY in
    // Card still produce the same inner slotKey — and therefore the same
    // outer SevenPick slotKey, since the outer key never separately checks
    // inner.Card either. That is exactly the shape the collapse guard
    // must catch: same outer slot, but the SubMoves are not real
    // ScrapIndex variants of one another.
    const revealedThree = { Rank: 3, Suit: 1 } as const;
    const moves = [
      move({
        Kind: 7,
        Card: revealedThree,
        SubMove: move({ Kind: 4, HandIndex: 0, Card: revealedThree, Target: null, ScrapIndex: 0 }),
      }),
      move({
        Kind: 7,
        Card: revealedThree,
        // Inner Card mismatches the outer Card and the other candidate's
        // inner Card — not a shape the real engine produces, but exactly
        // what the structural guard must refuse to collapse.
        SubMove: move({ Kind: 4, HandIndex: 0, Card: { Rank: 4, Suit: 2 }, Target: null, ScrapIndex: 0 }),
      }),
    ];
    const grouped = groupAffordances(moves);
    const keys = Object.keys(grouped);
    expect(keys.length).toBe(1);
    expect(isAmbiguousSlot(grouped[keys[0]], moves)).toBe(true);
  });

  it('R11 (B2 guard): a dead-end SevenPick (null SubMove) never participates in a scrap-pick collapse', () => {
    // Two dead-end 7s that happen to reveal the SAME card can't occur in a
    // real 52-card deck, but the collapse check must still treat a null
    // SubMove as disqualifying rather than crashing or wrongly collapsing.
    const revealedThree = { Rank: 3, Suit: 1 } as const;
    const moves = [
      move({ Kind: 7, Card: revealedThree, SubMove: null }),
      move({ Kind: 7, Card: revealedThree, SubMove: null }),
    ];
    const grouped = groupAffordances(moves);
    expect(grouped).toEqual({ 'seven:3:1|scrap': [0, 1] });
    expect(isAmbiguousSlot(grouped['seven:3:1|scrap'], moves)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveDiscardPicker — R15.2
// ---------------------------------------------------------------------------

describe('deriveDiscardPicker', () => {
  const PHASE_NORMAL: Phase = 0;
  const PHASE_AWAITING_COUNTER: Phase = 1;
  const PHASE_SEVEN_CHOOSING: Phase = 2;
  const PHASE_AWAITING_DISCARD: Phase = 3;
  const PHASE_GAME_OVER: Phase = 4;

  it('R15.2: a 1-card discarding hand pre-selects the single {DiscardA:0, DiscardB:-1} move as confirm', () => {
    const oneCardHandMove = move({ Kind: 8, DiscardA: 0, DiscardB: -1 });
    const result = deriveDiscardPicker(PHASE_AWAITING_DISCARD, [oneCardHandMove]);
    expect(result).toEqual({ mode: 'preselected', moveIndex: 0, discardA: 0, discardB: -1 });
  });

  it('R15.2: a multi-card discarding hand offers every unordered pair for selection, unconfirmed', () => {
    const moves = [
      move({ Kind: 8, DiscardA: 0, DiscardB: 1 }),
      move({ Kind: 8, DiscardA: 0, DiscardB: 2 }),
      move({ Kind: 8, DiscardA: 1, DiscardB: 2 }),
    ];
    const result = deriveDiscardPicker(PHASE_AWAITING_DISCARD, moves);
    expect(result).toEqual({
      mode: 'select',
      candidates: [
        { moveIndex: 0, discardA: 0, discardB: 1 },
        { moveIndex: 1, discardA: 0, discardB: 2 },
        { moveIndex: 2, discardA: 1, discardB: 2 },
      ],
    });
  });

  it('R15.2: the picker never renders outside PhaseAwaitingDiscard — proves the first half unit-side', () => {
    const oneCardHandMove = move({ Kind: 8, DiscardA: 0, DiscardB: -1 });
    const otherPhases: Phase[] = [PHASE_NORMAL, PHASE_AWAITING_COUNTER, PHASE_SEVEN_CHOOSING, PHASE_GAME_OVER];
    for (const phase of otherPhases) {
      expect(deriveDiscardPicker(phase, [oneCardHandMove])).toBeNull();
    }
  });

  it('R15.2: even with zero legal moves offered, a non-AwaitingDiscard phase still reports no picker', () => {
    expect(deriveDiscardPicker(PHASE_NORMAL, [])).toBeNull();
  });

  it('R15.2 (orchestrator cycle 1, point 4 — pinned assumption): a 2-card hand also pre-selects, because it too has exactly one legal unordered pair', () => {
    // ASSUMPTION: `deriveDiscardPicker` pre-selects on `legalMoves.length
    // === 1`, not on "the hand has exactly 1 card." A 2-card hand's own
    // legalDiscardMoves (engine/apply.go:502-518) also produces exactly
    // one move (the single pair {0,1}), so it pre-selects too. This is a
    // conscious, accepted generalization, not a bug — see report.
    const twoCardHandMove = move({ Kind: 8, DiscardA: 0, DiscardB: 1 });
    const result = deriveDiscardPicker(PHASE_AWAITING_DISCARD, [twoCardHandMove]);
    expect(result).toEqual({ mode: 'preselected', moveIndex: 0, discardA: 0, discardB: 1 });
  });
});

// ---------------------------------------------------------------------------
// boardTargetKey — P2 W11 addition (mapping a move to its board target key)
// ---------------------------------------------------------------------------

describe('boardTargetKey', () => {
  it('Draw targets the deck itself', () => {
    expect(boardTargetKey(move({ Kind: 0 }))).toBe('deck');
  });

  it('Pass, Decline, Counter, and DiscardPair have no board location', () => {
    expect(boardTargetKey(move({ Kind: 9 }))).toBeNull();
    expect(boardTargetKey(move({ Kind: 6 }))).toBeNull();
    expect(boardTargetKey(move({ Kind: 5, HandIndex: 2 }))).toBeNull();
    expect(boardTargetKey(move({ Kind: 8, DiscardA: 0, DiscardB: 1 }))).toBeNull();
  });

  it('PlayPoint targets the points zone', () => {
    expect(boardTargetKey(move({ Kind: 1, HandIndex: 0 }))).toBe('zone:points');
  });

  it('PlayPermanent with no JackTarget targets the permanents zone', () => {
    expect(boardTargetKey(move({ Kind: 2, HandIndex: 0, JackTarget: null }))).toBe('zone:permanents');
  });

  it('PlayPermanent with a JackTarget targets that owner/zone/index (a point card)', () => {
    const m = move({ Kind: 2, HandIndex: 5, JackTarget: { Owner: 1, Zone: 0, Index: 2 } });
    expect(boardTargetKey(m)).toBe('point:1:2');
  });

  it('a JackTarget in the permanents zone targets perm:owner:index (generic over Zone, no rule knowledge)', () => {
    const m = move({ Kind: 2, HandIndex: 5, JackTarget: { Owner: 0, Zone: 1, Index: 1 } });
    expect(boardTargetKey(m)).toBe('perm:0:1');
  });

  it('Scuttle targets its Target point card', () => {
    const m = move({ Kind: 3, HandIndex: 1, Target: { Owner: 1, Zone: 0, Index: 0 } });
    expect(boardTargetKey(m)).toBe('point:1:0');
  });

  it('Scuttle with no Target throws a diagnostic error', () => {
    expect(() => boardTargetKey(move({ Kind: 3, Target: null }))).toThrow(/Scuttle/);
  });

  it('targetless OneOff targets the one-off zone', () => {
    expect(boardTargetKey(move({ Kind: 4, HandIndex: 2, Target: null }))).toBe('zone:oneoff');
  });

  it('targeted OneOff (2-as-scrap, 9) targets its owner/zone/index', () => {
    const perm = move({ Kind: 4, HandIndex: 3, Target: { Owner: 0, Zone: 1, Index: 2 } });
    expect(boardTargetKey(perm)).toBe('perm:0:2');
    const point = move({ Kind: 4, HandIndex: 3, Target: { Owner: 1, Zone: 0, Index: 0 } });
    expect(boardTargetKey(point)).toBe('point:1:0');
  });

  it('SevenPick recurses into its SubMove', () => {
    const inner = move({ Kind: 1, HandIndex: 0 });
    const m = move({ Kind: 7, Card: TWO_HEARTS, SubMove: inner });
    expect(boardTargetKey(m)).toBe('zone:points');
  });

  it('a dead-end SevenPick (SubMove: null) targets the scrap pile', () => {
    expect(boardTargetKey(move({ Kind: 7, Card: THREE_CLUBS, SubMove: null }))).toBe('scrap');
  });

  it('an unrecognized MoveKind throws, not a silent guess', () => {
    expect(() => boardTargetKey(move({ Kind: 99 as unknown as Move['Kind'] }))).toThrow(/unhandled MoveKind/);
  });
});

// ---------------------------------------------------------------------------
// stagingAffordances — P2 W11 addition (the round-scoped test-hook data)
// ---------------------------------------------------------------------------

describe('stagingAffordances', () => {
  it('the golden seed-42 deal is fully in scope: identical to groupAffordances (no round-4 kinds present)', () => {
    expect(stagingAffordances(GOLDEN_MOVES)).toEqual(groupAffordances(GOLDEN_MOVES));
  });

  it('excludes Counter, Decline, SevenPick, and DiscardPair slots, keeping in-scope ones', () => {
    const moves = [
      move({ Kind: 5, HandIndex: 0 }), // Counter
      move({ Kind: 6 }), // Decline
      move({ Kind: 7, Card: TWO_HEARTS, SubMove: move({ Kind: 1, HandIndex: 1 }) }), // SevenPick
      move({ Kind: 8, DiscardA: 0, DiscardB: 1 }), // DiscardPair
      move({ Kind: 0 }), // Draw — in scope
      move({ Kind: 1, HandIndex: 2, Card: THREE_CLUBS }), // PlayPoint — in scope
    ];
    expect(stagingAffordances(moves)).toEqual({
      deck: [4],
      'hand:2|zone:points': [5],
    });
  });

  it('excludes a rank-3 scrap-pick collapse (needs the round-4 ScrapBrowser)', () => {
    const three = { Rank: 3, Suit: 3 } as const;
    const moves = [
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 0 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 1 }),
      move({ Kind: 1, HandIndex: 2, Card: TWO_HEARTS }), // unrelated, in-scope
    ];
    expect(stagingAffordances(moves)).toEqual({ 'hand:2|zone:points': [2] });
  });

  it('keeps a genuinely ambiguous in-scope group (two PlayPoint moves sharing a hand index)', () => {
    const moves = [
      move({ Kind: 1, HandIndex: 0, Card: TWO_HEARTS }),
      move({ Kind: 1, HandIndex: 0, Card: TWO_HEARTS }),
    ];
    expect(stagingAffordances(moves)).toEqual({ 'hand:0|zone:points': [0, 1] });
  });

  it('an empty legal-move list produces an empty map', () => {
    expect(stagingAffordances([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// R15.2, second half — driving the real WASM engine toward a 4-vs-empty-hand
// position. A deterministic greedy walk (never random) sheds hand cards
// until a legal OneOff's Card is rank 4 AND the opponent's hand is already
// empty, then applies it and asserts the engine auto-resumed exactly as
// apply.go:621-623 promises (PhaseNormal, not PhaseAwaitingDiscard).
//
// The PRIMARY path replays a single pinned seed deterministically to the
// exact ply where this is already known to happen (seed 2, ply 23). If a
// future engine bump ever moves the pinned position: under `CI` (set by
// scripts/ci.sh, round 2 W7 F1/F2) the test fails immediately with a
// message telling the developer to re-pin — a drifted pin must never pass
// silently in the gate. Outside CI, a bounded multi-seed search below runs
// instead: it is loud-failing only in the sense that it either finds a new
// position (and says so via console.warn) or throws — it never silently
// stops covering this half of R15.2 during local development.
//
// This does NOT prove the UI's DiscardPicker component behavior (that is
// Svelte, out of this round's scope) — it proves the engine-side half of
// R15.2's second clause, which `deriveDiscardPicker` above cannot reach on
// its own because it is a pure function with no engine to auto-resume.
// ---------------------------------------------------------------------------

const MOVE_DRAW = 0;
const MOVE_PLAY_POINT = 1;
const MOVE_PLAY_PERMANENT = 2;
const MOVE_SCUTTLE = 3;
const MOVE_ONE_OFF = 4;
const MOVE_COUNTER = 5;
const MOVE_DECLINE = 6;
const MOVE_SEVEN_PICK = 7;
const MOVE_DISCARD_PAIR = 8;
const MOVE_PASS = 9;
const PHASE_NORMAL = 0;

const REST_OF_PRIORITY = [MOVE_DECLINE, MOVE_SEVEN_PICK, MOVE_DISCARD_PAIR, MOVE_COUNTER, MOVE_DRAW, MOVE_PASS];

/**
 * Sheds hand cards without racing to the points-threshold win, so games run
 * long enough for a hand to actually reach empty. Ranks 3 (takes a card
 * from scrap) and 5 (draws 2) GROW the hand, so those two one-off ranks are
 * deliberately deprioritized below PlayPoint rather than preferred first —
 * everything else that sheds a card without scoring goes first: other
 * one-offs, then permanents (no points), then scuttles (no points), then
 * point plays only as a last resort before falling through to the
 * bookkeeping kinds. This is test-harness search strategy, not production
 * rule logic — affordances.ts never reasons about ranks.
 */
function pickGreedyIndex(legalMoves: Move[]): number {
  const cheapOneOff = legalMoves.findIndex(
    (m) => m.Kind === MOVE_ONE_OFF && m.Card !== null && m.Card.Rank !== 3 && m.Card.Rank !== 5,
  );
  if (cheapOneOff !== -1) return cheapOneOff;

  const permanent = legalMoves.findIndex((m) => m.Kind === MOVE_PLAY_PERMANENT);
  if (permanent !== -1) return permanent;

  const scuttle = legalMoves.findIndex((m) => m.Kind === MOVE_SCUTTLE);
  if (scuttle !== -1) return scuttle;

  const point = legalMoves.findIndex((m) => m.Kind === MOVE_PLAY_POINT);
  if (point !== -1) return point;

  const growingOneOff = legalMoves.findIndex((m) => m.Kind === MOVE_ONE_OFF);
  if (growingOneOff !== -1) return growingOneOff;

  for (const kind of REST_OF_PRIORITY) {
    const idx = legalMoves.findIndex((m) => m.Kind === kind);
    if (idx !== -1) return idx;
  }
  return 0;
}

function ok(result: BridgeResult): Envelope {
  if (!result.ok) throw new Error(`bridge call failed: ${result.code}: ${result.message}`);
  return result;
}

interface JackpotResult {
  seed: number;
  ply: number;
  after: Envelope;
}

/**
 * Replays `seed` with the greedy hand-depletion heuristic, up to
 * `maxPlies`. Returns the position and post-apply envelope the moment a
 * legal `OneOff` rank-4 move is offered against an already-empty-handed
 * opponent, or `null` if the walk ends (GameOver, no legal moves, or a
 * misfired heuristic move) before that happens.
 */
function walkToJackpot(seed: number, maxPlies: number): JackpotResult | null {
  let envelope = ok(engineNewGame({ seed: String(seed) }));

  for (let ply = 0; ply < maxPlies; ply++) {
    if (envelope.state.phase === 4 /* PhaseGameOver */ || envelope.legalMoves.length === 0) {
      return null;
    }

    const jackpotIndex = envelope.legalMoves.findIndex(
      (m) => m.Kind === MOVE_ONE_OFF && m.Card !== null && m.Card.Rank === 4 && envelope.state.opponent.handCount === 0,
    );

    if (jackpotIndex !== -1) {
      const after = ok(engineApply(jackpotIndex));
      return { seed, ply, after };
    }

    const index = pickGreedyIndex(envelope.legalMoves);
    const applied = engineApply(index);
    if (!applied.ok) return null; // heuristic misfired for this seed; caller moves on
    envelope = ok(engineLegalMoves());
  }
  return null;
}

describe('R15.2 (engine half): 4-vs-empty-hand auto-resume against the real WASM engine', () => {
  it(
    'pinned replay (seed 2, ply 23) reaches the position; a bounded search is the loud-failing fallback if the pin ever drifts',
    async () => {
      await createWasmEngine(); // boots the WASM bridge; we then call engine.ts directly for full Move typing

      const PINNED_SEED = 2;
      const PINNED_PLY = 23;

      let result = walkToJackpot(PINNED_SEED, PINNED_PLY + 1);

      if (result === null || result.ply !== PINNED_PLY) {
        // The pin drifted (engine bump, heuristic edit, …).
        if (process.env.CI) {
          // In the gate (scripts/ci.sh exports CI=1, round 2 W7 F1/F2), a
          // drifted pin must not pass silently — even a successful fallback
          // search would hide the fact that the pin is now stale. Fail
          // loudly and tell the developer exactly what to do.
          throw new Error(
            `R15.2 pinned replay drifted under CI: seed ${PINNED_SEED}@ply${PINNED_PLY} ` +
              `${result === null ? 'found nothing' : `now reaches ply ${result.ply} instead`}. ` +
              `Re-pin PINNED_SEED/PINNED_PLY in this test to the new position and verify locally ` +
              '(run without CI set to see the fallback search locate a candidate).',
          );
        }
        // Outside CI: don't treat this as "this half is now unproven" —
        // widen the search so a real regression (auto-resume disappearing)
        // still fails loud instead of being masked by "well, the pin just
        // moved."
        const SEEDS = 500;
        const MAX_PLIES = 400;
        let fallback: JackpotResult | null = null;
        for (let seed = 1; seed <= SEEDS && fallback === null; seed++) {
          fallback = walkToJackpot(seed, MAX_PLIES);
        }
        if (fallback === null) {
          throw new Error(
            `R15.2 engine search: no 4-vs-empty-hand position found — neither the pinned seed ${PINNED_SEED}@ply${PINNED_PLY} ` +
              `(got ${result === null ? 'nothing' : `ply ${result.ply}`}) nor a ${SEEDS}-seed × ${MAX_PLIES}-ply fallback search ` +
              'reached one. This half of R15.2 is unproven.',
          );
        }
        console.warn(
          `[R15.2 engine search] pinned seed ${PINNED_SEED}@ply${PINNED_PLY} drifted; fallback found seed=${fallback.seed} ply=${fallback.ply}`,
        );
        result = fallback;
      }

      const { after } = result;
      expect(after.state.phase).toBe(PHASE_NORMAL);
      // The would-be discarder's hand is still empty — no discard happened.
      expect(after.state.opponent.handCount).toBe(0);
      // The turn passed: control is no longer with the player who just
      // played the 4 (apply()'s envelope keeps `viewer` as the mover, so a
      // changed `active` proves endTurn ran instead of entering
      // PhaseAwaitingDiscard, per §4.4's auto-resume row).
      expect(after.state.active).not.toBe(after.state.viewer);
    },
    30_000,
  );
});
