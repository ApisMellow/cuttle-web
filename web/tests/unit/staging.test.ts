// P2 W11 — StagingStore (SPEC §5.3, §6.1–§6.5). Part 1 drives the pipeline
// with canned `Move[]` fixtures, mirroring `affordances.test.ts`'s `move()`
// helper style, for fast, deterministic coverage of every state transition,
// including the round-4 "never stage a wrong index" exclusions. Part 2
// drives the REAL wasm engine for the invariants that must hold against
// actual `LegalMoves()` output: R11.3's golden-scenario chooser, and a
// completeness/soundness/R12 walk across several seeded games.

import { describe, expect, it } from 'vitest';

import type { BridgeResult, Envelope, Move } from '../../src/lib/bridge/schema';
import {
  apply as engineApply,
  newGame as engineNewGame,
  view as engineView,
} from '../../src/lib/bridge/engine';
import { boardTargetKey, stagingAffordances } from '../../src/lib/affordances';
import { MoveKind } from '../../src/lib/enums';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';
import type { TargetKey } from '../../src/lib/targetKey';
import { createWasmEngine } from '../scenario/wasm-engine';

// ---------------------------------------------------------------------------
// Part 1 — canned fixtures
// ---------------------------------------------------------------------------

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

const CLUBS_3 = { Rank: 3, Suit: 0 } as const;
const HEARTS_ACE = { Rank: 1, Suit: 2 } as const;

/** A no-op default `apply` for tests that never confirm. */
async function neverApply(): Promise<void> {
  throw new Error('apply() should not have been called by this test');
}

function envOf(legalMoves: Move[], descriptions?: string[]): () => StagingEnv {
  const d = descriptions ?? legalMoves.map((_, i) => `move ${i}`);
  return () => ({ legalMoves, descriptions: d });
}

describe('StagingStore — idle/selected/staged pipeline (SPEC §6.1)', () => {
  it('a hand card with no in-scope candidate opens the inspect popover instead of selecting (SPEC §6.1, R9.3)', () => {
    // Only a Counter move exists for hand index 0 — round-4, so index 0 has
    // no candidate this round's pipeline can act on.
    const legalMoves = [move({ Kind: 5, HandIndex: 0 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);

    store.tap('hand:0');

    expect(store.state).toBe('idle');
    expect(store.selectedHand).toBeNull();
    expect(store.inspect).toBe(0);
  });

  it('a single-candidate hand card selects, highlights its one zone, and stages on that zone tap (SPEC §6.1)', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 2, Card: CLUBS_3 })]; // PlayPoint
    const descriptions = ['play 3♣ as point card'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);

    store.tap('hand:2');
    expect(store.state).toBe('selected');
    expect(store.selectedHand).toBe(2);
    expect(store.highlighted).toEqual(new Set(['zone:points']));

    store.tap('zone:points');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('play 3♣ as point card');
    expect(store.staged).toEqual(new Set(['hand:2', 'zone:points']));
    expect(store.highlighted).toEqual(new Set());
  });

  it('tapping a non-highlighted key while selected clears to idle and stages nothing (SPEC §6.1, R9.4)', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 2, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);

    store.tap('hand:2');
    store.tap('zone:permanents'); // not highlighted for this card

    expect(store.state).toBe('idle');
    expect(store.selectedHand).toBeNull();
    expect(store.stagedIndex).toBeNull();
  });

  it('tapping a different hand card while selected re-selects (SPEC §6.1)', () => {
    const legalMoves = [
      move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 }),
      move({ Kind: 2, HandIndex: 1, Card: HEARTS_ACE, JackTarget: null }),
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);

    store.tap('hand:0');
    expect(store.selectedHand).toBe(0);
    store.tap('hand:1');
    expect(store.selectedHand).toBe(1);
    expect(store.highlighted).toEqual(new Set(['zone:permanents']));
  });

  it('cancel() while merely selected (no chooser) is a no-op — Cancel is only wired to staged and the chooser (SPEC §6.1, §6.4)', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('hand:0');
    store.cancel();
    expect(store.state).toBe('selected');
    expect(store.selectedHand).toBe(0);
  });

  it('cancel() from staged returns to idle without calling apply', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('hand:0');
    store.tap('zone:points');
    expect(store.state).toBe('staged');

    store.cancel();

    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
    expect(store.staged).toEqual(new Set());
  });

  it('reset() clears back to idle from any pipeline state', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('hand:0');
    store.reset();
    expect(store.state).toBe('idle');
    expect(store.selectedHand).toBeNull();

    store.tap('hand:0');
    store.tap('zone:points');
    store.reset();
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });

  it('a subsequent tap dismisses a prior inspect popover (SPEC §6.1)', () => {
    const legalMoves = [
      move({ Kind: 5, HandIndex: 0 }), // Counter — no in-scope candidate
      move({ Kind: 1, HandIndex: 1, Card: CLUBS_3 }),
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('hand:0');
    expect(store.inspect).toBe(0);
    store.tap('hand:1');
    expect(store.inspect).toBeNull();
    expect(store.state).toBe('selected');
  });
});

