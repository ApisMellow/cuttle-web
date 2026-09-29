// @vitest-environment jsdom
// Issue #37 — table mode (SPEC §5.10), wired through the real GameScreen,
// game store and StagingStore (only `lib/bridge/engine` is faked, as in
// game-screen-drag.svelte.test.ts). In table mode every screen addressed to
// player 2 (seat 1) is turned 180° at the game-screen root; player 1's
// screens, and every screen in normal pass-and-play, are not. The setting
// is read at a curtain or view change, never in the middle of a turn.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';

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

function point(card: { Rank: PointEntry['Card']['Rank']; Suit: PointEntry['Card']['Suit'] }, owner: PlayerId): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const QUEEN = { Rank: 12, Suit: 2 } as const;
const TWO = { Rank: 2, Suit: 1 } as const;

/** Seat 0 (Alice) to act: hand [A, 9]. */
const P0_MOVES: Move[] = [
  mv({ Kind: Kind.Draw }),
  mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }),
  mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: NINE }),
];
const P0_DESCRIPTIONS = ['draw a card', 'play ace as point card', 'play nine as point card'];

function p0View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, NINE], frozenHandIndices: [], points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [], watched: false },
    opponent: { handCount: 2, hand: null, points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [] },
    ...overrides,
  });
}

/** Seat 1 (Blake) to act: hand [Q, 2]. */
const P1_MOVES: Move[] = [
  mv({ Kind: Kind.Draw }),
  mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: TWO }),
];
const P1_DESCRIPTIONS = ['draw a card', 'play two as point card'];

function p1View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 1,
    active: 1,
    phase: Phase.Normal,
    you: { hand: [QUEEN, TWO], frozenHandIndices: [], points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [], watched: false },
    opponent: { handCount: 2, hand: null, points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [] },
    ...overrides,
  });
}

function p0Env(): Envelope {
  return envelope({ state: p0View(), legalMoves: P0_MOVES, descriptions: P0_DESCRIPTIONS });
}

function p1Env(): Envelope {
  return envelope({ state: p1View(), legalMoves: P1_MOVES, descriptions: P1_DESCRIPTIONS });
}

/** Seat 0 plays the Ace for points; the turn passes to seat 1. */
function wireP0ToP1(): void {
  const played = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 1, card: ACE, description: 'play A♠ as point card' });
  bridge.apply.mockImplementation((): BridgeResult => envelope({ state: p0View({ active: 1 }), lastMove: played, history: [played] }));
  bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => {
    const entry = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, card: ACE, description: 'play A♠ as point card' });
    return viewer === 1
      ? envelope({ state: p1View(), lastMove: entry, history: [entry], legalMoves: P1_MOVES, descriptions: P1_DESCRIPTIONS })
      : envelope({ state: p0View({ active: 1 }), lastMove: entry, history: [entry] });
  });
}

/** Seat 1 plays the 2 for points; the turn passes to seat 0. */
function wireP1ToP0(): void {
  const played = appliedMove({ by: 1, kind: Kind.PlayPoint, seq: 1, index: 1, card: TWO, description: 'play 2♥ as point card' });
  bridge.apply.mockImplementation((): BridgeResult => envelope({ state: p1View({ active: 0 }), lastMove: played, history: [played] }));
  bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => {
    const entry = appliedMove({ by: 1, kind: Kind.PlayPoint, seq: 1, card: TWO, description: 'play 2♥ as point card' });
    return viewer === 0
      ? envelope({ state: p0View(), lastMove: entry, history: [entry], legalMoves: P0_MOVES, descriptions: P0_DESCRIPTIONS })
      : envelope({ state: p1View({ active: 0 }), lastMove: entry, history: [entry] });
  });
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
  settings.tableMode = false;
}

let hitElement: Element | null = null;

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  resetSingletons();
  hitElement = null;
  document.elementFromPoint = () => hitElement;
});

