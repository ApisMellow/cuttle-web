// Two-phone W12 (docs/two-phone-plan.md §7, SPEC §2.12): OnlineGameStore,
// the online TableSource, driven through the real W11 connection over a
// FakeSocket. The test plays the server: it opens the socket, sends
// `welcome`, `state`, `responding`, `presence`, `rematch` and `error`
// frames, and reads back what the store sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import { createConnection } from '../../src/lib/online/connection';
import { SEAT_STORAGE_KEY, loadSeat, type SeatRecord } from '../../src/lib/online/seat';
import type { SeatNames } from '../../src/lib/online/protocol';
import { OnlineGameStore } from '../../src/lib/stores/onlineGame.svelte';
import { MoveNotSent } from '../../src/lib/stores/tableSource';
import { Kind, Phase, appliedMove, envelope, fakeStorage, playerView } from './game-test-support';
import { CODE, FakeEnvironment, ORIGIN, TOKEN, socketFactory } from './online-fakes';

const ACE = { Rank: 1, Suit: 3 } as const;
const FIVE = { Rank: 5, Suit: 1 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const KING = { Rank: 13, Suit: 0 } as const;
const QUEEN = { Rank: 12, Suit: 2 } as const;
const TWO = { Rank: 2, Suit: 0 } as const;

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

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) =>
    appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1 }),
  );
}

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, FIVE], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

/** Alice (seat 0) to act at seq 2: Draw, the Ace for points, or the 5 as a one-off. */
function aliceToAct(history = draws(2)): Envelope {
  return envelope({
    state: view(),
    history,
    legalMoves: [
      mv({ Kind: Kind.Draw }),
      mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }),
      mv({ Kind: Kind.OneOff, HandIndex: 1, Card: FIVE }),
    ],
    descriptions: ['draw a card', 'play ace as point card', 'play 5 as one-off'],
  });
}

/** Blake's turn, as Alice sees it. */
function blakeToAct(history: AppliedMove[]): Envelope {
  return envelope({ state: view({ active: 1 }), history });
}

function stateFrame(env: Envelope, opts: { game?: number; opponentOnline?: boolean; tally?: [number, number] } = {}) {
  return { t: 'state', game: opts.game ?? 1, envelope: env, opponentOnline: opts.opponentOnline ?? true, tally: opts.tally ?? [0, 0] };
}

function seatRecord(seat: PlayerId = 0, names: SeatNames = ['Alice', 'Blake']): SeatRecord {
  return { v: 1, server: ORIGIN, code: CODE, seat, token: TOKEN, names };
}

let stores: OnlineGameStore[] = [];

function setup(opts: { seat?: PlayerId; names?: SeatNames } = {}) {
  const sockets = socketFactory();
  const env = new FakeEnvironment();
  const storage = fakeStorage();
  const left: (string | null)[] = [];
  const store = new OnlineGameStore({
    connect: (o) => createConnection({ ...o, socketFactory: sockets.factory, environment: env, random: () => 0.5 }),
    seatStorage: storage,
    onLeave: (notice) => left.push(notice),
  });
  stores.push(store);
  const record = seatRecord(opts.seat ?? 0, opts.names ?? ['Alice', 'Blake']);
  storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
  store.attach(record);
  const server = {
    get socket() {
      return sockets.last;
    },
    open(seat: PlayerId = opts.seat ?? 0, names: SeatNames = ['Alice', 'Blake'], status = 'playing') {
      sockets.last.serverOpen();
      sockets.last.serverSend({ t: 'welcome', seat, names, status });
    },
    send(frame: unknown) {
      sockets.last.serverSend(frame);
    },
    sentMoves() {
      return sockets.sockets.flatMap((s) => s.frames()).filter((f) => f.t === 'move' || f.t === 'rematch');
    },
  };
  return { store, sockets, env, storage, left, server };
}

beforeEach(() => {
  vi.useFakeTimers();
  stores = [];
});

