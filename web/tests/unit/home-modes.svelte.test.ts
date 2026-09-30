// @vitest-environment jsdom
// W13a: the Home screen's three modes and the online entry points.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import HomeScreen from '../../src/lib/components/HomeScreen.svelte';
import { createFakeOnlineActions, type OnlineActions } from '../../src/lib/online/actions';
import { game } from '../../src/lib/stores/game.svelte';
import { online } from '../../src/lib/stores/online.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: { actions?: OnlineActions; onlineEnabled?: boolean }): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(HomeScreen, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function has(el: HTMLElement, id: string): boolean {
  return el.querySelector(`[data-testid="${id}"]`) !== null;
}

beforeEach(() => {
  localStorage.clear();
  game.screen = 'home';
  game.notice = null;
  game.error = null;
  session.setNames('', '');
  settings.lastNames = null;
  online.close();
});
afterEach(cleanup);

describe('Home: three modes', () => {
  it('names each mode with a heading; table mode is a switch under Pass and play', () => {
    const el = render({ actions: createFakeOnlineActions(), onlineEnabled: true });
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(['Pass and play', 'Play on two phones']);
    const pass = el.querySelector('[data-testid="mode-pass-play"]');
    expect(pass?.querySelector('[data-testid="table-mode-toggle"]')).not.toBeNull();
    expect(pass?.querySelector('[data-testid="new-game"]')).not.toBeNull();
  });

  it('Start a room and Join with a code open the online screens', () => {
    const el = render({ actions: createFakeOnlineActions(), onlineEnabled: true });
    el.querySelector<HTMLButtonElement>('[data-testid="online-create"]')?.click();
    expect(online.view).toBe('create');
    online.close();
    el.querySelector<HTMLButtonElement>('[data-testid="online-join"]')?.click();
    expect(online.view).toBe('join');
    expect(online.joinCode).toBe('');
  });

  it('hides the online mode when it is not available', () => {
    const el = render({ actions: createFakeOnlineActions(), onlineEnabled: false });
    expect(has(el, 'mode-online')).toBe(false);
    expect(has(el, 'new-game')).toBe(true);
  });
});

describe('Home: one online game per phone', () => {
  it('a saved seat shows Resume online game instead of Create and Join', () => {
    const actions = createFakeOnlineActions({ saved: { code: 'K7QX', opponentName: 'Blake' } });
    const el = render({ actions, onlineEnabled: true });
    const resume = el.querySelector<HTMLButtonElement>('[data-testid="resume-online"]');
    expect(resume?.textContent?.trim()).toBe('Resume online game with Blake');
    expect(has(el, 'online-create')).toBe(false);
    expect(has(el, 'online-join')).toBe(false);
    resume?.click();
    expect(actions.calls.resume).toBe(1);
  });

  it('falls back to a plain label when the opponent is unknown', () => {
    const actions = createFakeOnlineActions({ saved: { code: 'K7QX', opponentName: null } });
    const el = render({ actions, onlineEnabled: true });
    expect(el.querySelector('[data-testid="resume-online"]')?.textContent?.trim()).toBe('Resume online game');
  });
});
