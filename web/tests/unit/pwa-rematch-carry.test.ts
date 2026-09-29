// @vitest-environment jsdom
// R18: the Rematch that carries across an update reload lives in
// sessionStorage for one boot, and is read once.
import { beforeEach, describe, expect, it } from 'vitest';

import { REMATCH_KEY, applyUpdateAtRematch, takePendingRematch } from '../../src/lib/pwa/register';

beforeEach(() => sessionStorage.clear());

describe('pending rematch', () => {
  it('is read once, then gone', () => {
    sessionStorage.setItem(REMATCH_KEY, JSON.stringify({ names: ['Alice', 'Blake'], dealer: 1 }));
    expect(takePendingRematch()).toEqual({ names: ['Alice', 'Blake'], dealer: 1 });
    expect(takePendingRematch()).toBeNull();
    expect(sessionStorage.getItem(REMATCH_KEY)).toBeNull();
  });

  it('keeps an unset dealer unset', () => {
    sessionStorage.setItem(REMATCH_KEY, JSON.stringify({ names: ['A', 'B'] }));
    expect(takePendingRematch()).toEqual({ names: ['A', 'B'], dealer: undefined });
  });

  it('ignores and clears a malformed value', () => {
    sessionStorage.setItem(REMATCH_KEY, '{"names":["only-one"]}');
    expect(takePendingRematch()).toBeNull();
    expect(sessionStorage.getItem(REMATCH_KEY)).toBeNull();
    sessionStorage.setItem(REMATCH_KEY, 'not json');
    expect(takePendingRematch()).toBeNull();
  });

  it('applyUpdateAtRematch does nothing when no worker is registered (dev, unsupported)', () => {
    expect(applyUpdateAtRematch({ names: ['A', 'B'], dealer: 0 })).toBe(false);
    expect(sessionStorage.getItem(REMATCH_KEY)).toBeNull();
  });
});
