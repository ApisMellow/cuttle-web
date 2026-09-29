// P2 W13, SPEC §4.3 Presentation table — the CounterPrompt's card and chain,
// from public history only (the played one-off and every 2 played on it),
// never `pending`. The curtain drops the same entries from the recap before
// the prompt (ruling 2026-09-29).
import { describe, expect, it } from 'vitest';

import { counterPromptEntries } from '../../src/lib/recap';
import { Kind, appliedMove } from './game-test-support';

const nine = { Rank: 9 as const, Suit: 2 as const };
const two = { Rank: 2 as const, Suit: 3 as const };
const twoB = { Rank: 2 as const, Suit: 0 as const };

describe('counterPromptEntries (SPEC §4.3)', () => {
  it('first window after a one-off: just the one-off', () => {
    const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 3, card: nine, targetCard: { Rank: 5, Suit: 1 } });
    const history = [appliedMove({ by: 1, kind: Kind.Draw, seq: 2 }), oneOff];
    expect(counterPromptEntries(history)).toEqual([oneOff]);
  });

  it('after counters: the one-off, then every 2 in the order played', () => {
    const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 3, card: nine });
    const c1 = appliedMove({ by: 1, kind: Kind.Counter, seq: 4, card: two });
    const c2 = appliedMove({ by: 0, kind: Kind.Counter, seq: 5, card: twoB });
    expect(counterPromptEntries([oneOff, c1, c2])).toEqual([oneOff, c1, c2]);
  });

  it('a one-off played through a 7 counts as the origin', () => {
    const pick = appliedMove({ by: 0, kind: Kind.SevenPick, subKind: Kind.OneOff, seq: 6, card: nine });
    expect(counterPromptEntries([pick])).toEqual([pick]);
  });

  it('returns [] when the last move is not a counterable chain', () => {
    expect(counterPromptEntries([])).toEqual([]);
    expect(counterPromptEntries([appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, card: nine })])).toEqual([]);
    expect(
      counterPromptEntries([appliedMove({ by: 0, kind: Kind.SevenPick, subKind: Kind.PlayPoint, seq: 1, card: nine })]),
    ).toEqual([]);
    // counters with no origin before them
    expect(counterPromptEntries([appliedMove({ by: 1, kind: Kind.Counter, seq: 1, card: two })])).toEqual([]);
  });

  it('stops at the chain start: earlier moves never leak in', () => {
    const early = appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 6, Suit: 0 } });
    const decline = appliedMove({ by: 0, kind: Kind.Decline, seq: 2 });
    const oneOff = appliedMove({ by: 1, kind: Kind.OneOff, seq: 3, card: nine });
    expect(counterPromptEntries([early, decline, oneOff])).toEqual([oneOff]);
  });
});
