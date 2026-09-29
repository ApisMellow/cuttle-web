import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const staticRoot = path.join(webRoot, 'static');
const wasmPath = path.join(staticRoot, 'cuttle.wasm');
const wasmExecPath = path.join(staticRoot, 'wasm_exec.js');

// R18.1 / SPEC §7.6: fail if the gzipped cuttle.wasm exceeds 1.5 MB, taken
// literally as the stricter decimal reading (1,500,000 bytes), not 1.5 MiB.
const WASM_GZIP_BUDGET_BYTES = 1_500_000;

let runtime;

async function boot() {
  if (runtime) return runtime;
  assert.ok(existsSync(wasmPath), `missing ${wasmPath}; run npm run build:wasm`);
  assert.ok(existsSync(wasmExecPath), `missing ${wasmExecPath}; run npm run build:wasm`);

  await import(pathToFileURL(wasmExecPath).href);
  const go = new globalThis.Go();
  const bytes = await readFile(wasmPath);
  const result = await WebAssembly.instantiate(bytes, go.importObject);
  void go.run(result.instance);

  const deadline = Date.now() + 10_000;
  while (!globalThis.__cuttleReady && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(globalThis.__cuttleReady, true, 'WASM bridge did not become ready');
  runtime = { go, result };
  return runtime;
}

function call(name, ...args) {
  const raw = globalThis[name](...args);
  assert.equal(typeof raw, 'string', `${name} must return a JSON string`);
  return JSON.parse(raw);
}

function assertEnvelope(envelope) {
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.ok(envelope.state && typeof envelope.state === 'object');
  assert.ok(Array.isArray(envelope.legalMoves));
  assert.ok(Array.isArray(envelope.descriptions));
  assert.equal(envelope.legalMoves.length, envelope.descriptions.length);
  assert.ok(Array.isArray(envelope.history));
  assert.equal(envelope.history.length, envelope.seq);
  assert.equal(envelope.state.deck, undefined, 'deck contents crossed the bridge');
  assert.equal(typeof envelope.state.deckCount, 'number');
  assert.ok(Array.isArray(envelope.state.scrap));
  for (const move of envelope.legalMoves) {
    assert.equal(move.Card === null || move.Card.Rank >= 1, true, 'Rank 0 was not normalized');
  }
}

function xorshift32(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test('boots the real compiled Go WASM bridge and keeps it alive', async () => {
  await boot();
  for (const name of [
    '__cuttleNewGame',
    '__cuttleLegalMoves',
    '__cuttleApply',
    '__cuttleDescribe',
    '__cuttleView',
    '__cuttleSnapshot',
    '__cuttleRestore',
  ]) {
    assert.equal(typeof globalThis[name], 'function', `${name} is not registered`);
  }

  assertEnvelope(call('__cuttleNewGame', JSON.stringify({ seed: '42', dealer: 1 })));
  assertEnvelope(call('__cuttleLegalMoves'));
});

test('R18.1: gzipped cuttle.wasm stays within the 1.5 MB budget', async () => {
  assert.ok(existsSync(wasmPath), `missing ${wasmPath}; run npm run build:wasm`);
  const raw = await readFile(wasmPath);
  const gzippedBytes = gzipSync(raw, { level: 9 }).length;
  assert.ok(
    gzippedBytes <= WASM_GZIP_BUDGET_BYTES,
    `cuttle.wasm gzipped is ${gzippedBytes} bytes, budget is ${WASM_GZIP_BUDGET_BYTES} bytes (SPEC §7.6, R18.1)`,
  );
});

test('reproduces the seed-42 golden deal byte-for-byte', async () => {
  await boot();
  const envelope = call('__cuttleNewGame', JSON.stringify({ seed: '42', dealer: 1 }));
  assertEnvelope(envelope);
  assert.deepEqual(envelope.descriptions, [
    'draw a card',
    'play 2♥ as point card',
    'play 3♣ as point card',
    'play A♥ as one-off',
    'play A♥ as point card',
    'play K♦ as permanent',
    'play Q♣ as permanent',
  ]);
  assert.equal(envelope.state.active, 0);
  assert.equal(envelope.state.phase, 0);
  assert.equal(envelope.state.deckCount, 41);

  const snapshot = call('__cuttleSnapshot');
  const card = (Rank, Suit) => ({ Rank, Suit });
  assert.deepEqual(snapshot.state.Players[0].Hand, [
    card(2, 2), card(3, 0), card(1, 2), card(13, 1), card(12, 0),
  ]);
  assert.deepEqual(snapshot.state.Players[1].Hand, [
    card(5, 2), card(9, 2), card(8, 1), card(4, 1), card(5, 3), card(4, 2),
  ]);
  assert.deepEqual(snapshot.state.Deck.slice(0, 5), [
    card(2, 0), card(9, 3), card(9, 1), card(11, 2), card(7, 0),
  ]);
});

test('R11.4: full committed seed corpus reaches terminal state via offered indices with zero legal-move-contract breaks', async () => {
  await boot();
  // No exclusions: engine v0.2.0 fixes E-1 and handles E-2 with a dead-end
  // scrap fallback (SPEC §2.10 is stale on this point). Confirmed clean
  // 2026-09-26 by running this exact corpus with the former exclusion list
  // emptied — see docs/loop-log/engine-issues.md.
  const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
  const seeds = Array.from({ length: corpus.count }, (_, i) => corpus.start + i).map(String);
  assert.ok(seeds.length >= 200, `corpus has only ${seeds.length} seeds`);

  let wins = 0;
  let stalemates = 0;
  const defects = [];
  for (const seed of seeds) {
    let envelope = call('__cuttleNewGame', JSON.stringify({
      seed,
      dealer: Number(BigInt(seed) & 1n),
    }));
    const random = xorshift32(Number(BigInt(seed) & 0xffffffffn));
    for (let step = 0; step < 3_000 && envelope.state.phase !== 4; step += 1) {
      assertEnvelope(envelope);
      if (envelope.legalMoves.length === 0) {
        defects.push({ seed, step, code: 'NO_LEGAL_MOVES', phase: envelope.state.phase });
        break;
      }
      const index = random() % envelope.legalMoves.length;
      const beforeSeq = envelope.seq;
      const mover = envelope.state.active;
      const applied = call('__cuttleApply', index);
      if (!applied.ok) {
        defects.push({ seed, step, ...applied });
        break;
      }
      assertEnvelope(applied);
      assert.equal(applied.seq, beforeSeq + 1, `seed ${seed} step ${step}: seq did not increment once`);
      // apply returns the mover's view; the incoming actor's comes from view() (§3.3 rule 4).
      assert.equal(applied.state.viewer, mover, `seed ${seed} step ${step}: apply must return the mover's view`);
      envelope = call('__cuttleView', applied.state.active);
      assert.equal(envelope.seq, applied.seq, `seed ${seed} step ${step}: view seq differs from apply seq`);
    }
    if (!envelope.ok || envelope.state.phase !== 4) continue;
    if (envelope.state.winner === null) stalemates += 1;
    else wins += 1;
  }
  assert.deepEqual(defects, [], `unexpected legal-move-contract break (R11.4):\n${JSON.stringify(defects, null, 2)}`);
  assert.ok(wins > 0, 'corpus produced no wins');
  assert.ok(stalemates > 0, 'corpus produced no stalemates');
});

// assertNoLeak checks one viewer's view against the ground-truth snapshot
// taken at the same position (SPEC §3.2, §7.2(5)): opponent.hand is null
// unless the viewer holds a glasses-8; deck contents never cross for either
// player, in any phase; and history[].index is present only for the
// viewer's own entries (assumptions.md Batch 1).
function assertNoLeak(viewer, view, snapshot) {
  assertEnvelope(view);
  if (view.state.opponent.hand !== null) {
    const hasGlasses = view.state.you.permanents.some((c) => c.Rank === 8);
    assert.ok(hasGlasses, `viewer ${viewer} saw opponent.hand without glasses`);
  } else {
    // Raw snapshot state is unnormalized: a nil hand marshals as null (§5.7).
    const hiddenHand = snapshot.state.Players[1 - viewer].Hand ?? [];
    for (const hidden of hiddenHand) {
      assert.equal(JSON.stringify(view.state).includes(JSON.stringify(hidden)), false,
        `viewer ${viewer} leaked opponent card ${JSON.stringify(hidden)}`);
    }
  }
  // R10: you.watched is true exactly when the OTHER player holds glasses,
  // i.e. exactly when their view carries this viewer's hand (SPEC §3.2).
  const otherHasGlasses = (snapshot.state.Players[1 - viewer].Permanents ?? []).some((c) => c.Rank === 8);
  assert.equal(view.state.you.watched, otherHasGlasses,
    `viewer ${viewer}: you.watched=${view.state.you.watched} disagrees with the opponent's glasses`);
  for (const hidden of snapshot.state.Deck ?? []) {
    assert.equal(JSON.stringify(view.state).includes(JSON.stringify(hidden)), false,
      `viewer ${viewer} leaked deck card ${JSON.stringify(hidden)}`);
  }
  for (const entry of view.history) {
    if (entry.by !== viewer) {
      assert.equal('index' in entry, false,
        `viewer ${viewer} saw index on an opponent history entry (seq ${entry.seq})`);
    }
  }
}

test('§7.2(5): redaction holds across sampled positions in multiple corpus games', async () => {
  await boot();
  const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
  const sampleSeeds = [5, 45, 90, 135, 180, 225]
    .filter((n) => n >= corpus.start && n < corpus.start + corpus.count)
    .map(String);
  assert.ok(sampleSeeds.length >= 5, `expected at least 5 sample seeds, got ${sampleSeeds.length}`);

  let positionsChecked = 0;
  for (const seed of sampleSeeds) {
    let envelope = call('__cuttleNewGame', JSON.stringify({
      seed,
      dealer: Number(BigInt(seed) & 1n),
    }));
    const random = xorshift32(Number(BigInt(seed) & 0xffffffffn));
    for (let step = 0; step < 3_000 && envelope.state.phase !== 4; step += 1) {
      if (step % 5 === 0) {
        const snapshot = call('__cuttleSnapshot');
        for (const viewer of [0, 1]) {
          assertNoLeak(viewer, call('__cuttleView', viewer), snapshot);
        }
        positionsChecked += 1;
      }
      if (envelope.legalMoves.length === 0) break;
      const index = random() % envelope.legalMoves.length;
      const applied = call('__cuttleApply', index);
      if (!applied.ok) break;
      envelope = call('__cuttleView', applied.state.active);
    }
  }
  assert.ok(positionsChecked >= 20,
    `only sampled ${positionsChecked} positions across ${sampleSeeds.length} games`);
});

test('SPEC §2.4/§5.7: snapshot restore round-trip preserves seq and viewer', async () => {
  await boot();
  const active = call('__cuttleNewGame', JSON.stringify({ seed: '42', dealer: 1 }));
  const snapshot = call('__cuttleSnapshot');

  // restore(snapshotJson, viewerId): TS passes its persisted Snapshot.viewer.
  const restored = call('__cuttleRestore', JSON.stringify(snapshot), active.state.viewer);
  assertEnvelope(restored);
  assert.equal(restored.seq, active.seq);
  assert.equal(restored.state.viewer, active.state.viewer);
});
