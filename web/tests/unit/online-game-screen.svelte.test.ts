// @vitest-environment jsdom
// Two-phone W12: ONE mounted GameScreen driven by a real OnlineGameStore
// over the W11 connection and a FakeSocket. The test plays the server.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { createConnection } from '../../src/lib/online/connection';
import type { SeatNames } from '../../src/lib/online/protocol';
import { SEAT_STORAGE_KEY, type SeatRecord } from '../../src/lib/online/seat';
import { OnlineGameStore } from '../../src/lib/stores/onlineGame.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { Kind, Phase, appliedMove, envelope, fakeStorage, playerView } from './game-test-support';
import { CODE, FakeEnvironment, ORIGIN, TOKEN, socketFactory } from './online-fakes';

const ACE = { Rank: 1, Suit: 3 } as const;
const FIVE = { Rank: 5, Suit: 1 } as const;
const KING = { Rank: 13, Suit: 0 } as const;

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) => appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1 }));
}

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    you: { hand: [ACE, FIVE], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

function aliceToAct(history = draws(2)): Envelope {
  return envelope({
    state: view(),
    history,
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.OneOff, HandIndex: 1, Card: FIVE })],
    descriptions: ['draw a card', 'play 5 as one-off'],
  });
}

function stateFrame(env: Envelope, game = 1) {
  return { t: 'state', game, envelope: env, opponentOnline: true, tally: [0, 0] };
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let store: OnlineGameStore | undefined;

function setup(names: SeatNames = ['Alice', 'Blake'], seat: PlayerId = 0) {
  const sockets = socketFactory();
  const env = new FakeEnvironment();
  const storage = fakeStorage();
  store = new OnlineGameStore({
    connect: (o) => createConnection({ ...o, socketFactory: sockets.factory, environment: env, random: () => 0.5 }),
    seatStorage: storage,
  });
  const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat, token: TOKEN, names };
  storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
  store.attach(record);
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: store } });
  flushSync();
  return { store, sockets, env };
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

function moves(sockets: ReturnType<typeof socketFactory>) {
  return sockets.sockets.flatMap((s) => s.frames()).filter((f) => f.t === 'move');
}

beforeEach(() => {
  vi.useFakeTimers();
  session.setNames('Player 1', 'Player 2');
  settings.revealPreference = 'two-step';
  settings.setTableMode(false);
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  store?.detach();
  store = undefined;
  settings.setTableMode(false);
  vi.useRealTimers();
});

describe('W12: GameScreen on the online store', () => {
  it('plays a move: state -> Confirm -> pending -> responding -> state', async () => {
    const { sockets } = setup();
    expect(q('online-waiting')).not.toBeNull();
    expect(q('online-status')?.textContent).toContain('Connecting');

    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    await settle();
    expect(q('board')).not.toBeNull();
    expect(q('online-status')).toBeNull();
    // Names come from the room, not the pass-and-play session.
    expect(host?.textContent).toContain('Alice');
    expect(host?.textContent).toContain('Blake');

    await click('deck-pile');
    await click('staging-confirm');
    expect(moves(sockets)).toEqual([{ t: 'move', game: 1, seq: 2, index: 0 }]);
    expect(q('board')?.getAttribute('data-inert')).toBe('true');

    sockets.last.serverSend({ t: 'responding', by: 1 });
    await settle();
    expect(q('board')).toBeNull();
    expect(q('online-responding')?.textContent).toContain('Blake is responding');

    sockets.last.serverSend(stateFrame(envelope({ state: view({ active: 1 }), history: draws(3) })));
    await settle();
    expect(q('online-responding')).toBeNull();
    expect(q('board')).not.toBeNull();
    expect(q('board')?.getAttribute('data-inert')).toBe('false');
  });

  it('offline: Confirm sends nothing, the staged move stays, and a notice says why', async () => {
    const { sockets, env } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    await settle();
    await click('deck-pile');
    env.goOffline();
    await settle();
    expect(q('online-status')?.textContent).toContain('offline');
    await click('staging-confirm');
    expect(moves(sockets)).toEqual([]);
    expect(q('staging-confirm')).not.toBeNull();
    expect(q('online-notice')?.textContent).toContain('wasn’t sent');
  });

  it('replaced: the status line offers "Play here", which reconnects', async () => {
    const { sockets } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    sockets.last.serverSend({ t: 'error', code: 'REPLACED', message: 'x' });
    await settle();
    expect(q('online-status')?.textContent).toContain('somewhere else');
    const before = sockets.sockets.length;
    await click('online-retry');
    expect(q('online-retry')).toBeNull();
    expect(sockets.sockets.length).toBe(before + 1);
  });

  it('shows the draw reveal on the drawer’s own screen when the state arrives', async () => {
    const { sockets } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    await settle();
    const after = envelope({
      state: view({ active: 1, you: { hand: [ACE, KING], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      history: [...draws(2), appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, seq: 3, drawn: 1, index: 1 })],
    });
    sockets.last.serverSend(stateFrame(after));
    await settle();
    expect(q('draw-reveal')).not.toBeNull();
    await click('draw-reveal-continue');
    expect(q('draw-reveal')).toBeNull();
    expect(q('board')).not.toBeNull();
  });

  it('never turns the screen for table mode', async () => {
    settings.setTableMode(true);
    const { sockets } = setup(['Alice', 'Blake'], 1);
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 1, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(envelope({ state: view({ viewer: 1, active: 1 }), history: draws(3) })));
    await settle();
    expect(q('game-screen')?.getAttribute('data-table-rotated')).toBe('false');
  });

  it('the menu’s New game does nothing mid-game', async () => {
    const { sockets } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    await settle();
    await store?.newGame();
    expect(sockets.sockets.flatMap((s) => s.frames()).filter((f) => f.t === 'rematch')).toEqual([]);
  });

  it('the menu’s New game is gated while a move is pending', async () => {
    const { sockets } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(stateFrame(aliceToAct()));
    await settle();
    await click('deck-pile');
    await click('staging-confirm');
    expect(store?.pending).toBe(true);
    const newGame = vi.spyOn(store as OnlineGameStore, 'newGame');
    await click('menu-button');
    await click('menu-new-game');
    await click('confirm-abandon');
    expect(newGame).not.toHaveBeenCalled();
  });

  it('shows the counter prompt at its own counter window', async () => {
    const TWO = { Rank: 2, Suit: 0 } as const;
    const { sockets } = setup();
    sockets.last.serverOpen();
    sockets.last.serverSend({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    sockets.last.serverSend(
      stateFrame(
        envelope({
          state: view({ phase: Phase.AwaitingCounter, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
          history: [...draws(2), appliedMove({ by: 1, kind: Kind.OneOff, card: FIVE, seq: 3, description: 'play 5♦ as one-off' })],
          legalMoves: [mv({ Kind: Kind.Counter, HandIndex: 0, Card: TWO }), mv({ Kind: Kind.Decline })],
          descriptions: ['counter with 2', 'decline'],
        }),
      ),
    );
    await settle();
    expect(q('board')).toBeNull();
    expect(q('counter-prompt')).not.toBeNull();
  });
});
