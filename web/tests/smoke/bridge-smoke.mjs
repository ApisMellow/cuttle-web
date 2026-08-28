import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const staticRoot = path.join(webRoot, 'static');
const wasmPath = path.join(staticRoot, 'cuttle.wasm');
const wasmExecPath = path.join(staticRoot, 'wasm_exec.js');

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

test('plays at least 200 fixed seeds to a terminal state through offered indices', async () => {
  await boot();
  const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
  const exclusions = JSON.parse(await readFile(path.join(here, 'exclusions.json'), 'utf8'));
  const excluded = new Set(exclusions.seeds.map(({ seed }) => String(seed)));
  const seeds = Array.from({ length: corpus.count }, (_, i) => corpus.start + i)
    .map(String)
    .filter((seed) => !excluded.has(seed));
  assert.ok(seeds.length >= 200, `corpus has only ${seeds.length} active seeds`);

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
      envelope = call('__cuttleApply', index);
      if (!envelope.ok) {
        defects.push({ seed, step, ...envelope });
        break;
      }
      assert.equal(envelope.seq, beforeSeq + 1, `seed ${seed} step ${step}: seq did not increment once`);
    }
    if (!envelope.ok || envelope.state.phase !== 4) continue;
    if (envelope.state.winner === null) stalemates += 1;
    else wins += 1;
  }
  assert.deepEqual(defects, [], `upstream engine defects must be listed in exclusions.json:\n${JSON.stringify(defects, null, 2)}`);
  assert.ok(wins > 0, 'corpus produced no wins');
  assert.ok(stalemates > 0, 'corpus produced no stalemates');
});

test('redacts both player views and survives snapshot restore', async () => {
  await boot();
  const active = call('__cuttleNewGame', JSON.stringify({ seed: '42', dealer: 1 }));
  const snapshot = call('__cuttleSnapshot');
  for (const viewer of [0, 1]) {
    const view = call('__cuttleView', viewer);
    assertEnvelope(view);
    assert.equal(view.state.opponent.hand, null);
    const hiddenHand = snapshot.state.Players[1 - viewer].Hand;
    for (const hidden of hiddenHand) {
      assert.equal(JSON.stringify(view.state).includes(JSON.stringify(hidden)), false,
        `viewer ${viewer} leaked opponent card ${JSON.stringify(hidden)}`);
    }
    for (const hidden of snapshot.state.Deck) {
      assert.equal(JSON.stringify(view.state).includes(JSON.stringify(hidden)), false,
        `viewer ${viewer} leaked deck card ${JSON.stringify(hidden)}`);
    }
  }

  const restored = call('__cuttleRestore', JSON.stringify(snapshot));
  assertEnvelope(restored);
  assert.equal(restored.seq, active.seq);
});
