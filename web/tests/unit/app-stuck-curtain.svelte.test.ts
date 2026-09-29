// @vitest-environment jsdom
// P2 W13 — the stuck-curtain case. If `engine.view` fails while the curtain
// leaves reveal/recap for the board, the store keeps the curtain where it
// was and sets `game.error`; RevealGate's once-only latch means the curtain
// itself can never retry. SPEC §2.9 routes a failed bridge call (INTERNAL,
// NO_LEGAL_MOVES, ILLEGAL_MOVE) to the stuck-state screen with no auto-retry,
// so the App's error screen (the W12 stand-in for §2.10's StuckState) must
// take over, and its "New game" must actually start a fresh game.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, PlayerId } from '../../src/lib/bridge/schema';
import { Kind, Phase, appliedMove, engineError, envelope, playerView } from './game-test-support';

vi.mock('../../src/lib/bridge/wasm', () => ({
  ensureEngine: vi.fn(() => Promise.resolve()),
  resetEngineForTests: vi.fn(),
}));

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

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
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
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

describe('stuck curtain: engine.view fails leaving the reveal (SPEC §2.9)', () => {
  it('routes to the error screen (board and curtain gone), and New game recovers', async () => {
    const deal = () =>
      envelope({
        state: playerView({ viewer: 0, active: 0, you: { hand: [{ Rank: 5, Suit: 0 }], frozenHandIndices: [], points: [], permanents: [] } }),
        legalMoves: [{ Kind: Kind.Draw, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null }],
        descriptions: ['draw a card'],
      });
    bridge.newGame.mockImplementation(deal);
    const drew = appliedMove({ by: 0, kind: Kind.Draw, seq: 1, index: 0, description: 'draw a card' });
    bridge.apply.mockImplementation(
      (): BridgeResult => envelope({ state: playerView({ viewer: 0, active: 1, phase: Phase.Normal }), lastMove: drew, history: [drew] }),
    );
    // P0's opening view (W25) succeeds; P1's view, after P0's draw, fails.
    bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => (viewer === 0 ? deal() : engineError('INTERNAL', 'boom')));

    host = document.createElement('div');
    document.body.append(host);
    instance = mount(App, { target: host });
    await settle();
    await click('new-game');
    expect(q('board')).toBeNull(); // W25: behind the opening curtain
    await click('reveal-two-step');
    await click('reveal-two-step');
    expect(q('board')).not.toBeNull();
    bridge.view.mockClear();

    await click('deck-pile');
    await click('staging-confirm');
    expect(game.curtain.kind).toBe('handoff');
    await click('reveal-two-step'); // handoff -> reveal
    await click('reveal-two-step'); // reveal -> recap (the draw is unseen by P1)
    await click('recap-dismiss'); // recap -> none: view(1) fails

    expect(bridge.view).toHaveBeenCalledWith(1);
    expect(game.error?.code).toBe('INTERNAL');
    expect(q('error-screen')).not.toBeNull();
    expect(q('curtain')).toBeNull();
    expect(q('board')).toBeNull();
    // no auto-retry (SPEC §2.10 item 3)
    expect(bridge.view).toHaveBeenCalledTimes(1);

    // The only forward action works. The stuck game is still in progress, so
    // the R4.3 abandon confirm comes first.
    bridge.view.mockReset();
    bridge.view.mockImplementation(() => deal());
    await click('error-new-game');
    await click('confirm-abandon');
    expect(game.error).toBeNull();
    expect(game.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'turn' });
    await click('reveal-two-step');
    await click('reveal-two-step');
    expect(game.curtain.kind).toBe('none');
    expect(q('board')).not.toBeNull();
  });
});
