import { describe, expect, it } from 'vitest';

import { isValidCode, joinLink, normalizeCode, parseJoinHash, parseRoomCode } from '../../src/lib/online/code';

describe('normalizeCode', () => {
  it('uppercases', () => expect(normalizeCode('k7qx')).toBe('K7QX'));
  it('folds O to 0 and I or L to 1', () => {
    expect(normalizeCode('oilo')).toBe('0110');
    expect(normalizeCode('ABiL')).toBe('AB11');
  });
  it('drops spaces and hyphens', () => expect(normalizeCode(' k7-qx ')).toBe('K7QX'));
});

describe('isValidCode', () => {
  it('accepts 4 Crockford characters', () => expect(isValidCode('K7QX')).toBe(true));
  it('rejects wrong length', () => {
    expect(isValidCode('K7Q')).toBe(false);
    expect(isValidCode('K7QXA')).toBe(false);
  });
  it('rejects U and other non-Crockford characters', () => {
    expect(isValidCode('K7QU')).toBe(false);
    expect(isValidCode('K7Q!')).toBe(false);
  });
});

describe('parseJoinHash', () => {
  it('reads a valid link', () => expect(parseJoinHash('#/join/ABCD')).toEqual({ kind: 'join', code: 'ABCD' }));
  it('reads lowercase', () => expect(parseJoinHash('#/join/k7qx')).toEqual({ kind: 'join', code: 'K7QX' }));
  it('folds confusables', () => expect(parseJoinHash('#/join/oi1L')).toEqual({ kind: 'join', code: '0111' }));
  it('tolerates a trailing slash', () => expect(parseJoinHash('#/join/ABCD/')).toEqual({ kind: 'join', code: 'ABCD' }));
  it('flags junk after /join/ as a bad link', () => {
    expect(parseJoinHash('#/join/')).toEqual({ kind: 'bad-join' });
    expect(parseJoinHash('#/join/toolongcode')).toEqual({ kind: 'bad-join' });
    expect(parseJoinHash('#/join/AB%ZZ')).toEqual({ kind: 'bad-join' });
    expect(parseJoinHash('#/join/AB!D')).toEqual({ kind: 'bad-join' });
  });
  it('ignores hashes that are not join links', () => {
    expect(parseJoinHash('')).toBeNull();
    expect(parseJoinHash('#')).toBeNull();
    expect(parseJoinHash('#/gallery')).toBeNull();
    expect(parseJoinHash('#/joined/ABCD')).toBeNull();
  });
});

describe('joinLink', () => {
  it('appends the join hash to the page URL', () => {
    expect(joinLink('K7QX', 'https://apismellow.github.io/cuttle-web/')).toBe(
      'https://apismellow.github.io/cuttle-web/#/join/K7QX',
    );
  });
  it('replaces an existing hash', () => {
    expect(joinLink('K7QX', 'https://example.test/app/#/join/OLD1')).toBe('https://example.test/app/#/join/K7QX');
  });
});

// Pinned to the server: internal/store/codes.go NormalizeCode and its table in
// codes_test.go TestNormalizeCode. Change one side only with the other.
describe('parseRoomCode matches store.NormalizeCode', () => {
  const SERVER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // store.CodeAlphabet

  it('accepts what the server accepts, with the same result', () => {
    const ok: Record<string, string> = {
      K7QX: 'K7QX',
      k7qx: 'K7QX',
      ' k7qx ': 'K7QX',
      o0il: '0011',
      OILZ: '011Z',
    };
    for (const [input, want] of Object.entries(ok)) expect(parseRoomCode(input), input).toBe(want);
  });

  it('rejects what the server rejects', () => {
    for (const input of ['', 'K7Q', 'K7QXZ', 'K7QU', 'K7Q!', 'K7-Q', 'K7QÉ']) {
      expect(parseRoomCode(input), input).toBeNull();
    }
  });

  it('keeps every server alphabet character and rejects every other ASCII one', () => {
    for (let i = 33; i < 127; i++) {
      const c = String.fromCharCode(i);
      const folded = c.toUpperCase().replace('O', '0').replace(/[IL]/, '1');
      const want = SERVER_ALPHABET.includes(folded) ? `${folded}000` : null;
      expect(parseRoomCode(`${c}000`), c).toBe(c === '-' ? null : want);
    }
  });

  it('also drops inner separators, a client-only forgiveness', () => {
    expect(parseRoomCode('k7-qx')).toBe('K7QX');
    expect(parseRoomCode('k7 qx')).toBe('K7QX');
  });
});