describe('StagingStore — different-zone candidates resolve by zone tap, no chooser (SPEC §6.4, §2.6)', () => {
  // The golden scenario's Ace: hand:2 offers a targetless one-off ([0]) and
  // a point play ([1]) — two DIFFERENT board keys. affordances.ts's own
  // suite (`isAmbiguousSlot`) already treats these as two separate,
  // non-ambiguous slots; the store must resolve each with its own zone tap,
  // never a chooser. See this file's engine-driven R11.3 test below and the
  // hand-back report for the SPEC §2.6 vs §6.4 tension this reflects.
  const legalMoves = [
    move({ Kind: 4, HandIndex: 2, Card: HEARTS_ACE, Target: null }), // [0] one-off
    move({ Kind: 1, HandIndex: 2, Card: HEARTS_ACE }), // [1] point card
  ];
  const descriptions = ['play A♥ as one-off', 'play A♥ as point card'];

  it('both zones highlight, and no chooser opens', () => {
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);
    store.tap('hand:2');
    expect(store.highlighted).toEqual(new Set(['zone:oneoff', 'zone:points']));
    expect(store.chooser).toBeNull();
  });

  it('tapping zone:oneoff stages the one-off directly', () => {
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);
    store.tap('hand:2');
    store.tap('zone:oneoff');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('play A♥ as one-off');
    expect(store.chooser).toBeNull();
  });

  it('tapping zone:points stages the point play directly', () => {
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);
    store.tap('hand:2');
    store.tap('zone:points');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1);
    expect(store.stagedDescription).toBe('play A♥ as point card');
  });
});