afterEach(() => {
  cleanup();
  settings.tableMode = false;
  vi.restoreAllMocks();
});

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  await settle();
}

function rotated(el: HTMLElement): boolean {
  const root = q(el, 'game-screen');
  if (!root) throw new Error('no game-screen');
  const byAttr = root.dataset.tableRotated === 'true';
  // The attribute and the class that carries the transform must agree.
  expect(root.classList.contains('game-screen--rotated')).toBe(byAttr);
  return byAttr;
}

/** A live board for `env`'s viewer, at curtain `none`. */
async function boardFor(env: Envelope): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, env, { seed: '1' });
  return render();
}

/** Walks the two-step reveal gate (handoff -> reveal -> none/recap -> none). */
async function passCurtain(el: HTMLElement): Promise<void> {
  for (let i = 0; i < 4 && game.curtain.kind !== 'none'; i++) {
    if (game.curtain.kind === 'recap') await click(el, 'recap-dismiss');
    else await click(el, 'reveal-two-step');
  }
}

const START = { x: 100, y: 700 };

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('table mode (issue #37): which screens turn', () => {
  it("normal pass-and-play never turns player 2's board", async () => {
    const el = await boardFor(p1Env());
    expect(q(el, 'board')).not.toBeNull();
    expect(game.viewer).toBe(1);
    expect(rotated(el)).toBe(false);
  });

  it("table mode leaves player 1's board upright", async () => {
    settings.tableMode = true;
    const el = await boardFor(p0Env());
    expect(game.viewer).toBe(0);
    expect(rotated(el)).toBe(false);
  });

  it("table mode turns player 2's board", async () => {
    settings.tableMode = true;
    const el = await boardFor(p1Env());
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'player-hand')).not.toBeNull();
    expect(rotated(el)).toBe(true);
  });

  const addressed = (to: PlayerId): CurtainState[] => [
    { kind: 'handoff', to, reason: 'turn' },
    { kind: 'handoff', to, reason: 'resume' },
    { kind: 'reveal', to },
    { kind: 'recap', to, entries: [appliedMove({ by: (1 - to) as PlayerId, kind: Kind.Draw, seq: 1, description: 'draw a card' })] },
  ];

  it.each(addressed(1).map((c) => [`${c.kind}${'reason' in c ? `/${c.reason}` : ''}`, c] as const))(
    'table mode turns the %s curtain addressed to player 2, and never in normal mode',
    async (_label, curtain) => {
      game.curtain = curtain;
      game.screen = 'game';
      settings.tableMode = true;
      const el = render();
      expect(q(el, 'board')).toBeNull();
      expect(rotated(el)).toBe(true);
      cleanup();
      settings.tableMode = false;
      expect(rotated(render())).toBe(false);
    },
  );

  it.each(addressed(0).map((c) => [`${c.kind}${'reason' in c ? `/${c.reason}` : ''}`, c] as const))(
    'table mode leaves the %s curtain addressed to player 1 upright',
    async (_label, curtain) => {
      game.curtain = curtain;
      game.screen = 'game';
      settings.tableMode = true;
      expect(rotated(render())).toBe(false);
    },
  );

  it('the whole turn cycle: P1 upright, handoff/reveal/board to P2 turned, back upright for P1', async () => {
    settings.tableMode = true;
    const el = await boardFor(p0Env());
    expect(rotated(el)).toBe(false);

    wireP0ToP1();
    await click(el, 'hand-card-0');
    await click(el, 'zone-points');
    await click(el, 'staging-confirm');
    expect(game.curtain).toMatchObject({ kind: 'handoff', to: 1 });
    expect(rotated(el)).toBe(true);
    // Privacy is unchanged: behind the curtain the board is not in the DOM.
    expect(q(el, 'board')).toBeNull();
    expect(el.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(0);

    await click(el, 'reveal-two-step');
    expect(game.curtain.kind).not.toBe('none');
    expect(rotated(el)).toBe(true);
    expect(q(el, 'board')).toBeNull();

    await passCurtain(el);
    expect(game.curtain.kind).toBe('none');
    expect(game.viewer).toBe(1);
    expect(rotated(el)).toBe(true);
    expect(q(el, 'player-hand')).not.toBeNull();

    wireP1ToP0();
    await click(el, 'hand-card-1');
    await click(el, 'zone-points');
    await click(el, 'staging-confirm');
    expect(game.curtain).toMatchObject({ kind: 'handoff', to: 0 });
    expect(rotated(el)).toBe(false);
  });
});

