// @vitest-environment jsdom
// W21, PRD R9.3, SPEC §6.1 — the dimmed-card detail popover, wired into the
// real GameScreen/StagingStore pipeline (staging.svelte.ts already sets
// `inspect` on a dimmed-card tap; this round makes GameScreen render it).
//
// A separate file from game-screen.svelte.test.ts on purpose: a parallel
// developer is renaming that file's "Bob" fixture to "Blake" this round, so
// this file uses Alice/Blake from the start rather than touching that file.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Envelope, Move, PlayerView } from '../../src/lib/bridge/schema';
import { envelope, Phase, playerView } from './game-test-support';

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
// Fixtures — P0 to act, hand [Ace, King]; the King has no legal move (R9.3
// dimmed). A distinctive P1 (Blake) hand so any leak into the popover's DOM
// would be visible.
// ---------------------------------------------------------------------------

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return {
    Card: null,
    HandIndex: 0,
    Target: null,
    JackTarget: null,
    ScrapIndex: 0,
    DiscardA: 0,
    DiscardB: 0,
    SubMove: null,
    ...overrides,
  };
}

const ACE = { Rank: 1, Suit: 3 } as const; // A♠
const KING = { Rank: 13, Suit: 0 } as const; // K♣
// Blake's hand: a Queen of hearts and a 2 of diamonds. Given via `opponent.hand`
// (SPEC §2.7: `null` is "hidden", a Card[] is "visible" — e.g. glasses-8/R7)
// so the fixture makes the opponent's hand KNOWN to the store, and the
// privacy test below proves the popover still never names it.
const BLAKE_HAND = [
  { Rank: 12, Suit: 2 }, // Q♥
  { Rank: 2, Suit: 1 }, // 2♦
] as const;

// Kind enum values pinned locally (SPEC §2.5), matching game-test-support.ts.
const Kind = {
  Draw: 0,
  PlayPoint: 1,
} as const;

const MOVES: Move[] = [
  mv({ Kind: Kind.Draw }), // 0
  mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }), // 1
];
const DESCRIPTIONS = ['draw a card', 'play ace as point card'];

function p0View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, KING], frozenHandIndices: [], points: [], permanents: [] },
    opponent: { handCount: 2, hand: [...BLAKE_HAND], points: [], permanents: [] },
    ...overrides,
  });
}

function p0Opening(): Envelope {
  return envelope({ state: p0View(), legalMoves: MOVES, descriptions: DESCRIPTIONS });
}

// ---------------------------------------------------------------------------
// Harness (mirrors game-screen.svelte.test.ts's pattern)
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

function resetSingletons(): void {
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
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  resetSingletons();
});

afterEach(cleanup);

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function start(env: Envelope = p0Opening()): Promise<HTMLDivElement> {
  bridge.newGame.mockImplementation(() => env);
  await game.newGame({ seed: '1' });
  return render();
}

describe('GameScreen: dimmed-card detail popover (W21, R9.3)', () => {
  it('tapping a dimmed hand card opens the popover with that card, without entering selected', async () => {
    const el = await start();
    expect(q(el, 'hand-card-1')?.dataset.dimmed).toBe('true');
    expect(q(el, 'card-detail-popover')).toBeNull();

    await click(el, 'hand-card-1');

    const popover = q(el, 'card-detail-popover');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('K'); // the King, not the Ace
    expect(q(el, 'staging-bar')).toBeNull(); // never entered 'selected'/'staged'
    expect(q(el, 'hand-card-1')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('closes on the Close button', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    expect(q(el, 'card-detail-popover')).not.toBeNull();
    await click(el, 'card-detail-popover-close');
    expect(q(el, 'card-detail-popover')).toBeNull();
  });

  it('closes on tap-away (the scrim)', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    expect(q(el, 'card-detail-popover')).not.toBeNull();
    await click(el, 'card-detail-popover-scrim');
    expect(q(el, 'card-detail-popover')).toBeNull();
  });

  it('privacy: the popover DOM never contains the opponent (Blake)\'s hand', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    const popover = q(el, 'card-detail-popover')!;
    // Blake's hand is Q♥ and 2♦ — assert neither card identity leaks into
    // the open popover's DOM (innerHTML, so attributes/classes count too).
    expect(popover.innerHTML).not.toContain('♥');
    expect(popover.innerHTML).not.toContain('♦');
    // and no opponent-hand testid of any kind is anywhere in the popover
    expect(popover.querySelector('[data-testid*="opponent"]')).toBeNull();
  });
});
