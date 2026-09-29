// @vitest-environment jsdom
// The in-game menu (SPEC §5.2, §5.5 R17.2, §5.6 rule 5, §5.7; design.md §6,
// §8). ONE mounted GameScreen per test through the real `game`/`session`/
// `settings` singletons; only `lib/bridge/engine` is faked.
//
// Strict tier (hidden information and save/resume):
//   - The menu shows no game state and changes nothing the game holds.
//     Opening and closing it, the Rules sheet from it and a card-style swap
//     leave the curtain, viewer, envelope, history, seq, lastSeenSeq and the
//     save byte-for-byte as they were, and never call the engine.
//   - Behind a withheld curtain (handoff/reveal/recap) the menu button is
//     there (design.md §8: rules stay reachable), the board is never in the
//     DOM, and nothing the menu does brings it in.
//   - Home writes nothing; New game asks first and names the game.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Envelope, Move, PlayerView } from '../../src/lib/bridge/schema';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { loadThemeCatalog, resetThemeCatalogForTests } from '../../src/lib/theme';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';
import { THEMES_URL, fakeFetch, mythicRoutes } from './theme-fixture';

const bridge = vi.hoisted(() => ({
  newGame: vi.fn(),
  apply: vi.fn(),
  view: vi.fn(),
  snapshot: vi.fn(() => '"fake-engine-state"'),
  restore: vi.fn(),
  legalMoves: vi.fn(),
  describe: vi.fn(),
}));

vi.mock('../../src/lib/bridge/engine', () => bridge);

const { default: GameScreen } = await import('../../src/lib/components/GameScreen.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
/** Distinctive, so a leak would be visible in the DOM: the queen of hearts. */
const QUEEN = { Rank: 12, Suit: 2 } as const;

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

const MOVES: Move[] = [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE })];
const DESCRIPTIONS = ['draw a card', 'play ace as point card'];

function aliceView(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, NINE, QUEEN], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 4, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

function opening(): Envelope {
  return envelope({ state: aliceView(), legalMoves: MOVES, descriptions: DESCRIPTIONS });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

beforeEach(() => {
  localStorage.clear();
  resetThemeCatalogForTests();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  game.envelope = null;
  game.history = [];
  game.seq = 0;
  game.viewer = null;
  game.curtain = { kind: 'none' };
  game.lastSeenSeq = { 0: 0, 1: 0 };
  game.error = null;
  game.screen = 'home';
  game.notice = null;
  session.setNames('Alice', 'Blake');
  session.lastDealer = null;
  settings.revealPreference = 'two-step';
  settings.setThemeId('vector');
});

afterEach(() => {
  cleanup();
  settings.setThemeId('vector');
});

function q(el: ParentNode, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function click(el: ParentNode, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  await settle();
}

async function key(k: string, opts: KeyboardEventInit = {}): Promise<void> {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  await settle();
}

/** Everything the game holds, plus the raw save. */
function held(): string {
  return JSON.stringify({
    save: localStorage.getItem(SNAPSHOT_KEY),
    curtain: game.curtain,
    viewer: game.viewer,
    envelope: game.envelope,
    history: game.history,
    seq: game.seq,
    lastSeenSeq: game.lastSeenSeq,
    screen: game.screen,
    error: game.error,
  });
}

function engineCalls(): number {
  return bridge.newGame.mock.calls.length + bridge.apply.mock.calls.length + bridge.view.mock.calls.length + bridge.restore.mock.calls.length;
}

async function liveBoard(): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, opening(), { seed: '1' });
  bridge.newGame.mockClear();
  const el = render();
  expect(q(el, 'board')).not.toBeNull();
  return el;
}

/** The opening curtain: a withheld handoff to Alice, no envelope in memory. */
async function atHandoff(): Promise<HTMLDivElement> {
  bridge.newGame.mockImplementation(() => opening());
  await game.newGame({ seed: '1' });
  bridge.newGame.mockClear();
  const el = render();
  expect(game.curtain.kind).toBe('handoff');
  expect(q(el, 'board')).toBeNull();
  return el;
}

