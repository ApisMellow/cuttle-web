// @vitest-environment jsdom
// R18 update policy (SPEC §5.8): Rematch is a safe point. The result screen
// goes to a new game without passing Home, so a waiting update is applied at
// the Rematch tap, before the new game starts, and the rematch itself plays
// after the reload. The service-worker glue is mocked; the policy's own
// behaviour is covered in pwa-update.test.ts.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Envelope, PlayerId } from '../../src/lib/bridge/schema';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';

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

const pwa = vi.hoisted(() => ({
  reportScreen: vi.fn(),
  applyUpdateAtRematch: vi.fn((): boolean => false),
  takePendingRematch: vi.fn((): { names: [string, string]; dealer: 0 | 1 | undefined } | null => null),
}));
vi.mock('../../src/lib/pwa/register', () => pwa);

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

async function renderApp(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(App, { target: host });
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  return host;
}

function openingEnvelope(): Envelope {
  return envelope({ state: playerView({ viewer: 0, active: 0, phase: Phase.Normal }) });
}

function gameOverEnvelope(): Envelope {
  const lastMove = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 0, card: { Rank: 10, Suit: 2 } });
  return envelope({
    state: playerView({ viewer: 0, active: 1, phase: Phase.GameOver, winner: 0, stalemate: false }),
    lastMove,
    history: [lastMove],
  });
}

async function reachResult(): Promise<void> {
  await startGameMocked(game, bridge, openingEnvelope());
  bridge.apply.mockImplementationOnce((): BridgeResult => gameOverEnvelope());
  await game.apply(0);
  flushSync();
}

function tap(el: HTMLElement, id: string): void {
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  bridge.newGame.mockImplementation(() => openingEnvelope());
  pwa.applyUpdateAtRematch.mockReset().mockReturnValue(false);
  pwa.takePendingRematch.mockReset().mockReturnValue(null);
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
  session.tally = { 0: 0, 1: 0 };
  session.lastDealer = null;
  session.lastSeed = null;
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

describe('Rematch as an update safe point (R18)', () => {
  it('with an update waiting, the tap hands over to the update and does not start the game', async () => {
    pwa.applyUpdateAtRematch.mockReturnValue(true);
    const el = await renderApp();
    await reachResult();
    const newGameSpy = vi.spyOn(game, 'newGame');
    session.recordDealer(1 as PlayerId);

    tap(el, 'rematch');
    await Promise.resolve();

    // The dealer alternates: last dealer 1, so the rematch is dealt by 0.
    expect(pwa.applyUpdateAtRematch).toHaveBeenCalledWith({ names: ['Alice', 'Blake'], dealer: 0 });
    expect(newGameSpy).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="result-screen"]')).not.toBeNull();
  });

  it('with nothing waiting, the tap starts the rematch as before', async () => {
    const el = await renderApp();
    await reachResult();
    const newGameSpy = vi.spyOn(game, 'newGame');

    tap(el, 'rematch');
    await Promise.resolve();
    flushSync();

    expect(newGameSpy).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="game-screen"]')).not.toBeNull();
  });

  it('after the update reload, the pending rematch starts with the same names and dealer', async () => {
    pwa.takePendingRematch.mockReturnValue({ names: ['Cara', 'Dev'], dealer: 0 });
    const newGameSpy = vi.spyOn(game, 'newGame');
    await renderApp();
    await Promise.resolve();
    flushSync();

    expect(session.names).toEqual(['Cara', 'Dev']);
    expect(newGameSpy).toHaveBeenCalledWith({ dealer: 0 });
    expect(game.screen).toBe('game');
  });

  it('a normal boot with no pending rematch stays on Home', async () => {
    const newGameSpy = vi.spyOn(game, 'newGame');
    const el = await renderApp();
    expect(newGameSpy).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="home-screen"]')).not.toBeNull();
  });
});
