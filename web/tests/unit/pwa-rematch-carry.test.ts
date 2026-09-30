// @vitest-environment jsdom
// R18: the Rematch that carries across an update reload lives in
// sessionStorage for one boot, and is read once.
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ONLINE_REMATCH_KEY,
  REMATCH_KEY,
  applyUpdateAtOnlineRematch,
  applyUpdateAtRematch,
  takePendingOnlineRematch,
  takePendingRematch,
} from '../../src/lib/pwa/register';

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

// Review F4: an online Rematch across an update reload carries only the room
// code and the finished game's number (never a token; the seat stays in
// localStorage), for one boot.
describe('pending online rematch', () => {
  it('is read once, then gone', () => {
    sessionStorage.setItem(ONLINE_REMATCH_KEY, JSON.stringify({ code: 'K7QX', game: 3 }));
    expect(takePendingOnlineRematch()).toEqual({ code: 'K7QX', game: 3 });
    expect(takePendingOnlineRematch()).toBeNull();
    expect(sessionStorage.getItem(ONLINE_REMATCH_KEY)).toBeNull();
  });

  it.each(['not json', '{"code":"K7QX"}', '{"code":1,"game":1}', '{"code":"K7QX","game":0}', '{"code":"K7QX","game":1.5}'])(
    'ignores and clears %s',
    (raw) => {
      sessionStorage.setItem(ONLINE_REMATCH_KEY, raw);
      expect(takePendingOnlineRematch()).toBeNull();
      expect(sessionStorage.getItem(ONLINE_REMATCH_KEY)).toBeNull();
    },
  );

  it('does not read the pass-and-play key, nor that one this', () => {
    sessionStorage.setItem(REMATCH_KEY, JSON.stringify({ names: ['A', 'B'], dealer: 1 }));
    expect(takePendingOnlineRematch()).toBeNull();
    sessionStorage.setItem(ONLINE_REMATCH_KEY, JSON.stringify({ code: 'K7QX', game: 1 }));
    expect(takePendingRematch()).toEqual({ names: ['A', 'B'], dealer: 1 });
    expect(takePendingOnlineRematch()).toEqual({ code: 'K7QX', game: 1 });
  });

  it('applyUpdateAtOnlineRematch does nothing when no worker is registered', () => {
    expect(applyUpdateAtOnlineRematch({ code: 'K7QX', game: 1 })).toBe(false);
    expect(sessionStorage.getItem(ONLINE_REMATCH_KEY)).toBeNull();
  });
});