describe('StagingStore — genuine ambiguity opens the chooser (SPEC §6.4)', () => {
  it('two candidates sharing one board key (synthetic — same hand index, same zone) open the chooser on that zone tap', () => {
    const legalMoves = [
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 0 } }),
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 1 } }),
    ];
    const descriptions = ['play 2♣ as point card', 'play 2♦ as point card'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);

    store.tap('hand:0');
    expect(store.highlighted).toEqual(new Set(['zone:points']));
    store.tap('zone:points');

    expect(store.state).toBe('selected');
    expect(store.chooser).toEqual({
      candidates: [
        { index: 0, description: 'play 2♣ as point card' },
        { index: 1, description: 'play 2♦ as point card' },
      ],
    });
    expect(store.stagedIndex).toBeNull();
  });

  it('choosing an invalid index is a no-op; choosing a valid one stages it, never applying directly', () => {
    const legalMoves = [
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 0 } }),
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 1 } }),
    ];
    const descriptions = ['play 2♣ as point card', 'play 2♦ as point card'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);
    store.tap('hand:0');
    store.tap('zone:points');

    store.choose(99);
    expect(store.chooser).not.toBeNull();
    expect(store.state).toBe('selected');

    store.choose(1);
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1);
    expect(store.stagedDescription).toBe('play 2♦ as point card');
    expect(store.chooser).toBeNull();
  });

  it('choose() bounds-checks the index against the CURRENT env, not just the chooser it was built from (SPEC §6.4, §5.3)', () => {
    // `#getEnv()` is re-invoked fresh inside choose(), separately from the
    // env that built `this.chooser.candidates` when the target was tapped.
    // If the integrator's position moved on between the tap and the choose()
    // call (e.g. an external refresh shrank legalMoves), an index that was a
    // real chooser candidate can be out of range for the CURRENT env. choose()
    // must refuse to stage it rather than reading past the current array.
    const legalMoves = [
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 0 } }),
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 1 } }),
    ];
    const descriptions = ['play 2♣ as point card', 'play 2♦ as point card'];
    let currentMoves = legalMoves;
    let currentDescriptions = descriptions;
    const store = new StagingStore(() => ({ legalMoves: currentMoves, descriptions: currentDescriptions }), neverApply);

    store.tap('hand:0');
    store.tap('zone:points');
    expect(store.chooser?.candidates.map((c) => c.index)).toEqual([0, 1]);

    // The env shrinks out from under the open chooser — index 1 no longer
    // exists in the CURRENT legalMoves, even though it was a real candidate
    // when the chooser opened.
    currentMoves = [legalMoves[0]];
    currentDescriptions = [descriptions[0]];

    store.choose(1);

    expect(store.state).toBe('selected');
    expect(store.chooser).not.toBeNull();
    expect(store.stagedIndex).toBeNull();
    expect(store.staged).toEqual(new Set());
  });

  it('cancel() from an open chooser returns to idle', () => {
    const legalMoves = [
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 0 } }),
      move({ Kind: 1, HandIndex: 0, Card: { Rank: 2, Suit: 1 } }),
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('hand:0');
    store.tap('zone:points');
    expect(store.chooser).not.toBeNull();

    store.cancel();

    expect(store.state).toBe('idle');
    expect(store.chooser).toBeNull();
  });

  it('a Scuttle and a targeted OneOff sharing the same point card are cross-kind ambiguous (SPEC §6.4 "a 2 — mixed")', () => {
    const point = { Owner: 1 as const, Zone: 0 as const, Index: 0 };
    const legalMoves = [
      move({ Kind: 3, HandIndex: 0, Card: { Rank: 9, Suit: 2 }, Target: point }), // Scuttle
      move({ Kind: 4, HandIndex: 0, Card: { Rank: 9, Suit: 2 }, Target: point }), // OneOff-9 targeted
    ];
    const descriptions = ['scuttle 10♦ with 9♥', 'play 9♥ — return 10♦ to their hand'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);

    store.tap('hand:0');
    expect(store.highlighted).toEqual(new Set(['point:1:0']));
    store.tap('point:1:0');

    expect(store.chooser).toEqual({
      candidates: [
        { index: 0, description: 'scuttle 10♦ with 9♥' },
        { index: 1, description: 'play 9♥ — return 10♦ to their hand' },
      ],
    });
  });
});

