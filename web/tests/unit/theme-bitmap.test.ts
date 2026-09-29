// @vitest-environment jsdom
// PRD §10 A-6 — bitmap themes as data, and SPEC §5.6 rule 4's fallback
// applied per slot: every face, the glasses face, the back and the playmat
// fall back to the vector rendering on their own when the theme lacks that
// image or the image fails to load. Light tier (look), except where noted.
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import {
  clearImageFailures,
  ensureThemeLoaded,
  getTheme,
  listThemeChoices,
  loadThemeCatalog,
  resetThemeCatalogForTests,
  vectorTheme,
} from '../../src/lib/theme';
import type { CardBackProps, CardFaceProps, CardSize, CardVisualState, TableProps } from '../../src/lib/theme/types';
import { THEMES_URL, fakeFetch, faceKeyOfSrc, mythicRoutes, type FixtureOptions } from './theme-fixture';

const SIZES: CardSize[] = ['hand', 'field', 'mini'];
const STATES: CardVisualState[] = ['normal', 'dimmed', 'highlighted', 'staged', 'frozen'];
const PHRASING_ROOTS = new Set(['SPAN', 'svg', 'IMG', 'PICTURE']);
const FLOW_ONLY =
  'div, p, section, article, aside, header, footer, nav, main, ul, ol, li, table, form, figure, button, a, input, canvas';

const ACE_SPADES: Card = { Rank: 1, Suit: 3 };
const TEN_HEARTS: Card = { Rank: 10, Suit: 2 };
const EIGHT_CLUBS: Card = { Rank: 8, Suit: 0 };

const hosts: Array<{ host: HTMLElement; instance: ReturnType<typeof mount> }> = [];

function render<P extends Record<string, unknown>>(component: Component<P>, props: P): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const instance = mount(component, { target: host, props });
  flushSync();
  hosts.push({ host, instance });
  return host;
}

/** Fails the current <img> in `host` `times` times (each retry mounts a fresh element). */
function failImage(host: HTMLElement, times = 2): void {
  for (let i = 0; i < times; i++) {
    const img = host.querySelector('img');
    if (!img) throw new Error(`no <img> to fail on attempt ${i + 1}`);
    img.dispatchEvent(new Event('error'));
    flushSync();
  }
}

async function loadMythic(opts: FixtureOptions = {}) {
  const fetch = fakeFetch(mythicRoutes(opts));
  await ensureThemeLoaded('mythic', { fetch, themesUrl: THEMES_URL });
  return { theme: getTheme('mythic'), fetch };
}

beforeEach(() => resetThemeCatalogForTests());

afterEach(() => {
  for (const { host, instance } of hosts.splice(0)) {
    unmount(instance);
    host.remove();
  }
});

describe('catalog and lazy loading (A-6)', () => {
  it('Classic is the only choice until the catalog loads, then catalog themes follow it', async () => {
    expect(listThemeChoices()).toEqual([{ id: 'vector', label: 'Classic' }]);
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    expect(listThemeChoices()).toEqual([
      { id: 'vector', label: 'Classic' },
      { id: 'mythic', label: 'Mythic' },
    ]);
  });

  it('reading the catalog fetches no theme manifest and no image', async () => {
    const fetch = fakeFetch(mythicRoutes());
    await loadThemeCatalog({ fetch, themesUrl: THEMES_URL });
    expect(fetch.calls).toEqual([`${THEMES_URL}index.json`]);
    expect(getTheme('mythic')).toBe(vectorTheme);
  });

  it('a chosen theme loads its manifest, registers, and getTheme returns it', async () => {
    const { theme, fetch } = await loadMythic();
    expect(theme.id).toBe('mythic');
    expect(theme.label).toBe('Mythic');
    expect(theme.assetBytes).toBe(1234);
    expect(fetch.calls).toEqual([`${THEMES_URL}index.json`, `${THEMES_URL}mythic/manifest.json`]);
  });

  it('a missing catalog leaves Classic as the only choice and never throws', async () => {
    const fetch = fakeFetch({});
    await expect(ensureThemeLoaded('mythic', { fetch, themesUrl: THEMES_URL })).resolves.toBeUndefined();
    expect(listThemeChoices().map((c) => c.id)).toEqual(['vector']);
    expect(getTheme('mythic')).toBe(vectorTheme);
  });

  it('a failed catalog fetch is not cached: the next call reads it again and the theme appears', async () => {
    await loadThemeCatalog({ fetch: fakeFetch({}), themesUrl: THEMES_URL });
    expect(listThemeChoices().map((c) => c.id)).toEqual(['vector']);
    const fetch = fakeFetch(mythicRoutes());
    await ensureThemeLoaded('mythic', { fetch, themesUrl: THEMES_URL });
    expect(fetch.calls).toContain(`${THEMES_URL}index.json`);
    expect(listThemeChoices().map((c) => c.id)).toEqual(['vector', 'mythic']);
    expect(getTheme('mythic').id).toBe('mythic');
  });

  it('ensureThemeLoaded("vector") fetches nothing', async () => {
    const fetch = fakeFetch(mythicRoutes());
    await ensureThemeLoaded('vector', { fetch, themesUrl: THEMES_URL });
    expect(fetch.calls).toEqual([]);
  });

  it('a manifest that fails to load falls back to vector (rule 4)', async () => {
    const routes = mythicRoutes();
    delete routes[`${THEMES_URL}mythic/manifest.json`];
    await ensureThemeLoaded('mythic', { fetch: fakeFetch(routes), themesUrl: THEMES_URL });
    expect(getTheme('mythic')).toBe(vectorTheme);
  });

  it('malformed catalog entries are skipped; "vector" cannot be shadowed', async () => {
    const fetch = fakeFetch({
      [`${THEMES_URL}index.json`]: {
        themes: [
          { id: 'vector', label: 'Imposter', manifest: 'x.json' },
          { id: 'Bad Id', label: 'x', manifest: 'x.json' },
          { id: 'ok', label: '', manifest: 'x.json' },
          { id: 'cathedral', label: 'Cathedral', manifest: 'cathedral/manifest.json' },
        ],
      },
    });
    await loadThemeCatalog({ fetch, themesUrl: THEMES_URL });
    expect(listThemeChoices()).toEqual([
      { id: 'vector', label: 'Classic' },
      { id: 'cathedral', label: 'Cathedral' },
    ]);
  });
});