describe('table mode (issue #37): a change takes effect at the next curtain or view change', () => {
  it('turning it on mid-turn does not turn a live board or drop the selection', async () => {
    const el = await boardFor(p1Env());
    await click(el, 'hand-card-1');
    expect(q(el, 'hand-card-1')?.getAttribute('aria-pressed')).toBe('true');

    settings.tableMode = true;
    await settle();
    expect(rotated(el)).toBe(false);
    expect(q(el, 'hand-card-1')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('turning it off mid-turn keeps the staged move and the orientation until the view changes', async () => {
    settings.tableMode = true;
    const el = await boardFor(p1Env());
    await click(el, 'hand-card-1');
    await click(el, 'zone-points');
    expect(q(el, 'staging-bar')).not.toBeNull();

    settings.tableMode = false;
    await settle();
    expect(rotated(el)).toBe(true);
    expect(q(el, 'staging-bar')).not.toBeNull();
  });

  it('a change made during player 1\'s turn applies at the handoff to player 2', async () => {
    const el = await boardFor(p0Env());
    settings.tableMode = true;
    await settle();
    expect(rotated(el)).toBe(false);

    wireP0ToP1();
    await click(el, 'hand-card-0');
    await click(el, 'zone-points');
    await click(el, 'staging-confirm');
    expect(game.curtain).toMatchObject({ kind: 'handoff', to: 1 });
    expect(rotated(el)).toBe(true);
  });
});

describe('table mode (issue #37): drag and drop in the turned view', () => {
  it('the dragged card follows the finger: screen deltas are negated in the turned frame', async () => {
    settings.tableMode = true;
    const el = await boardFor(p1Env());
    expect(rotated(el)).toBe(true);
    const card = q(el, 'hand-card-1')!;
    // On the physical screen player 2's hand is at the top, so dragging
    // toward the board centre moves the finger DOWN the screen (+y).
    pointer('pointerdown', card, START.x, START.y);
    pointer('pointermove', card, START.x + 15, START.y + 90);
    await settle();
    expect(card.dataset.dragging).toBe('true');
    expect(card.style.getPropertyValue('--drag-x')).toBe('-15px');
    expect(card.style.getPropertyValue('--drag-y')).toBe('-90px');
  });

  it('an upright view keeps screen deltas as they are', async () => {
    settings.tableMode = true;
    const el = await boardFor(p0Env());
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, START.x, START.y);
    pointer('pointermove', card, START.x + 15, START.y - 90);
    await settle();
    expect(card.style.getPropertyValue('--drag-x')).toBe('15px');
    expect(card.style.getPropertyValue('--drag-y')).toBe('-90px');
  });

  it('a drop in the turned view stages the zone under the finger; only Confirm applies', async () => {
    settings.tableMode = true;
    const el = await boardFor(p1Env());
    const card = q(el, 'hand-card-1')!;
    pointer('pointerdown', card, START.x, START.y);
    pointer('pointermove', card, START.x, START.y + 20);
    hitElement = q(el, 'zone-points');
    pointer('pointermove', card, START.x + 30, START.y + 300);
    pointer('pointerup', card, START.x + 30, START.y + 300);
    await settle();
    expect(q(el, 'staging-bar')?.textContent).toContain('Play two as point card');
    expect(bridge.apply).not.toHaveBeenCalled();
  });
});
