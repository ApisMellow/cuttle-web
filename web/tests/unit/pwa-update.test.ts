// R18 update policy (SPEC §5.8): a new build reaches players without ever
// reloading a game in progress. The waiting service worker takes over only
// at a safe point: the home screen (not while a name field is being typed
// in), the loading screen, or the boot-failure screen.
import { describe, expect, it } from 'vitest';

import { createUpdatePolicy, type UpdateScreen } from '../../src/lib/pwa/update';

function harness(opts: { typing?: boolean; start?: UpdateScreen } = {}) {
  const calls: string[] = [];
  let typing = opts.typing ?? false;
  let now = 1_000_000;
  const policy = createUpdatePolicy({
    activate: () => calls.push('activate'),
    reload: () => calls.push('reload'),
    checkForUpdate: () => calls.push('check'),
    isTyping: () => typing,
    now: () => now,
  });
  if (opts.start) policy.setScreen(opts.start);
  return {
    policy,
    calls,
    setTyping(v: boolean) {
      typing = v;
    },
    advance(ms: number) {
      now += ms;
    },
    actions: () => calls.filter((c) => c !== 'check'),
  };
}

describe('pwa update policy', () => {
  it('never activates or reloads while a game is on screen', () => {
    const h = harness({ start: 'game' });
    h.policy.updateReady();
    h.policy.visible();
    h.policy.poke();
    h.policy.setScreen('result');
    h.policy.setScreen('error');
    h.policy.setScreen('game');
    expect(h.actions()).toEqual([]);
  });

  it('activates the waiting worker once the player reaches the home screen', () => {
    const h = harness({ start: 'game' });
    h.policy.updateReady();
    expect(h.actions()).toEqual([]);
    h.policy.setScreen('home');
    expect(h.actions()).toEqual(['activate']);
    h.policy.setScreen('game');
    h.policy.setScreen('home');
    expect(h.actions()).toEqual(['activate']);
  });

  it('activates at once when the update is found on the home screen or while loading', () => {
    const home = harness({ start: 'home' });
    home.policy.updateReady();
    expect(home.actions()).toEqual(['activate']);

    const loading = harness({ start: 'loading' });
    loading.policy.updateReady();
    expect(loading.actions()).toEqual(['activate']);

    const failed = harness({ start: 'boot-failed' });
    failed.policy.updateReady();
    expect(failed.actions()).toEqual(['activate']);
  });

  it('waits while a name is being typed on the home screen', () => {
    const h = harness({ start: 'home', typing: true });
    h.policy.updateReady();
    expect(h.actions()).toEqual([]);
    h.setTyping(false);
    h.policy.poke();
    expect(h.actions()).toEqual(['activate']);
  });

  it('reloads when the new worker takes control at a safe point', () => {
    const h = harness({ start: 'home' });
    h.policy.updateReady();
    h.policy.controllerChanged();
    expect(h.actions()).toEqual(['activate', 'reload']);
  });

  it('defers the reload if the player started a game before the new worker took control', () => {
    const h = harness({ start: 'home' });
    h.policy.updateReady();
    h.policy.setScreen('game');
    h.policy.controllerChanged();
    h.policy.visible();
    expect(h.actions()).toEqual(['activate']);
    h.policy.setScreen('home');
    expect(h.actions()).toEqual(['activate', 'reload']);
  });

  it('a takeover it did not ask for (another tab) never reloads a game', () => {
    const h = harness({ start: 'game' });
    h.policy.controllerChanged();
    expect(h.actions()).toEqual([]);
    h.policy.setScreen('home');
    expect(h.actions()).toEqual(['reload']);
  });

  it('reloads at most once', () => {
    const h = harness({ start: 'home' });
    h.policy.controllerChanged();
    h.policy.controllerChanged();
    h.policy.poke();
    h.policy.setScreen('home');
    expect(h.actions()).toEqual(['reload']);
  });

  it('checks for a new build on the home screen and on return to the app, at most once a minute', () => {
    const h = harness({ start: 'game' });
    expect(h.calls).toEqual([]);
    h.policy.setScreen('home');
    expect(h.calls).toEqual(['check']);
    h.policy.visible();
    expect(h.calls).toEqual(['check']);
    h.advance(61_000);
    h.policy.visible();
    expect(h.calls).toEqual(['check', 'check']);
    // Returning to the app mid-game still checks; it just never applies.
    h.policy.setScreen('game');
    h.advance(61_000);
    h.policy.visible();
    expect(h.calls).toEqual(['check', 'check', 'check']);
  });
});
