// Resume gate (SPEC §5.7 "Resume always raises a curtain", ruling 2026-09-29;
// §4.3 R14). Strict tier: hidden-information privacy and save/resume.
//
// Playtest finding: after a reload, or Menu -> Home -> Resume, the app went
// straight to the persisted viewer's live board, or to an open counter
// prompt, with no "I'm NAME" gate. Whoever tapped Resume saw that hand, or
// whether that player held a 2.
//
// Ruling: a restore into a resting curtain (`none`, or an `ack`, real or
// synthetic) first raises a resume gate addressed to the persisted viewer:
// `handoff` with reason `resume` -> `reveal` -> the persisted resting curtain.
// Nothing view-bearing is held until the gate is passed; the view is then
// fetched fresh with `engine.view`. The gate is never written to the save
// (the save already holds the resting position), so a reload during the gate
// comes back to the gate. The gate is the same for every resting kind, so a
// real counter window and a synthetic ack resume behind identical curtains.
// `result` is public (no hand renders, SPEC §5.2) and is not gated.

import { describe, expect, it, vi } from 'vitest';

import type { Envelope, PlayerId } from '../../src/lib/bridge/schema';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY, type Snapshot, decodeSnapshot, encodeSnapshot } from '../../src/lib/stores/snapshot';
import { Kind, Phase, appliedMove, createFakeEngine, envelope, fakeStorage, playerView } from './game-test-support';

const SECRET = { Rank: 13, Suit: 3 } as const;
const TWO = { Rank: 2, Suit: 1 } as const;
const DECLINE_MOVE = { Kind: Kind.Decline, Card: null, HandIndex: -1, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null };
const COUNTER_MOVE = { ...DECLINE_MOVE, Kind: Kind.Counter, Card: TWO, HandIndex: 1 };

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    v: 2,
    savedAt: '2026-09-29T00:00:00.000Z',
    engineState: '"opaque-blob"',
    history: [],
    lastSeenSeq: { 0: 1, 1: 1 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Blake'],
    seed: '42',
    dealer: 1,
    ...overrides,
  };
}

/** Blake (1) played 9♣ as a one-off at seq 1; the viewer's own entry carries its mover-only index. */
function oneOffBy(by: PlayerId) {
  return appliedMove({ by, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 }, index: 2 });
}

/** The viewer's envelope: a secret hand, and at a real window a Counter option. */
function viewerEnvelope(viewer: PlayerId, opts: { phase: number; active: PlayerId; counter?: boolean; history: Envelope['history'] }): Envelope {
  const legalMoves = opts.counter ? [DECLINE_MOVE, COUNTER_MOVE] : [DECLINE_MOVE];
  return envelope({
    state: playerView({
      viewer,
      active: opts.active,
      phase: opts.phase as 0 | 1 | 2 | 3 | 4,
      you: { hand: [SECRET, ...(opts.counter ? [TWO] : [])], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 4, hand: null, points: [], permanents: [] },
    }),
    legalMoves,
    descriptions: legalMoves.map((m) => (m.Kind === Kind.Counter ? 'counter with 2♦' : 'decline')),
    history: opts.history,
    seq: 1,
  });
}

interface Setup {
  store: GameStore;
  engine: ReturnType<typeof createFakeEngine>;
  storage: Storage;
  writes: () => number;
}

function setup(snap: Snapshot, env: Envelope, extra: Parameters<typeof createFakeEngine>[0] = {}): Setup {
  const storage = fakeStorage();
  storage.setItem(SNAPSHOT_KEY, encodeSnapshot(snap));
  let writes = 0;
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (k: string, v: string) => {
    writes++;
    setItem(k, v);
  };
  const engine = createFakeEngine({ restore: vi.fn(() => env), view: vi.fn(() => env), ...extra });
  return { store: new GameStore({ engine, storage, session: new SessionStore() }), engine, storage, writes: () => writes };
}

