// Two-phone W13b (docs/two-phone-plan.md §7, SPEC §2.12.2 "lastSeq", §2.10,
// §4.6): what the online store adds for the in-game polish.
//   - `missed`: the missed-moves recap on a same-game seq jump, built only
//     from the state frames this seat received, never naming a hidden card.
//   - `stuck`: the §2.10 stuck state online.
//   - the table info's waiting line, the held card on the responding panel
//     and the status line's tone.
// The test plays the server over a FakeSocket, as online-game-store.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import { createConnection } from '../../src/lib/online/connection';
import { SEAT_STORAGE_KEY, loadSeat, type SeatRecord } from '../../src/lib/online/seat';
import { OnlineGameStore } from '../../src/lib/stores/onlineGame.svelte';
import { Kind, Phase, appliedMove, envelope, fakeStorage, playerView } from './game-test-support';
import { CODE, FakeEnvironment, ORIGIN, TOKEN, socketFactory } from './online-fakes';

const ACE = { Rank: 1, Suit: 3 } as const;
const FIVE = { Rank: 5, Suit: 1 } as const;
const SEVEN_H = { Rank: 7, Suit: 2 } as const;

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

/** Alice (seat 0) to act: Draw, or the 5 as a one-off. */
function aliceToAct(history = draws(2)): Envelope {
  return envelope({
    state: view(),
    history,
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.OneOff, HandIndex: 1, Card: FIVE })],
    descriptions: ['draw a card', 'play 5♦ as one-off'],
  });
}

function stateFrame(env: Envelope, game = 1) {
  return { t: 'state', game, envelope: env, opponentOnline: true, tally: [0, 0] };
}

let stores: OnlineGameStore[] = [];

function setup(seat: PlayerId = 0) {
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
  const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat, token: TOKEN, names: ['Alice', 'Blake'] };
  storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
  store.attach(record);
  const server = {
    open() {
      sockets.last.serverOpen();
      sockets.last.serverSend({ t: 'welcome', seat, names: ['Alice', 'Blake'], status: 'playing' });
    },
    send(frame: unknown) {
      sockets.last.serverSend(frame);
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
});

// Alice drew (seq 3, her move in flight when the socket dropped), then Blake
// played 7♥ for points (seq 4). The reconnect's state jumps from 2 to 4.
function afterReconnect(): AppliedMove[] {
  return [
    ...draws(2),
    appliedMove({ by: 0, kind: Kind.Draw, description: 'draw a card', seq: 3, index: 0 }),
    appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 4 }),
  ];
}

