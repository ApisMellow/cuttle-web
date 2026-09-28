// P2 W13 — the shared board/staging target-key type (round-3 coupling note:
// `hand:i`, `deck`, `scrap`, `pass`, `zone:*`, `point:o:i`, `perm:o:i`), and
// the one tap rewrite the integrator owns: a tap on the viewer's own point
// (or permanent) card while that row's drop zone is lit means the zone.
import { describe, expect, it } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import type { Move } from '../../src/lib/bridge/schema';
import { parseTargetKey, resolveBoardTap, type TargetKey } from '../../src/lib/targetKey';

function move(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return {
    Card: { Rank: 9, Suit: 2 },
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

describe('parseTargetKey', () => {
  it.each([
    'hand:0',
    'hand:7',
    'deck',
    'scrap',
    'pass',
    'zone:points',
    'zone:permanents',
    'zone:oneoff',
    'point:0:0',
    'point:1:4',
    'perm:0:2',
    'perm:1:0',
  ])('accepts %s unchanged', (raw) => {
    expect(parseTargetKey(raw)).toBe(raw);
  });

  it.each(['', 'hand:', 'hand:-1', 'hand:x', 'point:2:0', 'point:0', 'perm:1:1:1', 'zone:hand', 'decks', ' deck'])(
    'rejects %j',
    (raw) => {
      expect(parseTargetKey(raw)).toBeNull();
    },
  );

  it('every board key the affordance layer can produce parses (staging and board share one vocabulary)', () => {
    const produced = [
      boardTargetKey(move({ Kind: 0 })),
      boardTargetKey(move({ Kind: 1 })),
      boardTargetKey(move({ Kind: 2 })),
      boardTargetKey(move({ Kind: 2, JackTarget: { Owner: 1, Zone: 0, Index: 3 } })),
      boardTargetKey(move({ Kind: 3, Target: { Owner: 1, Zone: 0, Index: 0 } })),
      boardTargetKey(move({ Kind: 4 })),
      boardTargetKey(move({ Kind: 4, Target: { Owner: 0, Zone: 1, Index: 1 } })),
      boardTargetKey(move({ Kind: 7, SubMove: null })),
    ];
    for (const key of produced) {
      expect(key).not.toBeNull();
      expect(parseTargetKey(key as string)).toBe(key);
    }
  });
});

describe('resolveBoardTap (own-card tap while the row zone is lit)', () => {
  const lit = (...keys: TargetKey[]): ReadonlySet<string> => new Set(keys);

  it('maps a tap on the viewer\'s own point card to zone:points while zone:points is lit', () => {
    expect(resolveBoardTap('point:0:2', lit('zone:points'), 0)).toBe('zone:points');
    expect(resolveBoardTap('point:1:0', lit('zone:points'), 1)).toBe('zone:points');
  });

  it('maps a tap on the viewer\'s own permanent to zone:permanents while zone:permanents is lit', () => {
    expect(resolveBoardTap('perm:0:0', lit('zone:permanents'), 0)).toBe('zone:permanents');
  });

  it('leaves the opponent\'s cards alone (a tap there is a scuttle/steal target or a miss)', () => {
    expect(resolveBoardTap('point:1:0', lit('zone:points'), 0)).toBe('point:1:0');
    expect(resolveBoardTap('perm:1:0', lit('zone:permanents'), 0)).toBe('perm:1:0');
  });

  it('a card that is itself highlighted keeps its own key (e.g. a 2 aimed at a stack in your row)', () => {
    expect(resolveBoardTap('point:0:1', lit('zone:points', 'point:0:1'), 0)).toBe('point:0:1');
  });

  it('does nothing when the zone is not lit', () => {
    expect(resolveBoardTap('point:0:0', lit(), 0)).toBe('point:0:0');
    expect(resolveBoardTap('point:0:0', lit('zone:permanents'), 0)).toBe('point:0:0');
    expect(resolveBoardTap('perm:0:0', lit('zone:points'), 0)).toBe('perm:0:0');
  });

  it('passes every non-row key through unchanged', () => {
    for (const key of ['hand:1', 'deck', 'scrap', 'pass', 'zone:oneoff'] as TargetKey[]) {
      expect(resolveBoardTap(key, lit('zone:points', 'zone:permanents'), 0)).toBe(key);
    }
  });
});
