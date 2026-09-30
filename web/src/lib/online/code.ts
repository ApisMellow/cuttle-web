// Two-phone play: room codes and join links (docs/two-phone-plan.md §5, §7).
//
// A code is 4 Crockford base32 characters: 0-9 and A-Z without I, L, O, U.
// People misread and mistype look-alikes, so input is forgiven: any case, O
// counts as 0, and I or L counts as 1. Separators (spaces, hyphens) are ignored.

export const CODE_LENGTH = 4;

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

/** Uppercase, drop separators, and fold the look-alikes (O to 0, I and L to 1). */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** True for a normalized code: exactly 4 Crockford characters. */
export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && CROCKFORD.test(code);
}

export type JoinHash =
  | { kind: 'join'; code: string }
  /** `#/join/...` with something that is not a code. Open manual entry with a hint. */
  | { kind: 'bad-join' };

/** Reads `#/join/CODE`. Anything else in the hash is not ours: null. */
export function parseJoinHash(hash: string): JoinHash | null {
  const match = /^#\/join\/([^/?#]*)\/?$/i.exec(hash);
  if (!match) return null;
  let raw = match[1] ?? '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return { kind: 'bad-join' };
  }
  const code = normalizeCode(raw);
  return isValidCode(code) ? { kind: 'join', code } : { kind: 'bad-join' };
}

/** The shareable link. `base` is the page URL without a hash. */
export function joinLink(code: string, base: string): string {
  return `${base.replace(/#.*$/, '')}#/join/${code}`;
}
