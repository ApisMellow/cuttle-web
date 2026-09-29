// PRD §10 A-6 / R22.3 — the shipped theme catalog and the Mythic theme's
// files. Every theme in `static/themes/index.json` has a manifest; every
// image a manifest names exists; the declared `assetBytes` is the real total
// and fits the 4 MB budget. Also checks the catalog parses the way the app
// will read it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCatalog, parseManifest } from '../../src/lib/theme/catalog';
import { RANK_LABELS, SUIT_NAMES } from './theme-fixture';

const THEMES = join(__dirname, '..', '..', 'static', 'themes');
const BUDGET = 4 * 1024 * 1024;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const catalog = parseCatalog(readJson(join(THEMES, 'index.json')));

describe('shipped theme catalog', () => {
  it('lists Mythic', () => {
    expect(catalog.map((t) => [t.id, t.label])).toContainEqual(['mythic', 'Mythic']);
  });

  for (const entry of catalog) {
    describe(entry.id, () => {
      const manifestPath = join(THEMES, entry.manifest);
      const raw = readJson(manifestPath) as { assetBytes: number };
      const manifest = parseManifest(raw, entry);
      const dir = dirname(manifestPath);
      const files = [
        ...Object.values(manifest.faces),
        ...Object.values(manifest.glasses),
        manifest.back ?? [],
        manifest.table ?? [],
      ].flatMap((sources) => sources.map((s) => join(dir, s.src)));

      it('every image the manifest names exists', () => {
        for (const file of files) expect({ file, exists: existsSync(file) }).toEqual({ file, exists: true });
      });

      it('declared assetBytes equals the real total and is within the 4 MB budget (R22.3)', () => {
        const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
        expect(raw.assetBytes).toBe(total);
        expect(total).toBeLessThanOrEqual(BUDGET);
      });
    });
  }
});

describe('Mythic is a complete deck', () => {
  const entry = catalog.find((t) => t.id === 'mythic')!;
  const manifest = parseManifest(readJson(join(THEMES, entry.manifest)), entry);

  it('has a face for all 52 cards, each at game size and 2x', () => {
    for (const rank of RANK_LABELS) {
      for (const suit of SUIT_NAMES) {
        expect(manifest.faces[`${rank}-${suit}`]?.map((s) => s.w)).toEqual([132, 264]);
      }
    }
  });

  it('has a landscape glasses face for every suit (the glasses 8)', () => {
    for (const suit of SUIT_NAMES) expect(manifest.glasses[suit]?.map((s) => s.w)).toEqual([172, 344]);
  });

  it('records where the painted corner index sits (upper left)', () => {
    expect(manifest.index).not.toBeNull();
    expect(manifest.index!.x).toBeLessThan(0.1);
    expect(manifest.index!.y).toBeLessThan(0.1);
  });
});