afterEach(() => {
  for (const s of stores) s.detach();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OnlineGameStore: state frames', () => {
  it('takes envelope, history, seq and viewer from a state frame; curtain none', async () => {
    const { store, server } = setup();
    expect(store.envelope).toBeNull();
    expect(store.viewer).toBeNull();
    server.open();
    const env = aliceToAct();
    server.send(stateFrame(env, { tally: [1, 2], opponentOnline: false }));
    expect(store.envelope?.state.viewer).toBe(0);
    expect(store.envelope?.legalMoves).toHaveLength(3);
    expect(store.history).toHaveLength(2);
    expect(store.seq).toBe(2);
    expect(store.viewer).toBe(0);
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.game).toBe(1);
    expect(store.tally).toEqual([1, 2]);
    expect(store.opponentOnline).toBe(false);
    await expect(store.advanceCurtain()).resolves.toBeUndefined();
  });

  it('names come from welcome; the board reads them through `online.names`', () => {
    const { store, server } = setup();
    server.open(0, ['Alice', 'Blake']);
    expect(store.online?.names).toEqual(['Alice', 'Blake']);
  });

  it("strips a mover-only `index` from the other seat's history entries (history is always redacted)", () => {
    const { store, server } = setup();
    server.open();
    const history = [
      appliedMove({ by: 0, kind: Kind.Draw, seq: 1, index: 0 }),
      appliedMove({ by: 1, kind: Kind.Draw, seq: 2, index: 0 }),
    ];
    server.send(stateFrame(aliceToAct(history)));
    expect(Object.prototype.hasOwnProperty.call(store.history[0], 'index')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(store.history[1], 'index')).toBe(false);
  });

  it('reports ack at its own counter window, none when the other seat is deciding, result at game over', () => {
    const { store, server } = setup();
    server.open();
    const window = envelope({
      state: view({ phase: Phase.AwaitingCounter, active: 0, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      history: [...draws(2), appliedMove({ by: 1, kind: Kind.OneOff, card: NINE, seq: 3 })],
      legalMoves: [mv({ Kind: Kind.Counter, HandIndex: 0, Card: TWO }), mv({ Kind: Kind.Decline })],
      descriptions: ['counter with 2', 'decline'],
    });
    server.send(stateFrame(window));
    expect(store.curtain).toEqual({ kind: 'ack', to: 0 });

    server.send(stateFrame(envelope({ state: view({ phase: Phase.AwaitingCounter, active: 1 }), history: draws(3) })));
    expect(store.curtain).toEqual({ kind: 'none' });

    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) })));
    expect(store.curtain).toEqual({ kind: 'result' });
  });

  it('holds only its own seat’s envelope: a state for the other seat is refused (SEAT_MISMATCH)', () => {
    const { store, server, storage, left } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ viewer: 1 }) })));
    expect(store.envelope).toBeNull();
    expect(loadSeat(storage)).toBeNull();
    expect(left).toEqual(['This game couldn’t be resumed.']);
  });
});

