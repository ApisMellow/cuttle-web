// Issue #54 — the pure press-and-hold helper, on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerView } from '../../src/lib/bridge/schema';
import { LONG_PRESS_MS, LONG_PRESS_SWALLOW_MS, LongPress, cardForKey } from '../../src/lib/longPress';
import { playerView } from './game-test-support';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LongPress', () => {
  it('fires once after LONG_PRESS_MS, not before', () => {
    const fired: string[] = [];
    const lp = new LongPress((key) => fired.push(key));
    lp.down(1, 'hand:2', 10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fired).toEqual([]);
    expect(lp.held).toBeNull();
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['hand:2']);
    expect(lp.held).toBe('hand:2');
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual(['hand:2']);
  });

  it('uses 2000 ms', () => {
    expect(LONG_PRESS_MS).toBe(2000);
  });

  it('a release before the time is not a hold and never fires', () => {
    const fired: string[] = [];
    const lp = new LongPress((key) => fired.push(key));
    lp.down(1, 'hand:0', 0, 0);
    vi.advanceTimersByTime(1999);
    expect(lp.up(1, 5000)).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual([]);
    expect(lp.swallowClick(5001)).toBe(false);
  });

  it('moving 8 px or more before the time cancels the hold; under 8 px keeps it', () => {
    const fired: string[] = [];
    const lp = new LongPress((key) => fired.push(key));
    lp.down(1, 'hand:0', 100, 100);
    lp.move(1, 100, 107);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toEqual(['hand:0']);
    lp.cancel();

    const lp2 = new LongPress((key) => fired.push(key));
    lp2.down(1, 'hand:1', 100, 100);
    lp2.move(1, 100, 109);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(fired).toEqual(['hand:0']);
    expect(lp2.pointerId).toBeNull();
  });

  it('after it fires, moving does not cancel it; the release ends it and swallows the next click', () => {
    const lp = new LongPress(() => undefined);
    lp.down(1, 'point:0:0', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.move(1, 300, 300);
    expect(lp.held).toBe('point:0:0');
    expect(lp.up(1, 10_000)).toBe(true);
    expect(lp.held).toBeNull();
    expect(lp.swallowClick(10_000 + LONG_PRESS_SWALLOW_MS - 1)).toBe(true);
    expect(lp.swallowClick(10_001)).toBe(false);
  });

  it('a late click is not swallowed', () => {
    const lp = new LongPress(() => undefined);
    lp.down(1, 'hand:0', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.up(1, 0);
    expect(lp.swallowClick(LONG_PRESS_SWALLOW_MS)).toBe(false);
  });

  it('cancel clears the timer; other pointers are ignored', () => {
    const fired: string[] = [];
    const lp = new LongPress((key) => fired.push(key));
    lp.down(1, 'hand:0', 0, 0);
    lp.down(2, 'hand:1', 0, 0);
    lp.move(2, 500, 500);
    expect(lp.up(2, 0)).toBe(false);
    expect(lp.pointerId).toBe(1);
    lp.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(fired).toEqual([]);
  });
});

describe('cardForKey', () => {
  const view: PlayerView = playerView({
    viewer: 1,
    you: {
      hand: [{ Rank: 1, Suit: 3 }, { Rank: 9, Suit: 2 }],
      frozenHandIndices: [],
      points: [{ Card: { Rank: 3, Suit: 0 }, Owner: 1, JackStack: [], JackOwners: [], Controller: 1 }],
      permanents: [{ Rank: 13, Suit: 0 }],
      watched: false,
    },
    opponent: {
      handCount: 3,
      hand: null,
      points: [{ Card: { Rank: 7, Suit: 1 }, Owner: 0, JackStack: [], JackOwners: [], Controller: 0 }],
      permanents: [{ Rank: 12, Suit: 2 }],
    },
  });

  it('names own hand, points and permanents, and the opponent’s points and permanents', () => {
    expect(cardForKey('hand:1', view)).toEqual({ Rank: 9, Suit: 2 });
    expect(cardForKey('point:1:0', view)).toEqual({ Rank: 3, Suit: 0 });
    expect(cardForKey('perm:1:0', view)).toEqual({ Rank: 13, Suit: 0 });
    expect(cardForKey('point:0:0', view)).toEqual({ Rank: 7, Suit: 1 });
    expect(cardForKey('perm:0:0', view)).toEqual({ Rank: 12, Suit: 2 });
  });

  it('is null for the deck, scrap, zones, the tray and missing indices', () => {
    expect(cardForKey('deck', view)).toBeNull();
    expect(cardForKey('scrap', view)).toBeNull();
    expect(cardForKey('zone:points', view)).toBeNull();
    expect(cardForKey('seven:0', view)).toBeNull();
    expect(cardForKey('hand:5', view)).toBeNull();
    expect(cardForKey('point:0:4', view)).toBeNull();
  });
});
