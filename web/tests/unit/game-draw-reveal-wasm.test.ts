// Issue #27 (SPEC §4.7) through the REAL WASM bridge: the store's draw
// reveal names exactly the cards the engine drew, only on the drawer's own
// board, once, across many seeded games. The expected cards are captured
// straight from the bridge at the apply that resolved the 5 (engine v0.2.0
// `resolveOneOffWith` case Five appends them to the drawer's hand), by a
// test-side `view(drawer)` peek that the store never sees.
//
// The walk plays every 5 it can (and every 9, so a returned card lands
// after a draw), lets every counter window resolve most of the time, and
// counters now and then so even chains resolve on a Counter.
//
// Ruling 2026-09-29 (SPEC §4.3, closes #23): a one-off takes effect at once
// unless the responder holds a legal 2. The walk also checks, at every
// step, that the store never shows a responder an ack without a counter to
// play, and that a 5 resolved by the drawer's own move shows before the
// pass while one resolved by the opponent's Decline waits for the drawer's
// next own view.

import { describe, expect, it } from 'vitest';

import type { Card, Move, PlayerId } from '../../src/lib/bridge/schema';
import { view as bridgeView } from '../../src/lib/bridge/engine';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, fakeStorage } from './game-test-support';

interface Expected {
  seq: number;
  cards: Card[];
}

interface Tally {
  reveals: number;
  beforePass: number;
  atNextBoard: number;
  frozenTailSkipped: number;
  oneCard: number;
  resolvedByCounter: number;
  resolvedByDecline: number;
  unrevealedAtEnd: number;
  atAck: number;
  /** Real counter windows reached (each must offer at least one Counter). */
  acks: number;
  /** Counterable moves that opened no window (no ack may follow). */
  noWindowOneOffs: number;
  /** 5s resolved by the drawer's own apply (must reveal before the pass). */
  ownMoveDraws: number;
  /** 5s resolved while the opponent held the phone (must reveal later). */
  deferredDraws: number;
}

function newTally(): Tally {
  return {
    reveals: 0,
    beforePass: 0,
    atNextBoard: 0,
    frozenTailSkipped: 0,
    oneCard: 0,
    resolvedByCounter: 0,
    resolvedByDecline: 0,
    unrevealedAtEnd: 0,
    atAck: 0,
    acks: 0,
    noWindowOneOffs: 0,
    ownMoveDraws: 0,
    deferredDraws: 0,
  };
}

