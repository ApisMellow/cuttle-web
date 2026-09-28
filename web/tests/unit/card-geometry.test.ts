// W22 (iPhone 15 design pass): the target device is iPhone 15 (393x852) or
// larger, so the old 360x740 compact tier is gone. Base (393): hand 60,
// field 60, far field 52, mini 32. Roomy (>=420 wide AND >=860 tall, the
// 430x932 Plus / Pro Max class): 66/66/56/34. Tablet (>=600 AND >=900):
// 72/72/64/36. `theme.test.ts` separately checks the tokens exist and that
// no theme file reads them; this file pins the VALUES, so a regression
// fails here instead of only showing up in a screenshot.
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

describe('card geometry tokens (docs/design.md §5, W22)', () => {
  it('base (393 wide): hand 60, field 60, far field 52, mini 32, aspect 1.3', () => {
    const root = block(/:root\s*\{([^}]*)\}/);
    expect(root).toMatch(/--cuttle-card-aspect-ratio:\s*1\.3\s*;/);
    expect(root).toMatch(/--cuttle-card-aspect:\s*1\s*\/\s*var\(--cuttle-card-aspect-ratio\)\s*;/);
    expect(root).toMatch(/--cuttle-card-width-hand:\s*60px\s*;/);
    expect(root).toMatch(/--cuttle-card-width-field:\s*60px\s*;/);
    expect(root).toMatch(/--cuttle-card-width-field-far:\s*52px\s*;/);
    expect(root).toMatch(/--cuttle-card-width-mini:\s*32px\s*;/);
  });

  it('roomy (>=420 wide AND >=860 tall) steps up to 66/66/56/34', () => {
    const roomy = block(/@media\s*\(min-width:\s*420px\)\s*and\s*\(min-height:\s*860px\)\s*\{\s*:root\s*\{([^}]*)\}/);
    expect(roomy).toMatch(/--cuttle-card-width-hand:\s*66px\s*;/);
    expect(roomy).toMatch(/--cuttle-card-width-field:\s*66px\s*;/);
    expect(roomy).toMatch(/--cuttle-card-width-field-far:\s*56px\s*;/);
    expect(roomy).toMatch(/--cuttle-card-width-mini:\s*34px\s*;/);
  });

  it('tablet (>=600 wide AND >=900 tall) steps up to 72/72/64/36, declared after roomy', () => {
    const tablet = block(/@media\s*\(min-width:\s*600px\)\s*and\s*\(min-height:\s*900px\)\s*\{\s*:root\s*\{([^}]*)\}/);
    expect(tablet).toMatch(/--cuttle-card-width-hand:\s*72px\s*;/);
    expect(tablet).toMatch(/--cuttle-card-width-field:\s*72px\s*;/);
    expect(tablet).toMatch(/--cuttle-card-width-field-far:\s*64px\s*;/);
    expect(tablet).toMatch(/--cuttle-card-width-mini:\s*36px\s*;/);
    expect(css.indexOf('min-width: 600px')).toBeGreaterThan(css.indexOf('min-width: 420px'));
  });

  it('no compact tier: exactly two media queries (roomy and tablet), none keyed on max-height or max-width', () => {
    expect(css.match(/@media/g)?.length).toBe(2);
    expect(css).not.toMatch(/max-height|max-width/);
  });
});
