import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadScenario } from '../scenario/loader';
import { replayScenario } from '../scenario/replayer';
import { createWasmEngine } from '../scenario/wasm-engine';

const here = path.dirname(fileURLToPath(import.meta.url));

// EXPECTED RED until Batch 1. The committed web/static/cuttle.wasm never
// signals __cuttleReady — confirmed independently by running
// `node tests/smoke/bridge-smoke.mjs`, which fails the identical way.
// This test is real (not a placeholder): once Batch 1 ships a working
// bridge, it should go green with no changes to this file.
describe('scenario replay against the real WASM bridge', () => {
  it('replays the opening scenario end to end', async () => {
    const engine = await createWasmEngine();
    const scenario = await loadScenario(path.join(here, '../scenarios/opening.yaml'));
    expect(() => replayScenario(engine, scenario)).not.toThrow();
  }, 15_000);
});
