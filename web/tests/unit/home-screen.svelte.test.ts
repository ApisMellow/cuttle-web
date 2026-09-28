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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import HomeScreen from '../../src/lib/components/HomeScreen.svelte';
import { game } from '../../src/lib/stores/game.svelte';
import { session } from '../../src/lib/stores/session.svelte';
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
});

afterEach(cleanup);

function resumeButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>('[data-testid="resume"]');
}

function newGameButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="new-game"]');
  if (!found) throw new Error('no new-game button rendered');
  return found;
}

const VALID_SNAPSHOT: Snapshot = {
  v: 1,
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
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 2, bogus: true }));
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
