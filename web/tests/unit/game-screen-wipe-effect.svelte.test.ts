// @vitest-environment jsdom
// Issue #53 (SPEC §4.8): GameScreen plays a source's `wipeEffect` over the
// board, through WipeEffect. One mounted GameScreen per test, driven by a
// FakeTableSource.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Envelope, PlayerId } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { WIPE_EFFECT_MS, type WipeEffect } from '../../src/lib/globalEffect';
import { SETTINGS_KEY, settings } from '../../src/lib/stores/settings.svelte';
import { FakeTableSource } from './fake-table-source.svelte';
import { Phase, envelope, playerView } from './game-test-support';

const SEVEN: Card = { Rank: 7, Suit: 0 };
const NINE: Card = { Rank: 9, Suit: 1 };

function board(viewer: PlayerId): Envelope {
  return envelope({
    state: playerView({
      viewer,
      active: (1 - viewer) as PlayerId,
      phase: Phase.Normal,
      you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 3, hand: null, points: [], permanents: [] },
    }),
    legalMoves: [],
    descriptions: [],
  });
}

function wipe(overrides: Partial<WipeEffect> = {}): WipeEffect {
  return {
    seq: 5,
    by: 0,
    to: 0,
    mode: 'show',
    beforePass: true,
    cards: [
      { card: SEVEN, seat: 0, row: 'points', slot: 0, jack: -1 },
      { card: NINE, seat: 1, row: 'points', slot: 0, jack: -1 },
    ],
    ...overrides,
  };
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(source: FakeTableSource): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source } });
  flushSync();
  return host;
}

function q(sel: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(sel) ?? null;
}

function source(viewer: PlayerId, effect: WipeEffect | null): FakeTableSource {
  const s = new FakeTableSource();
  s.push(board(viewer));
  s.wipeEffect = effect;
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  settings.setReducedMotion(false);
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  settings.setReducedMotion(false);
  settings.setReplayEffects(true);
  vi.useRealTimers();
});

describe('WipeEffect in GameScreen', () => {
  it('shows over the mover’s board with one clone per wiped card, and takes the tap only during the hold', () => {
    const s = source(0, wipe());
    render(s);
    const layer = q('[data-testid="wipe-effect"]');
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.style.pointerEvents).toBe('auto');
    expect(layer?.dataset.mode).toBe('show');
    expect(host?.querySelectorAll('[data-part="wipe-clone"]')).toHaveLength(2);
    expect(host?.querySelectorAll('[data-part="wipe-clone"] [data-testid]')).toHaveLength(0);
    expect(q('[data-testid="board"]')).not.toBeNull();
  });

  it('a tap pressed after mount ends it early, once; a click with no press after mount does not', () => {
    const s = source(0, wipe());
    render(s);
    const layer = q('[data-testid="wipe-effect"]')!;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    flushSync();
    expect(s.wipeDismissals).toBe(0);
    layer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    flushSync();
    expect(s.wipeDismissals).toBe(1);
    expect(q('[data-testid="wipe-effect"]')).toBeNull();
  });

  it('a key held from the previous screen (auto-repeat) cannot skip it; a fresh press can', () => {
    const s = source(0, wipe());
    render(s);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    flushSync();
    expect(s.wipeDismissals).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    flushSync();
    expect(s.wipeDismissals).toBe(1);
  });

  it('the timer ends it after WIPE_EFFECT_MS', () => {
    const s = source(0, wipe());
    render(s);
    vi.advanceTimersByTime(WIPE_EFFECT_MS - 1);
    expect(s.wipeDismissals).toBe(0);
    vi.advanceTimersByTime(1);
    flushSync();
    expect(s.wipeDismissals).toBe(1);
    expect(q('[data-testid="wipe-effect"]')).toBeNull();
  });

  it('a replay ignores the pointer and keys, and the board is inert while it plays', () => {
    const s = source(1, wipe({ to: 1, mode: 'replay', beforePass: false }));
    render(s);
    const layer = q('[data-testid="wipe-effect"]')!;
    expect(layer.style.pointerEvents).toBe('none');
    layer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    flushSync();
    expect(s.wipeDismissals).toBe(0);
    expect(q('[data-testid="board"]')?.dataset.inert).toBe('true');
    vi.advanceTimersByTime(WIPE_EFFECT_MS);
    flushSync();
    expect(s.wipeDismissals).toBe(1);
    expect(q('[data-testid="board"]')?.dataset.inert).toBe('false');
  });

  it('reduced motion: no clones, a static outline on each emptied row only', () => {
    settings.setReducedMotion(true);
    const s = source(0, wipe());
    render(s);
    expect(q('[data-testid="wipe-effect"]')?.dataset.motion).toBe('reduced');
    expect(host?.querySelectorAll('[data-part="wipe-clone"]')).toHaveLength(0);
    expect(host?.querySelectorAll('[data-part="wipe-outline"]')).toHaveLength(2);
    vi.advanceTimersByTime(WIPE_EFFECT_MS);
    flushSync();
    expect(s.wipeDismissals).toBe(1);
  });

  it('never mounts for another viewer, nor behind a curtain', () => {
    const s = source(1, wipe({ to: 0 }));
    render(s);
    expect(q('[data-testid="wipe-effect"]')).toBeNull();
    s.wipeEffect = wipe({ to: 1 });
    s.curtain = { kind: 'handoff', to: 1, reason: 'turn' };
    flushSync();
    expect(q('[data-testid="wipe-effect"]')).toBeNull();
  });
});

describe('the menu’s Replay effects switch', () => {
  it('persists replayEffects and is at least 44 px tall by its class rule', () => {
    const s = source(0, null);
    render(s);
    q('[data-testid="menu-button"]')!.click();
    flushSync();
    const row = q('[data-testid="menu-replay-effects"]');
    expect(row).not.toBeNull();
    const input = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(input.getAttribute('role')).toBe('switch');
    expect(input.checked).toBe(true);
    input.click();
    flushSync();
    expect(settings.replayEffects).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).replayEffects).toBe(false);
    expect(s.wipeDismissals).toBe(0);
    expect(s.applied).toEqual([]);
  });
});
