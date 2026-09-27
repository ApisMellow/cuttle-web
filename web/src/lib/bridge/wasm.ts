// SPEC §5.4 / §2.3 — load and readiness lifecycle. This is the ONLY module
// that boots the Go/WASM bridge. Nothing else calls `WebAssembly.*`, and no
// component or store calls a `__cuttle*` global directly (§2.3) — that goes
// through `lib/bridge/engine.ts`.
//
// The Go program's `main` registers the `__cuttle*` globals and then blocks
// forever on `select {}`. If `main` ever returns, the Go runtime tears down
// and every later call throws. Catching that class of defect is exactly
// what the bridge-smoke suite (§7.2) is for; this module only implements
// the required boot sequence correctly.

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

let readyPromise: Promise<void> | null = null;

function whenReady(): Promise<void> {
  return new Promise((resolve) => {
    function poll() {
      if (cuttleGlobal.__cuttleReady === true) {
        resolve();
        return;
      }
      requestAnimationFrame(poll);
    }
    poll();
  });
}

/**
 * Loads `wasm_exec.js` as a classic (non-module) script tag, not a dynamic
 * `import()` (deviation from the SPEC §2.3 illustration — logged in
 * docs/assumptions.md). Vite's dev server refuses to `import()` a plain,
 * un-processed file out of `publicDir` ("Cannot import non-asset file …
 * which is inside /public", verified against vite@8.3.1); a `<script src>`
 * load sidesteps the module graph entirely and works identically in dev,
 * build, and preview, which is all this step needs — the script's only job
 * is the side effect of defining `globalThis.Go`.
 */
function loadWasmExec(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/wasm_exec.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load /wasm_exec.js'));
    document.head.appendChild(script);
  });
}

/**
 * Boots the Go/WASM bridge exactly once (§2.3). Idempotent: concurrent and
 * later callers all share the same promise. Callers must show a loading
 * state until this resolves, and a hard-fail screen — never a blank board —
 * if it rejects.
 */
export function ensureEngine(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await loadWasmExec(); // defines globalThis.Go
    if (!cuttleGlobal.Go) {
      throw new Error('wasm_exec.js did not define globalThis.Go');
    }
    const go = new cuttleGlobal.Go();
    const result = await WebAssembly.instantiateStreaming(fetch('/cuttle.wasm'), go.importObject);
    void go.run(result.instance); // never await — resolves only when the Go program exits (§2.3)
    await whenReady();
  })();
  return readyPromise;
}

/**
 * Test-only escape hatch: clears the memoized promise so a test can force a
 * fresh `ensureEngine()` call. Never used by production code.
 */
export function resetEngineForTests(): void {
  readyPromise = null;
}
