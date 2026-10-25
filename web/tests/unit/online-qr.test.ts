import { describe, expect, it } from 'vitest';

import { joinLink } from '../../src/lib/online/code';
import { QR_QUIET_ZONE, qrMatrix, qrPath } from '../../src/lib/online/qr';

const base = 'https://example.test/cuttle-web/';

// A QR finder pattern: 7x7, solid ring, light ring, 3x3 solid core.
function isFinder(m: boolean[][], top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const want = ring !== 2;
      if (m[top + r]![left + c] !== want) return false;
    }
  }
  return true;
}

describe('qrMatrix', () => {
  const m = qrMatrix(joinLink('K7QX', base));

  it('is a square matrix of a valid QR size', () => {
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect((m.length - 17) % 4).toBe(0);
    for (const row of m) expect(row.length).toBe(m.length);
  });

  it('has the three finder patterns', () => {
    const n = m.length;
    expect(isFinder(m, 0, 0)).toBe(true);
    expect(isFinder(m, 0, n - 7)).toBe(true);
    expect(isFinder(m, n - 7, 0)).toBe(true);
  });

  it('is deterministic and differs per code', () => {
    expect(qrMatrix(joinLink('K7QX', base))).toEqual(m);
    expect(qrMatrix(joinLink('ABCD', base))).not.toEqual(m);
  });

  it('stays at version 1 for 14 bytes (M holds 14; Q and H hold fewer)', () => {
    expect(qrMatrix('a'.repeat(14)).length).toBe(21);
  });

  it('uses error correction M (a version-1 M payload limit is 14 bytes)', () => {
    // 15 bytes cannot fit v1-M; with L it would. So size must exceed 21.
    expect(qrMatrix('a'.repeat(15)).length).toBeGreaterThan(21);
  });
});

describe('qrPath', () => {
  it('draws one unit square per dark module and nothing else', () => {
    const m = [
      [true, false],
      [false, true],
    ];
    expect(qrPath(m)).toBe('M0 0h1v1h-1zM1 1h1v1h-1z');
  });

  it('has a quiet zone of at least 4 modules', () => {
    expect(QR_QUIET_ZONE).toBeGreaterThanOrEqual(4);
  });
});
