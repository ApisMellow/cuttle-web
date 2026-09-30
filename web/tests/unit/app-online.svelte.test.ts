// @vitest-environment jsdom
// Two-phone W12: App routing for online play, end to end through the real
// wiring: configureOnlineActions -> real OnlineActions -> http.ts (a stubbed
// fetch) -> the app's OnlineGameStore -> the W11 connection (a stubbed
// global WebSocket). The test plays the server. ONE mounted App per test;
// the wasm boot and the bridge are mocked as in app.svelte.test.ts.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
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

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { online } = await import('../../src/lib/stores/online.svelte');
const { onlineGame } = await import('../../src/lib/stores/onlineGame.svelte');
const { configureOnlineActions, getOnlineActions, setOnlineActions } = await import('../../src/lib/online/provider');
const { SEAT_STORAGE_KEY, loadSeat } = await import('../../src/lib/online/seat');

const ACE = { Rank: 1, Suit: 3 } as const;

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

const fetchMock = vi.fn();

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) => appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1 }));
}

function view(seat: PlayerId, overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: seat,
    active: seat,
    you: { hand: [ACE], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

function toAct(seat: PlayerId, history = draws(2)): Envelope {
  return envelope({ state: view(seat), history, legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] });
}

function stateFrame(env: Envelope, opts: { game?: number; tally?: [number, number] } = {}) {
  return { t: 'state', game: opts.game ?? 1, envelope: env, opponentOnline: true, tally: opts.tally ?? [0, 0] };
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

async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement | null;
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function submit(id: string): Promise<void> {
  const el = q(id) as HTMLButtonElement | null;
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

beforeEach(() => {
  localStorage.clear();
  sockets.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('WebSocket', GlobalSocket);
  vi.stubGlobal('fetch', fetchMock);
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  bridge.newGame.mockImplementation(() => envelope({ state: playerView({ viewer: 0, active: 0 }) }));
  game.goHome();
  game.error = null;
  game.notice = null;
  session.setNames('', '');
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
  history.replaceState(null, '', location.pathname);
});

describe('W12 App: online routing', () => {
  it('create -> waiting -> the opponent joins -> state -> a move -> responding -> state', async () => {
    fetchMock.mockImplementation(async () => reply(201, { code: CODE, seat: 0, token: TOKEN }));
    await renderApp();
    await click('online-create');
    await type('online-name-input', 'Alice');
    await submit('create-room');
    expect(q('waiting-screen')).not.toBeNull();
    expect(q('room-code')?.textContent).toContain(CODE);
    expect(loadSeat()?.names).toEqual(['Alice', null]);

    lastSocket().serverOpen();
    const hello = sent('hello');
    expect(hello).toEqual([{ t: 'hello', v: 1, code: CODE, token: TOKEN, lastSeq: 0 }]);
    expect(lastSocket().url).not.toContain(TOKEN);
    await server({ t: 'welcome', seat: 0, names: ['Alice', null], status: 'waiting' });
    expect(q('waiting-screen')).not.toBeNull();

    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    expect(q('waiting-screen')).toBeNull();
    expect(q('game-screen')).not.toBeNull();
    expect(q('online-waiting')).not.toBeNull();

    await server(stateFrame(toAct(0)));
    expect(q('board')).not.toBeNull();
    await click('deck-pile');
    await click('staging-confirm');
    expect(sent('move')).toEqual([{ t: 'move', game: 1, seq: 2, index: 0 }]);

    await server({ t: 'responding', by: 1 });
    expect(q('online-responding')?.textContent).toContain('Blake is responding');

    await server(stateFrame(envelope({ state: view(0, { active: 1 }), history: draws(3) })));
    expect(q('online-responding')).toBeNull();
    expect(q('board')).not.toBeNull();
    // Pass-and-play's store was never touched.
    expect(game.screen).toBe('home');
    expect(bridge.newGame).not.toHaveBeenCalled();
    expect(host?.innerHTML).not.toContain(TOKEN);
  });

  it('#/join/CODE opens Join; joining shows the table once the host is named', async () => {
    fetchMock.mockImplementation(async () => reply(200, { code: CODE, seat: 1, token: TOKEN }));
    history.replaceState(null, '', `${location.pathname}#/join/k7qx`);
    await renderApp();
    expect(q('join-screen')).not.toBeNull();
    expect((q('join-code-input') as HTMLInputElement).value).toBe(CODE);
    await type('online-name-input', 'Blake');
    await submit('join-room');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${ORIGIN}/api/rooms/${CODE}/join`);

    lastSocket().serverOpen();
    await server({ t: 'welcome', seat: 1, names: ['Alice', 'Blake'], status: 'playing' });
    expect(q('game-screen')).not.toBeNull();
    await server(stateFrame(toAct(1)));
    expect(q('board')).not.toBeNull();
  });

  it('Home offers "Resume online game with Blake" for a saved seat, and it reconnects', async () => {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
    await renderApp();
    expect(q('resume-online')?.textContent).toContain('Resume online game with Blake');
    await click('resume-online');
    expect(q('game-screen')).not.toBeNull();
    lastSocket().serverOpen();
    expect(sent('hello')).toHaveLength(1);
    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    await server(stateFrame(toAct(0)));
    expect(q('board')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ROOM_GONE forgets the seat and returns Home with a message', async () => {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
    await renderApp();
    await click('resume-online');
    lastSocket().serverOpen();
    await server({ t: 'error', code: 'ROOM_GONE', message: 'gone' });
    expect(q('home-screen')).not.toBeNull();
    expect(host?.textContent).toContain('This game has ended.');
    expect(loadSeat()).toBeNull();
    expect(q('resume-online')).toBeNull();
    expect(q('online-create')).not.toBeNull();
  });

  it('the menu’s Home leaves the online game and keeps the seat for Resume', async () => {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
    await renderApp();
    await click('resume-online');
    lastSocket().serverOpen();
    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    await server(stateFrame(toAct(0)));
    onlineGame.goHome();
    await settle();
    expect(q('home-screen')).not.toBeNull();
    expect(q('resume-online')).not.toBeNull();
    expect(lastSocket().closedWith).not.toBeNull();
  });

  it('the result screen reads the online store; Rematch sends one request', async () => {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
    await renderApp();
    await click('resume-online');
    lastSocket().serverOpen();
    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'over' });
    const over = envelope({
      state: view(0, { phase: Phase.GameOver, winner: 0 }),
      history: [appliedMove({ by: 0, kind: Kind.PlayPoint, card: { Rank: 10, Suit: 2 }, description: 'play 10♥ as point card', seq: 1, index: 0 })],
    });
    await server(stateFrame(over, { tally: [1, 0] }));
    expect(q('result-screen')).not.toBeNull();
    expect(q('result-screen')?.textContent).toContain('Alice wins!');
    expect(q('tally')?.textContent).toContain('Alice 1');
    expect(q('tally')?.textContent).toContain('Blake 0');
    await click('rematch');
    await click('rematch');
    expect(sent('rematch')).toEqual([{ t: 'rematch', game: 1 }]);
    await server({ t: 'rematch', requestedBy: 0 });
    expect(q('online-rematch-status')?.textContent).toContain('Waiting for Blake');
    // W13b: Rematch is spent while the request is out.
    expect((q('rematch') as HTMLButtonElement).disabled).toBe(true);
    await server(stateFrame(toAct(0, []), { game: 2, tally: [1, 0] }));
    expect(q('result-screen')).toBeNull();
    expect(q('board')).not.toBeNull();
    // The pass-and-play tally is untouched by an online win.
    expect(session.tally).toEqual({ 0: 0, 1: 0 });
  });

  // W13b (plan §7): the rematch line when Blake asks first.
  it('Blake asks first: "Blake wants a rematch.", then Rematch says the rematch is starting', async () => {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] }));
    await renderApp();
    await click('resume-online');
    lastSocket().serverOpen();
    await server({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'over' });
    const over = envelope({
      state: view(0, { phase: Phase.GameOver, winner: 1, active: 1 }),
      history: [appliedMove({ by: 1, kind: Kind.PlayPoint, card: { Rank: 10, Suit: 2 }, description: 'play 10♥ as point card', seq: 1 })],
    });
    await server(stateFrame(over, { tally: [0, 1] }));
    expect(q('online-rematch-status')).toBeNull();
    await server({ t: 'rematch', requestedBy: 1 });
    expect(q('online-rematch-status')?.textContent).toContain('Blake wants a rematch.');
    expect((q('rematch') as HTMLButtonElement).disabled).toBe(false);
    await click('rematch');
    expect(sent('rematch')).toEqual([{ t: 'rematch', game: 1 }]);
    expect(q('online-rematch-status')?.textContent).toContain('Starting the rematch…');
  });

  it('pass-and-play is unaffected: no socket, no request', async () => {
    await renderApp();
    await click('new-game');
    expect(game.screen).toBe('game');
    expect(q('game-screen')).not.toBeNull();
    expect(sockets).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onlineGame.attached).toBe(false);
  });
});
