// P2 W9 (docs/design.md §5) — the provisional geometry: field 72 -> 60 on
// phones (52 compact), a tablet step-up to 64/72/36 when both dimensions
// clear the threshold. Hand and mini are unchanged on phones. `theme.test.ts`
// separately checks the tokens exist at all and that no theme file reads or
// redefines them; this file checks the actual VALUES this round's brief
// pins, so a regression to the old 72px field width (or a wrong breakpoint)
// fails loudly here instead of only showing up as a layout screenshot diff.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CSS_PATH = join(__dirname, '..', '..', 'src', 'lib', 'styles', 'card-geometry.css');
const css = readFileSync(CSS_PATH, 'utf8');

function block(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) throw new Error(`pattern not found in card-geometry.css: ${pattern}`);
  return match[1];
}

describe('card geometry tokens (docs/design.md §5)', () => {
  it('phone defaults: hand 56, field 60, mini 32, aspect unchanged', () => {
    const root = block(/:root\s*\{([^}]*)\}/);
    expect(root).toMatch(/--cuttle-card-aspect:\s*2\.5\s*\/\s*3\.5\s*;/);
    expect(root).toMatch(/--cuttle-card-width-hand:\s*56px\s*;/);
    expect(root).toMatch(/--cuttle-card-width-field:\s*60px\s*;/);
    expect(root).toMatch(/--cuttle-card-width-mini:\s*32px\s*;/);
  });

  it('compact (<=780 tall or <375 wide) narrows field to 52; hand/mini untouched in that block', () => {
    const compact = block(/@media\s*\(max-height:\s*780px\),\s*\(max-width:\s*374px\)\s*\{\s*:root\s*\{([^}]*)\}/);
    expect(compact).toMatch(/--cuttle-card-width-field:\s*52px\s*;/);
    expect(compact).not.toMatch(/--cuttle-card-width-hand/);
    expect(compact).not.toMatch(/--cuttle-card-width-mini/);
  });

  it('tablet (>=600 wide AND >=900 tall) steps up to 64/72/36', () => {
    const tablet = block(/@media\s*\(min-width:\s*600px\)\s*and\s*\(min-height:\s*900px\)\s*\{\s*:root\s*\{([^}]*)\}/);
    expect(tablet).toMatch(/--cuttle-card-width-hand:\s*64px\s*;/);
    expect(tablet).toMatch(/--cuttle-card-width-field:\s*72px\s*;/);
    expect(tablet).toMatch(/--cuttle-card-width-mini:\s*36px\s*;/);
  });

  it('exactly two media queries exist (compact and tablet — no stray third breakpoint)', () => {
    expect(css.match(/@media/g)?.length).toBe(2);
  });
});
