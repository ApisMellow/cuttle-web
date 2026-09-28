// W19 — StagingStore corpus walk (strict tier: move wiring, SPEC §6.1–§6.5).
//
// Walks real games through the wasm engine for the committed smoke corpus
// (seeds 1–240, tests/smoke/corpus.json) and, at every position, drives a
// FRESH StagingStore by taps for every legal move index the staging pipeline
// owns: board target keys, `seven:<i>` roots, scrap picks (chosen by the scrap
// card the move takes), and discard toggles in BOTH orders. Each tap sequence
// must stage exactly that index. `Counter` and `Decline` are out of scope:
// they are staged by CounterPrompt, not this store.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import { apply as engineApply, newGame as engineNewGame, view as engineView } from '../../src/lib/bridge/engine';
import type { BridgeResult, Card, Envelope, Move } from '../../src/lib/bridge/schema';
import { MoveKind, Phase } from '../../src/lib/enums';
import { StagingStore, type StagingEnv } from '../../src/lib/stores/staging.svelte';
import type { TargetKey } from '../../src/lib/targetKey';
import { createWasmEngine } from '../scenario/wasm-engine';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.resolve(here, '../smoke/corpus.json'), 'utf8')) as {
  start: number;
  count: number;
};

const MAX_STEPS = 3_000;

function ok(result: BridgeResult): Envelope {
  if (!result.ok) throw new Error(`bridge call failed: ${result.code}: ${result.message}`);
  return result;
}

// Same PRNG as tests/smoke/bridge-smoke.mjs, so the walk replays the smoke games.
function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

async function neverApply(): Promise<void> {
  throw new Error('the corpus walk never confirms');
}

function envFor(envelope: Envelope): StagingEnv {
  const view = envelope.state;
  return {
    legalMoves: envelope.legalMoves,
    descriptions: envelope.descriptions,
    handSize: view.you.hand.length,
    hand: view.you.hand,
    revealed: view.phase === Phase.SevenChoosing && view.viewer === view.active ? view.sevenRevealed : null,
    scrap: view.scrap,
  };
}

function sameCard(a: Card | null, b: Card): boolean {
  return a !== null && a.Rank === b.Rank && a.Suit === b.Suit;
}

function scrapIndexOf(m: Move): number {
  return m.Kind === MoveKind.SevenPick && m.SubMove !== null ? m.SubMove.ScrapIndex : m.ScrapIndex;
}

/** After the root + target taps: resolve an open chooser or scrap-pick sheet the way a player would. */
function finishPick(store: StagingStore, index: number, m: Move): void {
  if (store.chooser) {
    // The chooser lists this index; the player taps its row.
    if (store.chooser.candidates.some((c) => c.index === index)) store.choose(index);
    return;
  }
  if (store.scrapPick) {
    // The player taps the scrap card the move takes, not a move index.
    const taken = scrapIndexOf(m);
    const candidate = store.scrapPick.candidates.find((c) => c.scrapIndex === taken);
    if (candidate) store.pickScrap(candidate.index);
  }
}

/** Every tap sequence that should stage `index`; each returns what it staged. */
function tapSequences(env: StagingEnv, index: number): Array<{ label: string; run: () => number | null }> {
  const m = env.legalMoves[index];
  const fresh = (): StagingStore => {
    const store = new StagingStore(() => env, neverApply);
    store.reset();
    return store;
  };
  switch (m.Kind) {
    case MoveKind.Draw:
    case MoveKind.Pass: {
      const key: TargetKey = m.Kind === MoveKind.Draw ? 'deck' : 'pass';
      return [
        {
          label: key,
          run: () => {
            const s = fresh();
            s.tap(key);
            finishPick(s, index, m);
            return s.stagedIndex;
          },
        },
      ];
    }
    case MoveKind.PlayPoint:
    case MoveKind.PlayPermanent:
    case MoveKind.Scuttle:
    case MoveKind.OneOff: {
      const target = boardTargetKey(m) as TargetKey;
      return [
        {
          label: `hand:${m.HandIndex} → ${target}`,
          run: () => {
            const s = fresh();
            s.tap(`hand:${m.HandIndex}`);
            s.tap(target);
            finishPick(s, index, m);
            return s.stagedIndex;
          },
        },
      ];
    }
    case MoveKind.SevenPick: {
      const revealed = env.revealed ?? [];
      const r = revealed.findIndex((c) => sameCard(m.Card, c));
      const target = boardTargetKey(m) as TargetKey;
      return [
        {
          label: `seven:${r} → ${target}`,
          run: () => {
            const s = fresh();
            s.tap(`seven:${r}`);
            s.tap(target);
            finishPick(s, index, m);
            return s.stagedIndex;
          },
        },
      ];
    }
    case MoveKind.DiscardPair: {
      if (m.DiscardB === -1) {
        return [{ label: 'one-card discard (pre-staged)', run: () => fresh().stagedIndex }];
      }
      const order = (a: number, b: number) => ({
        label: `hand:${a} then hand:${b}`,
        run: () => {
          const s = fresh();
          s.tap(`hand:${a}`);
          s.tap(`hand:${b}`);
          return s.stagedIndex;
        },
      });
      return [order(m.DiscardA, m.DiscardB), order(m.DiscardB, m.DiscardA)];
    }
    default:
      return []; // Counter, Decline: CounterPrompt's controls, not this store
  }
}

describe('StagingStore corpus walk (SPEC §6.1–§6.5, strict)', () => {
  it(
    `every staged legal move index is reachable by taps, and stages exactly that index (seeds ${corpus.start}–${corpus.start + corpus.count - 1})`,
    async () => {
      await createWasmEngine();
      const failures: string[] = [];
      const kindsSeen = new Set<number>();
      let discardOrders = 0;
      let scrapPicks = 0;
      let checked = 0;

      for (let seed = corpus.start; seed < corpus.start + corpus.count; seed++) {
        let envelope = ok(engineNewGame({ seed: String(seed), dealer: (seed & 1) as 0 | 1 }));
        const random = xorshift32(seed);
        for (let step = 0; step < MAX_STEPS && envelope.state.phase !== Phase.GameOver; step++) {
          if (envelope.legalMoves.length === 0) break;
          const env = envFor(envelope);
          env.legalMoves.forEach((m, index) => {
            for (const seq of tapSequences(env, index)) {
              checked++;
              kindsSeen.add(m.Kind);
              if (m.Kind === MoveKind.DiscardPair && m.DiscardB !== -1) discardOrders++;
              const staged = seq.run();
              if (staged !== index && failures.length < 20) {
                failures.push(
                  `seed ${seed} step ${step}: ${seq.label} for index ${index} (${env.descriptions[index]}) staged ${staged}`,
                );
              }
            }
            if (scrapIndexOf(m) > 0) scrapPicks++;
          });

          const applied = engineApply(random() % envelope.legalMoves.length);
          if (!applied.ok) break;
          envelope = ok(engineView(applied.state.active));
        }
      }

      expect(failures).toEqual([]);
      // Prove the walk exercised every path it claims to cover.
      for (const kind of [
        MoveKind.Draw,
        MoveKind.PlayPoint,
        MoveKind.PlayPermanent,
        MoveKind.Scuttle,
        MoveKind.OneOff,
        MoveKind.SevenPick,
        MoveKind.DiscardPair,
      ]) {
        expect(kindsSeen, `kind ${kind} never offered`).toContain(kind);
      }
      expect(discardOrders).toBeGreaterThan(0);
      expect(scrapPicks).toBeGreaterThan(0);
      expect(checked).toBeGreaterThan(10_000);
    },
    60_000,
  );
});