describe('W13b store: the missed-moves recap', () => {
  it('a seq jump in the same game lists the other seat’s unseen moves, oldest first', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    expect(store.missed).toEqual([]);
    server.send(stateFrame(aliceToAct(afterReconnect())));
    expect(store.missed.map((e) => e.seq)).toEqual([4]);
    expect(store.online?.missed.map((e) => e.seq)).toEqual([4]);
  });

  it('builds the entries from the state frame’s own history, redacted: no mover-only index', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    const history = afterReconnect();
    // Defense in depth: an index the wire should never carry on Blake's entry.
    history[3] = { ...history[3], index: 2 };
    server.send(stateFrame(aliceToAct(history)));
    expect(store.missed).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(store.missed[0], 'index')).toBe(false);
    expect(store.missed[0]).toEqual(store.history[3]);
  });

  it('a one-step state shows no recap', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct(draws(2))));
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(3) })));
    expect(store.missed).toEqual([]);
  });

  it('the first state and a new game never recap', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct(draws(8))));
    expect(store.missed).toEqual([]);
    server.send(stateFrame(aliceToAct(draws(2))));
    server.send(stateFrame(aliceToAct(draws(6)), 2));
    expect(store.missed).toEqual([]);
  });

  it('a new game clears a recap that was up', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send(stateFrame(aliceToAct(afterReconnect())));
    expect(store.missed).toHaveLength(1);
    server.send(stateFrame(aliceToAct([]), 2));
    expect(store.missed).toEqual([]);
  });

  it('dismissMissed clears it, and so does this seat’s next move', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send(stateFrame(aliceToAct(afterReconnect())));
    store.online?.dismissMissed();
    expect(store.missed).toEqual([]);

    server.send(stateFrame(aliceToAct([...afterReconnect(), ...[5, 6].map((seq) => appliedMove({ by: (seq % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq }))])));
    expect(store.missed.map((e) => e.seq)).toEqual([5]);
    await store.apply(0);
    expect(store.missed).toEqual([]);
  });

  it('a second jump while the recap is up extends it from the first one', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send(stateFrame(aliceToAct(afterReconnect())));
    const more = [
      ...afterReconnect(),
      appliedMove({ by: 0, kind: Kind.Draw, description: 'draw a card', seq: 5, index: 0 }),
      appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 6 }),
    ];
    server.send(stateFrame(aliceToAct(more)));
    expect(store.missed.map((e) => e.seq)).toEqual([4, 6]);
  });

  // The hold (SPEC §2.12.5): after Alice's 5 the answer may be a Decline
  // (Blake held a 2) or nothing (no window). The state that ends the hold is
  // seq+1 in one case and seq+2 in the other. Own moves and Declines are
  // never recapped, so neither case shows anything: the recap is no tell.
  it('the post-hold jump over only her own move and a Decline recaps nothing (no hold tell)', async () => {
    for (const declined of [false, true]) {
      const { store, server } = setup();
      server.open();
      server.send(stateFrame(aliceToAct()));
      await store.apply(1);
      server.send({ t: 'responding', by: 1 });
      const history = [
        ...draws(2),
        appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, description: 'play 5♦ as one-off', seq: 3, index: 1, drawn: declined ? null : 2 }),
        ...(declined ? [appliedMove({ by: 1, kind: Kind.Decline, description: 'decline to counter', seq: 4, drawn: 2 })] : []),
      ];
      server.send(stateFrame(envelope({ state: view({ active: 1 }), history })));
      expect(store.missed).toEqual([]);
      expect(store.online?.missed).toEqual([]);
      store.detach();
    }
  });

  // Review blocker 2 (SPEC §2.12.9, §4.6): the counter prompt shows the
  // chain; the responder's own apply there counts as having seen it.
  const TWO_C = { Rank: 2, Suit: 0 } as const;
  const TWO_D = { Rank: 2, Suit: 1 } as const;
  const TWO_S = { Rank: 2, Suit: 3 } as const;

  function atAck(history: AppliedMove[]): Envelope {
    return envelope({
      state: view({ phase: Phase.AwaitingCounter, you: { hand: [TWO_D, TWO_S], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
      history,
      legalMoves: [mv({ Kind: Kind.Counter, HandIndex: 0, Card: TWO_D }), mv({ Kind: Kind.Decline })],
      descriptions: ['counter with 2♦', 'decline to counter'],
    });
  }

  it('countered: declining at the prompt drops the moves the prompt showed', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'responding', by: 1 });
    const five = appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, description: 'play 5♦ as one-off', seq: 3, index: 1 });
    const counter = appliedMove({ by: 1, kind: Kind.Counter, card: TWO_C, description: 'counter with 2♣', seq: 4 });
    server.send(stateFrame(atAck([...draws(2), five, counter])));
    expect(store.curtain.kind).toBe('ack');
    expect(store.missed.map((e) => e.seq)).toEqual([4]);
    await store.apply(1); // Decline at the prompt
    expect(store.missed).toEqual([]);
    const decline = appliedMove({ by: 0, kind: Kind.Decline, description: 'decline to counter', seq: 5, index: 1 });
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: [...draws(2), five, counter, decline] })));
    expect(store.missed).toEqual([]);
  });

  it('a counter war: each apply at the prompt drops what it showed; nothing comes back later', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'responding', by: 1 });
    const h = [
      ...draws(2),
      appliedMove({ by: 0, kind: Kind.OneOff, card: FIVE, description: 'play 5♦ as one-off', seq: 3, index: 1 }),
      appliedMove({ by: 1, kind: Kind.Counter, card: TWO_C, description: 'counter with 2♣', seq: 4 }),
    ];
    server.send(stateFrame(atAck(h)));
    expect(store.missed.map((e) => e.seq)).toEqual([4]);
    await store.apply(0); // Alice counters with 2♦
    expect(store.missed).toEqual([]);
    server.send({ t: 'responding', by: 1 });
    const h2 = [
      ...h,
      appliedMove({ by: 0, kind: Kind.Counter, card: TWO_D, description: 'counter with 2♦', seq: 5, index: 0 }),
      appliedMove({ by: 1, kind: Kind.Counter, card: TWO_C, description: 'counter with 2♣', seq: 6 }),
    ];
    server.send(stateFrame(atAck(h2)));
    expect(store.missed.map((e) => e.seq)).toEqual([6]);
    await store.apply(1); // Decline
    expect(store.missed).toEqual([]);
    const h3 = [...h2, appliedMove({ by: 0, kind: Kind.Decline, description: 'decline to counter', seq: 7, index: 1 })];
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: h3 })));
    expect(store.missed).toEqual([]);
  });

  it('keeps earlier missed moves the prompt did not show, and never brings the shown ones back', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(2) })));
    const h = [
      ...draws(2),
      appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 3 }),
      appliedMove({ by: 0, kind: Kind.Draw, description: 'draw a card', seq: 4, index: 0 }),
      appliedMove({ by: 1, kind: Kind.OneOff, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off', seq: 5 }),
    ];
    server.send(stateFrame(atAck(h)));
    expect(store.missed.map((e) => e.seq)).toEqual([3, 5]);
    await store.apply(1); // Decline
    expect(store.missed.map((e) => e.seq)).toEqual([3]);
    const h2 = [...h, appliedMove({ by: 0, kind: Kind.Decline, description: 'decline to counter', seq: 6, index: 1, drawn: 2 })];
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: h2 })));
    expect(store.missed.map((e) => e.seq)).toEqual([3]);
    // A later jump extends from the same start but never re-adds seq 5.
    const h3 = [
      ...h2,
      appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 7 }),
      appliedMove({ by: 0, kind: Kind.Draw, description: 'draw a card', seq: 8, index: 0 }),
      appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 9 }),
    ];
    server.send(stateFrame(aliceToAct(h3)));
    expect(store.missed.map((e) => e.seq)).toEqual([3, 7, 9]);
  });

  it('detach drops the recap', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send(stateFrame(aliceToAct(afterReconnect())));
    store.detach();
    expect(store.missed).toEqual([]);
  });
});