describe('StagingStore — round-4 kinds never stage a wrong index (P2 W11 brief)', () => {
  it('a rank-3 scrap-pick collapse (multiple ScrapIndex variants) highlights the zone but tapping it stages nothing — no ScrapBrowser this round', () => {
    const three = { Rank: 3, Suit: 3 } as const;
    const legalMoves = [
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 0 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 1 }),
      move({ Kind: 4, HandIndex: 1, Card: three, Target: null, ScrapIndex: 2 }),
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);

    store.tap('hand:1');
    expect(store.state).toBe('selected');
    expect(store.highlighted).toEqual(new Set(['zone:oneoff'])); // still shown as playable

    store.tap('zone:oneoff');

    // Never stages, never opens a chooser (SPEC §6.2 excludes this shape
    // from the chooser too) — the tap is a deliberate no-op.
    expect(store.state).toBe('selected');
    expect(store.chooser).toBeNull();
    expect(store.stagedIndex).toBeNull();
    expect(store.staged).toEqual(new Set());
  });

  it('a hand card playable only via Counter (round 4) dims instead of selecting, and does not corrupt an unrelated in-scope card', () => {
    const legalMoves = [
      move({ Kind: 5, HandIndex: 0 }), // Counter
      move({ Kind: 1, HandIndex: 1, Card: CLUBS_3 }), // in-scope
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);

    expect(store.dimmedHand).toEqual(new Set([0]));

    store.tap('hand:0');
    expect(store.state).toBe('idle');
    expect(store.inspect).toBe(0);

    store.tap('hand:1');
    expect(store.state).toBe('selected');
    expect(store.selectedHand).toBe(1);
  });

  it('Decline/SevenPick/DiscardPair moves contribute nothing to dimmedHand (they never name a specific hand card this round cares about)', () => {
    const legalMoves = [
      move({ Kind: 6 }), // Decline
      move({ Kind: 7, Card: HEARTS_ACE, SubMove: move({ Kind: 1, HandIndex: 0, Card: HEARTS_ACE }) }), // SevenPick
      move({ Kind: 8, DiscardA: 0, DiscardB: 1 }), // DiscardPair
    ];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    expect(store.dimmedHand).toEqual(new Set());
  });
});

describe('StagingStore — Draw and Pass go straight to staged (no target step, SPEC §6.1, §6.3)', () => {
  it('a single legal Draw stages immediately on tap(\'deck\'), skipping "selected"', () => {
    const legalMoves = [move({ Kind: 0 })];
    const descriptions = ['draw a card'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);

    store.tap('deck');

    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.stagedDescription).toBe('draw a card');
    expect(store.staged).toEqual(new Set(['deck']));
    expect(store.selectedHand).toBeNull();
  });

  it('tap(\'deck\') with no legal Draw is a no-op', () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), neverApply);
    store.tap('deck');
    expect(store.state).toBe('idle');
  });

  it('two synthetic legal Draws open the chooser directly from idle (no target step to separate them)', () => {
    const legalMoves = [move({ Kind: 0 }), move({ Kind: 0 })];
    const descriptions = ['draw a card', 'draw a card (dup)'];
    const store = new StagingStore(envOf(legalMoves, descriptions), neverApply);

    store.tap('deck');

    expect(store.state).toBe('selected');
    expect(store.chooser).toEqual({
      candidates: [
        { index: 0, description: 'draw a card' },
        { index: 1, description: 'draw a card (dup)' },
      ],
    });
    store.choose(1);
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(1);
  });

  it('passAvailable is true only when legalMoves is exactly [Pass]; tap(\'pass\') stages it', () => {
    const passOnly = [move({ Kind: 9 })];
    const store = new StagingStore(envOf(passOnly, ['pass']), neverApply);
    expect(store.passAvailable).toBe(true);

    store.tap('pass');
    expect(store.state).toBe('staged');
    expect(store.stagedIndex).toBe(0);
    expect(store.staged).toEqual(new Set(['pass']));
  });

  it('passAvailable is false when Pass coexists with anything else, and tap(\'pass\') is then a no-op', () => {
    const mixed = [move({ Kind: 9 }), move({ Kind: 0 })];
    const store = new StagingStore(envOf(mixed), neverApply);
    expect(store.passAvailable).toBe(false);
    store.tap('pass');
    expect(store.state).toBe('idle');
  });
});