async function loadMythicCatalog(): Promise<void> {
  await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
  await settle();
}

// ---------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------

describe('menu button placement', () => {
  it('on the live board it sits in the score bar, labelled, collapsed', async () => {
    const el = await liveBoard();
    const button = q(el, 'menu-button');
    expect(button).not.toBeNull();
    expect(q(el, 'score-bar')?.contains(button)).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(q(el, 'game-menu')).toBeNull();
  });

  it('behind a withheld curtain it is outside the curtain, and there is exactly one', async () => {
    const el = await atHandoff();
    expect(el.querySelectorAll('[data-testid="menu-button"]')).toHaveLength(1);
    expect(q(el, 'curtain')?.contains(q(el, 'menu-button'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Open, close, focus, Escape
// ---------------------------------------------------------------------------

describe('opening and closing the menu', () => {
  it('opens a labelled dialog with focus on its first item; Close returns focus to the button', async () => {
    const el = await liveBoard();
    await click(el, 'menu-button');
    const menu = q(el, 'game-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(menu?.getAttribute('aria-label')).toBe('Menu');
    expect(q(el, 'menu-button')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(q(el, 'menu-rules'));
    for (const id of ['menu-rules', 'menu-home', 'menu-new-game', 'menu-close']) expect(q(el, id)).not.toBeNull();

    await click(el, 'menu-close');
    expect(q(el, 'game-menu')).toBeNull();
    expect(document.activeElement).toBe(q(el, 'menu-button'));
  });

  it('Escape closes the menu only: focus goes back to the button and a selected card stays selected', async () => {
    const el = await liveBoard();
    await click(el, 'hand-card-0');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
    await click(el, 'menu-button');
    await key('Escape');
    expect(q(el, 'game-menu')).toBeNull();
    expect(document.activeElement).toBe(q(el, 'menu-button'));
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a tap on the backdrop closes it', async () => {
    const el = await liveBoard();
    await click(el, 'menu-button');
    await click(el, 'menu-backdrop');
    expect(q(el, 'game-menu')).toBeNull();
  });

  it('Tab stays inside the open menu (wraps from last to first and back)', async () => {
    const el = await liveBoard();
    await click(el, 'menu-button');
    q(el, 'menu-close')!.focus();
    await key('Tab');
    expect(document.activeElement).toBe(q(el, 'menu-rules'));
    await key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(q(el, 'menu-close'));
  });

  it('opening, closing and Escape change nothing the game holds and never call the engine', async () => {
    const el = await liveBoard();
    const before = held();
    const calls = engineCalls();
    await click(el, 'menu-button');
    expect(held()).toBe(before);
    await click(el, 'menu-close');
    await click(el, 'menu-button');
    await key('Escape');
    expect(held()).toBe(before);
    expect(engineCalls()).toBe(calls);
  });
});

// ---------------------------------------------------------------------------
// Rules (R17.2)
// ---------------------------------------------------------------------------

describe('Rules from the menu (R17.2)', () => {
  it('opens the rules sheet over the menu and the game without unmounting either; closing returns to the menu (r16)', async () => {
    const el = await liveBoard();
    const before = held();
    await click(el, 'menu-button');
    q(el, 'menu-rules')?.focus();
    await click(el, 'menu-rules');
    // r16 (playtest friction 8): the menu stays open under the sheet.
    expect(q(el, 'game-menu')).not.toBeNull();
    expect(q(el, 'rules-sheet')).not.toBeNull();
    expect(q(el, 'game-screen')).not.toBeNull();
    expect(q(el, 'board')).not.toBeNull();
    expect(held()).toBe(before);

    await click(el, 'rules-close');
    expect(q(el, 'rules-sheet')).toBeNull();
    expect(q(el, 'game-menu')).not.toBeNull();
    expect(document.activeElement).toBe(q(el, 'menu-rules'));
    expect(held()).toBe(before);

    await click(el, 'menu-close');
    expect(q(el, 'game-menu')).toBeNull();
    expect(document.activeElement).toBe(q(el, 'menu-button'));
  });

  it('Escape closes the rules sheet back to the menu, and does not reach the board (a selection survives)', async () => {
    const el = await liveBoard();
    await click(el, 'hand-card-0');
    await click(el, 'menu-button');
    await click(el, 'menu-rules');
    await key('Escape');
    expect(q(el, 'rules-sheet')).toBeNull();
    expect(q(el, 'game-menu')).not.toBeNull();
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
    await key('Escape');
    expect(q(el, 'game-menu')).toBeNull();
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('at a counter prompt: the prompt stays, lastSeenSeq and the save are untouched', async () => {
    await startGameMocked(game, bridge, opening(), { seed: '1' });
    const oneOff = appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off' });
    game.history = [oneOff];
    game.curtain = { kind: 'ack', to: 0 };
    const el = render();
    expect(q(el, 'counter-prompt')).not.toBeNull();
    const before = held();

    await click(el, 'menu-button');
    await click(el, 'menu-rules');
    expect(q(el, 'rules-sheet')).not.toBeNull();
    expect(q(el, 'counter-prompt')).not.toBeNull();
    await click(el, 'rules-close');
    expect(q(el, 'counter-prompt')).not.toBeNull();
    expect(held()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Card style (§5.6 rule 5)
// ---------------------------------------------------------------------------

describe('Card style in the menu (SPEC §5.6 rule 5)', () => {
  it('is hidden while Classic is the only style', async () => {
    const el = await liveBoard();
    await click(el, 'menu-button');
    expect(el.querySelector('[data-testid^="menu-theme-option-"]')).toBeNull();
  });

  it('swaps Classic for Mythic mid-game: the setting changes, the board stays, the save and game do not', async () => {
    const el = await liveBoard();
    await loadMythicCatalog();
    const before = held();
    const calls = engineCalls();
    await click(el, 'menu-button');
    const classic = el.querySelector<HTMLInputElement>('[data-testid="menu-theme-option-vector"] input');
    const mythic = el.querySelector<HTMLInputElement>('[data-testid="menu-theme-option-mythic"] input');
    expect(classic?.checked).toBe(true);
    expect(q(el, 'menu-theme-option-mythic')?.textContent).toContain('Mythic');

    mythic!.click();
    await settle();
    expect(settings.themeId).toBe('mythic');
    expect(mythic?.checked).toBe(true);
    expect(q(el, 'game-menu')).not.toBeNull(); // the menu stays open on a pick
    expect(q(el, 'board')).not.toBeNull();
    expect(held()).toBe(before);
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toMatch(/mythic|themeId/);
    expect(engineCalls()).toBe(calls);
  });
});

// ---------------------------------------------------------------------------
// Home and New game
// ---------------------------------------------------------------------------

describe('Home and New game', () => {
  it('Home leaves for the home screen without touching the save or the engine', async () => {
    const el = await liveBoard();
    const save = localStorage.getItem(SNAPSHOT_KEY);
    const calls = engineCalls();
    await click(el, 'menu-button');
    await click(el, 'menu-home');
    expect(game.screen).toBe('home');
    expect(game.envelope).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(save);
    expect(engineCalls()).toBe(calls);
  });

  it('New game asks first, naming the game; Cancel keeps everything', async () => {
    const el = await liveBoard();
    const before = held();
    await click(el, 'menu-button');
    await click(el, 'menu-new-game');
    const confirm = el.querySelector('[role="alertdialog"]');
    expect(confirm?.textContent).toContain('Abandon Alice vs Blake?');
    expect(document.activeElement).toBe(q(el, 'cancel-abandon'));
    await click(el, 'cancel-abandon');
    expect(q(el, 'confirm-abandon')).toBeNull();
    expect(q(el, 'menu-new-game')).not.toBeNull();
    expect(bridge.newGame).not.toHaveBeenCalled();
    expect(held()).toBe(before);
  });

  it('New game confirmed deals a new game behind the opening curtain and closes the menu', async () => {
    const el = await liveBoard();
    const save = localStorage.getItem(SNAPSHOT_KEY);
    bridge.newGame.mockImplementation(() => opening());
    await click(el, 'menu-button');
    await click(el, 'menu-new-game');
    await click(el, 'confirm-abandon');
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
    expect(game.curtain.kind).toBe('handoff');
    expect(q(el, 'game-menu')).toBeNull();
    expect(q(el, 'board')).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBe(save);
  });

  it('after Abandon, reopening the menu shows the item list, never a live Abandon', async () => {
    const el = await liveBoard();
    bridge.newGame.mockImplementation(() => opening());
    await click(el, 'menu-button');
    await click(el, 'menu-new-game');
    await click(el, 'confirm-abandon');
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
    await click(el, 'menu-button');
    expect(q(el, 'menu-rules')).not.toBeNull();
    expect(q(el, 'confirm-abandon')).toBeNull();
  });

  it('a confirm left open by Escape does not come back on the next open', async () => {
    const el = await liveBoard();
    await click(el, 'menu-button');
    await click(el, 'menu-new-game');
    await key('Escape');
    await click(el, 'menu-button');
    expect(q(el, 'menu-rules')).not.toBeNull();
    expect(q(el, 'confirm-abandon')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Privacy behind the curtain
// ---------------------------------------------------------------------------

describe('the menu behind a withheld curtain (privacy)', () => {
  it('opening it, Rules, a style swap and closing never mount the board, move the curtain or call the engine', async () => {
    const el = await atHandoff();
    await loadMythicCatalog();
    const before = held();

    await click(el, 'menu-button');
    expect(q(el, 'board')).toBeNull();
    expect(game.curtain.kind).toBe('handoff');
    q(el, 'menu-theme-option-mythic')!.querySelector('input')!.click();
    await settle();
    await click(el, 'menu-rules');
    expect(q(el, 'board')).toBeNull();
    await click(el, 'rules-close');
    await click(el, 'menu-button');
    await key('Escape');

    expect(q(el, 'board')).toBeNull();
    expect(q(el, 'curtain')).not.toBeNull();
    expect(held()).toBe(before);
    expect(engineCalls()).toBe(0);
  });

  it('the open menu carries no game state: no card, count, score or hand', async () => {
    const el = await atHandoff();
    await click(el, 'menu-button');
    const menu = q(el, 'game-menu')!;
    expect(menu.querySelector('[data-testid^="hand-card-"], [data-testid="score-bar"], [data-testid="deck-pile"], .cuttle-card-face')).toBeNull();
    expect(menu.textContent).not.toMatch(/\d/);
  });

  it('Home at the curtain keeps the curtain in the save for Resume', async () => {
    const el = await atHandoff();
    const save = localStorage.getItem(SNAPSHOT_KEY);
    await click(el, 'menu-button');
    await click(el, 'menu-home');
    expect(game.screen).toBe('home');
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(save);
    expect(JSON.parse(save!).curtain.kind).toBe('handoff');
    expect(engineCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariance (SPEC §4.3, §4.5; design.md §8): the menu is the same for every
// handoff reason and on both ack paths, closed and open.
// ---------------------------------------------------------------------------

describe('menu invariance behind the curtain', () => {
  async function menuDom(): Promise<{ float: string; menu: string }> {
    const el = render();
    const float = q(el, 'menu-button')!.parentElement!;
    expect(q(el, 'curtain')?.contains(float) ?? false).toBe(false);
    const closed = float.outerHTML;
    await click(el, 'menu-button');
    const menu = q(el, 'game-menu')!.outerHTML;
    cleanup();
    return { float: closed, menu };
  }

  it('the float and the open menu are byte-identical for every HandoffReason', async () => {
    await loadMythicCatalog();
    const reasons = ['turn', 'counter', 'discard', 'seven-return'] as const;
    const seen: { float: string; menu: string }[] = [];
    for (const reason of reasons) {
      game.envelope = null;
      game.viewer = null;
      game.curtain = { kind: 'handoff', to: 1, reason };
      const dom = await menuDom();
      expect(dom.float).toContain('menu-button');
      expect(dom.menu).toContain('menu-theme-option-mythic');
      seen.push(dom);
    }
    for (const dom of seen) expect(dom).toEqual(seen[0]);
  });
});