describe('W13b store: the stuck state (SPEC §2.10)', () => {
  it('ILLEGAL_MOVE after a move is stuck, with the code, game and seq; no notice', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct(), 3));
    await store.apply(0);
    server.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'illegal', seq: 2 });
    expect(store.stuck).toEqual({ code: 'ILLEGAL_MOVE', game: 3, seq: 2 });
    expect(store.online?.stuck).toEqual({ code: 'ILLEGAL_MOVE', game: 3, seq: 2 });
    expect(store.notice).toBeNull();
    expect(store.pending).toBe(false);
  });

  it('NO_LEGAL_MOVES from the server is stuck too', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send({ t: 'error', code: 'NO_LEGAL_MOVES', message: 'none' });
    expect(store.stuck?.code).toBe('NO_LEGAL_MOVES');
  });

  it('a state where this seat must act but nothing is offered is stuck NO_LEGAL_MOVES (rule 1)', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ phase: Phase.SevenChoosing }), history: draws(2) })));
    expect(store.stuck).toEqual({ code: 'NO_LEGAL_MOVES', game: 1, seq: 2 });
  });

  it('the other seat’s turn with no moves listed is not stuck', () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(2) })));
    expect(store.stuck).toBeNull();
  });

  it('the same position resent keeps it; a new position clears it', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(0);
    server.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'illegal' });
    server.send(stateFrame(aliceToAct()));
    expect(store.stuck?.code).toBe('ILLEGAL_MOVE');
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(3) })));
    expect(store.stuck).toBeNull();
  });

  it('leaveGame forgets the seat and leaves for Home', () => {
    const { store, server, storage, left } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    server.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'illegal' });
    store.online?.leaveGame();
    expect(loadSeat(storage)).toBeNull();
    expect(store.attached).toBe(false);
    expect(store.stuck).toBeNull();
    expect(left).toEqual([null]);
  });
});

describe('W13b store: waiting line, held card, status tone', () => {
  it('names what the other seat is doing, from public phase and turn only', () => {
    const { store, server } = setup();
    server.open();
    const cases: Array<[Partial<PlayerView>, string | null]> = [
      [{ active: 1, phase: Phase.AwaitingDiscard }, 'Blake is choosing what to discard.'],
      [{ active: 1, phase: Phase.SevenChoosing }, 'Blake is choosing from the 7.'],
      // Only reachable without a hold (a server restart): the same words as
      // the hold panel, so it says nothing the hold doesn't.
      [{ active: 1, phase: Phase.AwaitingCounter }, 'Blake is responding…'],
      [{ active: 1, phase: Phase.Normal }, null],
      [{ active: 0, phase: Phase.Normal }, null],
      [{ active: 1, phase: Phase.GameOver, winner: 1 }, null],
    ];
    let seq = 2;
    for (const [overrides, text] of cases) {
      seq += 1;
      const legal = overrides.active === 0 ? { legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] } : {};
      server.send(stateFrame(envelope({ state: view(overrides), history: draws(seq), ...legal })));
      expect(store.online?.waitingText).toBe(text);
    }
  });

  it('the responding panel gets the card this seat just played, and loses it with the state', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    server.send({ t: 'responding', by: 1 });
    expect(store.online?.respondingName).toBe('Blake');
    expect(store.online?.respondingCard).toEqual(FIVE);
    server.send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(4) })));
    expect(store.online?.respondingName).toBeNull();
    expect(store.online?.respondingCard).toBeNull();
  });

  it('a hold met on resume shows no card, even when this page had sent a move before', async () => {
    const { store, server } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    await store.apply(1);
    // The socket came back: a fresh welcome ends anything in flight, then the hold.
    server.send({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' });
    server.send({ t: 'responding', by: 1 });
    expect(store.online?.respondingName).toBe('Blake');
    expect(store.online?.respondingCard).toBeNull();
  });

  it('connection trouble is a warning; the opponent being away is information', () => {
    const { store, server, env } = setup();
    server.open();
    server.send(stateFrame(aliceToAct()));
    expect(store.online?.statusTone).toBeNull();
    server.send({ t: 'presence', opponentOnline: false });
    expect(store.online?.statusText).toBe('Blake is offline.');
    expect(store.online?.statusTone).toBe('info');
    env.goOffline();
    expect(store.online?.statusText).toContain('offline. Online games need a connection');
    expect(store.online?.statusTone).toBe('warn');
  });
});
