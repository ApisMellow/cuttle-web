// A production build laid out the way GitHub Pages serves it: the Vite app
// built for a base path, plus the card gallery copied to `gallery/` after
// the build (as .github/workflows/pages.yml does). Tests use it to check the
// real service worker, not the dev server, which never registers one.
//
// Needs web/static/cuttle.wasm and wasm_exec.js (scripts/build-wasm.sh).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const webDir = path.resolve(here, '..');
const repoRoot = path.resolve(webDir, '..');
const viteBin = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Builds into `outDir` (emptied first) with `base` as Vite's base path, and
 * copies the gallery beside it. Returns `outDir`.
 */
export function buildForPages(outDir, { base = '/cuttle-web/', gallery = true } = {}) {
  for (const name of ['cuttle.wasm', 'wasm_exec.js']) {
    if (!existsSync(path.join(webDir, 'static', name))) {
      throw new Error(`web/static/${name} is missing; run scripts/build-wasm.sh first`);
    }
  }
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: webDir,
    env: { ...process.env, CUTTLE_BASE: base },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (gallery) cpSync(path.join(repoRoot, 'gallery', 'site'), path.join(outDir, 'gallery'), { recursive: true });
  return outDir;
}
