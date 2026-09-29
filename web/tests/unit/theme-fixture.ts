// Shared fixture for bitmap-theme tests (PRD §10 A-6): a catalog and a
// manifest served by a fake `fetch`, so no test touches the network.

export const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

export const THEMES_URL = 'https://cuttle.test/themes/';

export interface FixtureOptions {
  /** Face keys ("A-spades") to leave out of the manifest. */
  omitFaces?: string[];
  back?: boolean;
  table?: boolean;
  glasses?: boolean;
}

export function fixtureManifest(opts: FixtureOptions = {}): Record<string, unknown> {
  const omit = new Set(opts.omitFaces ?? []);
  const faces: Record<string, unknown> = {};
  for (const rank of RANK_LABELS) {
    for (const suit of SUIT_NAMES) {
      const key = `${rank}-${suit}`;
      if (omit.has(key)) continue;
      faces[key] = [
        { src: `faces/${key}.webp`, w: 132 },
        { src: `faces-2x/${key}.webp`, w: 264 },
      ];
    }
  }
  const glasses: Record<string, unknown> = {};
  if (opts.glasses ?? true) {
    for (const suit of SUIT_NAMES) glasses[suit] = [{ src: `glasses/${suit}.webp`, w: 172 }];
  }
  return {
    assetBytes: 1234,
    index: { x: 0.0156, y: 0.012, w: 0.246, h: 0.365 },
    faces,
    glasses,
    back: opts.back ? [{ src: 'back.webp', w: 132 }] : null,
    table: opts.table ? [{ src: 'table.webp', w: 1024 }] : null,
  };
}

export function fixtureCatalog(): Record<string, unknown> {
  return { themes: [{ id: 'mythic', label: 'Mythic', manifest: 'mythic/manifest.json' }] };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** A `fetch` that serves `routes` (absolute URL -> JSON body) and 404s everything else. */
export function fakeFetch(routes: Record<string, unknown>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (input: RequestInfo | URL): Promise<FakeResponse> => {
    const url = String(input);
    calls.push(url);
    if (url in routes) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
  };
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

export function mythicRoutes(opts: FixtureOptions = {}): Record<string, unknown> {
  return {
    [`${THEMES_URL}index.json`]: fixtureCatalog(),
    [`${THEMES_URL}mythic/manifest.json`]: fixtureManifest(opts),
  };
}

/** The face key an <img> src points at, or null if it isn't a face image. */
export function faceKeyOfSrc(src: string): string | null {
  const m = /\/faces(?:-2x)?\/([^/]+)\.webp$/.exec(src);
  return m ? m[1] : null;
}
