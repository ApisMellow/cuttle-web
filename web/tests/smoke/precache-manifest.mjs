// R18.2 (SPEC §5.8, §7.6): the generated service worker precaches everything
// the game needs to boot and play offline, and nothing it must not.
//
// Builds the app the way the Pages workflow does (base /cuttle-web/, gallery
// copied in after the build) into a temp directory, then reads the real
// `sw.js`. A missing wasm is the failure this guards: Workbox's 2 MiB
// `maximumFileSizeToCacheInBytes` default drops the ~3.4 MiB raw wasm with
// only a build warning, and the app then fails only when a player is offline.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildForPages } from '../../scripts/build-pages.mjs';
import { checkPrecache, parsePrecacheEntries, themeImagePaths } from '../../scripts/precache-manifest.mjs';

let tmp;
let dist;
let result;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cuttle-precache-'));
  dist = buildForPages(path.join(tmp, 'dist'));
  result = checkPrecache(dist);
  console.log(
    `precache: ${result.entries.length} entries, ${result.totalBytes.toLocaleString('en-US')} bytes ` +
      `(${(result.totalBytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('R18.2: the precache holds the wasm, its loader, the shell, icons and both card themes', () => {
  assert.deepEqual(result.problems, []);
  const urls = new Set(result.entries.map((e) => e.url));
  assert.ok(urls.has('cuttle.wasm'));
  assert.ok(urls.has('wasm_exec.js'));
  // Classic (the vector theme) is drawn by the JS bundle; Mythic is images.
  const mythic = themeImagePaths(dist).filter((p) => p.startsWith('themes/mythic/'));
  assert.ok(mythic.length >= 110, `expected the full Mythic deck, got ${mythic.length} paths`);
  for (const p of mythic) assert.ok(urls.has(p), `missing ${p}`);
});

test('R18.2: the gallery and its images stay out of the precache', () => {
  assert.ok(result.entries.every((e) => !e.url.startsWith('gallery/')));
  // Still deployed beside the app, just not precached.
  assert.ok(readFileSync(path.join(dist, 'gallery', 'index.html'), 'utf8').length > 0);
});

test('R18: the service worker never falls back to the app for gallery navigations', () => {
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
  assert.match(sw, /NavigationRoute\(.*denylist:\s*\[[^\]]*gallery/);
});

test('R18 updates: the service worker never activates itself over a running game', () => {
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
  // The only skipWaiting is the one the page asks for with SKIP_WAITING.
  const calls = sw.match(/skipWaiting\(\)/g) ?? [];
  assert.equal(calls.length, 1, 'expected exactly one skipWaiting() call');
  assert.match(sw, /"SKIP_WAITING"\s*===\s*[a-z]+\.data\.type\s*&&\s*self\.skipWaiting\(\)/);
  assert.doesNotMatch(sw, /clientsClaim\(\)/);
  // No runtime caching: nothing outside the build is ever stored.
  assert.doesNotMatch(sw, /registerRoute\((?!new [a-zA-Z_$]+\.NavigationRoute)/);
});

test('R18.2: the engine URL token (?v=) still matches its precache entry', () => {
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
  assert.match(sw, /ignoreURLParametersMatching:\s*\[[^\]]*\/\^v\$\//);
});

test('checker: a precache without the wasm or its loader fails', () => {
  const fake = path.join(tmp, 'fake');
  mkdirSync(fake, { recursive: true });
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8')
    .replace(/\{url:"cuttle\.wasm",revision:(null|"[^"]*")\},?/, '')
    .replace(/\{url:"wasm_exec\.js",revision:(null|"[^"]*")\},?/, '');
  writeFileSync(path.join(fake, 'sw.js'), sw);
  // The checker reads the theme catalog from the build it is checking.
  mkdirSync(path.join(fake, 'themes'), { recursive: true });
  writeFileSync(path.join(fake, 'themes', 'index.json'), '{"themes":[]}');
  const { problems } = checkPrecache(fake);
  assert.ok(problems.includes('missing from precache: cuttle.wasm'), problems.join('\n'));
  assert.ok(problems.includes('missing from precache: wasm_exec.js'), problems.join('\n'));
});

test('R18.2: the bundled UI font (regular and bold woff2) is precached', () => {
  const fonts = result.entries.filter((e) => /^assets\/atkinson-hyperlegible-next-latin-(400|700)-normal-.+\.woff2$/.test(e.url));
  assert.equal(fonts.length, 2, `expected latin 400 and 700 woff2, got ${fonts.map((e) => e.url).join(', ')}`);
});

test('checker: a precache without the UI font fails', () => {
  const fake = path.join(tmp, 'fake-font');
  mkdirSync(path.join(fake, 'themes'), { recursive: true });
  writeFileSync(path.join(fake, 'themes', 'index.json'), '{"themes":[]}');
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8').replace(
    /\{url:"assets\/atkinson-hyperlegible-next-[^"]*\.woff2",revision:(null|"[^"]*")\},?/g,
    '',
  );
  writeFileSync(path.join(fake, 'sw.js'), sw);
  const { problems } = checkPrecache(fake);
  assert.ok(problems.includes('missing from precache: the UI font (latin 400 woff2)'), problems.join('\n'));
  assert.ok(problems.includes('missing from precache: the UI font (latin 700 woff2)'), problems.join('\n'));
});

test('checker: a gallery entry in the precache fails', () => {
  const entries = parsePrecacheEntries('precacheAndRoute([{url:"gallery/img/2-clubs.webp",revision:"abc"}])');
  assert.deepEqual(entries, [{ url: 'gallery/img/2-clubs.webp', revision: 'abc' }]);
  const fake = path.join(tmp, 'fake-gallery');
  mkdirSync(path.join(fake, 'themes'), { recursive: true });
  writeFileSync(path.join(fake, 'themes', 'index.json'), '{"themes":[]}');
  writeFileSync(path.join(fake, 'sw.js'), 'precacheAndRoute([{url:"gallery/img/2-clubs.webp",revision:"abc"}])');
  assert.ok(checkPrecache(fake).problems.includes('must not be precached: gallery/img/2-clubs.webp'));
});
