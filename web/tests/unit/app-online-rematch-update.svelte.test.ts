// @vitest-environment jsdom
// Review F4 (R18, SPEC §5.8): online players get updates too. The online
// result screen's Rematch is a safe point: with an update waiting, the tap
// hands over to the update (no rematch is sent from the old page), and the
// reloaded page resumes the saved seat and sends the rematch once the
// finished game's state arrives. The service-worker glue is mocked; the real
// online actions, store and connection run over a stubbed WebSocket.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Envelope, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import { Kind, Phase, appliedMove, envelope, playerView } from './game-test-support';
import { CODE, FakeSocket, ORIGIN, TOKEN } from './online-fakes';

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
  applyUpdateAtOnlineRematch: vi.fn((): boolean => false),
  takePendingOnlineRematch: vi.fn((): { code: string; game: number } | null => null),
}));
vi.mock('../../src/lib/pwa/register', () => pwa);

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { online } = await import('../../src/lib/stores/online.svelte');
const { onlineGame } = await import('../../src/lib/stores/onlineGame.svelte');
const { configureOnlineActions, getOnlineActions, setOnlineActions } = await import('../../src/lib/online/provider');
const { SEAT_STORAGE_KEY } = await import('../../src/lib/online/seat');

const sockets: FakeSocket[] = [];
class GlobalSocket extends FakeSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

function lastSocket(): FakeSocket {
  const s = sockets.at(-1);
  if (!s) throw new Error('no socket');
  return s;
}

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) => appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1 }));
}

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

function over(): Envelope {
  return envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) });
}

function stateFrame(env: Envelope, game = 1) {
  return { t: 'state', game, envelope: env, opponentOnline: true, tally: [1, 0] };
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let savedActions: ReturnType<typeof getOnlineActions>;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function renderApp(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(App, { target: host });
  await settle();
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

async function server(frame: unknown): Promise<void> {
  lastSocket().serverSend(frame);
  await settle();
}

function sent(t: string): Array<Record<string, unknown>> {
  return sockets.flatMap((s) => s.frames()).filter((f) => f.t === t);
}

function saveSeat(code = CODE): void {
  localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
}

async function reachOnlineResult(): Promise<void> {
  saveSeat();
  await renderApp();
  await click('resume-online');
  lastSocket().serverOpen();
  await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'over' });
  await server(stateFrame(over()));
  expect(q('result-screen')).not.toBeNull();
}

beforeEach(() => {
  localStorage.clear();
  sockets.length = 0;
  vi.stubGlobal('WebSocket', GlobalSocket);
  vi.stubGlobal('fetch', vi.fn());
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  pwa.applyUpdateAtRematch.mockReset().mockReturnValue(false);
  pwa.takePendingRematch.mockReset().mockReturnValue(null);
  pwa.applyUpdateAtOnlineRematch.mockReset().mockReturnValue(false);
  pwa.takePendingOnlineRematch.mockReset().mockReturnValue(null);
  game.goHome();
  game.error = null;
  onlineGame.detach();
  online.leave(null);
  savedActions = getOnlineActions();
  expect(configureOnlineActions({ origin: ORIGIN })).toBe('real');
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  onlineGame.detach();
  online.leave(null);
  setOnlineActions(savedActions);
  vi.unstubAllGlobals();
});

describe('online Rematch as an update safe point (review F4)', () => {
  it('with an update waiting, the tap hands over to the update and sends no rematch', async () => {
    pwa.applyUpdateAtOnlineRematch.mockReturnValue(true);
    await reachOnlineResult();
    await click('rematch');
    expect(pwa.applyUpdateAtOnlineRematch).toHaveBeenCalledWith({ code: CODE, game: 1 });
    expect(sent('rematch')).toEqual([]);
    expect(q('result-screen')).not.toBeNull();
    // Nothing secret goes into the carried value.
    expect(JSON.stringify(pwa.applyUpdateAtOnlineRematch.mock.calls)).not.toContain(TOKEN);
  });

  it('with nothing waiting, the tap sends the rematch as before', async () => {
    await reachOnlineResult();
    await click('rematch');
    expect(pwa.applyUpdateAtOnlineRematch).toHaveBeenCalledTimes(1);
    expect(sent('rematch')).toEqual([{ t: 'rematch', game: 1 }]);
  });

  it('once this seat’s rematch is already out, a tap never reloads', async () => {
    await reachOnlineResult();
    await click('rematch');
    await server({ t: 'rematch', requestedBy: 0 });
    pwa.applyUpdateAtOnlineRematch.mockClear().mockReturnValue(true);
    await click('rematch');
    expect(pwa.applyUpdateAtOnlineRematch).not.toHaveBeenCalled();
    expect(sent('rematch')).toHaveLength(1);
  });

  it('after the reload: resumes the saved seat and sends the rematch once the finished game arrives', async () => {
    saveSeat();
    pwa.takePendingOnlineRematch.mockReturnValue({ code: CODE, game: 1 });
    await renderApp();
    expect(q('home-screen')).toBeNull();
    expect(q('game-screen')).not.toBeNull();
    lastSocket().serverOpen();
    expect(sent('hello')).toHaveLength(1);
    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'over' });
    expect(sent('rematch')).toEqual([]);
    await server(stateFrame(over()));
    expect(sent('rematch')).toEqual([{ t: 'rematch', game: 1 }]);
    expect(q('result-screen')).not.toBeNull();
    expect(q('online-rematch-status')?.textContent).toContain('Waiting for Blake');
  });

  it('after the reload: a carried rematch for another room is ignored (stays Home, no socket)', async () => {
    saveSeat('WXYZ');
    pwa.takePendingOnlineRematch.mockReturnValue({ code: CODE, game: 1 });
    await renderApp();
    expect(q('home-screen')).not.toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('pass-and-play’s carried rematch is untouched by the online path', async () => {
    pwa.takePendingRematch.mockReturnValue({ names: ['Alice', 'Blake'], dealer: 0 });
    bridge.newGame.mockImplementation(() => envelope({ state: playerView({ viewer: 0, active: 0 }) }));
    await renderApp();
    expect(game.screen).toBe('game');
    expect(sockets).toHaveLength(0);
  });
});
