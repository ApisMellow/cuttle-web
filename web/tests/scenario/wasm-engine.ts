// Test-only Node bootstrap for the compiled Go/WASM bridge (SPEC §2.3),
// paired with the real production call surface from src/lib/bridge/engine.ts
// (SPEC §5.4) for the actual bridge calls.
//
// The boot sequence here is DELIBERATELY NOT `ensureEngine()` from
// lib/bridge/wasm.ts: that module loads `wasm_exec.js` via a `<script src>`
// tag and fetches `/cuttle.wasm` from the page's own origin — both need a
// real browser DOM plus a running HTTP server (see docs/assumptions.md,
// Batch 3: Vite's dev server refuses to `import()` a public-dir file
// directly, which is why lib/bridge/wasm.ts uses a script tag in the first
// place). This harness runs under plain Node — vitest's jsdom environment
// does not execute an injected `<script src>`, and there is no dev server
// backing a relative `fetch()` here — so it loads the same two files
// straight off disk instead, exactly as tests/smoke/bridge-smoke.mjs does.
//
// Once booted, every actual bridge *call* (newGame, legalMoves, apply,
// view) delegates to the real lib/bridge/engine.ts wrappers, so this file
// no longer duplicates the argument-shape and schema-validation logic that
// used to live here — only the boot dance remains test-only.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  apply as engineApply,
  legalMoves as engineLegalMoves,
  newGame as engineNewGame,
  type NewGameOpts,
  view as engineView,
} from '../../src/lib/bridge/engine';
import type { BridgeResult, Envelope } from '../../src/lib/bridge/schema';
import type { ScenarioEngine, ScenarioEnvelope } from './replayer';

interface GoInstance {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface GoConstructor {
  new (): GoInstance;
}

type CuttleGlobal = typeof globalThis & {
  Go?: GoConstructor;
  __cuttleReady?: boolean;
};

const cuttleGlobal = globalThis as CuttleGlobal;

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
    void go.run(result.instance); // never await — resolves only on Go program exit (SPEC §2.3)

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

/** Scenario replay never expects a bridge error; surface one loudly if it happens. */
function okOrThrow(result: BridgeResult): Envelope {
  if (!result.ok) {
    throw new Error(`bridge call failed: ${result.code}: ${result.message}`);
  }
  return result;
}

// `Envelope` (schema.ts) has no index signature, so it isn't directly
// assignable to `ScenarioEnvelope`'s `[field: string]: unknown` even though
// every field it has is structurally compatible. The values are the same
// object at runtime; this only widens the static type at the boundary.
function asScenarioEnvelope(envelope: Envelope): ScenarioEnvelope {
  return envelope as unknown as ScenarioEnvelope;
}

export async function createWasmEngine(): Promise<ScenarioEngine> {
  await ensureBooted();
  return {
    newGame(opts): ScenarioEnvelope {
      // ScenarioEngine's opts shape (replayer.ts) is looser than the real
      // NewGameOpts (dealer: number vs 0|1, names: string[] vs a 2-tuple) —
      // scenarios are already validated to those exact ranges by
      // scenario/loader.ts before they ever reach here.
      return asScenarioEnvelope(okOrThrow(engineNewGame(opts as unknown as NewGameOpts)));
    },
    legalMoves(): ScenarioEnvelope {
      return asScenarioEnvelope(okOrThrow(engineLegalMoves()));
    },
    apply(index): ScenarioEnvelope {
      // apply returns the MOVER's view; the replayer needs the incoming
      // actor's legal moves, which the real UI fetches with view() after
      // the curtain reveal (SPEC §3.3 rule 4, §2.4 amended 2026-09-26).
      const applied = okOrThrow(engineApply(index));
      return asScenarioEnvelope(okOrThrow(engineView(applied.state.active)));
    },
  };
}