function isCounterable(kind: number, subKind: number | null): boolean {
  return kind === Kind.OneOff || kind === Kind.Counter || (kind === Kind.SevenPick && subKind === Kind.OneOff);
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function choose(moves: Move[], rand: () => number): number {
  const find = (pred: (m: Move) => boolean) => moves.findIndex(pred);
  const five = find((m) => m.Kind === Kind.OneOff && m.Card?.Rank === 5);
  if (five >= 0) return five;
  const sevenFive = find((m) => m.Kind === Kind.SevenPick && m.Card?.Rank === 5 && m.SubMove?.Kind === Kind.OneOff);
  if (sevenFive >= 0) return sevenFive;
  const nine = find((m) => m.Kind === Kind.OneOff && m.Card?.Rank === 9);
  if (nine >= 0 && rand() < 0.7) return nine;
  const counter = find((m) => m.Kind === Kind.Counter);
  const decline = find((m) => m.Kind === Kind.Decline);
  if (decline >= 0) return counter >= 0 && rand() < 0.3 ? counter : decline;
  return Math.floor(rand() * moves.length);
}

function cardsAt(hand: Card[], indices: number[]): Card[] {
  return indices.map((i) => hand[i]);
}

async function playSeed(seed: number, tally: Tally, reloadEvery: number | null): Promise<void> {
  const storage = fakeStorage();
  let store = new GameStore({ storage, session: new SessionStore() });
  await store.newGame({ seed: String(seed) });
  const rand = lcg(seed * 7919);
  const expected: Record<PlayerId, Expected | null> = { 0: null, 1: null };
  let steps = 0;

  for (let ply = 0; ply < 600; ply++) {
    if (store.error !== null) break;
    const curtain = store.curtain;
    if (curtain.kind === 'result') break;

    // Privacy at every step: a reveal exists only on its own drawer's board.
    if (store.drawReveal !== null) {
      expect(['none', 'ack']).toContain(curtain.kind);
      if (curtain.kind === 'ack') tally.atAck++;
      expect(store.viewer).toBe(store.drawReveal.to);
      expect(store.envelope?.state.viewer).toBe(store.drawReveal.to);
      const p = store.drawReveal.to;
      const exp = expected[p];
      expect(exp, `seed ${seed}: a reveal for P${p} with no draw behind it`).not.toBeNull();
      const shown = cardsAt(store.envelope!.state.you.hand, store.drawReveal.indices);
      expect(shown, `seed ${seed} ply ${ply}: wrong cards revealed`).toEqual(exp!.cards);
      tally.reveals++;
      if (store.drawReveal.beforePass) {
        // Before the pass: the mover's own apply, the turn already gone.
        expect(curtain.kind).toBe('none');
        expect(store.legalMoves.length).toBe(0);
        tally.beforePass++;
      } else if (curtain.kind === 'none') tally.atNextBoard++;
      if (shown.length === 1) tally.oneCard++;
      const frozen = store.envelope!.state.you.frozenHandIndices;
      if (frozen.includes(store.envelope!.state.you.hand.length - 1) && store.envelope!.state.phase === 0) tally.frozenTailSkipped++;
      expected[p] = null;
      store.dismissDrawReveal();
      continue;
    }
    // A draw that was due must have been shown by the drawer's first own view.
    if ((curtain.kind === 'none' || curtain.kind === 'ack') && store.viewer !== null) {
      expect(expected[store.viewer], `seed ${seed} ply ${ply}: P${store.viewer}'s board with an unshown draw`).toBeNull();
    }

    // Ruling 2026-09-29 (SPEC §4.3): no "acknowledge" step exists any more.
    if (curtain.kind === 'handoff') {
      expect(curtain.reason as string, `seed ${seed} ply ${ply}: an acknowledge handoff`).not.toBe('acknowledge');
    }
    if (curtain.kind === 'ack') {
      // An ack is only ever the real counter window: the responder holds a
      // legal 2, so the engine offers at least one Counter.
      tally.acks++;
      const ackEnv = store.envelope;
      expect(ackEnv, `seed ${seed} ply ${ply}: an ack with no view`).not.toBeNull();
      expect(ackEnv!.state.phase, `seed ${seed} ply ${ply}: an ack outside a counter window`).toBe(1);
      expect(
        ackEnv!.legalMoves.some((m) => m.Kind === Kind.Counter),
        `seed ${seed} ply ${ply}: an ack for a responder with no 2`,
      ).toBe(true);
    }

    const looking = curtain.kind === 'none' || curtain.kind === 'ack';
    if (!looking) {
      await store.advanceCurtain();
      continue;
    }
    const env = store.envelope;
    if (env === null || env.state.viewer !== env.state.active || env.legalMoves.length === 0) break;
    await store.apply(choose(env.legalMoves, rand));
    steps++;

    const mv = store.history.at(-1);
    if (mv !== undefined && isCounterable(mv.kind, mv.subKind) && store.curtain.kind !== 'result') {
      // SPEC §4.3: with no window opened the one-off has already resolved;
      // nothing may stage an ack for it.
      const peekActive = bridgeView(mv.by);
      if (!peekActive.ok) throw new Error('peek failed');
      if (peekActive.state.phase !== 1) {
        tally.noWindowOneOffs++;
        const next = store.curtain;
        if (next.kind === 'handoff') expect(next.reason as string).not.toBe('acknowledge');
        expect(next.kind).not.toBe('ack');
      }
    }
    if (mv !== undefined && mv.drawn !== null && mv.drawn > 0) {
      const drawer = (mv.kind === Kind.Decline ? 1 - mv.by : mv.by) as PlayerId;
      if (mv.kind === Kind.Decline) tally.resolvedByDecline++;
      if (mv.kind === Kind.Counter) tally.resolvedByCounter++;
      const peek = bridgeView(drawer);
      if (!peek.ok) throw new Error('peek failed');
      expected[drawer] = { seq: mv.seq, cards: peek.state.you.hand.slice(-mv.drawn) };
      if (drawer === mv.by) {
        // The 5 resolved on the drawer's own move (no window, or their own
        // Counter closed the chain): the reveal comes now, before the pass.
        tally.ownMoveDraws++;
        expect(store.drawReveal, `seed ${seed} ply ${ply}: no reveal before the pass`).not.toBeNull();
        expect(store.drawReveal!.beforePass).toBe(true);
        expect(store.drawReveal!.to).toBe(drawer);
      } else {
        // The opponent let it resolve and holds the phone: nothing now.
        tally.deferredDraws++;
        expect(store.drawReveal, `seed ${seed} ply ${ply}: a reveal on the opponent's screen`).toBeNull();
      }
    }

    if (reloadEvery !== null && steps % reloadEvery === 0 && store.drawReveal === null) {
      // A reload: a fresh store from the save alone. The bridge keeps its
      // state, as the page's own module would after restore().
      const reloaded = new GameStore({ storage, session: new SessionStore() });
      await reloaded.restore();
      expect(reloaded.drawReveal).toBeNull();
      expect(storage.getItem(SNAPSHOT_KEY)).not.toBeNull();
      store = reloaded;
    }
  }
  for (const p of [0, 1] as const) if (expected[p] !== null) tally.unrevealedAtEnd++;
}

function report(label: string, tally: Tally): void {
  console.info(`[draw-reveal wasm] ${label}: ${JSON.stringify(tally)}`);
}

describe('SPEC §4.7 draw reveal against the real engine', () => {
  it('seeds 1-60: every reveal names exactly the drawn cards, on the drawer\'s own screen, once', async () => {
    await createWasmEngine();
    const tally = newTally();
    for (let seed = 1; seed <= 60; seed++) await playSeed(seed, tally, null);
    report('seeds 1-60', tally);
    // The property must actually have been exercised, on each path.
    expect(tally.reveals).toBeGreaterThan(40);
    expect(tally.beforePass).toBeGreaterThan(0);
    expect(tally.atNextBoard).toBeGreaterThan(0);
    expect(tally.resolvedByCounter).toBeGreaterThan(0);
    expect(tally.resolvedByDecline).toBeGreaterThan(0);
    expect(tally.atAck).toBeGreaterThan(0);
    // `frozenTailSkipped` is reported, not required: since the 2026-09-29
    // ruling a draw waits for the drawer's next view only after the
    // opponent's Decline, and a 9 landing in between did not occur in 400
    // seeds. The skip is pinned by draw-reveal.test.ts and
    // game-draw-reveal.test.ts; every reveal here still names the exact
    // drawn cards.
    expect(tally.oneCard).toBeGreaterThan(0);
    expect(tally.acks).toBeGreaterThan(0);
    expect(tally.noWindowOneOffs).toBeGreaterThan(0);
    expect(tally.ownMoveDraws).toBeGreaterThan(0);
    expect(tally.deferredDraws).toBeGreaterThan(0);
    // Every draw resolved on the drawer's own move showed before the pass.
    expect(tally.beforePass).toBe(tally.ownMoveDraws);
  }, 60_000);

  it('seeds 61-100 with a reload every few moves: a reveal is never wrong and never on the wrong screen', async () => {
    await createWasmEngine();
    const tally = newTally();
    for (let seed = 61; seed <= 100; seed++) await playSeed(seed, tally, 3);
    report('seeds 61-100, reloads', tally);
    expect(tally.reveals).toBeGreaterThan(20);
  }, 60_000);
});