describe('OnlineGameStore: apply and pending', () => {
  it('sends move {game, seq, index}; pending until the next state', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    expect(server.sentMoves()).toEqual([{ t: 'move', game: 1, seq: 2, index: 1 }]);
    expect(store.pending).toBe(true);
    server.send(stateFrame(blakeToAct(draws(3))));
    expect(store.pending).toBe(false);
    expect(store.seq).toBe(3);
  });

  it('a second apply while pending sends nothing (double-send guard)', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    await store.apply(0);
    await store.apply(1);
    expect(server.sentMoves()).toHaveLength(1);
  });

  it('an error clears pending; the fresh state that follows resyncs', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'error', code: 'STALE', message: 'stale', seq: 2 });
    expect(store.pending).toBe(false);
    server.send(stateFrame(aliceToAct(draws(2))));
    expect(store.pending).toBe(false);
    expect(store.envelope?.legalMoves).toHaveLength(3);
    // The player can confirm again.
    await store.apply(0);
    expect(server.sentMoves()).toHaveLength(2);
  });

  it('an error with no state after it (INDEX_OUT_OF_RANGE) clears pending and says so', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'error', code: 'INDEX_OUT_OF_RANGE', message: 'x', seq: 2 });
    expect(store.pending).toBe(false);
    expect(store.online?.notice).toMatch(/didn’t go through/);
  });

  it('while disconnected, apply sends nothing, rejects with MoveNotSent and says why', async () => {
    const { store, server, env } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    env.goOffline();
    await expect(store.apply(1)).rejects.toBeInstanceOf(MoveNotSent);
    expect(server.sentMoves()).toEqual([]);
    expect(store.pending).toBe(false);
    expect(store.online?.notice).toMatch(/wasn’t sent/);
    expect(store.online?.statusText).toMatch(/offline/);
    // The next state clears the notice.
    env.goOnline();
    server.open();
    server.send(stateFrame(aliceToAct()));
    expect(store.online?.notice).toBeNull();
  });

  it('a resent state with the same curtain keeps the same curtain object (review F2)', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    const curtain = store.curtain;
    server.send(stateFrame(aliceToAct()));
    expect(store.curtain).toBe(curtain);
    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(3) })));
    expect(store.curtain).toEqual({ kind: 'result' });
  });

  it('a kept move and a reconnect to a new position: "The game moved on" notice (review F2)', async () => {
    const { store, server, env } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    env.goOffline();
    await expect(store.apply(1)).rejects.toBeInstanceOf(MoveNotSent);
    env.goOnline();
    server.open();
    server.send(stateFrame(aliceToAct(draws(4))));
    expect(store.online?.notice).toMatch(/The game moved on while you were away/);
    // The next state after that is ordinary.
    server.send(stateFrame(aliceToAct(draws(4))));
    expect(store.online?.notice).toBeNull();
  });

  // Review F5: a move sent just before a drop may get no answer at all (the
  // server's welcome is followed by state, responding or nothing).
  it('a fresh welcome with no hold clears a stuck pending; a responding after it holds again', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    expect(store.pending).toBe(true);
    server.socket.serverClose();
    vi.advanceTimersByTime(1000);
    server.open();
    expect(store.pending).toBe(false);
    // No double send: the move went once, and the board is free to confirm again.
    expect(server.sentMoves()).toHaveLength(1);
    server.send({ t: 'responding', by: 1 });
    expect(store.pending).toBe(true);
  });

  it('a stall clears a stuck pending', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    for (let i = 0; i < 10; i++) {
      server.socket.serverClose();
      vi.advanceTimersByTime(60_000);
    }
    expect(store.status.kind).toBe('stalled');
    expect(store.pending).toBe(false);
  });

  it('replaced clears a stuck pending', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'error', code: 'REPLACED', message: 'x' });
    expect(store.status.kind).toBe('replaced');
    expect(store.pending).toBe(false);
  });

  it('refuses to apply when it is not this seat’s turn, or with no state yet', async () => {
    const { store, server } = setup();
    server.open();
    await expect(store.apply(0)).rejects.toThrow();
    server.send(stateFrame(blakeToAct(draws(3))));
    await expect(store.apply(0)).rejects.toThrow();
    expect(server.sentMoves()).toEqual([]);
  });
});

describe('OnlineGameStore: responding, presence, rematch', () => {
  it('responding holds the board (pending) until the state arrives', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(2);
    server.send({ t: 'responding', by: 1 });
    expect(store.responding).toBe(1);
    expect(store.pending).toBe(true);
    expect(store.online?.respondingName).toBe('Blake');
    server.send(stateFrame(blakeToAct(draws(3))));
    expect(store.responding).toBeNull();
    expect(store.pending).toBe(false);
    expect(store.online?.respondingName).toBeNull();
  });

  it('after a reconnect, welcome then responding holds the board again', () => {
    const { store, server } = setup();
    server.open();
    server.send({ t: 'responding', by: 1 });
    expect(store.pending).toBe(true);
    server.socket.serverClose();
    vi.advanceTimersByTime(1000);
    server.open();
    expect(store.responding).toBeNull();
    server.send({ t: 'responding', by: 1 });
    expect(store.responding).toBe(1);
  });

  it('presence sets opponentOnline and the status line says so', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send({ t: 'presence', opponentOnline: false });
    expect(store.opponentOnline).toBe(false);
    expect(store.online?.statusText).toBe('Blake is offline.');
    server.send({ t: 'presence', opponentOnline: true });
    expect(store.online?.statusText).toBeNull();
  });

  it('newGame() at game over requests a rematch once; the new game clears it', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) }), { tally: [1, 0] }));
    await store.newGame();
    await store.newGame();
    expect(server.sentMoves()).toEqual([{ t: 'rematch', game: 1 }]);
    server.send({ t: 'rematch', requestedBy: 0 });
    expect(store.rematchRequestedBy).toBe(0);
    await store.newGame();
    expect(server.sentMoves()).toHaveLength(1);

    server.send(stateFrame(aliceToAct(draws(0)), { game: 2, tally: [1, 0] }));
    expect(store.game).toBe(2);
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.rematchRequestedBy).toBeNull();
  });

  it('rematchWhenResumed: after an update reload, the first state of that finished game sends the rematch once (review F4)', () => {
    const { store, server } = setup();
    store.rematchWhenResumed(1);
    server.open(0, ['Alice', 'Blake'], 'over');
    expect(server.sentMoves()).toEqual([]);
    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) })));
    expect(server.sentMoves()).toEqual([{ t: 'rematch', game: 1 }]);
    expect(store.rematchPending).toBe(true);
    // A reconnect resends the same state: nothing more is sent.
    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) })));
    expect(server.sentMoves()).toHaveLength(1);
  });

  it('rematchWhenResumed sends nothing if the room is on another game, or not over', () => {
    const a = setup();
    a.store.rematchWhenResumed(1);
    a.server.open();
    // The room is already on a later finished game (another tab played on).
    a.server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) }), { game: 2 }));
    expect(a.server.sentMoves()).toEqual([]);

    const c = setup();
    c.store.rematchWhenResumed(1);
    c.server.open();
    c.server.send(stateFrame(aliceToAct(draws(0)), { game: 2 }));
    c.server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) }), { game: 2 }));
    expect(c.server.sentMoves()).toEqual([]);

    const b = setup();
    b.store.rematchWhenResumed(1);
    b.server.open();
    b.server.send(stateFrame(aliceToAct()));
    b.server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) })));
    expect(b.server.sentMoves()).toEqual([]);
  });

  it('rematchWhenResumed is dropped by a detach', () => {
    const { store, server, sockets } = setup();
    store.rematchWhenResumed(1);
    store.detach();
    store.attach(seatRecord());
    server.open();
    sockets.last.serverSend(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 0 }), history: draws(4) })));
    expect(server.sentMoves()).toEqual([]);
  });

  it('shows the other seat’s rematch request', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ phase: Phase.GameOver, winner: 1 }), history: draws(4) })));
    server.send({ t: 'rematch', requestedBy: 1 });
    expect(store.rematchRequestedBy).toBe(1);
  });

  it('newGame() mid-game sends nothing', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.newGame();
    expect(server.sentMoves()).toEqual([]);
  });
});