/** Nothing view-bearing is reachable from the store's public fields. */
function expectNothingExposed(store: GameStore): void {
  expect(store.envelope).toBeNull();
  expect(store.view).toBeNull();
  expect(store.viewer).toBeNull();
  expect(store.legalMoves).toEqual([]);
  expect(store.isViewerActive).toBe(false);
  const reachable = JSON.stringify([store.history, store.curtain, store.recapFor(0), store.recapFor(1)]);
  expect(reachable).not.toContain(JSON.stringify(SECRET));
  expect(reachable).not.toContain('"index"');
}

const resumeGate = (to: PlayerId): CurtainState => ({ kind: 'handoff', to, reason: 'resume' });

describe('Resume at the live board raises a gate for the persisted viewer (both viewers)', () => {
  for (const viewer of [0, 1] as const) {
    it(`viewer ${viewer}: handoff(resume) -> reveal -> none; the view is fetched only after the gate`, async () => {
      const history = [oneOffBy(viewer)];
      const env = viewerEnvelope(viewer, { phase: Phase.Normal, active: viewer, history });
      const { store, engine, storage, writes } = setup(snapshot({ viewer, history }), env);
      const saved = storage.getItem(SNAPSHOT_KEY);

      await store.restore();
      expect(store.screen).toBe('game');
      expect(store.curtain).toEqual(resumeGate(viewer));
      expectNothingExposed(store);
      expect(engine.view).not.toHaveBeenCalled();

      await store.advanceCurtain();
      expect(store.curtain).toEqual({ kind: 'reveal', to: viewer });
      expectNothingExposed(store);
      expect(engine.view).not.toHaveBeenCalled();

      await store.advanceCurtain();
      expect(store.curtain).toEqual({ kind: 'none' });
      expect(engine.view).toHaveBeenCalledTimes(1);
      expect(engine.view).toHaveBeenCalledWith(viewer);
      expect(store.viewer).toBe(viewer);
      expect(store.view?.you.hand).toEqual([SECRET]);
      // The gate writes nothing: the save already holds this exact position.
      expect(writes()).toBe(0);
      expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);
      // No recap on resume: the resting position had already been seen.
      await expect(store.advanceCurtain()).rejects.toThrow();
    });
  }
});

describe('Resume at a counter window: the gate is identical for a real window and a synthetic ack (R14)', () => {
  // Blake (1) played the 9; Alice (0) is the responder.
  const history = [oneOffBy(1)];

  async function atGate(synthetic: boolean) {
    const env = synthetic
      ? viewerEnvelope(0, { phase: Phase.Normal, active: 0, history })
      : viewerEnvelope(0, { phase: Phase.AwaitingCounter, active: 0, counter: true, history });
    const s = setup(snapshot({ viewer: 0, curtain: { kind: 'ack', to: 0, synthetic }, history, lastSeenSeq: { 0: 1, 1: 1 } }), env);
    await s.store.restore();
    return s;
  }

  it('real window: gate first, then the window with its Counter option, and apply() works', async () => {
    const { store, engine } = await atGate(false);
    expect(store.curtain).toEqual(resumeGate(0));
    expectNothingExposed(store);
    // No move can be submitted from behind the gate.
    await expect(store.apply(0)).rejects.toThrow();
    expect(engine.apply).not.toHaveBeenCalled();

    await store.advanceCurtain();
    expectNothingExposed(store);
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: false });
    expect(store.legalMoves.some((m) => m.Kind === Kind.Counter)).toBe(true);
    expect(store.isViewerActive).toBe(true);
  });

  it('synthetic ack: gate first, then the ack, which advances on to the board', async () => {
    const { store } = await atGate(true);
    expect(store.curtain).toEqual(resumeGate(0));
    expectNothingExposed(store);
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: true });
    await store.advanceCurtain(); // post.active (0) is the acknowledger -> none
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
  });

  it('the gate and its reveal are the same state on both paths, and the same as a board resume for that player', async () => {
    const real = await atGate(false);
    const synthetic = await atGate(true);
    const board = setup(snapshot({ viewer: 0, history }), viewerEnvelope(0, { phase: Phase.Normal, active: 0, history }));
    await board.store.restore();
    const states = [real.store, synthetic.store, board.store].map((s) => JSON.stringify([s.curtain, s.envelope, s.viewer, s.history, s.legalMoves]));
    expect(new Set(states).size).toBe(1);
    for (const s of [real.store, synthetic.store, board.store]) await s.advanceCurtain();
    const reveals = [real.store, synthetic.store, board.store].map((s) => JSON.stringify([s.curtain, s.envelope, s.viewer, s.history]));
    expect(new Set(reveals).size).toBe(1);
  });
});

