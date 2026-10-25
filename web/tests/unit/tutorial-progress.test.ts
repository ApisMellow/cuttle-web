// T7 / S7: tutorial progress storage (docs/tutorial-design.md §10, plan §5).
// Key `cuttle-web:tutorial`, value exactly {"v":1,"done":[…]}: the lesson
// numbers finished, unique, 1-5. Anything else reads as "nothing done".
// Every storage access is wrapped: a throwing storage never throws here.
import { describe, expect, it, vi } from 'vitest';

import { TUTORIAL_KEY, decodeProgress, encodeProgress, loadProgress, saveProgress } from '../../src/lib/tutorial/progress';

describe('TUTORIAL_KEY', () => {
  it('is the one tutorial key', () => {
    expect(TUTORIAL_KEY).toBe('cuttle-web:tutorial');
  });
});

describe('decodeProgress', () => {
  it('reads null and the empty string as nothing done', () => {
    expect(decodeProgress(null)).toEqual([]);
    expect(decodeProgress('')).toEqual([]);
  });

  it('sorts and de-duplicates', () => {
    expect(decodeProgress('{"v":1,"done":[2,1,2]}')).toEqual([1, 2]);
    expect(decodeProgress('{"v":1,"done":[5,3,4,1,2]}')).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops unknown lesson numbers and keeps the rest', () => {
    expect(decodeProgress('{"v":1,"done":[0,6,2.5,"3",4,-1,null,true,1e3]}')).toEqual([4]);
    expect(decodeProgress('{"v":1,"done":[0,6,2.5,"3"]}')).toEqual([]);
  });

  it('reads a wrong or missing version as nothing done', () => {
    expect(decodeProgress('{"v":2,"done":[1,2]}')).toEqual([]);
    expect(decodeProgress('{"v":"1","done":[1,2]}')).toEqual([]);
    expect(decodeProgress('{"done":[1,2]}')).toEqual([]);
  });

  it('reads malformed JSON as nothing done', () => {
    expect(decodeProgress('{"v":1,"done":[1,2')).toEqual([]);
    expect(decodeProgress('not json')).toEqual([]);
  });

  it('reads a non-object as nothing done', () => {
    expect(decodeProgress('[1,2]')).toEqual([]);
    expect(decodeProgress('3')).toEqual([]);
    expect(decodeProgress('"done"')).toEqual([]);
    expect(decodeProgress('null')).toEqual([]);
    expect(decodeProgress('true')).toEqual([]);
  });

  it('reads a done field that is not an array as nothing done', () => {
    expect(decodeProgress('{"v":1,"done":3}')).toEqual([]);
    expect(decodeProgress('{"v":1,"done":{"0":1}}')).toEqual([]);
    expect(decodeProgress('{"v":1}')).toEqual([]);
  });
});

describe('encodeProgress', () => {
  it('writes exactly the keys v and done', () => {
    const encoded = encodeProgress([3, 1]);
    expect(encoded).toBe('{"v":1,"done":[1,3]}');
    expect(Object.keys(JSON.parse(encoded) as object)).toEqual(['v', 'done']);
  });

  it('sorts, de-duplicates and accepts any iterable', () => {
    expect(encodeProgress(new Set([5, 2, 2] as const))).toBe('{"v":1,"done":[2,5]}');
    expect(encodeProgress([])).toBe('{"v":1,"done":[]}');
  });

  it('round-trips through decodeProgress', () => {
    expect(decodeProgress(encodeProgress([4, 2, 1]))).toEqual([1, 2, 4]);
  });
});

describe('loadProgress', () => {
  it('reads the tutorial key from the given storage', () => {
    const getItem = vi.fn((key: string) => (key === TUTORIAL_KEY ? '{"v":1,"done":[1,3]}' : null));
    expect(loadProgress({ getItem })).toEqual([1, 3]);
    expect(getItem).toHaveBeenCalledWith(TUTORIAL_KEY);
  });

  it('reads nothing done when getItem throws', () => {
    const getItem = vi.fn(() => {
      throw new Error('storage blocked');
    });
    expect(() => loadProgress({ getItem })).not.toThrow();
    expect(loadProgress({ getItem })).toEqual([]);
  });
});

describe('saveProgress', () => {
  it('writes only the tutorial key, in the encoded shape', () => {
    const setItem = vi.fn();
    expect(saveProgress([2, 1], { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(TUTORIAL_KEY, '{"v":1,"done":[1,2]}');
  });

  it('returns false and does not throw when setItem throws', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota');
    });
    expect(() => saveProgress([1], { setItem })).not.toThrow();
    expect(saveProgress([1], { setItem })).toBe(false);
  });
});
