// SPEC §5.7 (orchestrator ruling 2026-09-28): a v1 save — written before
// AppliedMove gained `drawn` (SPEC §2.7) — is migrated to v2 on restore, not
// discarded, so family-beta games survive the upgrade. The engine state
// layout is unchanged; v2 only adds `drawn` to history entries.
//
// Two kinds of v1 input, both through the real WASM bridge:
//   1. A genuine v1 engine snapshot, produced by the base commit's bridge
//      (bce9fb2) and committed at internal/wasm/testdata/snapshot-v1-bce9fb2.json
//      (seed "2", dealer 0: Blake's 5, Alice's decline, Alice's draw), wrapped
//      in the v1 TS Snapshot the store wrote then (same shape as v2, v: 1).
//   2. Live saves captured at every curtain kind, then written back in v1
//      form (v: 1 outside and inside the engine state, no `drawn` keys): the
//      restored store must match a v2 restore of the same save exactly, and
//      its next write must be v2.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, fakeStorage, passResumeGate } from './game-test-support';

const FIXTURE = join(__dirname, '..', '..', '..', 'internal', 'wasm', 'testdata', 'snapshot-v1-bce9fb2.json');

function stripDrawn(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e: Record<string, unknown>) => {
    const copy = { ...e };
    delete copy.drawn;
    return copy;
  });
}

/** A v2 persisted save rewritten exactly as the v1 code wrote it. */
function toV1(raw: string): string {
  const outer = JSON.parse(raw);
  const inner = JSON.parse(outer.engineState);
  inner.v = 1;
  inner.history = stripDrawn(inner.history);
  outer.v = 1;
  outer.engineState = JSON.stringify(inner);
  outer.history = stripDrawn(outer.history);
  if (outer.curtain.kind === 'recap') outer.curtain.entries = stripDrawn(outer.curtain.entries);
  return JSON.stringify(outer);
}

async function restoreFrom(raw: string): Promise<{ store: GameStore; storage: Storage }> {
  const storage = fakeStorage();
  storage.setItem(SNAPSHOT_KEY, raw);
  const store = new GameStore({ storage, session: new SessionStore() });
  await store.restore();
  return { store, storage };
}

/** One step onward from a restored state: through the curtain, or a decline at a real counter window. */
async function stepOn(store: GameStore): Promise<void> {
  const c = store.curtain;
  if (c.kind === 'ack' && !c.synthetic) {
    const decline = store.envelope!.legalMoves.findIndex((m) => m.Kind === Kind.Decline);
    await store.apply(decline);
  } else if (c.kind !== 'none' && c.kind !== 'result') {
    await store.advanceCurtain();
  } else if (c.kind === 'none') {
    await store.apply(0);
  }
}

function persisted(storage: Storage): { v: number; inner: number } {
  const outer = JSON.parse(storage.getItem(SNAPSHOT_KEY)!);
  return { v: outer.v, inner: JSON.parse(outer.engineState).v };
}

describe('v1 -> v2 snapshot migration (SPEC §5.7, ruling 2026-09-28)', () => {
  it('a genuine base-commit v1 save restores, reads drawn: null, plays on, and the next write is v2', async () => {
    await createWasmEngine();
    const engineState = readFileSync(FIXTURE, 'utf8');
    const inner = JSON.parse(engineState);
    expect(inner.v).toBe(1);
    expect(engineState).not.toContain('"drawn"');
    const v1 = {
      v: 1,
      savedAt: '2026-09-27T20:00:00.000Z',
      engineState,
      history: inner.history,
      lastSeenSeq: { 0: 3, 1: 1 },
      viewer: 1,
      curtain: { kind: 'handoff', to: 1, reason: 'turn' },
      names: ['Alice', 'Blake'],
      seed: '2',
      dealer: 0,
    };
    const { store, storage } = await restoreFrom(JSON.stringify(v1));
    expect(store.error).toBeNull();
    expect(store.screen).toBe('game');
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(store.history).toHaveLength(3);
    for (const h of store.history) expect(h.drawn).toBeNull();

    for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
    expect(store.curtain.kind).toBe('none');
    expect(store.view?.viewer).toBe(1);
    expect(persisted(storage)).toEqual({ v: 2, inner: 2 });
  }, 15_000);

  it('a live save at every curtain kind, rewritten as v1, restores exactly like the v2 save and writes v2 next', async () => {
    await createWasmEngine();
    const wanted: CurtainState['kind'][] = ['handoff', 'reveal', 'recap', 'ack', 'none', 'result'];
    const captured = new Map<string, string>();
    const key = (c: CurtainState): string => (c.kind === 'ack' ? `ack-${c.synthetic ? 'synthetic' : 'real'}` : c.kind);

    for (let seed = 1; seed <= 12 && captured.size < wanted.length + 1; seed++) {
      const storage = fakeStorage();
      const live = new GameStore({ storage, session: new SessionStore() });
      await live.newGame({ seed: String(seed), dealer: 0 });
      let x = seed * 2654435761;
      for (let ply = 0; ply < 400 && live.curtain.kind !== 'result'; ply++) {
        const k = key(live.curtain);
        if (!captured.has(k)) captured.set(k, storage.getItem(SNAPSHOT_KEY)!);
        const c = live.curtain;
        if (c.kind === 'none' || (c.kind === 'ack' && !c.synthetic)) {
          const moves = live.envelope!.legalMoves;
          x = (x * 1103515245 + 12345) >>> 0;
          await live.apply(x % moves.length);
        } else {
          await live.advanceCurtain();
        }
      }
      if (live.curtain.kind === 'result' && !captured.has('result')) captured.set('result', storage.getItem(SNAPSHOT_KEY)!);
    }
    expect([...captured.keys()].sort()).toEqual(['ack-real', 'ack-synthetic', 'handoff', 'none', 'recap', 'result', 'reveal']);

    // The bridge holds one game at a time, so each restore runs to the end
    // of its checks before the next one starts.
    async function observe(raw: string, kind: string) {
      const { store, storage } = await restoreFrom(raw);
      const before = { error: store.error, curtain: store.curtain, view: store.view, historyLength: store.history.length };
      if (kind === 'result') return { before };
      // SPEC §5.7 (ruling 2026-09-29): `none` and an `ack` resume behind the
      // resume gate, which writes nothing; pass it, then play on.
      if (kind === 'none' || kind.startsWith('ack')) await passResumeGate(store);
      await stepOn(store);
      return { before, after: { error: store.error, curtain: store.curtain, view: store.view }, persisted: persisted(storage) };
    }

    for (const [kind, raw] of captured) {
      expect(JSON.parse(raw).v, kind).toBe(2);
      const v1Raw = toV1(raw);
      expect(v1Raw, kind).not.toContain('"drawn"');
      const a = await observe(raw, kind);
      const b = await observe(v1Raw, kind);
      expect(b.before.error, kind).toBeNull();
      expect(b.before, kind).toEqual(a.before);
      if (kind === 'result') continue;
      expect(b.after, kind).toEqual(a.after);
      expect(b.after?.error, kind).toBeNull();
      expect(b.persisted, kind).toEqual({ v: 2, inner: 2 });
    }
  }, 60_000);
});
