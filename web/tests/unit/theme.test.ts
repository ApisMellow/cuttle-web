// @vitest-environment jsdom
// SPEC §5.6 — CardTheme registry contract (R23.1 unit bullet), the `vector`
// default-theme rules (rules 4-5), and rule 2's geometry ownership: the APP
// sizes the card box, a theme only paints inside it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount, type Component } from 'svelte';
import { describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import * as themeIndex from '../../src/lib/theme';
import { DEFAULT_THEME_ID, getTheme, listThemes, registerTheme, vectorTheme } from '../../src/lib/theme';
import type { CardBackProps, CardFaceProps, CardSize, CardVisualState } from '../../src/lib/theme/types';

const SRC_ROOT = join(__dirname, '..', '..', 'src');
const THEME_DIR = join(SRC_ROOT, 'lib', 'theme');
const GEOMETRY_CSS = join(SRC_ROOT, 'lib', 'styles', 'card-geometry.css');
const HAND_CARD = join(SRC_ROOT, 'lib', 'components', 'HandCard.svelte');
const SETTINGS_STORE = join(SRC_ROOT, 'lib', 'stores', 'settings.svelte.ts');

const SIZES: CardSize[] = ['hand', 'field', 'mini'];
const STATES: CardVisualState[] = ['normal', 'dimmed', 'highlighted', 'staged', 'frozen'];
const SAMPLE_CARDS: Card[] = [
  { Rank: 1, Suit: 0 },
  { Rank: 7, Suit: 2 },
  { Rank: 13, Suit: 3 },
];

// A Face/Back root sits inside HandCard's <button>, so it and everything in
// it must be phrasing content (HTML content model of <button>).
const PHRASING_ROOTS = new Set(['SPAN', 'svg', 'IMG', 'PICTURE']);
const FLOW_ONLY_SELECTOR =
  'div, p, section, article, aside, header, footer, nav, main, ul, ol, li, dl, table, form, figure, blockquote, pre, hr, h1, h2, h3, h4, h5, h6, button, a, input, select, textarea, canvas';

function mountFace(component: Component<CardFaceProps>, props: CardFaceProps) {
  const host = document.createElement('div');
  const instance = mount(component, { target: host, props });
  flushSync();
  return { host, instance };
}

function mountBack(component: Component<CardBackProps>, props: CardBackProps) {
  const host = document.createElement('div');
  const instance = mount(component, { target: host, props });
  flushSync();
  return { host, instance };
}

function expectPhrasingRoot(host: HTMLElement): Element {
  expect(host.children.length).toBe(1);
  const root = host.firstElementChild as Element;
  expect(PHRASING_ROOTS.has(root.tagName)).toBe(true);
  expect(root.querySelectorAll(FLOW_ONLY_SELECTOR).length).toBe(0);
  return root;
}

describe('theme registry (SPEC §5.6)', () => {
  it('registers vector as the only theme in this round', () => {
    expect(listThemes().map((t) => t.id)).toEqual(['vector']);
  });

  it('DEFAULT_THEME_ID is a single constant naming vector (rule 5)', () => {
    expect(DEFAULT_THEME_ID).toBe('vector');
  });

  it('getTheme(DEFAULT_THEME_ID) returns the vector theme', () => {
    expect(getTheme(DEFAULT_THEME_ID)).toBe(vectorTheme);
  });

  it('vector has zero external assets and is always available (rule 4)', () => {
    expect(vectorTheme.assetBytes).toBe(0);
    expect(vectorTheme.available()).toBe(true);
  });

  it('falls back to vector for an unknown theme id (rule 4)', () => {
    expect(getTheme('art-v1-not-yet-registered')).toBe(vectorTheme);
  });

  it('the public surface exports no glyph helper — <Face>/<Back> are the only way to draw a card (rule 1)', () => {
    expect(Object.keys(themeIndex).sort()).toEqual(
      ['DEFAULT_THEME_ID', 'getTheme', 'listThemes', 'registerTheme', 'vectorTheme'].sort(),
    );
  });

  it('settings.svelte.ts takes the default from lib/theme/default, not the component-bearing index', () => {
    const src = readFileSync(SETTINGS_STORE, 'utf8');
    expect(src).toMatch(/from '\.\.\/theme\/default'/);
    expect(src).not.toMatch(/from '\.\.\/theme(?:\/index)?'/);
  });
});

describe('Face/Back component contract, every registry entry × size × state (R23.1)', () => {
  for (const theme of listThemes()) {
    for (const size of SIZES) {
      for (const state of STATES) {
        it(`${theme.id} Face honours size=${size} state=${state} on a phrasing root`, () => {
          for (const card of SAMPLE_CARDS) {
            const { host, instance } = mountFace(theme.Face, { card, size, state });
            const root = expectPhrasingRoot(host);
            expect(root.getAttribute('data-size')).toBe(size);
            expect(root.getAttribute('data-state')).toBe(state);
            unmount(instance);
          }
        });
      }

      it(`${theme.id} Face defaults an omitted state to normal (size=${size})`, () => {
        const { host, instance } = mountFace(theme.Face, { card: SAMPLE_CARDS[0], size });
        expect(expectPhrasingRoot(host).getAttribute('data-state')).toBe('normal');
        unmount(instance);
      });

      it(`${theme.id} Back honours size=${size} on a phrasing root and carries no card identity`, () => {
        const { host, instance } = mountBack(theme.Back, { size });
        const root = expectPhrasingRoot(host);
        expect(root.getAttribute('data-size')).toBe(size);
        expect(host.textContent?.trim()).toBe('');
        unmount(instance);
      });
    }
  }
});

describe('vector theme rendering (SPEC §2.5)', () => {
  it('renders the pinned rank labels (Rank 1 = A … 13 = K)', () => {
    const labels = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    labels.forEach((label, i) => {
      const { host, instance } = mountFace(vectorTheme.Face, {
        card: { Rank: (i + 1) as Card['Rank'], Suit: 0 },
        size: 'hand',
      });
      expect(host.textContent).toContain(label);
      unmount(instance);
    });
  });

  it('renders all four §2.5 suits with their pinned glyphs', () => {
    const expected: Record<number, string> = { 0: '♣', 1: '♦', 2: '♥', 3: '♠' };
    for (const [suit, glyph] of Object.entries(expected)) {
      const { host, instance } = mountFace(vectorTheme.Face, {
        card: { Rank: 5, Suit: Number(suit) as Card['Suit'] },
        size: 'hand',
        state: 'normal',
      });
      expect(host.textContent).toContain(glyph);
      unmount(instance);
    }
  });
});

// --- Rule 2: the app owns the box --------------------------------------

const SIZING_PROPERTY = String.raw`(?<![\w-])(?:aspect-ratio|(?:min-|max-)?(?:width|height|inline-size|block-size))`;

/**
 * Every place a theme component could size its own box: CSS declarations
 * (in <style> or a style="" attribute), `style:width=` directives, and
 * presentational `width=`/`height=` attributes (e.g. on an inline <svg>).
 * Only `100%` is allowed — fill the box you are given.
 */
function findSizingViolations(source: string): string[] {
  const found: string[] = [];
  const decl = new RegExp(`${SIZING_PROPERTY}\\s*:\\s*([^;}"'\\n]+)`, 'g');
  const directive = /style:(aspect-ratio|(?:min-|max-)?(?:width|height))\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  const attribute = /(?<![\w:-])(width|height)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  for (const m of source.matchAll(decl)) {
    if (m[1].trim() !== '100%') found.push(m[0].trim());
  }
  for (const m of source.matchAll(directive)) {
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (value !== '100%') found.push(m[0]);
  }
  for (const m of source.matchAll(attribute)) {
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (value !== '100%') found.push(m[0]);
  }
  return found;
}

const themeComponents = readdirSync(THEME_DIR)
  .filter((f) => f.endsWith('.svelte'))
  .map((f) => join(THEME_DIR, f));

describe('rule 2 sizing detector self-check', () => {
  const violations = [
    '.face { width: var(--cuttle-card-width-hand); }',
    '.face { width: 72px; }',
    '.face { aspect-ratio: 2.5 / 3.5; }',
    '.face { aspect-ratio: var(--cuttle-card-aspect); }',
    '.face { max-width: 56px; }',
    '.face { min-height: 44px; }',
    '.face { inline-size: 5rem; }',
    '<span style="width: 60px">',
    '<span style:width="60px">',
    "<span style:aspect-ratio={'5 / 7'}>",
    '<svg width="56" height="78">',
  ];
  for (const src of violations) {
    it(`flags ${src}`, () => expect(findSizingViolations(src)).not.toEqual([]));
  }

  it('allows fill-the-box and unrelated *-width/*-height properties', () => {
    const ok =
      '.face { width: 100%; height: 100%; line-height: 1; border-width: 1px; outline-width: 3px; stroke-width: 2; max-width: 100%; }\n<svg width="100%" height="100%" viewBox="0 0 25 35">';
    expect(findSizingViolations(ok)).toEqual([]);
  });
});

describe('rule 2: the app sizes the card box, the theme never does (SPEC §5.6)', () => {
  it('the geometry tokens live in the app-owned stylesheet outside lib/theme/', () => {
    const css = readFileSync(GEOMETRY_CSS, 'utf8');
    // W17 (round-4): the aspect ratio moved from 2.5/3.5 to ~1.3.
    expect(css).toMatch(/--cuttle-card-aspect:\s*1\s*\/\s*1\.3\s*;/);
    for (const size of SIZES) {
      expect(css).toMatch(new RegExp(`--cuttle-card-width-${size}:\\s*[^;]+;`));
    }
  });

  it('no styling file in lib/theme/ defines, reads or imports the geometry tokens', () => {
    expect(existsSync(join(THEME_DIR, 'geometry.css'))).toBe(false);
    for (const file of readdirSync(THEME_DIR).filter((f) => /\.(?:svelte|css)$/.test(f))) {
      const src = readFileSync(join(THEME_DIR, file), 'utf8');
      expect({ file, tokens: /--cuttle-card-/.test(src) }).toEqual({ file, tokens: false });
      expect({ file, imports: /card-geometry\.css/.test(src) }).toEqual({ file, imports: false });
    }
  });

  it('there are theme components to check (not vacuous)', () => {
    expect(themeComponents.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of themeComponents) {
    it(`${file.slice(THEME_DIR.length + 1)} sets no width/height/aspect-ratio other than 100%`, () => {
      expect(findSizingViolations(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }

  it('HandCard imports the geometry stylesheet and owns the box: hand width, card aspect, clipped', () => {
    const src = readFileSync(HAND_CARD, 'utf8');
    expect(src).toMatch(/import '\.\.\/styles\/card-geometry\.css';/);
    const rule = /\.hand-card\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    expect(rule).toMatch(/(?<![\w-])width:\s*var\(--cuttle-card-width-hand\)\s*;/);
    expect(rule).toMatch(/aspect-ratio:\s*var\(--cuttle-card-aspect\)\s*;/);
    expect(rule).toMatch(/overflow:\s*hidden\s*;/);
  });
});

// Placed last: it mutates the shared module-level registry (P-ART's own
// entry point), so every assertion above about the registry's shipped
// contents runs against the unmodified registry first.
describe('registry mutation', () => {
  it('falls back to vector when a registered theme reports unavailable (rule 4)', () => {
    registerTheme({ ...vectorTheme, id: 'not-ready', available: () => false });
    expect(getTheme('not-ready')).toBe(vectorTheme);
  });
});
