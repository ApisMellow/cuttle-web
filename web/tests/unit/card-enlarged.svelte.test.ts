// @vitest-environment jsdom
// Issue #54 — press and hold a card for LONG_PRESS_MS to see it enlarged,
// through the real GameScreen, game store and StagingStore (only
// `lib/bridge/engine` is faked, as in game-screen-drag.svelte.test.ts). Only
// setTimeout is faked, so Svelte's own scheduling is untouched.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Envelope, Move, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import { LONG_PRESS_MS } from '../../src/lib/longPress';
import { Kind, Phase, envelope, playerView, startGameMocked } from './game-test-support';

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

function point(card: { Rank: PointEntry['Card']['Rank']; Suit: PointEntry['Card']['Suit'] }, owner: 0 | 1): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const KING = { Rank: 13, Suit: 0 } as const;
const QUEEN = { Rank: 12, Suit: 2 } as const;

const MOVES: Move[] = [
  mv({ Kind: Kind.Draw }),
  mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }),
  mv({ Kind: Kind.OneOff, HandIndex: 0, Card: ACE }),
];
const DESCRIPTIONS = ['draw a card', 'play ace as point card', 'play ace as one-off'];

function view(): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: {
      hand: [ACE, NINE, KING],
      frozenHandIndices: [],
      points: [point({ Rank: 3, Suit: 0 }, 0)],
      permanents: [KING],
      watched: false,
    },
    opponent: { handCount: 4, hand: null, points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [QUEEN] },
  });
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: game } });
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
  // jsdom has no layout; a drag's drop lands on empty space.
  document.elementFromPoint = () => null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function start(): Promise<HTMLDivElement> {
  const env: Envelope = envelope({ state: view(), legalMoves: MOVES, descriptions: DESCRIPTIONS });
  await startGameMocked(game, bridge, env, { seed: '1' });
  return render();
}

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      pointerType: 'touch',
    }),
  );
  flushSync();
}

function hold(ms: number): void {
  vi.advanceTimersByTime(ms);
  flushSync();
}

const AT = { x: 100, y: 700 };

describe('press and hold to enlarge (issue #54)', () => {
  it('a hand card held for 2000 ms enlarges; release hides it and selects or stages nothing', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS - 1);
    expect(q(el, 'card-enlarged')).toBeNull();
    hold(1);
    const big = q(el, 'card-enlarged');
    expect(big).not.toBeNull();
    expect(big?.querySelector('[data-testid]')).toBeNull();

    pointer('pointerup', card, AT.x, AT.y);
    card.click();
    flushSync();
    await tick();
    expect(q(el, 'card-enlarged')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(q(el, 'staging-bar')).toBeNull();
    expect(el.querySelector('[data-card-hint]')).toBeNull();
    expect(bridge.apply).not.toHaveBeenCalled();
  });

  it('shows the pressed card’s own face (same theme Face as the card pressed)', async () => {
    const el = await start();
    const faces: string[] = [];
    for (const id of ['hand-card-0', 'hand-card-1']) {
      const card = q(el, id)!;
      pointer('pointerdown', card, AT.x, AT.y);
      hold(LONG_PRESS_MS);
      const big = q(el, 'card-enlarged')!;
      // Same face component and size: the markup inside matches the small card's face.
      expect(big.textContent?.trim()).toBe(card.textContent?.trim());
      expect(big.textContent?.length).toBeGreaterThan(0);
      faces.push(big.innerHTML);
      pointer('pointerup', card, AT.x, AT.y);
    }
    expect(faces[0]).not.toBe(faces[1]);
  });

  it('a short hold then release is a normal tap: the card selects', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS - 100);
    pointer('pointerup', card, AT.x, AT.y);
    card.click();
    flushSync();
    await tick();
    hold(LONG_PRESS_MS);
    expect(q(el, 'card-enlarged')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-card-hint]')).not.toBeNull();
  });

  it('moving 9 px starts the drag and no enlargement follows', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    pointer('pointermove', card, AT.x, AT.y - 9);
    await tick();
    expect(card.dataset.dragging).toBe('true');
    hold(LONG_PRESS_MS * 2);
    expect(q(el, 'card-enlarged')).toBeNull();
    pointer('pointerup', card, AT.x, AT.y - 9);
  });

  it('once enlarged, moving on never turns the pointer into a drag', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS);
    pointer('pointermove', card, AT.x, AT.y - 80);
    await tick();
    expect(card.dataset.dragging).toBe('false');
    expect(q(el, 'card-enlarged')).not.toBeNull();
    pointer('pointerup', card, AT.x, AT.y - 80);
    await tick();
    expect(q(el, 'card-enlarged')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['point-0-0', 'point-1-0', 'perm-0-0', 'perm-1-0'])('%s enlarges the same way', async (testId) => {
    const el = await start();
    const card = q(el, testId)!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS);
    expect(q(el, 'card-enlarged')).not.toBeNull();
    pointer('pointerup', card, AT.x, AT.y);
    expect(q(el, 'card-enlarged')).toBeNull();
  });

  it('the deck, the scrap and the opponent’s hand do not enlarge', async () => {
    const el = await start();
    for (const target of [q(el, 'deck-pile'), q(el, 'scrap-pile'), q(el, 'opp-hand')]) {
      expect(target).not.toBeNull();
      pointer('pointerdown', target!, AT.x, AT.y);
      hold(LONG_PRESS_MS * 2);
      expect(q(el, 'card-enlarged')).toBeNull();
      pointer('pointerup', target!, AT.x, AT.y);
    }
  });

  it('pointercancel closes the view', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS);
    expect(q(el, 'card-enlarged')).not.toBeNull();
    pointer('pointercancel', card, AT.x, AT.y);
    expect(q(el, 'card-enlarged')).toBeNull();
  });

  it('a curtain change closes the view', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, AT.x, AT.y);
    hold(LONG_PRESS_MS);
    expect(q(el, 'card-enlarged')).not.toBeNull();
    game.curtain = { kind: 'handoff', to: 1 };
    await tick();
    flushSync();
    expect(q(el, 'card-enlarged')).toBeNull();
    expect(q(el, 'board')).toBeNull();
  });

  it('prevents the context menu on a card', async () => {
    const el = await start();
    const ev = new Event('contextmenu', { bubbles: true, cancelable: true });
    q(el, 'hand-card-0')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
