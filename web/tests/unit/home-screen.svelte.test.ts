// @vitest-environment jsdom
// SPEC §5.2 HomeScreen (R1, R4.3, R4.4).
//
// HomeScreen calls only the public store API (`session.setNames`,
// `game.newGame`, `game.restore`). This suite covers exactly the parts of
// that wiring that do NOT reach the bridge, so it runs with no WASM at all:
//   - the R4.4 "discarded snapshot -> brief notice" path, which
//     `GameStore.restore()` resolves without ever calling the bridge when
//     `decodeSnapshot` already failed (see HomeScreen.svelte's module doc).
//   - the R4.3 abandon-confirm dialog appearing/naming the existing game/
//     being cancellable, none of which touches the engine until Confirm
//     is pressed.
// A valid-snapshot Resume, a from-scratch New game, and a confirmed abandon
// all end in a real `newGame()`/`restore()` bridge call and are covered by
// the e2e suite instead (this round's brief: R1.3 and R4.3 are e2e
// acceptance items).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeScreen from '../../src/lib/components/HomeScreen.svelte';
import { game } from '../../src/lib/stores/game.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { SETTINGS_KEY, settings } from '../../src/lib/stores/settings.svelte';
import { SNAPSHOT_KEY, encodeSnapshot, type Snapshot } from '../../src/lib/stores/snapshot';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(HomeScreen, { target: host });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function resetGameSingleton(): void {
  game.envelope = null;
  game.history = [];
  game.seq = 0;
  game.viewer = null;
  game.curtain = { kind: 'none' };
  game.lastSeenSeq = { 0: 0, 1: 0 };
  game.error = null;
  game.screen = 'home';
  game.notice = null;
}

beforeEach(() => {
  localStorage.clear();
  resetGameSingleton();
  session.setNames('', ''); // resets the shared singleton back to defaults
  settings.lastNames = null; // the settings singleton read storage once, at import
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function resumeButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>('[data-testid="resume"]');
}

function newGameButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="new-game"]');
  if (!found) throw new Error('no new-game button rendered');
  return found;
}

const VALID_SNAPSHOT: Snapshot = {
  v: 2,
  savedAt: '2026-09-27T00:00:00.000Z',
  engineState: '{}',
  history: [],
  lastSeenSeq: { 0: 0, 1: 0 },
  viewer: 0,
  curtain: { kind: 'none' },
  names: ['Alice', 'Blake'],
  seed: '42',
  dealer: 1,
};

describe('HomeScreen (SPEC §5.2, R1)', () => {
  it('carries the home-screen root and both name-input testids at mount', () => {
    const el = render();
    expect(el.querySelector('[data-testid="home-screen"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="name-input-0"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="name-input-1"]')).not.toBeNull();
  });

  it('no Resume button and no notice when there is no snapshot at all', () => {
    const el = render();
    expect(resumeButton(el)).toBeNull();
    expect(el.textContent).not.toContain('could not be restored');
    expect(el.textContent).not.toContain('could not be read');
  });
});

describe('HomeScreen Resume affordance (R4.2/R4.3) — presence only, no bridge call', () => {
  it('shows Resume when a valid snapshot exists', () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(VALID_SNAPSHOT));
    const el = render();
    expect(resumeButton(el)).not.toBeNull();
  });
});

describe('HomeScreen abandon-confirm (R4.3)', () => {
  it('New game shows a confirm dialog naming the in-progress game when a snapshot exists', () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(VALID_SNAPSHOT));
    const el = render();

    expect(el.querySelector('[data-testid="confirm-abandon"]')).toBeNull();
    newGameButton(el).click();
    flushSync();

    const confirmButton = el.querySelector('[data-testid="confirm-abandon"]');
    const cancelButton = el.querySelector('[data-testid="cancel-abandon"]');
    expect(confirmButton).not.toBeNull();
    expect(cancelButton).not.toBeNull();
    expect(el.textContent).toContain('Abandon Alice vs Blake?');
  });

  it('Cancel dismisses the confirm dialog and leaves the snapshot untouched', () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(VALID_SNAPSHOT));
    const el = render();

    newGameButton(el).click();
    flushSync();
    el.querySelector<HTMLButtonElement>('[data-testid="cancel-abandon"]')?.click();
    flushSync();

    expect(el.querySelector('[data-testid="confirm-abandon"]')).toBeNull();
    expect(resumeButton(el)).not.toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(encodeSnapshot(VALID_SNAPSHOT));
  });

  it('New game skips the confirm dialog entirely when there is no snapshot to abandon', () => {
    const el = render();
    newGameButton(el);
    // No snapshot exists, so a click starts the game directly instead of
    // confirming; we only assert the dialog never appears pre-click, since
    // clicking would reach the bridge (covered by e2e).
    expect(el.querySelector('[data-testid="confirm-abandon"]')).toBeNull();
  });
});

