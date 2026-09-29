// R18 (PRD R18, SPEC §5.8, §7.4 "R18 offline"): after one online visit the
// game boots and plays with no network, and a new build never reloads a
// game in progress.
//
// The dev server never registers a service worker, so this file builds the
// app the way the Pages workflow does (base /cuttle-web/, gallery copied in
// after the build) and serves it from its own static server on 127.0.0.1 at
// an OS-assigned port. Every test gets a fresh browser context, so a fresh
// worker registration and fresh storage. No test hook here: it exists only
// in dev builds, so moves are draws (legal with any hand), and the deal is
// seeded by pinning crypto.getRandomValues for the one New game tap.
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { buildForPages } from '../../scripts/build-pages.mjs';

const BASE = '/cuttle-web/';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// "Build B": a byte-different sw.js (all a browser needs to install it as an
// update) whose precache list also differs from A's: index.html has new
// content and a new revision, so installing B fetches a changed file and
// activating it drops A's entry. It also answers a 'build?' message so a
// test can tell which worker controls the page.
const BUILD_B_MARKER = '<!-- build B -->';
const BUILD_B_SUFFIX = `
self.addEventListener('message', (e) => { if (e.data === 'build?') e.source.postMessage('B'); });
`;

let tmp: string;
let dist: string;
let server: Server;
let origin: string;
let serveBuildB = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cuttle-offline-'));
  dist = buildForPages(path.join(tmp, 'dist'), { base: BASE });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    let body: Buffer | string = readFileSync(file);
    if (serveBuildB && rel === 'sw.js') {
      const patched = body.toString('utf8').replace(/(url:"index\.html",revision:")[0-9a-f]+"/, '$1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
      if (patched === body.toString('utf8')) throw new Error('sw.js has no index.html precache entry to change');
      body = patched + BUILD_B_SUFFIX;
    }
    if (serveBuildB && rel === 'index.html') body = body.toString('utf8') + BUILD_B_MARKER;
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
  serveBuildB = false;
});

const app = () => `${origin}${BASE}`;

/** Loads the app online and waits until the worker is active (precache done). */
async function firstVisit(page: Page): Promise<void> {
  await page.goto(app());
  await expect(page.getByTestId('home-screen')).toBeVisible();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(app());
}

/** Taps New game with the deal pinned to seed "42". */
async function newSeededGame(page: Page): Promise<void> {
  await page.getByTestId('name-input-0').fill('Alice');
  await page.getByTestId('name-input-1').fill('Blake');
  await page.evaluate(() => {
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(buf: T): T => {
      crypto.getRandomValues = real;
      if (buf instanceof Uint32Array && buf.length === 2) {
        buf[0] = 0;
        buf[1] = 42;
        return buf;
      }
      return real(buf as never) as T;
    }) as typeof crypto.getRandomValues;
  });
  await page.getByTestId('new-game').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  expect(await saved(page, (s) => s.seed)).toBe('42');
}

interface SaveShape {
  seed: string;
  history: unknown[];
}

async function saved<T>(page: Page, pick: (s: SaveShape) => T): Promise<T> {
  const raw = await page.evaluate(() => localStorage.getItem('cuttle-web:game'));
  expect(raw).not.toBeNull();
  return pick(JSON.parse(raw as string) as SaveShape);
}

