// Issue #93 (SPEC §4.3, design §8 C1, C3, C4): counter rewind through the
// real wasm engine and the pass-and-play store.
//
//   C1  Twin games, identical except that Blake holds a 2: the curtain and
//       the saved curtain match after every move. Holding a 2 changes
//       nothing anyone sees until Blake plays it.
//   C3  The recap and result lines after a counter and after "Let it happen".
//   C4  Resume at a board where a counter is available, at a pending win, at
//       an owed discard; a v2 save restores and the next write is v3; a
//       legacy counter window (a v0.2.x save at phase 1) finishes through
//       the `ack` curtain.
//
// Positions are written with the tutorial's `positionSnapshot` (a v2 bridge
// snapshot), so every start here is also a v2 -> v3 migration.

import { describe, expect, it } from 'vitest';

import type { Card, Move } from '../../src/lib/bridge/schema';
import { MoveKind, Phase } from '../../src/lib/enums';
import { lastMoveLine, winningMoveLine } from '../../src/lib/recap';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { StagingStore } from '../../src/lib/stores/staging.svelte';
import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonPosition } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { fakeStorage, passResumeGate } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Blake'];

function tsSave(engineState: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    engineState,
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: NAMES,
    seed: '0',
    dealer: 1,
    ...extra,
  });
}

async function restoreFrom(raw: string, storage = fakeStorage()): Promise<{ store: GameStore; storage: Storage }> {
  storage.setItem(SNAPSHOT_KEY, raw);
  const store = new GameStore({ storage, session: new SessionStore() });
  await store.restore();
  expect(store.error).toBeNull();
  return { store, storage };
}

/** A lesson-style position, Alice to move, restored and past the resume gate. */
async function startAt(pos: LessonPosition): Promise<{ store: GameStore; storage: Storage }> {
  const started = await restoreFrom(tsSave(positionSnapshot(pos)));
  await passResumeGate(started.store);
  return started;
}

/** A fresh store from the save alone (a reload). */
async function reload(storage: Storage): Promise<GameStore> {
  const store = new GameStore({ storage, session: new SessionStore() });
  await store.restore();
  expect(store.error).toBeNull();
  return store;
}

function saved(storage: Storage): { v: number; curtain: CurtainState; inner: number } {
  const outer = JSON.parse(storage.getItem(SNAPSHOT_KEY)!);
  return { v: outer.v, curtain: outer.curtain, inner: JSON.parse(outer.engineState).v };
}

function sameCard(a: Card | null, b: Card): boolean {
  return a !== null && a.Rank === b.Rank && a.Suit === b.Suit;
}

function indexOf(store: GameStore, pred: (m: Move) => boolean, what: string): number {
  const i = store.legalMoves.findIndex(pred);
  if (i < 0) throw new Error(`no legal move: ${what}`);
  return i;
}

const isOneOff = (card: Card) => (m: Move) => m.Kind === MoveKind.OneOff && sameCard(m.Card, card);
const isPoints = (card: Card) => (m: Move) => m.Kind === MoveKind.PlayPoint && sameCard(m.Card, card);
const isCounter = (m: Move) => m.Kind === MoveKind.Counter;
const isDraw = (m: Move) => m.Kind === MoveKind.Draw;
const isPair = (m: Move) => m.Kind === MoveKind.DiscardPair;

