// @vitest-environment jsdom
// SPEC §5.2 App shell wiring (R2.3, R3.1, R3.2, R4.2, R4.3, §2.9 error
// boundary). ONE mounted `App` per test, driven through the real `game` and
// `session` singletons. `ensureEngine` is mocked so the shell boots without
// WASM, and the four `lib/bridge/engine` calls the store makes are faked so
// `game.newGame()` / `apply()` / `restore()` run their real store code
// against scripted envelopes. A live transition into `result` therefore
// comes from a real `game.apply()`, and a restore from a real
// `game.restore()` reached through HomeScreen's Resume button.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Card, Envelope, PlayerId } from '../../src/lib/bridge/schema';
import { SNAPSHOT_KEY, encodeSnapshot, type Snapshot } from '../../src/lib/stores/snapshot';
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

// Imported after the mocks are registered (vi.mock is hoisted regardless).
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
  // Let the mocked ensureEngine() promise settle, then flush the route switch.
  await Promise.resolve();
  await Promise.resolve();
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
  session.setNames('', '');
  session.tally = { 0: 0, 1: 0 };
  session.lastDealer = null;
  session.lastSeed = null;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  bridge.newGame.mockImplementation(() => openingEnvelope());
  resetSingletons();
});

afterEach(cleanup);

// Distinctive card identities that must never reach the result screen (N3).
const HAND_CARDS: Card[] = [
  { Rank: 13, Suit: 3 },
  { Rank: 12, Suit: 2 },
  { Rank: 1, Suit: 0 },
];
const OPPONENT_HAND: Card[] = [{ Rank: 11, Suit: 1 }];

/** Player 0 to act (dealer 1), no cards needed. */
function openingEnvelope(): Envelope {
  return envelope({ state: playerView({ viewer: 0, active: 0, phase: Phase.Normal }) });
}

/** A game-over envelope from player 0's apply. Carries both hands, visible (N3). */
function gameOverEnvelope(outcome: { winner: PlayerId | null; stalemate: boolean }): Envelope {
  const lastMove = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 0, card: { Rank: 10, Suit: 2 } });
  return envelope({
    state: playerView({
      viewer: 0,
      active: 1,
      phase: Phase.GameOver,
      winner: outcome.winner,
      stalemate: outcome.stalemate,
      you: { hand: HAND_CARDS, frozenHandIndices: [], points: [], permanents: [] },
      opponent: { handCount: OPPONENT_HAND.length, hand: OPPONENT_HAND, points: [], permanents: [] },
    }),
    lastMove,
    history: [lastMove],
  });
}

async function startLiveGame(): Promise<void> {
  await game.newGame();
  flushSync();
}

/** A LIVE transition into `result`: a real `game.apply()` whose bridge result is game over. */
async function liveGameOver(outcome: { winner: PlayerId | null; stalemate: boolean }): Promise<void> {
  bridge.apply.mockImplementationOnce((): BridgeResult => gameOverEnvelope(outcome));
  await game.apply(0);
  flushSync();
}

function byTestId(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(el: HTMLElement, id: string): void {
  const target = byTestId(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  flushSync();
}

function resultSnapshot(): Snapshot {
  return {
    v: 1,
    savedAt: '2026-09-27T00:00:00.000Z',
    engineState: '"fake-engine-state"',
    // A curtain other than `none` needs at least one applied move (snapshot.ts isWellFormed).
    history: [appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 0, card: { Rank: 10, Suit: 2 } })],
    lastSeenSeq: { 0: 1, 1: 0 },
    viewer: 0,
    curtain: { kind: 'result' },
    names: ['Alice', 'Bob'],
    seed: '42',
    dealer: 1,
  };
}