/** handoff -> reveal via the two-step pill, then the recap if there is one. */
async function passThePhone(page: Page, { recap }: { recap: boolean }): Promise<void> {
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  await expect(page.getByTestId('board')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  if (recap) {
    await expect(page.getByTestId('recap')).toContainText('drew a card');
    await page.getByTestId('recap-dismiss').click();
  }
  await expect(page.getByTestId('board')).toBeVisible();
}

/** The player at the board draws a card; the phone is then passed. */
async function draw(page: Page): Promise<void> {
  const before = await saved(page, (s) => s.history.length);
  await page.getByTestId('deck-pile').click();
  await expect(page.getByTestId('staging-bar')).toContainText('Draw a card.');
  await page.getByTestId('staging-confirm').click();
  await expect(page.getByTestId('curtain-gate')).toBeVisible();
  expect(await saved(page, (s) => s.history.length)).toBe(before + 1);
}

/** Every hand-card image on screen decoded (served from the precache when offline). */
async function expectMythicFacesLoaded(page: Page): Promise<void> {
  const imgs = page.getByTestId('player-hand').locator('img');
  await expect(imgs.first()).toBeVisible();
  await expect
    .poll(() => imgs.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
  expect(await imgs.count()).toBeGreaterThanOrEqual(5);
}

async function passResumeGate(page: Page): Promise<void> {
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('curtain-gate')).toContainText('Resume game');
  await expect(page.getByTestId('board')).toHaveCount(0);
  await page.getByTestId('reveal-two-step').click();
  await page.getByTestId('reveal-two-step').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

test('R18.3: after one online visit the app boots offline and a seeded game plays through curtain passes', async ({ page, context }) => {
  await firstVisit(page);

  await context.setOffline(true);
  const failed: string[] = [];
  const network: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => {
    if (!r.fromServiceWorker()) network.push(r.url());
  });

  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible(); // only after the wasm engine booted
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // Mythic's catalog, manifest and faces all come from the precache.
  await page.getByTestId('theme-option-mythic').click();
  await newSeededGame(page);

  await passThePhone(page, { recap: false }); // the opening deal
  await expectMythicFacesLoaded(page);
  await draw(page); // wasm apply, offline
  await passThePhone(page, { recap: true });
  await expectMythicFacesLoaded(page);
  await draw(page);
  await passThePhone(page, { recap: true });
  await draw(page);
  expect(await saved(page, (s) => s.history.length)).toBe(3);

  expect(failed).toEqual([]);
  expect(network).toEqual([]);
});

test('R18.3: a save made online resumes offline', async ({ page, context }) => {
  await firstVisit(page);
  await newSeededGame(page);
  await passThePhone(page, { recap: false });
  await draw(page);
  await passThePhone(page, { recap: true });
  const save = await page.evaluate(() => localStorage.getItem('cuttle-web:game'));

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await passResumeGate(page);
  expect(await page.evaluate(() => localStorage.getItem('cuttle-web:game'))).toBe(save);

  await draw(page); // and play goes on
  await passThePhone(page, { recap: true });
});

test('R18 gallery: its navigations never get the app shell, online or offline', async ({ page, context }) => {
  await firstVisit(page);
  await page.goto(`${app()}gallery/`);
  await expect(page.locator('body[data-ready="true"]')).toHaveCount(1);
  await expect(page.getByTestId('app-shell')).toHaveCount(0);

  await context.setOffline(true);
  // Not precached and not a fallback: offline, the gallery simply isn't there.
  await expect(page.goto(`${app()}gallery/`)).rejects.toThrow();
  // The app itself is still there (a fresh tab: this one is on Chrome's error page).
  const tab = await context.newPage();
  await tab.goto(app());
  await expect(tab.getByTestId('home-screen')).toBeVisible();
});

test('R18 updates: a new build waits through a game, takes over at Home, and the save resumes on it', async ({ page }) => {
  await firstVisit(page);
  await page.reload(); // now controlled by build A's worker
  await newSeededGame(page);
  await passThePhone(page, { recap: false });
  await draw(page);
  await passThePhone(page, { recap: true });

  // A new deploy lands mid-game.
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  serveBuildB = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null))
    .toBe('installed');

  // It waits: no reload, no takeover, and play goes on.
  await page.waitForTimeout(1000);
  await draw(page);
  await passThePhone(page, { recap: true });
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null)).toBe(
    'installed',
  );
  const save = await page.evaluate(() => localStorage.getItem('cuttle-web:game'));

  // Home is a safe point: the new worker takes over and the page reloads once.
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu-home').click();
  await reloaded;
  await expect(page.getByTestId('home-screen')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBeUndefined();
  const build = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        navigator.serviceWorker.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
        navigator.serviceWorker.controller?.postMessage('build?');
      }),
  );
  expect(build).toBe('B');

  // Build B's precache list really differs: the shell in the cache is B's,
  // and A's copy of it is gone.
  const cachedShells = await page.evaluate(async () => {
    const texts: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (new URL(req.url).pathname.endsWith('/index.html')) texts.push(await (await cache.match(req))!.text());
      }
    }
    return texts;
  });
  expect(cachedShells).toHaveLength(1);
  expect(cachedShells[0]).toContain(BUILD_B_MARKER);

  // The save from build A resumes on build B, unchanged.
  expect(await page.evaluate(() => localStorage.getItem('cuttle-web:game'))).toBe(save);
  await passResumeGate(page);
  await draw(page);
});