/** Walks handoff -> reveal -> the board. */
async function pass(store: GameStore): Promise<void> {
  for (let i = 0; i < 4 && (store.curtain.kind === 'handoff' || store.curtain.kind === 'reveal'); i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}

// ---------------------------------------------------------------------------
// C1: twins
// ---------------------------------------------------------------------------

function twin(blakeHand: Card[]): LessonPosition {
  return {
    aliceHand: [c(5, 'H'), c(4, 'S'), c(10, 'D'), c(7, 'C')],
    alicePoints: [],
    blakeHand,
    blakePoints: [],
    scrap: [],
    // Every card drawn in the script below comes from these named tops, so the twins' decks agree.
    deckTop: [c(9, 'C'), c(9, 'D'), c(11, 'C'), c(11, 'D'), c(12, 'C'), c(12, 'D')],
  };
}

interface Step {
  label: string;
  curtain: CurtainState;
  saved: CurtainState;
  drawReveal: boolean;
}

async function playTwin(blakeHand: Card[]): Promise<{ steps: Step[]; blakeCounters: number[] }> {
  const { store, storage } = await startAt(twin(blakeHand));
  const steps: Step[] = [];
  const blakeCounters: number[] = [];
  const record = (label: string) =>
    steps.push({ label, curtain: store.curtain, saved: saved(storage).curtain, drawReveal: store.drawReveal !== null });

  // 1. Alice's 5: a one-off, so Blake's next turn could counter it.
  await store.apply(indexOf(store, isOneOff(c(5, 'H')), 'Alice 5♥'));
  record('Alice 5♥');
  store.dismissDrawReveal();
  record('draw reveal dismissed');
  await pass(store);
  record("Blake's board");
  blakeCounters.push(store.legalMoves.filter(isCounter).length);
  // 2. Blake lets it stand: he draws.
  await store.apply(indexOf(store, isDraw, 'Blake draws'));
  record('Blake draws');
  await pass(store);
  record("Alice's board");
  // 3. Alice's 4: Blake opens his turn owing 2.
  await store.apply(indexOf(store, isOneOff(c(4, 'S')), 'Alice 4♠'));
  record('Alice 4♠');
  await pass(store);
  record("Blake's owed discard");
  expect(store.view?.phase).toBe(Phase.AwaitingDiscard);
  blakeCounters.push(store.legalMoves.filter(isCounter).length);
  // 4. Blake pays and plays on in the same turn.
  await store.apply(indexOf(store, isPair, 'Blake pays'));
  record('Blake pays');
  await store.apply(indexOf(store, isDraw, 'Blake draws'));
  record('Blake draws again');
  await pass(store);
  // 5. Alice plays points.
  await store.apply(indexOf(store, isPoints(c(10, 'D')), 'Alice 10♦'));
  record('Alice 10♦');
  return { steps, blakeCounters };
}

describe('C1: holding a 2 changes no curtain (issue #93, SPEC §4.3)', () => {
  it('twin games, identical but for Blake\'s 2: the same curtains and saved curtains after every move', async () => {
    await createWasmEngine();
    const withTwo = await playTwin([c(2, 'C'), c(3, 'D'), c(8, 'S'), c(13, 'H')]);
    const withoutTwo = await playTwin([c(6, 'D'), c(3, 'D'), c(8, 'S'), c(13, 'H')]);
    // The 2 was live: Blake could have countered the 5 and the 4.
    expect(withTwo.blakeCounters).toEqual([1, 1]);
    expect(withoutTwo.blakeCounters).toEqual([0, 0]);
    expect(withTwo.steps).toEqual(withoutTwo.steps);
    // And the sequence is the new one: a turn handoff after a one-off, a discard handoff after a 4, no ack.
    expect(withTwo.steps.map((s) => s.saved)).toEqual([
      { kind: 'handoff', to: 1, reason: 'turn' },
      { kind: 'handoff', to: 1, reason: 'turn' },
      { kind: 'none' },
      { kind: 'handoff', to: 0, reason: 'turn' },
      { kind: 'none' },
      { kind: 'handoff', to: 1, reason: 'discard' },
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'handoff', to: 0, reason: 'turn' },
      { kind: 'handoff', to: 1, reason: 'turn' },
    ]);
    expect(withTwo.steps.some((s) => s.curtain.kind === 'ack' || s.saved.kind === 'ack')).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// C3 / C4: a pending win ("Not So Fast!")
// ---------------------------------------------------------------------------

function pendingWin(blakeHand: Card[]): LessonPosition {
  return {
    aliceHand: [c(7, 'C'), c(9, 'H')],
    alicePoints: [c(10, 'S'), c(3, 'S')],
    blakeHand,
    blakePoints: [],
    scrap: [],
    deckTop: [c(10, 'H'), c(4, 'D'), c(6, 'C')],
  };
}

/** Alice's 7 reveals 10♥ and she plays it for points: 23 of 21 on a counterable turn. */
async function winThroughSeven(store: GameStore): Promise<void> {
  await store.apply(indexOf(store, isOneOff(c(7, 'C')), 'Alice 7♣'));
  expect(store.view?.phase).toBe(Phase.SevenChoosing);
  const pick = indexOf(
    store,
    (m) => m.Kind === MoveKind.SevenPick && m.SubMove !== null && m.SubMove.Kind === MoveKind.PlayPoint && sameCard(m.Card, c(10, 'H')),
    '7 pick 10♥ for points',
  );
  await store.apply(pick);
}

describe('a pending win: "Not So Fast!", then "Let it happen" or a counter (issue #93, SPEC §4.3)', () => {
  it('Blake holds no 2: Alice wins at once, with no beat', async () => {
    await createWasmEngine();
    const { store } = await startAt(pendingWin([c(6, 'D'), c(5, 'D')]));
    await winThroughSeven(store);
    expect(store.curtain).toEqual({ kind: 'result' });
    expect(store.notSoFast).toBeNull();
    expect(store.view?.winner).toBe(0);
  });

  it('Blake holds a 2: the beat over Alice\'s board, the saved handoff to Blake, then his board with "Let it happen"', async () => {
    await createWasmEngine();
    const { store, storage } = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
    await winThroughSeven(store);

    // The beat: Alice's own board, no moves, the handoff already saved.
    expect(store.notSoFast).toEqual({ to: 0 });
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(0);
    expect(store.view?.phase).toBe(Phase.PendingWin);
    expect(store.legalMoves).toEqual([]);
    expect(saved(storage)).toEqual({ v: 3, curtain: { kind: 'handoff', to: 1, reason: 'turn' }, inner: 3 });
    await expect(store.apply(0)).rejects.toThrow(/Not So Fast/);

    store.dismissNotSoFast();
    expect(store.notSoFast).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.envelope).toBeNull();
    expect(store.history.some((h) => 'index' in h)).toBe(false);

    // C4: a reload during the handoff comes back to it, with no beat.
    const reloaded = await reload(storage);
    expect(reloaded.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(reloaded.notSoFast).toBeNull();

    await pass(reloaded);
    const view = reloaded.view!;
    expect(view.viewer).toBe(1);
    expect(view.phase).toBe(Phase.PendingWin);
    expect(view.counterable).toBe(true);
    expect(reloaded.legalMoves.map((m) => m.Kind)).toEqual([MoveKind.Counter, MoveKind.Decline]);
    expect(reloaded.envelope!.descriptions[1]).toBe('Let it happen');

    // C4: a reload at Blake's pending-win board resumes behind the gate, to the same board.
    const atBoard = await reload(storage);
    await passResumeGate(atBoard);
    expect(atBoard.legalMoves).toEqual(reloaded.legalMoves);

    // "Let it happen": one tap through the staging store.
    const staging = new StagingStore(
      () => ({
        legalMoves: atBoard.envelope!.legalMoves,
        descriptions: atBoard.envelope!.descriptions,
        handSize: atBoard.envelope!.state.you.hand.length,
        hand: atBoard.envelope!.state.you.hand,
      }),
      (i) => atBoard.apply(i),
    );
    expect(staging.letItHappen).toBe(true);
    expect(staging.dimmedHand).toEqual(new Set([1])); // the 5♦; the 2♣ can counter
    await staging.tap('let-it-happen');
    expect(atBoard.curtain).toEqual({ kind: 'result' });
    expect(atBoard.view?.winner).toBe(0);
    // C3: the Decline stays hidden; the result names the winning card.
    expect(winningMoveLine(atBoard.history, 0, NAMES, 23)).toBe('Alice won by reaching 23 with the 10♥, from the top of the deck.');
    expect(lastMoveLine(atBoard.history, 1, NAMES)).toBe('Alice revealed the top of the deck and played 10♥ for points.');
  }, 20_000);

  it('Blake counters instead: no curtain, his normal turn, and the rewind line for both players', async () => {
    await createWasmEngine();
    const { store } = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
    await winThroughSeven(store);
    store.dismissNotSoFast();
    await pass(store);
    await store.apply(indexOf(store, isCounter, 'Blake counters'));
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.viewer).toBe(1);
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    // The rewind: Alice's 7 and her 10♥ are gone from her points, her 7 to the scrap.
    expect(store.view?.opponent.points.map((p) => p.Card)).toEqual([c(10, 'S'), c(3, 'S')]);
    expect(store.view?.scrap.slice(-2)).toEqual([c(7, 'C'), c(2, 'C')]);
    // C3
    expect(lastMoveLine(store.history, 1, NAMES)).toBe("You countered with 2♣ and undid Alice's last turn.");
    expect(lastMoveLine(store.history, 0, NAMES)).toBe('Blake countered with 2♣ and undid your last turn.');
    // He plays on: a draw hands to Alice as usual.
    await store.apply(indexOf(store, isDraw, 'Blake draws'));
    expect(store.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'turn' });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// C4: an owed discard, and a board where a counter is available
// ---------------------------------------------------------------------------

function owed(): LessonPosition {
  return {
    aliceHand: [c(4, 'S'), c(9, 'H')],
    alicePoints: [],
    blakeHand: [c(2, 'C'), c(7, 'D'), c(13, 'C')],
    blakePoints: [],
    scrap: [],
    deckTop: [c(5, 'C'), c(6, 'C')],
  };
}

describe('C4: resume at an owed discard and at a counter (issue #93)', () => {
  it('after a 4: a discard handoff; Blake opens in phase 3 owing 2 with the Counter last; both resume', async () => {
    await createWasmEngine();
    const { store, storage } = await startAt(owed());
    await store.apply(indexOf(store, isOneOff(c(4, 'S')), 'Alice 4♠'));
    // The 4-player's own envelope already reads phase 3 with Blake owing.
    expect(saved(storage).curtain).toEqual({ kind: 'handoff', to: 1, reason: 'discard' });

    const atHandoff = await reload(storage);
    expect(atHandoff.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'discard' });
    await pass(atHandoff);
    const view = atHandoff.view!;
    expect(view.phase).toBe(Phase.AwaitingDiscard);
    expect(view.pending).toBeNull();
    expect(view.owedDiscards).toEqual({ you: 2, opponent: 0 });
    expect(view.counterable).toBe(true);
    const kinds = atHandoff.legalMoves.map((m) => m.Kind);
    expect(kinds.at(-1)).toBe(MoveKind.Counter);
    expect(kinds.filter((k) => k === MoveKind.DiscardPair)).toHaveLength(3);

    const atBoard = await reload(storage);
    await passResumeGate(atBoard);
    expect(atBoard.legalMoves).toEqual(atHandoff.legalMoves);
    expect(atBoard.view?.owedDiscards).toEqual({ you: 2, opponent: 0 });

    // Countering clears the debt: no curtain, Blake plays on in phase 0.
    await atBoard.apply(indexOf(atBoard, isCounter, 'Blake counters the 4'));
    expect(atBoard.curtain).toEqual({ kind: 'none' });
    expect(atBoard.view?.active).toBe(1);
    expect(atBoard.view?.phase).toBe(Phase.Normal);
    expect(atBoard.view?.owedDiscards).toEqual({ you: 0, opponent: 0 });
  }, 20_000);

  it('paying the debt keeps the turn: no curtain, phase 0, same player', async () => {
    await createWasmEngine();
    const { store } = await startAt(owed());
    await store.apply(indexOf(store, isOneOff(c(4, 'S')), 'Alice 4♠'));
    await pass(store);
    await store.apply(indexOf(store, isPair, 'Blake pays'));
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    expect(store.view?.owedDiscards.you).toBe(0);
    expect(store.legalMoves.some(isCounter)).toBe(false);
  }, 20_000);

  it('a board where a counter is available resumes with the counter still offered', async () => {
    await createWasmEngine();
    const { store, storage } = await startAt({ ...owed(), blakePoints: [c(8, 'H')] });
    await store.apply(indexOf(store, isOneOff(c(9, 'H')), 'Alice 9♥'));
    await pass(store);
    expect(store.view?.phase).toBe(Phase.Normal);
    const before = store.legalMoves;
    expect(before.at(-1)?.Kind).toBe(MoveKind.Counter);
    const resumed = await reload(storage);
    await passResumeGate(resumed);
    expect(resumed.view?.counterable).toBe(true);
    expect(resumed.legalMoves).toEqual(before);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// C4: a legacy counter window (v0.2.x save at phase 1)
// ---------------------------------------------------------------------------

describe('C4: a legacy v2 save at a counter window finishes through the ack curtain', () => {
  it('restores behind the resume gate to the ack, offers Decline and the Counter, and lets it resolve', async () => {
    await createWasmEngine();
    // Alice played 6♣ as a one-off; Blake, holding 2♣, is offered the counter.
    const pos: LessonPosition = {
      aliceHand: [c(9, 'H')],
      alicePoints: [],
      blakeHand: [c(2, 'C'), c(7, 'D')],
      blakePoints: [],
      scrap: [],
      deckTop: [c(6, 'C')],
    };
    const engine = JSON.parse(positionSnapshot(pos));
    engine.state.Deck = engine.state.Deck.slice(1); // 6♣ is in the pending one-off, not the deck
    engine.state.Active = 1;
    engine.state.Phase = 1;
    engine.state.Pending = { PlayedBy: 0, Card: c(6, 'C'), Target: null, ScrapIndex: 0, Revealed: null, CounterChain: null };
    const sixEntry = {
      by: 0,
      kind: MoveKind.OneOff,
      subKind: null,
      card: c(6, 'C'),
      targetCard: null,
      drawn: null,
      description: 'play 6♣ as one-off',
      seq: 1,
    };
    engine.history = [{ ...sixEntry, index: 2 }]; // the engine's snapshot holds unredacted history
    const raw = tsSave(JSON.stringify(engine), { viewer: 1, curtain: { kind: 'ack', to: 1 }, history: [sixEntry], lastSeenSeq: { 0: 1, 1: 0 } });

    const { store, storage } = await restoreFrom(raw);
    expect(store.notice).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'resume' });
    await passResumeGate(store);
    expect(store.curtain).toEqual({ kind: 'ack', to: 1 });
    expect(store.view?.phase).toBe(Phase.AwaitingCounter);
    expect(store.legalMoves.map((m) => m.Kind).sort()).toEqual([MoveKind.Counter, MoveKind.Decline]);

    await store.apply(indexOf(store, (m) => m.Kind === MoveKind.Decline, 'let it resolve'));
    expect(store.error).toBeNull();
    expect(store.curtain.kind === 'ack').toBe(false);
    expect(saved(storage).v).toBe(3);
    expect(saved(storage).inner).toBe(3);
  }, 20_000);
});
