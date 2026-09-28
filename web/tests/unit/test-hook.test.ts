// @vitest-environment jsdom
// SPEC §6.5 — `window.__cuttleTestHook` reads the current holder's envelope
// only while that holder is legitimately looking: curtain `none` or a REAL
// counter window. Behind every other curtain (a synthetic ack, recap, and
// the rest) every accessor returns empty, even when an envelope is handed to
// it. The store happens to hold `null` at recap, so this is tested against
// the hook directly: the promise is the hook's own, not the store's.
import { afterEach, describe, expect, it } from 'vitest';

import type { Envelope, Move, PlayerId } from '../../src/lib/bridge/schema';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { installTestHook, reachableAffordances } from '../../src/lib/testHook';
import { Kind, appliedMove, envelope, playerView } from './game-test-support';

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return {
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

/** A held envelope with a live Draw and a Decline/Counter pair, so any exposure is non-empty. */
function held(): Envelope {
  return envelope({
    state: playerView({ viewer: 1, active: 1 }),
    legalMoves: [
      mv({ Kind: Kind.Draw }),
      mv({ Kind: Kind.Decline }),
      mv({ Kind: Kind.Counter, HandIndex: 1, Card: { Rank: 2, Suit: 1 } }),
    ],
    descriptions: ['draw a card', 'decline', 'counter with 2♦'],
    history: [appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, description: 'play 9♥ as one-off' })],
  });
}

const WITHHELD: CurtainState[] = [
  { kind: 'ack', to: 1, synthetic: true },
  { kind: 'recap', to: 1, entries: [appliedMove({ by: 0, kind: Kind.OneOff, seq: 1 })] },
  { kind: 'handoff', to: 1, reason: 'counter' },
  { kind: 'reveal', to: 1 },
  { kind: 'result' },
];

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function install(curtain: CurtainState, env: Envelope): NonNullable<Window['__cuttleTestHook']> {
  uninstall = installTestHook({
    curtain: () => curtain,
    envelope: () => env,
    viewer: () => 1 as PlayerId,
    seq: () => env.seq,
    newGame: () => Promise.resolve(),
  });
  return window.__cuttleTestHook!;
}

describe('test hook redaction (SPEC §6.5)', () => {
  it.each(WITHHELD)('curtain $kind: affordances() and moves() are empty even with an envelope held', (curtain) => {
    const env = held();
    expect(reachableAffordances(curtain, env)).toEqual({});
    const hook = install(curtain, env);
    expect(hook.affordances()).toEqual({});
    expect(hook.moves()).toEqual([]);
  });

  it('control: a real counter window exposes the counter and decline slots', () => {
    const hook = install({ kind: 'ack', to: 1, synthetic: false }, held());
    expect(hook.affordances()).toEqual({ decline: [1], 'counter:1': [2] });
    expect(hook.moves()).toHaveLength(3);
  });

  it('control: curtain none exposes the staging map', () => {
    const hook = install({ kind: 'none' }, held());
    expect(hook.moves()).toHaveLength(3);
    expect(Object.keys(hook.affordances()).length).toBeGreaterThan(0);
  });
});

describe('test hook at curtain none covers the W15 pickers (SPEC §6.5)', () => {
  const EIGHT = { Rank: 8, Suit: 1 } as const;
  const THREE = { Rank: 3, Suit: 0 } as const;

  it('SevenPick slots are reachable, with the revealed card index for each move', () => {
    const env = envelope({
      state: playerView({ viewer: 0, active: 0, phase: 2, sevenRevealed: [{ Rank: 11, Suit: 0 }, EIGHT] }),
      legalMoves: [mv({ Kind: Kind.SevenPick, Card: EIGHT, SubMove: mv({ Kind: Kind.PlayPoint, Card: EIGHT }) })],
      descriptions: ['7: play 8♦ as point card'],
    });
    expect(reachableAffordances({ kind: 'none' }, env)).toEqual({ 'seven:8:1|hand:0|zone:points': [0] });
    const hook = install({ kind: 'none' }, env);
    expect(hook.moves()[0]).toMatchObject({ index: 0, revealIndex: 1, targetKey: 'zone:points' });
  });

  it('every DiscardPair is reachable, and moves() exposes the pair', () => {
    const env = envelope({
      state: playerView({ viewer: 0, active: 0, phase: 3 }),
      legalMoves: [
        mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 1 }),
        mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 2 }),
      ],
      descriptions: ['discard hand[0] and hand[1]', 'discard hand[0] and hand[2]'],
    });
    expect(reachableAffordances({ kind: 'none' }, env)).toEqual({ 'discard:0:1': [0], 'discard:0:2': [1] });
    const hook = install({ kind: 'none' }, env);
    expect(hook.moves()[1]).toMatchObject({ discardA: 0, discardB: 2, revealIndex: null });
  });

  it('a 3 scrap-pick group is reachable, and moves() exposes each ScrapIndex', () => {
    const env = envelope({
      state: playerView({ viewer: 0, active: 0 }),
      legalMoves: [
        mv({ Kind: Kind.OneOff, HandIndex: 1, Card: THREE, ScrapIndex: 0 }),
        mv({ Kind: Kind.OneOff, HandIndex: 1, Card: THREE, ScrapIndex: 1 }),
      ],
      descriptions: ['play 3♣ as one-off', 'play 3♣ as one-off'],
    });
    expect(reachableAffordances({ kind: 'none' }, env)).toEqual({ 'hand:1|zone:oneoff': [0, 1] });
    const hook = install({ kind: 'none' }, env);
    expect(hook.moves().map((m) => m.scrapIndex)).toEqual([0, 1]);
  });
});