describe('OnlineGameStore: the 5’s draw reveal (SPEC §4.7, online)', () => {
  /** Alice's 5 resolved at once (Blake held no 2) and drew 2; Blake to act. */
  function afterFive(): Envelope {
    return blakeToAct([
      ...draws(2),
      appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, seq: 3, drawn: 2, index: 2 }),
    ]);
  }

  function withHand(env: Envelope, hand: PlayerView['you']['hand']): Envelope {
    return { ...env, state: { ...env.state, you: { ...env.state.you, hand } } };
  }

  it('shows the drawer their drawn cards as soon as the state arrives (never "before the pass")', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(2);
    server.send({ t: 'responding', by: 1 });
    expect(store.drawReveal).toBeNull();
    server.send(stateFrame(withHand(afterFive(), [ACE, KING, QUEEN])));
    expect(store.drawReveal).toEqual({ to: 0, indices: [1, 2], beforePass: false });
    store.dismissDrawReveal();
    expect(store.drawReveal).toBeNull();
    store.dismissDrawReveal();
    // Shown once: the same position again shows nothing.
    server.send(stateFrame(withHand(afterFive(), [ACE, KING, QUEEN])));
    expect(store.drawReveal).toBeNull();
  });

  it('refuses to apply while the reveal is up', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    const five = withHand(
      envelope({
        state: view(),
        history: [...draws(2), appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, seq: 3, drawn: 1 }), appliedMove({ by: 1, kind: Kind.Draw, seq: 4 })],
        legalMoves: [mv({ Kind: Kind.Draw })],
        descriptions: ['draw a card'],
      }),
      [ACE, KING],
    );
    server.send(stateFrame(five));
    expect(store.drawReveal).not.toBeNull();
    await expect(store.apply(0)).rejects.toThrow();
    expect(server.sentMoves()).toEqual([]);
  });

  it('a first state that already holds the draw (a resume) does not replay it', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(withHand(afterFive(), [ACE, KING, QUEEN])));
    expect(store.drawReveal).toBeNull();
  });

  it('the opponent’s 5 shows nothing', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send(
      stateFrame(envelope({ state: view(), history: [...draws(2), appliedMove({ by: 1, kind: Kind.OneOff, card: FIVE, seq: 3, drawn: 2 })] })),
    );
    expect(store.drawReveal).toBeNull();
  });
});

