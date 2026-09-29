// @vitest-environment jsdom
// Issue #26 — dragging a hand card onto a target, wired through the real
// GameScreen, game store and StagingStore (only `lib/bridge/engine` is
// faked, as in game-screen.svelte.test.ts). A drag only ever makes the same
// taps a player would: select on start, tap the target on drop. Confirm is
// still the only thing that applies (R12).
//
// jsdom has no layout, so `document.elementFromPoint` is stubbed per test
// to return the element the drop "lands" on.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
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
// Fixtures (same position as game-screen.svelte.test.ts)
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
const KING = { Rank: 13, Suit: 0 } as const;

/** P0 to act. hand [A, 9, K]; own points [3]; opponent points [7]. K has no legal move. */
const P0_MOVES: Move[] = [
  mv({ Kind: Kind.Draw }), // 0
  mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }), // 1
  mv({ Kind: Kind.OneOff, HandIndex: 0, Card: ACE }), // 2
  mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: NINE }), // 3
  mv({ Kind: Kind.Scuttle, HandIndex: 1, Card: NINE, Target: { Owner: 1, Zone: 0, Index: 0 } }), // 4
  mv({ Kind: Kind.OneOff, HandIndex: 1, Card: NINE, Target: { Owner: 1, Zone: 0, Index: 0 } }), // 5
];
const P0_DESCRIPTIONS = [
  'draw a card',
  'play ace as point card',
  'play ace as one-off',
  'play nine as point card',
  'scuttle seven with nine',
  'play nine as one-off on seven',
];

function p0View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, NINE, KING], frozenHandIndices: [], points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [], watched: false },
    opponent: { handCount: 4, hand: null, points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [] },
    ...overrides,
  });
}

const P1_HAND = [
  { Rank: 12, Suit: 2 },
  { Rank: 2, Suit: 1 },
] as const;

function p1View(): PlayerView {
  return playerView({
    viewer: 1,
    active: 1,
    phase: Phase.Normal,
    you: { hand: [...P1_HAND], frozenHandIndices: [], points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [], watched: false },
    opponent: { handCount: 3, hand: null, points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [] },
  });
}

/** P0 plays the Ace for points; the turn passes to P1. */
function applyToHandoff(): void {
  const played = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 1, card: ACE, description: 'play A♠ as point card' });
  bridge.apply.mockImplementation(
    (): BridgeResult => envelope({ state: p0View({ active: 1 }), lastMove: played, history: [played] }),
  );
  bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => {
    const entry = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, card: ACE, description: 'play A♠ as point card' });
    return viewer === 1
      ? envelope({ state: p1View(), lastMove: entry, history: [entry], legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] })
      : envelope({ state: p0View({ active: 1 }), lastMove: entry, history: [entry] });
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
}

let hitElement: Element | null = null;

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  resetSingletons();
  hitElement = null;
  // jsdom has no layout; the drop lands on whatever the test says.
  document.elementFromPoint = () => hitElement;
});

afterEach(() => {
  cleanup();
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

async function start(env: Envelope = envelope({ state: p0View(), legalMoves: P0_MOVES, descriptions: P0_DESCRIPTIONS })): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, env, { seed: '1' });
  return render();
}

const START = { x: 100, y: 700 };

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 1): PointerEvent {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId,
    isPrimary: true,
    button: 0,
    pointerType: 'touch',
  });
  target.dispatchEvent(ev);
  flushSync();
  return ev;
}

/** Presses a hand card and moves 20 px up: past the threshold, so the drag has started. */
function beginDrag(el: HTMLElement, handIndex: number): HTMLElement {
  const card = q(el, `hand-card-${handIndex}`)!;
  pointer('pointerdown', card, START.x, START.y);
  pointer('pointermove', card, START.x, START.y - 20);
  return card;
}

/** Moves on and releases over `onto` (the element elementFromPoint reports). */
async function dropOn(card: HTMLElement, onto: Element | null): Promise<void> {
  hitElement = onto;
  pointer('pointermove', card, START.x + 30, START.y - 300);
  pointer('pointerup', card, START.x + 30, START.y - 300);
  await settle();
}

async function drag(el: HTMLElement, handIndex: number, onto: Element | null): Promise<HTMLElement> {
  const card = beginDrag(el, handIndex);
  await dropOn(card, onto);
  return card;
}

