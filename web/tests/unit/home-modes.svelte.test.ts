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
import { FakeEnvironment } from './online-fakes';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: { actions?: OnlineActions; onlineEnabled?: boolean; network?: FakeEnvironment }): HTMLDivElement {
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

  // R24.14 (plan §10): offline, Play online stays visible and says it needs a connection.
  it('offline, the online mode stays, explains, and Create and Join wait for the network', () => {
    const network = new FakeEnvironment();
    network.online = false;
    const el = render({ actions: createFakeOnlineActions(), onlineEnabled: true, network });
    expect(has(el, 'mode-online')).toBe(true);
    expect(el.querySelector('[data-testid="online-offline"]')?.textContent).toContain('You’re offline. Online games need a connection.');
    const create = el.querySelector<HTMLButtonElement>('[data-testid="online-create"]');
    const join = el.querySelector<HTMLButtonElement>('[data-testid="online-join"]');
    expect(create?.disabled).toBe(true);
    expect(join?.disabled).toBe(true);
    create?.click();
    expect(online.view).toBe('none');

    network.goOnline();
    flushSync();
    expect(has(el, 'online-offline')).toBe(false);
    expect(create?.disabled).toBe(false);
    network.goOffline();
    flushSync();
    expect(has(el, 'online-offline')).toBe(true);
  });

  it('online, no offline line', () => {
    const el = render({ actions: createFakeOnlineActions(), onlineEnabled: true, network: new FakeEnvironment() });
    expect(has(el, 'online-offline')).toBe(false);
  });

  it('stops listening for the network once Home is gone', () => {
    const network = new FakeEnvironment();
    render({ actions: createFakeOnlineActions(), onlineEnabled: true, network });
    expect(network.listenerCount()).toBeGreaterThan(0);
    cleanup();
    expect(network.listenerCount()).toBe(0);
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

  it('offline, Resume stays and the offline line shows', () => {
    const network = new FakeEnvironment();
    network.online = false;
    const actions = createFakeOnlineActions({ saved: { code: 'K7QX', opponentName: 'Blake' } });
    const el = render({ actions, onlineEnabled: true, network });
    expect(el.querySelector('[data-testid="online-offline"]')?.textContent).toContain('You’re offline. Online games need a connection.');
    const resume = el.querySelector<HTMLButtonElement>('[data-testid="resume-online"]');
    expect(resume?.disabled).toBe(false);
  });

  it('falls back to a plain label when the opponent is unknown', () => {
    const actions = createFakeOnlineActions({ saved: { code: 'K7QX', opponentName: null } });
    const el = render({ actions, onlineEnabled: true });
    expect(el.querySelector('[data-testid="resume-online"]')?.textContent?.trim()).toBe('Resume online game');
  });
});