describe('App tally wiring (R2.3, R3.1): only a live transition into result records', () => {
  it('a win records once; an unrelated re-render does not re-record; a second live result records again', async () => {
    session.setNames('Alice', 'Bob');
    const el = await renderApp();
    await startLiveGame();
    expect(byTestId(el, 'game-screen')).not.toBeNull();

    await liveGameOver({ winner: 0, stalemate: false });
    expect(byTestId(el, 'result-screen')).not.toBeNull();
    expect(session.tally).toEqual({ 0: 1, 1: 0 });

    // Unrelated re-renders while resting at result: a fresh envelope object
    // (same winner) and a fresh curtain object of the same kind.
    const current = game.envelope;
    if (!current) throw new Error('expected an envelope at result');
    game.envelope = { ...current };
    game.curtain = { kind: 'result' };
    game.notice = 'unrelated';
    flushSync();
    expect(session.tally).toEqual({ 0: 1, 1: 0 });

    // The curtain leaves result (a new game at curtain none), then a second live result.
    await startLiveGame();
    expect(game.curtain.kind).toBe('none');
    await liveGameOver({ winner: 0, stalemate: false });
    expect(session.tally).toEqual({ 0: 2, 1: 0 });
    expect(byTestId(el, 'tally')?.textContent?.trim()).toBe('Alice 2 – Bob 0');
  });

  it('a stalemate leaves the tally unchanged (R3)', async () => {
    const el = await renderApp();
    await startLiveGame();
    await liveGameOver({ winner: null, stalemate: true });
    expect(byTestId(el, 'result-screen')).not.toBeNull();
    expect(session.tally).toEqual({ 0: 0, 1: 0 });
  });

  it('Rematch at App level calls game.newGame and re-arms the tally for the next result (R3.2)', async () => {
    const newGameSpy = vi.spyOn(game, 'newGame');
    const el = await renderApp();
    await startLiveGame();
    await liveGameOver({ winner: 1, stalemate: false });
    expect(session.tally).toEqual({ 0: 0, 1: 1 });
    newGameSpy.mockClear();

    click(el, 'rematch');
    await Promise.resolve();
    flushSync();
    expect(newGameSpy).toHaveBeenCalledTimes(1);
    expect(game.curtain.kind).toBe('none');
    expect(byTestId(el, 'game-screen')).not.toBeNull();

    await liveGameOver({ winner: 1, stalemate: false });
    expect(session.tally).toEqual({ 0: 0, 1: 2 });
  });

  it('the result screen holds no card identity from a view that contains both hands (N3)', async () => {
    session.setNames('Alice', 'Bob');
    const el = await renderApp();
    await startLiveGame();
    await liveGameOver({ winner: 0, stalemate: false });

    // The view behind the result screen really does carry both hands.
    expect(game.view?.you.hand).toEqual(HAND_CARDS);
    expect(game.view?.opponent.hand).toEqual(OPPONENT_HAND);

    const shell = byTestId(el, 'app-shell');
    if (!shell) throw new Error('no app-shell');
    const ids = [...shell.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')).sort();
    expect(ids).toEqual(['rematch', 'result-screen', 'tally']);
    expect(shell.querySelectorAll('svg, img, canvas').length).toBe(0);
    // Every text node on the screen, verbatim: headline, tally, button. Nothing else.
    const texts = [...shell.querySelectorAll('h1, p, button')].map((n) => n.textContent?.trim());
    expect(texts).toEqual(['Alice wins!', 'Alice 1 – Bob 0', 'Rematch']);
    expect(shell.textContent?.replace(/\s+/g, '')).toBe('Alicewins!Alice1–Bob0Rematch');
  });
});

describe('App restore into result (B2, R4.2)', () => {
  it('a finished-game snapshot still offers Resume; Resume shows the result without re-tallying', async () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(resultSnapshot()));
    bridge.restore.mockImplementation(() => gameOverEnvelope({ winner: 0, stalemate: false }));
    const el = await renderApp();

    expect(byTestId(el, 'home-screen')).not.toBeNull();
    click(el, 'resume');
    await Promise.resolve();
    flushSync();

    expect(bridge.restore).toHaveBeenCalledTimes(1);
    expect(game.curtain.kind).toBe('result');
    expect(byTestId(el, 'result-screen')).not.toBeNull();
    expect(session.tally).toEqual({ 0: 0, 1: 0 });
    expect(byTestId(el, 'tally')?.textContent?.trim()).toBe('Alice 0 – Bob 0');
  });

  it('a store-level restore into result on a fresh session leaves the tally at 0-0', async () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(resultSnapshot()));
    bridge.restore.mockImplementation(() => gameOverEnvelope({ winner: 1, stalemate: false }));
    const el = await renderApp();

    await game.restore();
    flushSync();
    expect(byTestId(el, 'result-screen')).not.toBeNull();
    expect(session.tally).toEqual({ 0: 0, 1: 0 });

    // Rematch after a restored result: the next LIVE result does record.
    click(el, 'rematch');
    await Promise.resolve();
    flushSync();
    await liveGameOver({ winner: 0, stalemate: false });
    expect(session.tally).toEqual({ 0: 1, 1: 0 });
  });

  it('an App mounted onto a store already resting at result records nothing', async () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(resultSnapshot()));
    bridge.restore.mockImplementation(() => gameOverEnvelope({ winner: 0, stalemate: false }));
    await game.restore();
    expect(game.screen).toBe('game');
    expect(game.curtain.kind).toBe('result');

    const el = await renderApp();
    expect(byTestId(el, 'result-screen')).not.toBeNull();
    expect(session.tally).toEqual({ 0: 0, 1: 0 });
  });

  it('New game from Home starts immediately, with no abandon confirm, when the snapshot is a finished game', async () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(resultSnapshot()));
    const el = await renderApp();

    expect(byTestId(el, 'resume')).not.toBeNull();
    click(el, 'new-game');
    await Promise.resolve();
    flushSync();

    expect(byTestId(el, 'confirm-abandon')).toBeNull();
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
    expect(byTestId(el, 'game-screen')).not.toBeNull();
  });
});