function draggingCards(el: HTMLElement): Element[] {
  return [...el.querySelectorAll('[data-dragging="true"]')];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('drag and drop (issue #26)', () => {
  it('dropping a card on the lit points zone stages the move; only Confirm applies, once', async () => {
    const el = await start();
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({ state: p0View(), legalMoves: P0_MOVES, descriptions: P0_DESCRIPTIONS }),
    );
    await drag(el, 0, q(el, 'zone-points'));
    expect(q(el, 'staging-bar')?.textContent).toContain('Play ace as point card');
    expect(q(el, 'hand-card-0')?.dataset.staged).toBe('true');
    expect(bridge.apply).not.toHaveBeenCalled();

    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith(1);
  });

  it('while dragging: the card is selected, follows the pointer, and only its legal targets are lit', async () => {
    const el = await start();
    const card = beginDrag(el, 0);
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(card.dataset.dragging).toBe('true');
    expect(card.style.getPropertyValue('--drag-x')).toBe('0px');
    expect(card.style.getPropertyValue('--drag-y')).toBe('-20px');
    pointer('pointermove', card, START.x + 15, START.y - 90);
    expect(card.style.getPropertyValue('--drag-x')).toBe('15px');
    expect(card.style.getPropertyValue('--drag-y')).toBe('-90px');

    expect(q(el, 'zone-points')?.dataset.state).toBe('highlighted');
    expect(q(el, 'zone-oneoff')?.dataset.state).toBe('highlighted');
    expect(q(el, 'zone-permanents')?.dataset.state).toBe('normal');
    expect(draggingCards(el)).toHaveLength(1);
  });

  it('dropping on a card target that has two plays opens the same chooser a tap opens', async () => {
    const el = await start();
    await drag(el, 1, q(el, 'point-1-0'));
    expect(q(el, 'ambiguity-chooser')).not.toBeNull();
    expect(q(el, 'ambiguity-chooser-option-4')).not.toBeNull();
    expect(q(el, 'ambiguity-chooser-option-5')).not.toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();
    await click(el, 'ambiguity-chooser-option-5');
    expect(q(el, 'staging-bar')?.textContent).toContain('Play nine as one-off on seven');
    expect(bridge.apply).not.toHaveBeenCalled();
  });

  it('dropping on a card already in your own lit points row plays for points, as a tap there does', async () => {
    const el = await start();
    await drag(el, 0, q(el, 'point-0-0'));
    expect(q(el, 'staging-bar')?.textContent).toContain('Play ace as point card');
  });

  it('a drop on an unlit zone snaps back and leaves the card unselected', async () => {
    const el = await start();
    const card = await drag(el, 0, q(el, 'zone-permanents'));
    expect(q(el, 'staging-bar')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(card.dataset.dragging).toBe('false');
    expect(card.style.getPropertyValue('--drag-x')).toBe('');
    expect(q(el, 'zone-points')?.dataset.state).toBe('normal');
  });

  it('a drop on empty board space snaps back unselected', async () => {
    const el = await start();
    const card = await drag(el, 0, q(el, 'board'));
    expect(q(el, 'staging-bar')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(draggingCards(el)).toHaveLength(0);
  });

  it('a drop outside the page (nothing under the pointer) snaps back unselected', async () => {
    const el = await start();
    const card = await drag(el, 0, null);
    expect(q(el, 'staging-bar')).toBeNull();
    expect(card.getAttribute('aria-pressed')).toBe('false');
  });

  it('a drop on the deck snaps back and does not stage a draw', async () => {
    const el = await start();
    await drag(el, 0, q(el, 'deck-pile'));
    expect(q(el, 'staging-bar')).toBeNull();
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('dragging the already-selected card keeps it selected and drops normally', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
    const card = beginDrag(el, 0);
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('true');
    await dropOn(card, q(el, 'zone-oneoff'));
    expect(q(el, 'staging-bar')?.textContent).toContain('Play ace as one-off');
  });

  it('dragging a different card from the selected one re-selects, as a tap would', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    const card = beginDrag(el, 1);
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a move under 8 px is still a tap: the gesture selects nothing, the click selects', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, START.x, START.y);
    pointer('pointermove', card, START.x + 4, START.y - 5);
    await settle();
    expect(card.dataset.dragging).toBe('false');
    expect(card.getAttribute('aria-pressed')).toBe('false');
    pointer('pointerup', card, START.x + 4, START.y - 5);
    card.click(); // the browser's click for a tap
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('true');
    await click(el, 'zone-points');
    expect(q(el, 'staging-bar')?.textContent).toContain('Play ace as point card');
  });

  it('tapping still works exactly as before (no pointer movement at all)', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    await click(el, 'zone-points');
    expect(q(el, 'staging-bar')?.textContent).toContain('Play nine as point card');
  });

  it('the stray click the browser fires after a drag is swallowed', async () => {
    const el = await start();
    const card = await drag(el, 0, q(el, 'zone-permanents'));
    expect(card.getAttribute('aria-pressed')).toBe('false');
    card.click(); // would re-select the card if it counted as a tap
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('false');
  });

  it('a Confirm tapped right after a drop is never swallowed', async () => {
    const el = await start();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    await drag(el, 0, q(el, 'zone-points'));
    bridge.apply.mockImplementation(
      (): BridgeResult => envelope({ state: p0View(), legalMoves: P0_MOVES, descriptions: P0_DESCRIPTIONS }),
    );
    await click(el, 'staging-confirm'); // same instant as the drop
    expect(bridge.apply).toHaveBeenCalledTimes(1);
  });

  it('only the one click right after a drag is swallowed; later taps work', async () => {
    const el = await start();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const card = await drag(el, 0, q(el, 'zone-permanents'));
    now.mockReturnValue(5000);
    card.click();
    await settle();
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('a dimmed card does not drag: no selection, no detail popover', async () => {
    const el = await start();
    const king = beginDrag(el, 2);
    await settle();
    expect(king.dataset.dragging).toBe('false');
    expect(king.getAttribute('aria-pressed')).toBe('false');
    await dropOn(king, q(el, 'zone-permanents'));
    expect(q(el, 'card-detail-popover')).toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();
  });

  it('no drag while a move is staged: Confirm/Cancel still own the bar', async () => {
    const el = await start();
    await click(el, 'deck-pile');
    expect(q(el, 'staging-bar')?.textContent).toContain('Draw a card.');
    const card = beginDrag(el, 0);
    await settle();
    expect(card.dataset.dragging).toBe('false');
    await dropOn(card, q(el, 'zone-points'));
    expect(q(el, 'staging-bar')?.textContent).toContain('Draw a card.');
  });

  it('no drag while the chooser is open', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    await click(el, 'point-1-0');
    expect(q(el, 'ambiguity-chooser')).not.toBeNull();
    const card = beginDrag(el, 0);
    await settle();
    expect(card.dataset.dragging).toBe('false');
    expect(q(el, 'ambiguity-chooser')).not.toBeNull();
  });

  it('a mouse button other than the primary one does not drag', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 700, pointerId: 1, isPrimary: true, button: 2, pointerType: 'mouse' }));
    pointer('pointermove', card, 100, 600);
    await settle();
    expect(card.dataset.dragging).toBe('false');
    expect(card.getAttribute('aria-pressed')).toBe('false');
  });

  it('page scroll is prevented only once the drag has started', async () => {
    const el = await start();
    const card = q(el, 'hand-card-0')!;
    pointer('pointerdown', card, START.x, START.y);
    pointer('pointermove', card, START.x, START.y - 4);
    const early = new Event('touchmove', { bubbles: true, cancelable: true });
    card.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);

    pointer('pointermove', card, START.x, START.y - 20);
    const during = new Event('touchmove', { bubbles: true, cancelable: true });
    card.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    pointer('pointerup', card, START.x, START.y - 20);
    await settle();
    const after = new Event('touchmove', { bubbles: true, cancelable: true });
    card.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('pointercancel ends the drag: the card snaps back and stays selected', async () => {
    const el = await start();
    const card = beginDrag(el, 0);
    pointer('pointercancel', card, START.x, START.y - 20);
    await settle();
    expect(card.dataset.dragging).toBe('false');
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(q(el, 'staging-bar')).toBeNull();
    // A later release is not a drop.
    await dropOn(card, q(el, 'zone-points'));
    expect(q(el, 'staging-bar')).toBeNull();
  });
});