describe('Resume at result is not gated (the result screen is public)', () => {
  it('result: the final view is exposed at once, with no gate', async () => {
    const history = [oneOffBy(0)];
    const env = envelope({ state: playerView({ viewer: 0, active: 0, phase: Phase.GameOver, winner: 0 }), history });
    const { store } = setup(snapshot({ viewer: 0, curtain: { kind: 'result' }, history }), env);
    await store.restore();
    expect(store.curtain).toEqual({ kind: 'result' });
    expect(store.view?.winner).toBe(0);
  });
});

describe('The gate is never saved: reload, Home and New game during the gate', () => {
  const history = [oneOffBy(1)];
  const env = viewerEnvelope(1, { phase: Phase.Normal, active: 1, history });

  it('a reload at the gate or its reveal comes back to the gate, never to the board', async () => {
    const { store, storage } = setup(snapshot({ viewer: 1, history }), env);
    await store.restore();
    await store.advanceCurtain(); // gate -> reveal
    const reloaded = new GameStore({ engine: createFakeEngine({ restore: () => env, view: () => env }), storage, session: new SessionStore() });
    await reloaded.restore();
    expect(reloaded.curtain).toEqual(resumeGate(1));
    expectNothingExposed(reloaded);
  });

  it('Home at the gate, then Resume, raises the gate again', async () => {
    const { store, storage } = setup(snapshot({ viewer: 1, history }), env);
    await store.restore();
    const saved = storage.getItem(SNAPSHOT_KEY);
    store.goHome();
    await store.restore();
    expect(store.curtain).toEqual(resumeGate(1));
    expectNothingExposed(store);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(saved);
  });

  it('Home at the gate drops the pending resume: nothing can be advanced from the home screen', async () => {
    const { store, engine } = setup(snapshot({ viewer: 1, history }), env);
    await store.restore();
    await store.advanceCurtain();
    store.goHome();
    // No resume gate and no curtain context survive Home: the store reports
    // that there is nothing to advance (a kept gate would throw "resume gate").
    await expect(store.advanceCurtain()).rejects.toThrow(/no pending curtain context/);
    expect(engine.view).not.toHaveBeenCalled();
  });

  it('New game over the gate walks the new opening curtain, not the old resume target', async () => {
    const deal = envelope({ state: playerView({ viewer: 0, active: 0 }) });
    const { store, engine, storage } = setup(snapshot({ viewer: 1, history }), env, { newGame: () => deal });
    await store.restore();
    await store.newGame({ seed: '7' });
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'turn' });
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });
    (engine.view as ReturnType<typeof vi.fn>).mockImplementation(() => deal);
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    // The opening curtain's own step into 'none' runs: it stamps and saves.
    const saved = JSON.parse(storage.getItem(SNAPSHOT_KEY) as string);
    expect(saved.curtain).toEqual({ kind: 'none' });
    expect(saved.seed).toBe('7');
    expect(store.lastSeenSeq[0]).toBe(deal.seq);
  });

  it('a save naming the resume reason is not a save this app writes: it decodes as malformed', () => {
    const raw = encodeSnapshot(snapshot({ viewer: 1, history, curtain: resumeGate(1) }));
    expect(decodeSnapshot(raw)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('A failed fetch at the gate keeps the gate, and a retry passes it', () => {
  it('view fails once: error set, still at reveal, nothing exposed; the retry reaches the board', async () => {
    const history = [oneOffBy(0)];
    const env = viewerEnvelope(0, { phase: Phase.Normal, active: 0, history });
    const view = vi.fn().mockReturnValueOnce({ ok: false, code: 'INTERNAL', message: 'boom' }).mockReturnValue(env);
    const { store } = setup(snapshot({ viewer: 0, history }), env, { view });
    await store.restore();
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(store.error?.code).toBe('INTERNAL');
    expect(store.curtain).toEqual({ kind: 'reveal', to: 0 });
    expectNothingExposed(store);

    await store.advanceCurtain();
    expect(store.error).toBeNull();
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.you.hand).toEqual([SECRET]);
  });
});

// Review B1: the saved ack's addressee is not the engine's Active player.
// A cancelled counter chain leaves Active on the counterer (engine v0.2.0
// apply.go resolvePending: Active = PlayedBy, then endTurn), and a 7 leaves
// Active on the actor (resolveOneOffWith, case Seven). The gate, the fetched
// view and the viewer must all be the addressee's, never the active player's.
describe('Resume at a synthetic ack whose addressee is not the engine Active player', () => {
  const HAND: Record<PlayerId, { Rank: 13 | 12; Suit: 3 | 2 }> = { 0: { Rank: 13, Suit: 3 }, 1: { Rank: 12, Suit: 2 } };

  function envFor(viewer: PlayerId, active: PlayerId, phase: number, history: ReturnType<typeof appliedMove>[]): Envelope {
    return envelope({
      state: playerView({
        viewer,
        active,
        phase: phase as 0 | 1 | 2 | 3 | 4,
        you: { hand: [HAND[viewer]], frozenHandIndices: [], points: [], permanents: [], watched: false },
        opponent: { handCount: 1, hand: null, points: [], permanents: [] },
      }),
      history,
      seq: history.length,
    });
  }

  function run(active: PlayerId, phase: number, history: ReturnType<typeof appliedMove>[]) {
    const storage = fakeStorage();
    storage.setItem(
      SNAPSHOT_KEY,
      encodeSnapshot(snapshot({ history, viewer: 0, curtain: { kind: 'ack', to: 0, synthetic: true }, lastSeenSeq: { 0: history.length, 1: history.length } })),
    );
    const engine = createFakeEngine({
      restore: vi.fn((_s: string, v: PlayerId) => envFor(v, active, phase, history)),
      view: vi.fn((p: PlayerId) => envFor(p, active, phase, history)),
    });
    return { store: new GameStore({ engine, storage, session: new SessionStore() }), engine };
  }

  async function passGateAsAlice(store: GameStore, engine: ReturnType<typeof createFakeEngine>): Promise<void> {
    await store.restore();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'resume' });
    await store.advanceCurtain();
    await store.advanceCurtain();
    expect(engine.view).toHaveBeenCalledTimes(1);
    expect(engine.view).toHaveBeenCalledWith(0);
    expect(store.viewer).toBe(0);
    expect(store.view?.viewer).toBe(0);
    expect(store.view?.you.hand).toEqual([HAND[0]]);
    expect(JSON.stringify(store.envelope)).not.toContain(JSON.stringify(HAND[1]));
    expect(store.curtain).toEqual({ kind: 'ack', to: 0, synthetic: true });
  }

  it('cancelled chain: Alice played, Blake countered, Alice (no 2) acknowledges; Active is Blake', async () => {
    const history = [
      appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: { Rank: 5, Suit: 0 } }),
      appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: { Rank: 2, Suit: 0 } }),
    ];
    const { store, engine } = run(1, Phase.Normal, history);
    await passGateAsAlice(store, engine);
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
  });

  it('a 7 by Blake, Alice acknowledges; Active is Blake at SevenChoosing', async () => {
    const history = [appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 7, Suit: 0 } })];
    const { store, engine } = run(1, Phase.SevenChoosing, history);
    await passGateAsAlice(store, engine);
    await store.advanceCurtain();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'seven-return' });
    expect(store.envelope).toBeNull();
  });
});
