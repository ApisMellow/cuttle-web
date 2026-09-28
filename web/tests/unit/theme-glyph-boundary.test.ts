// SPEC §5.6 rule 1 / R23.1 — nothing outside `lib/theme/` renders a rank or
// suit glyph directly. Every card pixel comes from a theme's <Face>/<Back>.
//
// Two static checks over every `.js/.mjs/.cjs/.ts/.mts/.cts/.svelte/.css`
// file under `web/src/`, outside `lib/theme/`:
//
//  1. Import boundary. No file may reach into `lib/theme/` except through
//     its public surface: `lib/theme` (index), `lib/theme/types`, and
//     `lib/theme/default`. That surface exports no glyph helper (asserted in
//     theme.test.ts), so the only way to draw a card is `<Face>`/`<Back>`.
//     Rank labels ("A", "K", "10") cannot be pattern-matched, so this rule is
//     what actually keeps rank rendering inside the theme.
//  2. Glyph encodings. No suit glyph in any spelling a browser or JS engine
//     will turn into one: the raw character (with or without a variation
//     selector), HTML named/decimal/hex entities, JS `\uXXXX` / `\u{…}`
//     escapes, CSS `\2665` escapes, URL-encoded UTF-8, `0x266…` literals,
//     and decimal code points fed to `fromCodePoint`/`fromCharCode`.
//
// Comments are stripped conservatively, so prose may mention "A♥" but code
// cannot hide behind a comment marker: only WHOLE-LINE `//` comments,
// `/* … */` blocks that open at the start of a line, and (in `.svelte`)
// `<!-- … -->` are removed. A trailing `code; // …` comment is still
// scanned, because a `//` inside a string literal would otherwise hide the
// rest of its line from the check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..', 'src');
const THEME_DIR = join(SRC_ROOT, 'lib', 'theme');

const SCANNED_EXTENSIONS = /\.(?:[cm]?js|[cm]?ts|svelte|css)$/;

// Reviewed exception: `lib/recap.ts` matches suit-glyph characters that
// already arrived over the wire inside engine-authored `Move.Describe` text
// (SPEC §2.7) so it can reformat a recap line (SPEC §4.6). It parses prose;
// it does not draw a card, so it never competes with <Face> as the authority
// on how a Rank/Suit renders. It is exempt from the GLYPH check only — it is
// still subject to the import boundary.
const GLYPH_CHECK_EXEMPT = new Set<string>([join(SRC_ROOT, 'lib', 'recap.ts')]);

/** Public modules of `lib/theme/` (extension-less basenames). */
const THEME_PUBLIC_MODULES = new Set<string>(['index', 'types', 'default']);