describe('drag and the curtain (privacy)', () => {
  it('after a dragged move is confirmed, the curtain carries no card, no drag state, and the next hand renders clean', async () => {
    const el = await start();
    applyToHandoff();
    await drag(el, 0, q(el, 'zone-points'));
    await click(el, 'staging-confirm');

    expect(game.curtain.kind).toBe('handoff');
    expect(q(el, 'board')).toBeNull();
    expect(el.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(0);
    expect(draggingCards(el)).toHaveLength(0);
    expect(el.innerHTML).not.toContain('--drag-');

    await click(el, 'reveal-two-step');
    await click(el, 'reveal-two-step');
    expect(draggingCards(el)).toHaveLength(0);
    expect(el.innerHTML).not.toContain('--drag-');
    await click(el, 'recap-dismiss');

    expect(el.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(2);
    expect(draggingCards(el)).toHaveLength(0);
    expect(el.innerHTML).not.toContain('--drag-');
  });

  it('a curtain that goes up mid-drag ends the drag; nothing of it comes back with the board', async () => {
    const el = await start();
    const card = beginDrag(el, 0);
    await settle();
    expect(card.dataset.dragging).toBe('true');

    game.curtain = { kind: 'handoff', to: 0, reason: 'resume' };
    await settle();
    expect(q(el, 'board')).toBeNull();
    expect(draggingCards(el)).toHaveLength(0);

    game.curtain = { kind: 'none' };
    await settle();
    expect(q(el, 'board')).not.toBeNull();
    expect(draggingCards(el)).toHaveLength(0);
    expect(el.innerHTML).not.toContain('--drag-');

    // The finger lifting later is not a drop onto the new board.
    const fresh = q(el, 'hand-card-0')!;
    await dropOn(fresh, q(el, 'zone-points'));
    expect(q(el, 'staging-bar')).toBeNull();
    expect(fresh.getAttribute('aria-pressed')).toBe('false');
  });
});
