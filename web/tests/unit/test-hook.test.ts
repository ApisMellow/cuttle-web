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
