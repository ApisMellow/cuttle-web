// R10 (deploy safety, SPEC §2.3): the engine files are fetched from fixed
// publicDir names while the app JS is content-hashed. Each engine URL must
// carry a token derived from the engine files' content, so a deploy that
// changes the engine changes both URLs and a cached old engine can never be
// paired with new JS.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { engineAssetUrl } from '../../src/lib/bridge/wasm';

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../static');

function expectedToken(): string {
  const hash = createHash('sha256');
  for (const name of ['wasm_exec.js', 'cuttle.wasm']) hash.update(readFileSync(path.join(staticRoot, name)));
  return hash.digest('hex').slice(0, 16);
}

describe('R10: engine asset URLs carry the engine content token', () => {
  it('both files, under the base, with ?v= the hash of wasm_exec.js + cuttle.wasm', () => {
    const token = expectedToken();
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(engineAssetUrl('cuttle.wasm')).toBe(`${import.meta.env.BASE_URL}cuttle.wasm?v=${token}`);
    expect(engineAssetUrl('wasm_exec.js')).toBe(`${import.meta.env.BASE_URL}wasm_exec.js?v=${token}`);
  });
});
