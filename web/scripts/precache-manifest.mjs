#!/usr/bin/env node
// R18.2 (SPEC §5.8, §7.6): the offline guarantee lives in the service
// worker's precache list, and a file missing from it fails silently: the
// build succeeds, the app works online, and it breaks only when a player
// is in airplane mode. Workbox's 2 MiB `maximumFileSizeToCacheInBytes`
// default is the known way to lose the wasm like that. This module reads
// the generated `sw.js` and checks the list against what the game needs.
//
// Used two ways:
//   - by `tests/smoke/precache-manifest.mjs` (inside `test:smoke`, so the
//     gate fails on a bad list), and
//   - as a CLI after a real build, by the Pages workflow:
//       node scripts/precache-manifest.mjs dist
//     It prints the list and its size, and exits non-zero on any problem.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files the game can't boot or play without, relative to the build root. */
export const REQUIRED_ENTRIES = [
  'index.html',
  'cuttle.wasm',
  'wasm_exec.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'themes/index.json',
];

/** Weights of the bundled UI font (`--cu-weight-regular`, `--cu-weight-bold`). */
export const UI_FONT_WEIGHTS = [400, 700];

/** The card gallery is a separate static page and never enters the precache. */
export const EXCLUDED_PREFIXES = ['gallery/'];

/**
 * Every `{url, revision}` entry in a generated Workbox `sw.js`. The URLs are
 * relative to the service worker, which sits at the build root.
 */
export function parsePrecacheEntries(swSource) {
  const entries = [];
  const re = /\{\s*"?url"?\s*:\s*"([^"]+)"\s*,\s*"?revision"?\s*:\s*(null|"[^"]*")\s*\}/g;
  for (const match of swSource.matchAll(re)) {
    entries.push({ url: match[1], revision: match[2] === 'null' ? null : match[2].slice(1, -1) });
  }
  return entries;
}

/** Every image path a bitmap theme's manifest names, relative to the build root. */
export function themeImagePaths(distDir) {
  const out = [];
  const catalog = JSON.parse(readFileSync(path.join(distDir, 'themes', 'index.json'), 'utf8'));
  for (const theme of catalog.themes ?? []) {
    const manifestRel = path.posix.join('themes', theme.manifest);
    out.push(manifestRel);
    const manifestDir = path.posix.dirname(manifestRel);
    const manifest = JSON.parse(readFileSync(path.join(distDir, manifestRel), 'utf8'));
    const groups = [manifest.faces, manifest.glasses, { back: manifest.back }, { table: manifest.table }];
    for (const group of groups) {
      for (const sources of Object.values(group ?? {})) {
        for (const source of sources ?? []) out.push(path.posix.join(manifestDir, source.src));
      }
    }
  }
  return out;
}

/**
 * Checks a built `dist/`. Returns the entries, their total size on disk,
 * and a list of problems (empty when the precache is sound).
 */
export function checkPrecache(distDir) {
  const problems = [];
  let swSource;
  try {
    swSource = readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  } catch {
    return { entries: [], totalBytes: 0, problems: [`no sw.js in ${path.basename(distDir)}/`] };
  }

  const entries = parsePrecacheEntries(swSource);
  const urls = new Set(entries.map((e) => e.url));
  if (entries.length === 0) problems.push('sw.js has no precache entries');

  for (const required of [...REQUIRED_ENTRIES, ...themeImagePaths(distDir)]) {
    if (!urls.has(required)) problems.push(`missing from precache: ${required}`);
  }
  if (![...urls].some((u) => /^assets\/.+\.js$/.test(u))) problems.push('missing from precache: the app JS bundle');
  if (![...urls].some((u) => /^assets\/.+\.css$/.test(u))) problems.push('missing from precache: the app CSS bundle');
  // The UI font is bundled, not a system font: offline play must keep it.
  for (const weight of UI_FONT_WEIGHTS) {
    const re = new RegExp(`^assets/atkinson-hyperlegible-next-latin-${weight}-normal-.+\\.woff2$`);
    if (![...urls].some((u) => re.test(u))) problems.push(`missing from precache: the UI font (latin ${weight} woff2)`);
  }

  let totalBytes = 0;
  for (const url of urls) {
    if (EXCLUDED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      problems.push(`must not be precached: ${url}`);
    }
    if (/^[a-z]+:/i.test(url) || url.startsWith('/')) {
      problems.push(`precache entry is not relative to the service worker: ${url}`);
      continue;
    }
    try {
      totalBytes += statSync(path.join(distDir, url)).size;
    } catch {
      // A precache entry that 404s fails the whole service-worker install.
      problems.push(`precache entry does not exist in the build: ${url}`);
    }
  }

  return { entries, totalBytes, problems };
}

function formatBytes(n) {
  return `${n.toLocaleString('en-US')} bytes (${(n / 1024 / 1024).toFixed(2)} MiB)`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = path.resolve(process.argv[2] ?? 'dist');
  const { entries, totalBytes, problems } = checkPrecache(distDir);
  console.log(`precache: ${entries.length} entries, ${formatBytes(totalBytes)}`);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