describe('StagingStore — R12: apply only from confirm(), and only once (SPEC §6.1)', () => {
  it('confirm() is a no-op unless state is staged; apply is never called', async () => {
    let calls = 0;
    const apply = async () => {
      calls += 1;
    };
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), apply);

    await store.confirm(); // idle
    store.tap('hand:0');
    await store.confirm(); // selected
    expect(calls).toBe(0);
  });

  it('confirm() calls apply exactly once with the staged index, then returns to idle', async () => {
    const calls: number[] = [];
    const apply = async (index: number) => {
      calls.push(index);
    };
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), apply);
    store.tap('hand:0');
    store.tap('zone:points');

    await store.confirm();

    expect(calls).toEqual([0]);
    expect(store.state).toBe('idle');
    expect(store.stagedIndex).toBeNull();
  });

  it('a rapid second confirm() before the first resolves never calls apply twice; the board is inert meanwhile', async () => {
    let resolveApply: (() => void) | undefined;
    const calls: number[] = [];
    const apply = (index: number) =>
      new Promise<void>((resolve) => {
        calls.push(index);
        resolveApply = resolve;
      });
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const store = new StagingStore(envOf(legalMoves), apply);
    store.tap('hand:0');
    store.tap('zone:points');

    const first = store.confirm();
    expect(store.state).toBe('applying');
    expect(store.inert).toBe(true);

    const second = store.confirm(); // must be a no-op — state is already 'applying'
    store.tap('hand:0'); // any tap during 'applying' is also a no-op
    expect(calls).toEqual([0]); // apply invoked exactly once so far

    resolveApply?.();
    await Promise.all([first, second]);

    expect(calls).toEqual([0]);
    expect(store.state).toBe('idle');
    expect(store.inert).toBe(false);
  });

  it('a rejected apply() still clears the store back to idle via confirm()\'s finally (SPEC §6.1)', async () => {
    const legalMoves = [move({ Kind: 1, HandIndex: 0, Card: CLUBS_3 })];
    const failure = new Error('engine rejected the move');
    const apply = async () => {
      throw failure;
    };
    const store = new StagingStore(envOf(legalMoves), apply);
    store.tap('hand:0');
    store.tap('zone:points');
    expect(store.state).toBe('staged');

    await expect(store.confirm()).rejects.toBe(failure);

    // The rejection must not strand the store in 'applying': confirm()'s
    // finally always runs #clearToIdle(), even when apply() throws.
    expect(store.state).toBe('idle');
    expect(store.inert).toBe(false);
    expect(store.stagedIndex).toBeNull();
    expect(store.selectedHand).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — driven by the real wasm engine
// ---------------------------------------------------------------------------

function ok(result: BridgeResult): Envelope {
  if (!result.ok) throw new Error(`bridge call failed: ${result.code}: ${result.message}`);
  return result;
}

describe('StagingStore — R11.3, golden seed 42 dealer 1: A♥ at hand index 2 (SPEC §2.6, §6.4)', () => {
  it('resolves by zone tap to exactly the engine\'s two descriptions, never applying directly', async () => {
    await createWasmEngine(); // boots wasm; calls go through lib/bridge/engine.ts for full typing

    const envelope = ok(engineNewGame({ seed: '42', dealer: 1 }));
    expect(envelope.legalMoves).toHaveLength(7);

    const env: StagingEnv = { legalMoves: envelope.legalMoves, descriptions: envelope.descriptions };
    const oneOffIndex = envelope.legalMoves.findIndex((m) => m.Kind === 4 && m.HandIndex === 2);
    const pointIndex = envelope.legalMoves.findIndex((m) => m.Kind === 1 && m.HandIndex === 2);
    expect(oneOffIndex).toBe(3);
    expect(pointIndex).toBe(4);

    // Take the strings from the engine itself, per the brief — not hand-typed.
    expect(envelope.descriptions[oneOffIndex]).toBe('play A♥ as one-off');
    expect(envelope.descriptions[pointIndex]).toBe('play A♥ as point card');

    // SPEC-tension note (see hand-back report): requirements.yaml's R11.3
    // text describes this as "opens AmbiguityChooser listing exactly the 2
    // candidate descriptions". SPEC §6.4's own worked example calls the
    // Ace's two moves "two different zones again" (matching the 8's
    // "actually resolved by the zone tap; a chooser appears only if a
    // design later merges the zones") — and the existing, already-verified
    // `affordances.ts` suite treats hand:2's two slots as non-ambiguous
    // because they differ in zone. This test follows §6.4 + the shipped
    // `isAmbiguousSlot` classification: two zone taps, no chooser, both
    // ending in `staged`.
    const oneOffStore = new StagingStore(() => env, neverApply);
    oneOffStore.tap('hand:2');
    expect(oneOffStore.chooser).toBeNull();
    expect(oneOffStore.highlighted).toEqual(new Set(['zone:oneoff', 'zone:points']));
    oneOffStore.tap('zone:oneoff');
    expect(oneOffStore.state).toBe('staged');
    expect(oneOffStore.stagedIndex).toBe(oneOffIndex);
    expect(oneOffStore.stagedDescription).toBe(envelope.descriptions[oneOffIndex]);

    const pointStore = new StagingStore(() => env, neverApply);
    pointStore.tap('hand:2');
    pointStore.tap('zone:points');
    expect(pointStore.state).toBe('staged');
    expect(pointStore.stagedIndex).toBe(pointIndex);
    expect(pointStore.stagedDescription).toBe(envelope.descriptions[pointIndex]);
  });
});

/** The tap sequence that resolves `move`: `['deck']`/`['pass']`, or `['hand:H', targetKey]`. */
function tapSequenceFor(move: Move): TargetKey[] {
  switch (move.Kind) {
    case 0:
      return ['deck'];
    case 9:
      return ['pass'];
    default: {
      const target = boardTargetKey(move);
      if (target === null) throw new Error(`tapSequenceFor: no board key for in-scope kind ${move.Kind}`);
      return [`hand:${move.HandIndex}`, target];
    }
  }
}

/**
 * SPEC §6.5 — completeness and soundness at one position: every index
 * `stagingAffordances` says this round can reach really is reachable by its
 * tap sequence (ending in `staged` for a singleton, or `choose()` for a
 * genuine ambiguity), and nothing else ever gets staged along the way.
 */
function probePosition(envelope: Envelope): void {
  const env: StagingEnv = { legalMoves: envelope.legalMoves, descriptions: envelope.descriptions };
  const reachable = stagingAffordances(envelope.legalMoves);

  for (const indices of Object.values(reachable)) {
    for (const index of indices) {
      const store = new StagingStore(() => env, neverApply);
      const move = envelope.legalMoves[index];
      const [first, second] = tapSequenceFor(move);
      store.tap(first);
      if (second) store.tap(second);

      if (store.state !== 'staged') {
        // A genuine ambiguity at the board-key level (SPEC §6.4) — the
        // store groups by board key, which can be coarser than an
        // affordances.ts slot (e.g. a Scuttle and a targeted OneOff at the
        // same point card are different slots but one board key). The
        // target tap opened the chooser instead of staging directly;
        // resolve it explicitly and never accept anything but a real
        // chooser here.
        expect(store.state).toBe('selected');
        expect(store.chooser).not.toBeNull();
        expect(store.chooser?.candidates.some((c) => c.index === index)).toBe(true);
        store.choose(index);
      }

      // Completeness: this exact index is reachable.
      expect(store.state).toBe('staged');
      expect(store.stagedIndex).toBe(index);
      expect(store.stagedDescription).toBe(envelope.descriptions[index]);
    }
  }

  // Soundness (the cheap half provable without a full tap-space fuzz):
  // every index `stagingAffordances` reports is drawn from `legalMoves`
  // itself and is unique across the whole map — no affordance invents an
  // index the engine didn't offer, and none double-claims another's.
  const seen = new Set<number>();
  for (const indices of Object.values(reachable)) {
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(envelope.legalMoves.length);
      expect(seen.has(index)).toBe(false);
      seen.add(index);
    }
  }
}

// Mirrors `staging.svelte.ts`'s private `IN_SCOPE_HAND_KINDS` — the kinds
// `#selectHand`/`candidatesByTargetKey` will actually group under a hand
// index, whether or not that hand card's slot survives into
// `stagingAffordances`'s round-4-filtered `reachable` map (a rank-3
// scrap-pick collapse is IN_SCOPE and reaches `selected`, SPEC §6.2 last
// paragraph, but is deliberately excluded from `reachable`).
const IN_SCOPE_HAND_KINDS = new Set<Move['Kind']>([
  MoveKind.PlayPoint,
  MoveKind.PlayPermanent,
  MoveKind.Scuttle,
  MoveKind.OneOff,
]);

/**
 * Soundness, the exploratory half: from a freshly `selected` in-scope hand
 * card, tapping every OTHER in-scope hand card's own target keys must never
 * stage anything for the wrong card — either it clears to idle (a
 * non-highlighted key, R9.4) or, if two cards happen to share a board key
 * by coincidence, it stages only a move that genuinely belongs to that key
 * per `legalMoves` (never a foreign index).
 *
 * The key space is drawn from the FULL `legalMoves` list, not from
 * `stagingAffordances`'s round-4-filtered `reachable` map: a scrap-pick
 * collapse or any other kind `reachable` drops still contributes a real
 * `selected` state and a real board key inside the store (`#selectHand`
 * groups by `IN_SCOPE_HAND_KINDS` directly, not by `reachable`), so a
 * narrower probe misses exactly the hand cards and keys `reachable` doesn't
 * carry — the wider space is what actually walks every path `tap()` can
 * take this round.
 */
function probeCrossTalk(envelope: Envelope): void {
  const env: StagingEnv = { legalMoves: envelope.legalMoves, descriptions: envelope.descriptions };
  const handIndices = new Set<number>();
  const allKeys = new Set<TargetKey>();
  for (const m of envelope.legalMoves) {
    if (IN_SCOPE_HAND_KINDS.has(m.Kind)) handIndices.add(m.HandIndex);
    const key = boardTargetKey(m);
    if (key !== null) allKeys.add(key);
  }

  for (const handIndex of handIndices) {
    for (const key of allKeys) {
      const store = new StagingStore(() => env, neverApply);
      store.tap(`hand:${handIndex}`);
      const afterSelect: string = store.state;
      if (afterSelect !== 'selected') continue; // dimmed — nothing to probe
      store.tap(key);
      const afterTarget: string = store.state;
      if (afterTarget === 'staged') {
        // Whatever staged must be a move that is actually rooted at this
        // hand index and whose board key is exactly the tapped one —
        // never a foreign card's move.
        const staged = envelope.legalMoves[store.stagedIndex as number];
        expect(staged.HandIndex).toBe(handIndex);
        expect(boardTargetKey(staged)).toBe(key);
      }
    }
  }
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe('StagingStore — completeness and soundness across sampled positions (SPEC §6.5)', () => {
  it(
    'the golden seed-42 opening position',
    async () => {
      await createWasmEngine();
      const envelope = ok(engineNewGame({ seed: '42', dealer: 1 }));
      probePosition(envelope);
      probeCrossTalk(envelope);
    },
    30_000,
  );

  it(
    'a random walk over several seeded games',
    async () => {
      await createWasmEngine();
      const seeds = [1, 2, 3, 7, 11];
      for (const seed of seeds) {
        let envelope = ok(engineNewGame({ seed: String(seed), dealer: (seed & 1) as 0 | 1 }));
        const random = xorshift32(seed);
        for (let step = 0; step < 60 && envelope.state.phase !== 4; step += 1) {
          if (envelope.legalMoves.length === 0) break;
          probePosition(envelope);
          probeCrossTalk(envelope);

          const index = random() % envelope.legalMoves.length;
          const applied = engineApply(index);
          if (!applied.ok) break;
          // `apply` returns the MOVER's view; the next position's legal
          // moves come from `view()` for whoever is active next (mirrors
          // tests/smoke/bridge-smoke.mjs and tests/scenario/wasm-engine.ts).
          envelope = ok(engineView(applied.state.active));
        }
      }
    },
    60_000,
  );
});