// Suit code points U+2660..U+2667 (black and white suits).
const GLYPH_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'raw suit glyph', pattern: /[♠-♧][︎️]?/u },
  { name: 'HTML named entity', pattern: /&(?:spades|clubs|hearts|diams|spadesuit|clubsuit|heartsuit|diamondsuit);/i },
  { name: 'HTML decimal entity', pattern: /&#0*98(?:2[4-9]|3[01]);?/ },
  { name: 'HTML hex entity', pattern: /&#x0*266[0-7];?/i },
  { name: 'JS/CSS escape', pattern: /\\(?:u\{?)?0*266[0-7]/i },
  { name: 'URL-encoded UTF-8', pattern: /%E2%99%A[0-7]/i },
  { name: 'hex code point literal', pattern: /\b0x0*266[0-7]\b/i },
];

// Decimal code points only count next to a code-point constructor; a bare
// `9829` elsewhere is just a number.
const CODE_POINT_CONSTRUCTOR = /\bfrom(?:CodePoint|CharCode)\b/;
const DECIMAL_CODE_POINT = /\b98(?:2[4-9]|3[01])\b/;

function findGlyphViolations(source: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of GLYPH_PATTERNS) {
    const match = pattern.exec(source);
    if (match) found.push(`${name} ${JSON.stringify(match[0])}`);
  }
  if (CODE_POINT_CONSTRUCTOR.test(source)) {
    const match = DECIMAL_CODE_POINT.exec(source);
    if (match) found.push(`decimal code point ${match[0]} with fromCodePoint/fromCharCode`);
  }
  return found;
}

// Any quoted path-like string (import, dynamic import, re-export, CSS
// @import/url(), new URL(…), import.meta.glob) that resolves into
// `lib/theme/` but is not one of its public modules.
const QUOTED_PATH = /(['"`])(\.{1,2}\/[^'"`\n]*?)\1/g;

function stripQueryAndExtension(base: string): string {
  return base.replace(/[?#].*$/, '').replace(/\.(?:[cm]?js|[cm]?ts|svelte|css)$/, '');
}

function findThemeImportViolations(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(QUOTED_PATH)) {
    const specifier = match[2];
    const target = resolve(dirname(file), specifier.replace(/[?#].*$/, ''));
    const rel = relative(THEME_DIR, target);
    if (rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) continue; // outside theme
    if (rel === '') continue; // `…/theme` or `…/theme/` → index
    const parts = rel.split(sep);
    if (parts.length === 1 && THEME_PUBLIC_MODULES.has(stripQueryAndExtension(parts[0]))) continue;
    found.push(`imports theme-internal ${JSON.stringify(specifier)}`);
  }
  return found;
}

function stripComments(source: string, file: string): string {
  let out = source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
  if (!file.endsWith('.css')) out = out.replace(/^[ \t]*\/\/[^\n]*/gm, '');
  if (file.endsWith('.svelte')) out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (SCANNED_EXTENSIONS.test(entry)) files.push(full);
  }
  return files;
}

function isInsideTheme(file: string): boolean {
  const rel = relative(THEME_DIR, file);
  return !rel.startsWith('..') && !rel.startsWith(sep);
}

const HAND_CARD = join(SRC_ROOT, 'lib', 'components', 'HandCard.svelte');
const SUIT_CODES = ['2660', '2663', '2665', '2666'];

describe('glyph detector self-check (every bypass form is caught)', () => {
  const positives: Array<[string, string]> = [
    ['raw glyph', '<span>7♥</span>'],
    ['raw glyph + VS16', '7♥️'],
    ['raw glyph + VS15', '7♥︎'],
    ...(['spades', 'clubs', 'hearts', 'diams'] as const).map(
      (n): [string, string] => [`&${n};`, `<span>7&${n};</span>`],
    ),
    ['&heartsuit;', '<b>&heartsuit;</b>'],
    ...['9824', '9827', '9829', '9830'].map((d): [string, string] => [`&#${d};`, `<i>&#${d};</i>`]),
    ...SUIT_CODES.map((h): [string, string] => [`&#x${h};`, `<i>&#x${h};</i>`]),
    ['&#X2665; upper-case', '&#X2665;'],
    ...SUIT_CODES.map((h): [string, string] => [`JS \\u${h}`, `const s = '\\u${h}';`]),
    ...SUIT_CODES.map((h): [string, string] => [`JS \\u{${h}}`, `const s = "\\u{${h}}";`]),
    ['JS \\u{02665}', 'const s = `\\u{02665}`;'],
    ['CSS content escape', '.x::after { content: "\\2665"; }'],
    ['CSS padded escape', '.x::after { content: "\\002665 "; }'],
    ['URL-encoded in data URI', "background: url('data:image/svg+xml,%E2%99%A5');"],
    ...SUIT_CODES.map((h): [string, string] => [
      `0x${h} + fromCodePoint`,
      `String.fromCodePoint(0x${h})`,
    ]),
    ['0x2665 alone', 'const HEART = 0x2665;'],
    ['decimal + fromCodePoint', 'String.fromCodePoint(9829)'],
    ['decimal + fromCharCode', 'String.fromCharCode(9824)'],
  ];

  for (const [label, source] of positives) {
    it(`catches ${label}`, () => {
      expect(findGlyphViolations(source)).not.toEqual([]);
    });
  }

  it('does not flag ordinary card-free source', () => {
    expect(findGlyphViolations('const x = 9829; <span>hand</span> &amp; &nbsp; 0x2600')).toEqual([]);
  });

  it('ignores prose in whole-line comments', () => {
    const src = '  // "play A♥ as points"\n  /* 7♥\n   * K♠ */\n<!-- 9♦ -->\nconst ok = 1;';
    expect(findGlyphViolations(stripComments(src, 'X.svelte'))).toEqual([]);
  });

  it('still scans trailing comments and code after a "//" inside a string', () => {
    expect(findGlyphViolations(stripComments("const a = 1; // 7♥", 'x.ts'))).not.toEqual([]);
    expect(findGlyphViolations(stripComments("const u = '//'; const s = '\\u2665';", 'x.ts'))).not.toEqual([]);
  });

  it('does not treat "//" as a comment in CSS (CSS has no line comments)', () => {
    const css = ".x { color: red; }\n  // .y::after { content: '\\2665'; }";
    expect(findGlyphViolations(stripComments(css, 'x.css'))).not.toEqual([]);
  });
});

describe('theme import detector self-check', () => {
  const blocked = [
    "import { rankLabel, suitGlyph } from '../theme/glyphs';",
    "import { rankLabel } from '../theme/glyphs.ts';",
    "import VectorCardFace from '../theme/VectorCardFace.svelte';",
    "export * from '../theme/glyphs';",
    "const m = await import('../theme/glyphs');",
    "@import '../theme/vector.css';",
    "const g = import.meta.glob('../theme/*.svelte');",
    "new URL('../theme/glyphs.ts', import.meta.url)",
  ];
  for (const source of blocked) {
    it(`blocks ${source}`, () => {
      expect(findThemeImportViolations(HAND_CARD, source)).not.toEqual([]);
    });
  }

  const allowed = [
    "import { getTheme } from '../theme';",
    "import { getTheme } from '../theme/';",
    "import { getTheme } from '../theme/index';",
    "import type { CardTheme } from '../theme/types';",
    "import { DEFAULT_THEME_ID } from '../theme/default';",
    "import '../styles/card-geometry.css';",
    "import type { Card } from '../bridge/schema';",
  ];
  for (const source of allowed) {
    it(`allows ${source}`, () => {
      expect(findThemeImportViolations(HAND_CARD, source)).toEqual([]);
    });
  }
});

describe('theme seam boundary over web/src (SPEC §5.6 rule 1)', () => {
  const files = listSourceFiles(SRC_ROOT).filter((f) => !isInsideTheme(f));

  it('scans .ts, .svelte and .css files (the scan is not vacuous)', () => {
    const exts = new Set(files.map((f) => f.slice(f.lastIndexOf('.'))));
    expect(exts.has('.ts')).toBe(true);
    expect(exts.has('.svelte')).toBe(true);
    expect(exts.has('.css')).toBe(true);
    expect(files).toContain(HAND_CARD);
  });

  it('no file outside lib/theme/ imports a theme-internal module', () => {
    const offenders = files.flatMap((file) =>
      findThemeImportViolations(file, stripComments(readFileSync(file, "utf8"), file)).map((v) => `${relative(SRC_ROOT, file)}: ${v}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no file outside lib/theme/ contains a suit glyph in any encoding', () => {
    const offenders = files
      .filter((file) => !GLYPH_CHECK_EXEMPT.has(file))
      .flatMap((file) =>
        findGlyphViolations(stripComments(readFileSync(file, "utf8"), file)).map((v) => `${relative(SRC_ROOT, file)}: ${v}`),
      );
    expect(offenders).toEqual([]);
  });
});