describe('App error boundary (SPEC §2.9)', () => {
  it('wins over the home screen when game.error is set while screen is home (N1)', async () => {
    const el = await renderApp();
    expect(byTestId(el, 'home-screen')).not.toBeNull();

    game.error = engineError('NO_GAME');
    flushSync();
    expect(game.screen).toBe('home');
    expect(byTestId(el, 'error-screen')).not.toBeNull();
    expect(byTestId(el, 'home-screen')).toBeNull();
  });

  it('shows the error code and generic copy, never the raw bridge message (N4)', async () => {
    const el = await renderApp();
    game.error = engineError('ILLEGAL_MOVE', 'cannot play A♥ as one-off');
    flushSync();

    const screen = byTestId(el, 'error-screen');
    if (!screen) throw new Error('no error-screen');
    expect(screen.innerHTML).not.toContain('cannot play');
    expect(screen.innerHTML).not.toContain('A♥');
    expect(screen.textContent).toContain('ILLEGAL_MOVE');
    expect(screen.textContent).toContain('Something went wrong');
  });

  it('"New game" goes through the R4.3 abandon confirm when an in-progress snapshot exists (N5)', async () => {
    session.setNames('Alice', 'Bob');
    const el = await renderApp();
    await startLiveGame();
    const saved = localStorage.getItem(SNAPSHOT_KEY);
    expect(saved).not.toBeNull();
    bridge.newGame.mockClear();

    game.error = engineError('INTERNAL');
    flushSync();

    click(el, 'error-new-game');
    expect(byTestId(el, 'confirm-abandon')).not.toBeNull();
    expect(byTestId(el, 'error-screen')?.textContent).toContain('Abandon Alice vs Bob?');
    expect(bridge.newGame).not.toHaveBeenCalled();

    click(el, 'cancel-abandon');
    expect(byTestId(el, 'confirm-abandon')).toBeNull();
    expect(bridge.newGame).not.toHaveBeenCalled();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(saved);

    click(el, 'error-new-game');
    click(el, 'confirm-abandon');
    await Promise.resolve();
    flushSync();
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
    expect(byTestId(el, 'game-screen')).not.toBeNull();
  });

  it('"New game" starts immediately when there is no snapshot to abandon', async () => {
    const el = await renderApp();
    game.error = engineError('BAD_REQUEST');
    flushSync();

    click(el, 'error-new-game');
    await Promise.resolve();
    flushSync();
    expect(byTestId(el, 'confirm-abandon')).toBeNull();
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
    expect(byTestId(el, 'game-screen')).not.toBeNull();
  });

  it('"New game" starts immediately when the snapshot is a finished game', async () => {
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(resultSnapshot()));
    const el = await renderApp();
    game.error = engineError('BAD_REQUEST');
    flushSync();

    click(el, 'error-new-game');
    await Promise.resolve();
    flushSync();
    expect(byTestId(el, 'confirm-abandon')).toBeNull();
    expect(bridge.newGame).toHaveBeenCalledTimes(1);
  });
});