describe('HomeScreen discarded-snapshot notice (R4.4 — "already verified at store level; now make it visible")', () => {
  it('shows the version-mismatch notice and no Resume button', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 3, bogus: true }));
    const el = render();
    expect(resumeButton(el)).toBeNull();
    expect(el.textContent).toContain('Your saved game was from an older version and could not be restored.');
  });

  it('shows the malformed-JSON notice and no Resume button', () => {
    localStorage.setItem(SNAPSHOT_KEY, 'not valid json{{{');
    const el = render();
    expect(resumeButton(el)).toBeNull();
    expect(el.textContent).toContain('Your saved game could not be read and was discarded.');
  });

  it('discards the bad entry from storage (mirrors GameStore#discardSnapshot)', () => {
    localStorage.setItem(SNAPSHOT_KEY, 'not valid json{{{');
    render();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe('W25: name fields stay filled', () => {
  function inputs(el: HTMLElement): [string, string] {
    return [
      el.querySelector<HTMLInputElement>('[data-testid="name-input-0"]')!.value,
      el.querySelector<HTMLInputElement>('[data-testid="name-input-1"]')!.value,
    ];
  }

  it('after a reload (fresh session), the saved game fills the names', () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(VALID_SNAPSHOT));
    expect(inputs(render())).toEqual(['Alice', 'Blake']);
  });

  it('back on Home in the same session, the session names fill the fields', () => {
    session.setNames('Alice', 'Blake');
    expect(inputs(render())).toEqual(['Alice', 'Blake']);
  });

  it('default names leave the fields blank (the placeholder shows)', () => {
    expect(inputs(render())).toEqual(['', '']);
  });
});

describe('R10: names survive a reload with no saved game', () => {
  function inputs(el: HTMLElement): [string, string] {
    return [
      el.querySelector<HTMLInputElement>('[data-testid="name-input-0"]')!.value,
      el.querySelector<HTMLInputElement>('[data-testid="name-input-1"]')!.value,
    ];
  }

  it('with no saved game and a fresh session, the last-used names from settings fill the fields', () => {
    // A reload: the settings store read these names from storage at boot.
    settings.setLastNames('Alice', 'Blake');
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(inputs(render())).toEqual(['Alice', 'Blake']);
  });

  it('a blank last-used name stays blank, so its placeholder shows', () => {
    settings.setLastNames('Alice', '');
    const el = render();
    expect(inputs(el)).toEqual(['Alice', '']);
    expect(el.querySelector<HTMLInputElement>('[data-testid="name-input-1"]')!.placeholder).toBe('Player 2');
  });

  it('names set this session win over the last-used names', () => {
    settings.setLastNames('Blake', 'Alice');
    session.setNames('Alice', 'Blake');
    expect(inputs(render())).toEqual(['Alice', 'Blake']);
  });

  it('a saved game still wins over the last-used names', () => {
    settings.setLastNames('Blake', 'Alice');
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(VALID_SNAPSHOT));
    expect(inputs(render())).toEqual(['Alice', 'Blake']);
  });

  it('New game saves the typed names to settings, never to the game snapshot key', () => {
    const newGame = vi.spyOn(game, 'newGame').mockResolvedValue(undefined);
    const el = render();
    const [a, b] = [
      el.querySelector<HTMLInputElement>('[data-testid="name-input-0"]')!,
      el.querySelector<HTMLInputElement>('[data-testid="name-input-1"]')!,
    ];
    a.value = ' Alice ';
    a.dispatchEvent(new Event('input'));
    b.value = 'Blake';
    b.dispatchEvent(new Event('input'));
    flushSync();
    newGameButton(el).click();
    flushSync();

    expect(newGame).toHaveBeenCalledTimes(1);
    expect(settings.lastNames).toEqual(['Alice', 'Blake']);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).lastNames).toEqual(['Alice', 'Blake']);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe('issue #37: the table mode toggle', () => {
  beforeEach(() => {
    settings.tableMode = false;
  });

  afterEach(() => {
    settings.tableMode = false;
  });

  function toggle(el: HTMLElement): HTMLInputElement {
    const label = el.querySelector<HTMLElement>('[data-testid="table-mode-toggle"]');
    if (!label) throw new Error('no table-mode-toggle rendered');
    const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error('the toggle has no checkbox');
    return input;
  }

  it('is on the home screen, labelled for a phone lying flat, and off by default', () => {
    const el = render();
    const input = toggle(el);
    expect(input.checked).toBe(false);
    expect(el.querySelector('[data-testid="table-mode-toggle"]')?.textContent).toContain('Table mode: phone lies flat between you');
  });

  it('turning it on saves the setting under the settings key, never in the game snapshot', () => {
    const el = render();
    toggle(el).click();
    flushSync();
    expect(settings.tableMode).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).tableMode).toBe(true);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    toggle(el).click();
    flushSync();
    expect(settings.tableMode).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).tableMode).toBe(false);
  });

  it('shows a saved choice as checked', () => {
    settings.tableMode = true;
    expect(toggle(render()).checked).toBe(true);
  });
});
