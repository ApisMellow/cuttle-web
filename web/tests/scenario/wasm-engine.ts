// Test-only adapter from the raw __cuttle* WASM globals (SPEC §2.3/§2.4)
// to the ScenarioEngine interface, so the replayer can be exercised
// against the real compiled bridge. Mirrors the boot sequence already
// proven in tests/smoke/bridge-smoke.mjs.
//
// This is deliberately NOT src/lib/bridge/engine.ts — that production
// seam (SPEC §5.4) is Batch 3's responsibility. Duplicating the ~15-line
// boot dance here avoids taking a dependency on code that doesn't exist
// yet; once Batch 3 lands, this file is a natural candidate to delete in
// favor of importing the real bridge module (see docs/assumptions.md).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ScenarioEngine, ScenarioEnvelope } from './replayer';

interface GoInstance {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface GoConstructor {
  new (): GoInstance;
}

interface CuttleGlobals {
  Go?: GoConstructor;
  __cuttleReady?: boolean;
  __cuttleNewGame?: (json: string) => string;
  __cuttleLegalMoves?: () => string;
  __cuttleApply?: (index: number) => string;
}

const cuttleGlobal = globalThis as typeof globalThis & CuttleGlobals;

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, '../../static');

let booted: Promise<void> | null = null;

async function ensureBooted(): Promise<void> {
  if (booted) return booted;
  booted = (async () => {
    const wasmExecPath = path.join(staticRoot, 'wasm_exec.js');
    const wasmPath = path.join(staticRoot, 'cuttle.wasm');
    await import(pathToFileURL(wasmExecPath).href);

    const GoCtor = cuttleGlobal.Go;
    if (!GoCtor) throw new Error('wasm_exec.js did not define globalThis.Go');
    const go = new GoCtor();
    const bytes = await readFile(wasmPath);
    const result = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(result.instance); // never await — it resolves only on Go program exit (SPEC §2.3)

    const deadline = Date.now() + 10_000;
    while (!cuttleGlobal.__cuttleReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!cuttleGlobal.__cuttleReady) {
      throw new Error('WASM bridge did not become ready');
    }
  })();
  return booted;
}

function call<Args extends unknown[]>(fn: ((...args: Args) => string) | undefined, ...args: Args): ScenarioEnvelope {
  if (!fn) throw new Error('bridge function is not registered');
  return JSON.parse(fn(...args)) as ScenarioEnvelope;
}

export async function createWasmEngine(): Promise<ScenarioEngine> {
  await ensureBooted();
  return {
    newGame(opts) {
      return call(cuttleGlobal.__cuttleNewGame, JSON.stringify(opts));
    },
    legalMoves() {
      return call(cuttleGlobal.__cuttleLegalMoves);
    },
    apply(index) {
      return call(cuttleGlobal.__cuttleApply, index);
    },
  };
}
