#!/usr/bin/env node
// W16 (GitHub Pages deploy prep, PRD §10 A-4). One-shot local proof that
// the production build works when served out of a subpath, the way
// https://apismellow.github.io/cuttle-web/ will serve it — not something
// `npm run dev` or the default `npm run build` (base '/') can show.
//
// Deliberately NOT part of scripts/ci.sh (SPEC §7.6's nine rows): it builds
// with a non-default base, so wiring it into the gate would make ci.sh fail
// under its own default base. Run it by hand from web/:
//
//   node scripts/verify-pages-subpath.mjs
//
// It rebuilds the wasm bridge, builds web/ with CUTTLE_BASE set to the Pages
// subpath, serves the result from a throwaway directory laid out the way
// GitHub Pages serves a project site (dist/ under a /<repo>/ prefix, not at
// the origin root), then drives a real Chromium tab and checks:
//   - the app shell mounts and reaches the home screen (which only happens
//     after ensureEngine() resolves — see web/src/App.svelte's screen
//     derivation — so this is the WASM-boot proof, the static-build
//     equivalent of the golden-deal walking-skeleton check)
//   - every request the page makes resolves (no 404s under the subpath)
//   - no console errors or uncaught page errors
//   - the manifest link and its icons, and the apple-touch-icon link, both
//     read from the served DOM, fetch 200 under the subpath (W23,
//     add-to-home-screen)
//
// No service-worker check: `vite-plugin-pwa` (SPEC §5.8, R18) isn't wired
// up yet. "PWA/offline polish" is explicitly deferred past the family beta
// (docs/loop-workflow.md §4.5), so there is no service worker to register
// yet, under any base. When it lands, this script is where a
// `navigator.serviceWorker.ready` + scope-prefix check belongs.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { mkdtemp, symlink, rm } from 'node:fs/promises';

import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
// This script lives in web/scripts/ (not the repo-root scripts/) so its
// bare `@playwright/test` import resolves via web/node_modules — a plain
// ESM import walks up node_modules from the importing file's own path, not
// from $CWD, and the repo-root scripts/ directory has no node_modules of
// its own.
const webDir = path.resolve(here, '..');
const repoRoot = path.resolve(webDir, '..');
const distDir = path.join(webDir, 'dist');

const BASE_PATH = process.env.CUTTLE_BASE_PATH ?? '/cuttle-web/';
const basePathNoSlashes = BASE_PATH.replace(/^\/|\/$/g, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function log(...args) {
  console.log('[verify-pages-subpath]', ...args);
}

async function buildFresh() {
  log('building web/static/cuttle.wasm …');
  execFileSync(path.join(repoRoot, 'scripts', 'build-wasm.sh'), { stdio: 'inherit' });

  log(`building web/dist with CUTTLE_BASE=${BASE_PATH} …`);
  execFileSync('npm', ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, CUTTLE_BASE: BASE_PATH },
  });
}

async function startServer(serveRoot) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let filePath = path.join(serveRoot, decodeURIComponent(url.pathname));
      let st = await stat(filePath).catch(() => null);
      if (st?.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        st = await stat(filePath).catch(() => null);
      }
      if (!st) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { server, port };
}

async function main() {
  await buildFresh();

  // Lay out a throwaway root the way GitHub Pages serves a project site:
  // the built app under /<repo>/ , not at the origin root.
  const serveRoot = await mkdtemp(path.join(os.tmpdir(), 'cuttle-pages-'));
  await symlink(distDir, path.join(serveRoot, basePathNoSlashes));

  const { server, port } = await startServer(serveRoot);
  const url = `http://127.0.0.1:${port}${BASE_PATH}`;
  log(`serving ${distDir} at ${url}`);

  const failures = [];
  const requests = [];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') failures.push(`console error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => failures.push(`uncaught page error: ${err.message}`));
    page.on('requestfailed', (req) => {
      failures.push(`request failed: ${req.url()} — ${req.failure()?.errorText}`);
    });
    page.on('response', (res) => {
      requests.push({ url: res.url(), status: res.status() });
      if (res.status() >= 400) failures.push(`HTTP ${res.status()}: ${res.url()}`);
    });

    await page.goto(url, { waitUntil: 'load' });

    try {
      await page.waitForSelector('[data-testid="home-screen"]', { timeout: 15_000 });
      log('home-screen reached — WASM engine booted under the subpath');
    } catch {
      const status = await page.getAttribute('[data-testid="engine-status"]', 'data-testid').catch(() => null);
      failures.push(
        `timed out waiting for [data-testid="home-screen"]` +
          (status ? ' (app is stuck on the loading/boot-failed screen)' : ' (app-shell never mounted)'),
      );
    }

    // W23 (add-to-home-screen): the manifest link, its icons, and the
    // apple-touch-icon are read straight from the served DOM rather than
    // hardcoded here, so this proves what the *page* actually references
    // resolves under the subpath — not just that files with the expected
    // names happen to exist. Fetched explicitly with page.request.get
    // rather than relied on as passive page.on('response') traffic,
    // because a headless Chromium isn't guaranteed to fetch an
    // apple-touch-icon (a Safari/iOS affordance) on its own.
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    if (!manifestHref) {
      failures.push('no <link rel="manifest"> in the served index.html');
    } else {
      const manifestUrl = new URL(manifestHref, page.url()).toString();
      const manifestRes = await page.request.get(manifestUrl);
      if (!manifestRes.ok()) {
        failures.push(`manifest fetch failed: HTTP ${manifestRes.status()} at ${manifestUrl}`);
      } else {
        log(`manifest OK at ${manifestUrl}`);
        const manifest = await manifestRes.json();
        const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
        if (icons.length === 0) {
          failures.push(`manifest at ${manifestUrl} has no icons`);
        }
        for (const icon of icons) {
          const iconUrl = new URL(icon.src, manifestUrl).toString();
          const iconRes = await page.request.get(iconUrl);
          if (!iconRes.ok()) {
            failures.push(`manifest icon fetch failed: HTTP ${iconRes.status()} at ${iconUrl}`);
          } else {
            log(`manifest icon OK (${icon.sizes ?? '?'}) at ${iconUrl}`);
          }
        }
      }
    }

    const appleTouchIconHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    if (!appleTouchIconHref) {
      failures.push('no <link rel="apple-touch-icon"> in the served index.html');
    } else {
      const appleTouchIconUrl = new URL(appleTouchIconHref, page.url()).toString();
      const appleTouchIconRes = await page.request.get(appleTouchIconUrl);
      if (!appleTouchIconRes.ok()) {
        failures.push(`apple-touch-icon fetch failed: HTTP ${appleTouchIconRes.status()} at ${appleTouchIconUrl}`);
      } else {
        log(`apple-touch-icon OK at ${appleTouchIconUrl}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
    await rm(serveRoot, { recursive: true, force: true });
  }

  log(`${requests.length} requests observed, ${requests.filter((r) => r.status >= 400).length} with a 4xx/5xx status`);

  if (failures.length > 0) {
    log('FAIL —');
    for (const f of failures) log(' -', f);
    process.exitCode = 1;
    return;
  }
  log('PASS — app loaded, engine booted, zero 404s, under', BASE_PATH);
}

await main();
