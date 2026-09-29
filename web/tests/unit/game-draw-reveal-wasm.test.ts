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
      // With reloads a before-the-pass draw can be shown again at the
      // drawer's next board (SPEC §4.7 restore rule), so keep it to compare.
      if (reloadEvery === null) expected[p] = null;
      store.dismissDrawReveal();
      continue;
    }
    // A draw that was due must have been shown by the drawer's first own view.
    if ((curtain.kind === 'none' || curtain.kind === 'ack') && store.viewer !== null && reloadEvery === null) {
      expect(expected[store.viewer], `seed ${seed} ply ${ply}: P${store.viewer}'s board with an unshown draw`).toBeNull();
    }

    const looking = curtain.kind === 'none' || (curtain.kind === 'ack' && !curtain.synthetic);
    if (!looking) {
      await store.advanceCurtain();
      continue;
    }
    const env = store.envelope;
    if (env === null || env.state.viewer !== env.state.active || env.legalMoves.length === 0) break;
    await store.apply(choose(env.legalMoves, rand));
    steps++;

    const mv = store.history.at(-1);
    if (mv !== undefined && mv.drawn !== null && mv.drawn > 0) {
      const drawer = (mv.kind === Kind.Decline ? 1 - mv.by : mv.kind === Kind.Counter ? mv.by : mv.by) as PlayerId;
      if (mv.kind === Kind.Decline) tally.resolvedByDecline++;
      if (mv.kind === Kind.Counter) tally.resolvedByCounter++;
      const peek = bridgeView(drawer);
      if (!peek.ok) throw new Error('peek failed');
      expected[drawer] = { seq: mv.seq, cards: peek.state.you.hand.slice(-mv.drawn) };
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
    const tally: Tally = { reveals: 0, beforePass: 0, atNextBoard: 0, frozenTailSkipped: 0, oneCard: 0, resolvedByCounter: 0, resolvedByDecline: 0, unrevealedAtEnd: 0, atAck: 0 };
    for (let seed = 1; seed <= 60; seed++) await playSeed(seed, tally, null);
    report('seeds 1-60', tally);
    // The property must actually have been exercised, on each path.
    expect(tally.reveals).toBeGreaterThan(40);
    expect(tally.beforePass).toBeGreaterThan(0);
    expect(tally.atNextBoard).toBeGreaterThan(0);
    expect(tally.resolvedByCounter).toBeGreaterThan(0);
    expect(tally.resolvedByDecline).toBeGreaterThan(0);
    expect(tally.atAck).toBeGreaterThan(0);
    expect(tally.frozenTailSkipped).toBeGreaterThan(0);
    expect(tally.oneCard).toBeGreaterThan(0);
  }, 60_000);

  it('seeds 61-100 with a reload every few moves: a reveal is never wrong and never on the wrong screen', async () => {
    await createWasmEngine();
    const tally: Tally = { reveals: 0, beforePass: 0, atNextBoard: 0, frozenTailSkipped: 0, oneCard: 0, resolvedByCounter: 0, resolvedByDecline: 0, unrevealedAtEnd: 0, atAck: 0 };
    for (let seed = 61; seed <= 100; seed++) await playSeed(seed, tally, 3);
    report('seeds 61-100, reloads', tally);
    expect(tally.reveals).toBeGreaterThan(20);
  }, 60_000);
});
