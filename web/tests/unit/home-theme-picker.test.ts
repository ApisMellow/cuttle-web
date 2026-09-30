// @vitest-environment jsdom
// PRD §10 A-6 / R23.2 — the card-style picker on the home screen. Light tier:
// it renders the catalog's choices, marks the current one, and a pick lands
// in the settings store (its own storage key, SPEC §5.6 rule 5).
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import HomeScreen from '../../src/lib/components/HomeScreen.svelte';
import { SETTINGS_KEY, settings } from '../../src/lib/stores/settings.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { loadThemeCatalog, resetThemeCatalogForTests } from '../../src/lib/theme';
import { THEMES_URL, fakeFetch, mythicRoutes } from './theme-fixture';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(HomeScreen, { target: host });
  flushSync();
  return host;
}

function radio(el: HTMLElement, id: string): HTMLInputElement | null {
  return el.querySelector<HTMLInputElement>(`[data-testid="theme-option-${id}"] input[type="radio"]`);
}

beforeEach(() => {
  localStorage.clear();
  resetThemeCatalogForTests();
  settings.setThemeId('vector');
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  settings.setThemeId('vector');
});

describe('card-style picker (A-6)', () => {
  it('shows no picker while Classic is the only style', () => {
    const el = render();
    expect(el.querySelector('[data-testid^="theme-option-"]')).toBeNull();
  });

  it('lists Classic and Mythic once the catalog loads, with Classic checked by default', async () => {
    const el = render();
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    flushSync();
    await tick();
    expect(el.textContent).toContain('Card style');
    expect(el.querySelector('[data-testid="theme-option-vector"]')?.textContent).toContain('Classic');
    expect(el.querySelector('[data-testid="theme-option-mythic"]')?.textContent).toContain('Mythic');
    expect(radio(el, 'vector')?.checked).toBe(true);
    expect(radio(el, 'mythic')?.checked).toBe(false);
  });

  it('picking Mythic sets and persists the choice under the settings key, not the game save', async () => {
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    const el = render();
    radio(el, 'mythic')!.click();
    flushSync();
    expect(settings.themeId).toBe('mythic');
    expect(radio(el, 'mythic')?.checked).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) as string).themeId).toBe('mythic');
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it('offers a Card gallery link under the picker: a real anchor to the gallery under the app base', async () => {
    const el = render();
    expect(el.querySelector('[data-testid="home-gallery"]')).toBeNull();
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    flushSync();
    await tick();
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="home-gallery"]');
    expect(link?.tagName).toBe('A');
    expect(link?.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}gallery/`);
    expect(link?.textContent?.trim()).toBe('Card gallery');
    expect(link?.hasAttribute('target')).toBe(false);
    const picker = el.querySelector('.home-screen__themes')!;
    expect(picker.compareDocumentPosition(link!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a saved choice that is not in the catalog shows Classic checked', async () => {
    settings.setThemeId('retired-theme');
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    const el = render();
    expect(radio(el, 'vector')?.checked).toBe(true);
  });
});