describe('bitmap Face/Back contract (SPEC §5.6, R23.1)', () => {
  for (const size of SIZES) {
    for (const state of STATES) {
      it(`Face honours size=${size} state=${state} on a phrasing root`, async () => {
        const { theme } = await loadMythic();
        const host = render(theme.Face as Component<CardFaceProps & Record<string, unknown>>, { card: ACE_SPADES, size, state });
        expect(host.children.length).toBe(1);
        const root = host.firstElementChild as HTMLElement;
        expect(PHRASING_ROOTS.has(root.tagName)).toBe(true);
        expect(root.querySelectorAll(FLOW_ONLY).length).toBe(0);
        expect(root.dataset.size).toBe(size);
        expect(root.dataset.state).toBe(state);
        expect(root.hasAttribute('data-testid')).toBe(false);
      });
    }
  }

  it('the face image is the card named by the props, nothing else', async () => {
    const { theme } = await loadMythic();
    const host = render(theme.Face as Component<CardFaceProps & Record<string, unknown>>, { card: TEN_HEARTS, size: 'hand' });
    const imgs = [...host.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(faceKeyOfSrc(imgs[0].src)).toBe('10-hearts');
    expect(imgs[0].getAttribute('srcset')).toContain('faces-2x/10-hearts.webp 264w');
    expect(imgs[0].getAttribute('alt')).toBe('');
  });

  it('mini zooms the art to its painted corner index; hand and field show the whole card', async () => {
    const { theme } = await loadMythic();
    const Face = theme.Face as Component<CardFaceProps & Record<string, unknown>>;
    const mini = render(Face, { card: ACE_SPADES, size: 'mini' }).querySelector('img')!;
    expect(mini.style.transform).toMatch(/^scale\(/);
    const hand = render(Face, { card: ACE_SPADES, size: 'hand' }).querySelector('img')!;
    expect(hand.style.transform).toBe('');
  });

  it('Back carries no card identity: it shows the theme back image or the vector back', async () => {
    const { theme } = await loadMythic({ back: true });
    const host = render(theme.Back as Component<CardBackProps & Record<string, unknown>>, { size: 'hand' });
    const imgs = [...host.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0].src).toBe(`${THEMES_URL}mythic/back.webp`);
    expect(faceKeyOfSrc(imgs[0].src)).toBeNull();
  });
});

describe('per-slot fallback to vector (SPEC §5.6 rule 4, A-6)', () => {
  it('a face missing from the manifest renders the vector face; its neighbours stay bitmap', async () => {
    const { theme } = await loadMythic({ omitFaces: ['A-spades'] });
    const Face = theme.Face as Component<CardFaceProps & Record<string, unknown>>;
    const missing = render(Face, { card: ACE_SPADES, size: 'hand', state: 'highlighted' });
    expect(missing.querySelector('img')).toBeNull();
    const vector = missing.querySelector<HTMLElement>('.cuttle-card-face')!;
    expect(vector).not.toBeNull();
    expect(vector.dataset.state).toBe('highlighted');
    expect(missing.textContent).toContain('A');

    const present = render(Face, { card: TEN_HEARTS, size: 'hand' });
    expect(faceKeyOfSrc(present.querySelector('img')!.src)).toBe('10-hearts');
  });

  it('an image that fails to load drops that card to the vector face, and only that card', async () => {
    const { theme } = await loadMythic();
    const Face = theme.Face as Component<CardFaceProps & Record<string, unknown>>;
    const broken = render(Face, { card: ACE_SPADES, size: 'field' });
    const other = render(Face, { card: TEN_HEARTS, size: 'field' });
    failImage(broken);
    expect(broken.querySelector('img')).toBeNull();
    expect(broken.querySelector('.cuttle-card-face')).not.toBeNull();
    expect(other.querySelector('img')).not.toBeNull();
  });

  it('no back image: the vector back renders', async () => {
    const { theme } = await loadMythic({ back: false });
    const host = render(theme.Back as Component<CardBackProps & Record<string, unknown>>, { size: 'mini' });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.cuttle-card-back')).not.toBeNull();
  });

  it('a back image that fails to load drops to the vector back', async () => {
    const { theme } = await loadMythic({ back: true });
    const host = render(theme.Back as Component<CardBackProps & Record<string, unknown>>, { size: 'hand' });
    failImage(host);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.cuttle-card-back')).not.toBeNull();
  });

  it('glasses 8: the theme glasses art when present (no rank), else the vector goggles', async () => {
    const withArt = (await loadMythic()).theme;
    const art = render(withArt.Face as Component<CardFaceProps & Record<string, unknown>>, {
      card: EIGHT_CLUBS,
      size: 'field',
      variant: 'glasses',
    });
    const img = art.querySelector('img')!;
    expect(img.src).toBe(`${THEMES_URL}mythic/glasses/clubs.webp`);
    expect((art.firstElementChild as HTMLElement).dataset.variant).toBe('glasses');
    expect(img.style.transform).toBe('');

    resetThemeCatalogForTests();
    const noArt = (await loadMythic({ glasses: false })).theme;
    const vector = render(noArt.Face as Component<CardFaceProps & Record<string, unknown>>, {
      card: EIGHT_CLUBS,
      size: 'field',
      variant: 'glasses',
    });
    expect(vector.querySelector('img')).toBeNull();
    expect(vector.querySelector('[data-variant="glasses"] svg')).not.toBeNull();
    expect(vector.textContent).not.toContain('8');
  });

  it('playmat: drawn when the theme has one, nothing (the ink table) when it does not or it fails', async () => {
    const withMat = (await loadMythic({ table: true })).theme;
    const Table = withMat.Table as Component<TableProps>;
    const host = render(Table, {});
    const img = host.querySelector('img')!;
    expect(img.src).toBe(`${THEMES_URL}mythic/table.webp`);
    failImage(host);
    expect(host.querySelector('img')).toBeNull();

    resetThemeCatalogForTests();
    const noMat = (await loadMythic({ table: false })).theme;
    expect(render(noMat.Table as Component<TableProps>, {}).innerHTML.replace(/<!--[^>]*-->/g, '')).toBe('');
  });

  it('one load error retries the image once (a fresh <img>) before falling back', async () => {
    const { theme } = await loadMythic({ back: true, table: true });
    const hosts = [
      render(theme.Face as Component<CardFaceProps & Record<string, unknown>>, { card: ACE_SPADES, size: 'hand' }),
      render(theme.Back as Component<CardBackProps & Record<string, unknown>>, { size: 'hand' }),
      render(theme.Table as Component<TableProps>, {}),
    ];
    for (const host of hosts) {
      const first = host.querySelector('img')!;
      failImage(host, 1);
      const retry = host.querySelector('img');
      expect(retry).not.toBeNull();
      expect(retry).not.toBe(first);
      expect(retry!.src).toBe(first.src);
      failImage(host, 1);
      expect(host.querySelector('img')).toBeNull();
    }
  });

  it('clearImageFailures() gives every failed image a fresh chance', async () => {
    const { theme } = await loadMythic();
    const Face = theme.Face as Component<CardFaceProps & Record<string, unknown>>;
    const host = render(Face, { card: ACE_SPADES, size: 'field' });
    failImage(host);
    expect(host.querySelector('img')).toBeNull();
    clearImageFailures();
    flushSync();
    expect(faceKeyOfSrc(host.querySelector('img')!.src)).toBe('A-spades');
  });
});