describe('OnlineGameStore: terminal errors and connection trouble', () => {
  it.each([
    ['ROOM_GONE', 'This game has ended.'],
    ['UNAUTHORIZED', 'This game couldn’t be resumed.'],
  ])('%s forgets the seat and leaves for Home with a message', (code, message) => {
    const { store, server, storage, left } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send({ t: 'error', code, message: 'x' });
    expect(loadSeat(storage)).toBeNull();
    expect(left).toEqual([message]);
    expect(store.attached).toBe(false);
    expect(store.envelope).toBeNull();
    expect(store.history).toEqual([]);
  });

  it('SEAT_MISMATCH (a welcome for the other seat) forgets the seat', () => {
    const { server, storage, left } = setup();
    server.open(1);
    expect(loadSeat(storage)).toBeNull();
    expect(left).toEqual(['This game couldn’t be resumed.']);
  });

  it('UPGRADE_REQUIRED keeps the seat and asks for an update', () => {
    const { store, server, storage, left } = setup();
    server.socket.serverOpen();
    server.send({ t: 'error', code: 'UPGRADE_REQUIRED', message: 'x' });
    expect(loadSeat(storage)).not.toBeNull();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/update/i);
    expect(store.attached).toBe(false);
  });

  it('replaced: "Play here" calls retry(), which opens a new socket', () => {
    const { store, server, sockets } = setup();
    server.open();
    server.send({ t: 'error', code: 'REPLACED', message: 'x' });
    expect(store.status.kind).toBe('replaced');
    expect(store.online?.statusText).toMatch(/somewhere else/);
    expect(store.online?.statusAction).toBe('Play here');
    const before = sockets.sockets.length;
    store.online?.runStatusAction();
    expect(sockets.sockets.length).toBe(before + 1);
  });

  it('stalled: "Tap to reconnect" calls retry()', () => {
    const { store, server, sockets } = setup();
    for (let i = 0; i < 10; i++) {
      server.socket.serverClose();
      vi.advanceTimersByTime(60_000);
    }
    expect(store.status.kind).toBe('stalled');
    expect(store.online?.statusAction).toBe('Tap to reconnect');
    const before = sockets.sockets.length;
    store.online?.runStatusAction();
    expect(sockets.sockets.length).toBe(before + 1);
  });

  it('shows "Reconnecting…" after a drop', () => {
    const { store, server } = setup();
    server.open();
    server.socket.serverClose();
    expect(store.online?.statusText).toBe('Reconnecting…');
  });
});

describe('OnlineGameStore: room events and the seat record', () => {
  it('emits opponent-joined once, on the welcome that brings the second name', () => {
    const { store, server, storage } = setup({ names: ['Alice', null] });
    const events: unknown[] = [];
    store.onRoomEvent((e) => events.push(e));
    server.open(0, ['Alice', null], 'waiting');
    expect(events).toEqual([]);
    server.send({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    expect(events).toEqual([{ kind: 'opponent-joined', opponentName: 'Blake' }]);
    server.send({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    expect(events).toHaveLength(1);
    expect(loadSeat(storage)?.names).toEqual(['Alice', 'Blake']);
  });

  it('a first welcome that already has both names emits nothing', () => {
    const { store, server } = setup();
    const events: unknown[] = [];
    store.onRoomEvent((e) => events.push(e));
    server.open();
    expect(events).toEqual([]);
  });

  it('whenWelcomed resolves with the names, or null on timeout', async () => {
    const a = setup({ seat: 1, names: [null, 'Blake'] });
    const names = a.store.whenWelcomed(10_000);
    a.server.open(1, ['Alice', 'Blake']);
    await expect(names).resolves.toEqual(['Alice', 'Blake']);

    const b = setup({ seat: 1, names: [null, 'Blake'] });
    const none = b.store.whenWelcomed(10_000);
    vi.advanceTimersByTime(10_001);
    await expect(none).resolves.toBeNull();
  });

  it('goHome closes the socket, keeps the seat and leaves with no notice', () => {
    const { store, server, storage, left } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    const socket = server.socket;
    store.goHome();
    expect(socket.closedWith).not.toBeNull();
    expect(loadSeat(storage)).not.toBeNull();
    expect(left).toEqual([null]);
    expect(store.envelope).toBeNull();
    expect(store.attached).toBe(false);
  });

  it('never exposes the token, and never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const { store, server, env } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'error', code: 'STALE', message: 'x' });
    env.goOffline();
    await store.apply(1).catch(() => undefined);
    const visible = JSON.stringify({
      envelope: store.envelope,
      history: store.history,
      online: store.online,
      status: store.status,
      roomNames: store.roomNames,
      keys: Object.keys(store),
    });
    expect(visible).not.toContain(TOKEN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
