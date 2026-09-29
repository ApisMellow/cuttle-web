// Records the frames for the "tap the deck twice to draw" proof movie (issue #24).
//
// Films two real builds through the real UI on an iPhone 15 sized touch
// viewport (393x852 at 2x):
//   - before: the live site (https://apismellow.github.io/cuttle-web/), unmodified
//   - after:  a local production build of this tree, served by vite preview
// and writes numbered PNG frames at 10 fps into one directory per scene under
// <out>/frames/. Playwright is the web/ dev dependency; nothing new is installed.
//
// Usage: node demo/deck-double-tap/record.mjs [outDir]
//   (run `npm run build:wasm` and `npm run build` in web/ first; default outDir demo/deck-double-tap/out)

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../web');
const outDir = resolve(process.argv[2] ?? join(here, 'out')); // out/ is gitignored
const LIVE_URL = 'https://apismellow.github.io/cuttle-web/';
const PORT = 4181;
const LOCAL_URL = `http://localhost:${PORT}/`;
const FPS = 10;

const { chromium, devices } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- local production build served by vite preview -------------------------
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: webDir, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(LOCAL_URL)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}

const browser = await chromium.launch();
let exitCode = 0;
try {
  // A fresh context per site, so neither game inherits the other's saved state.
  async function newPhone() {
    const context = await browser.newContext({
      ...devices['iPhone 15'],
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });
    // Visible tap indicator: a ring that glides to each target, then pulses on touch.
    await context.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const ring = document.createElement('div');
        ring.id = '__tap-ring';
        ring.style.cssText =
          'position:fixed;left:-100px;top:-100px;width:44px;height:44px;border:4px solid rgba(255,64,129,.95);' +
          'background:rgba(255,64,129,.25);border-radius:50%;pointer-events:none;z-index:2147483647;' +
          'transform:translate(-50%,-50%);transition:left .55s ease-in-out,top .55s ease-in-out,transform .12s;';
        document.body.appendChild(ring);
        document.addEventListener('pointerdown', () => (ring.style.transform = 'translate(-50%,-50%) scale(.6)'), true);
        document.addEventListener('pointerup', () => (ring.style.transform = 'translate(-50%,-50%)'), true);
      });
    });
    return context.newPage();
  }

  let page = await newPhone();

  // --- frame capture: timestamped shots, resampled to a steady FPS per scene
  const scenes = {};
  let running = true;
  const t0 = Date.now();
  const marks = []; // {scene, at}
  const shots = []; // {at, buf}
  const capture = (async () => {
    while (running) {
      try {
        shots.push({ at: Date.now() - t0, buf: await page.screenshot({ type: 'png' }) });
      } catch {
        /* navigation or page swap raced the shot; drop the frame */
      }
    }
  })();
  const begin = (name) => marks.push({ scene: name, at: Date.now() - t0 });
  const pause = (ms) => sleep(ms);
  const tid = (id) => page.getByTestId(id);

  async function tapWithIndicator(locator) {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(([px, py]) => {
      const ring = document.getElementById('__tap-ring');
      ring.style.left = px + 'px';
      ring.style.top = py + 'px';
    }, [x, y]);
    await pause(750); // glide finishes, viewer sees where the finger is going
    await page.touchscreen.tap(x, y);
  }

  // Reveal the hand behind a curtain (two-step), dismissing a recap if one shows.
  async function reveal() {
    await tapWithIndicator(tid('reveal-two-step'));
    await pause(400);
    await tapWithIndicator(tid('reveal-two-step'));
    await page.locator('[data-testid="board"], [data-testid="recap"]').first().waitFor();
    if (await tid('recap').isVisible()) {
      await pause(2200); // let the recap be read
      await tapWithIndicator(tid('recap-dismiss'));
    }
    await tid('board').waitFor();
  }

  async function newGame(url) {
    await page.goto(url);
    await tid('name-input-0').waitFor();
    await pause(500);
    await tid('name-input-0').fill('Alice');
    await tid('name-input-1').fill('Blake');
    await pause(500);
    await tapWithIndicator(tid('new-game'));
    await tid('curtain-gate').waitFor();
    await pause(700);
    await reveal();
    await pause(900);
  }

  const deckCount = async () => Number((await tid('deck-pile').innerText()).trim());
  const handCount = () => tid('player-hand').locator('[data-testid^="hand-card-"]').count();
  const deckState = () => tid('deck-pile').getAttribute('data-state');
  const atCurtain = async () => (await tid('curtain-gate').isVisible()) && (await tid('board').count()) === 0;

  // --- before: the live site ------------------------------------------------
  begin('before-setup');
  await newGame(LIVE_URL);

  begin('before');
  await pause(600);
  await tapWithIndicator(tid('deck-pile'));
  await tid('staging-confirm').waitFor();
  await pause(1500);
  await tapWithIndicator(tid('deck-pile'));
  await pause(5500); // nothing happens; the Confirm bar is still waiting
  const beforeState = await deckState();
  const beforeConfirm = await tid('staging-confirm').isVisible();
  const beforeCurtain = await atCurtain();

  // --- after: the local build of the fix ------------------------------------
  const old = page;
  begin('after-setup');
  page = await newPhone();
  await old.context().close();
  await newGame(LOCAL_URL);
  const deckBefore = await deckCount();
  const handBefore = await handCount();

  begin('after');
  await pause(600);
  await tapWithIndicator(tid('deck-pile'));
  await tid('staging-confirm').waitFor();
  const afterFirstState = await deckState();
  await pause(1500);
  await tapWithIndicator(tid('deck-pile'));
  await tid('board').waitFor({ state: 'detached' });
  await tid('curtain-gate').waitFor();
  await pause(5000);
  const afterCurtain = await atCurtain();

  // --- landed: Blake's turn shows a deck one card smaller -------------------
  begin('landed');
  await pause(400);
  await reveal();
  await pause(4000);
  const deckAfter = await deckCount();

  begin('done');
  await pause(2500);
  const end = Date.now() - t0;

  running = false;
  await capture;

  const facts = { beforeState, beforeConfirm, beforeCurtain, deckBefore, handBefore, afterFirstState, afterCurtain, deckAfter };
  console.log(JSON.stringify(facts));
  if (beforeState !== 'staged' || !beforeConfirm || beforeCurtain) throw new Error('live site did not show the old behaviour');
  if (afterFirstState !== 'staged') throw new Error('first deck tap did not stage the draw');
  if (!afterCurtain) throw new Error('second deck tap did not go to the pass curtain');
  if (deckAfter !== deckBefore - 1) throw new Error(`deck count ${deckBefore} -> ${deckAfter}, expected one fewer`);

  // --- write frames
  const framesRoot = join(outDir, 'frames');
  rmSync(framesRoot, { recursive: true, force: true });
  marks.forEach((m, i) => {
    const from = m.at;
    const to = i + 1 < marks.length ? marks[i + 1].at : end;
    const dir = join(framesRoot, m.scene);
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let t = from; t < to; t += 1000 / FPS) {
      let pick = null;
      for (const s of shots) if (s.at <= t) pick = s;
      if (!pick) pick = shots[0];
      writeFileSync(join(dir, `f${String(++n).padStart(5, '0')}.png`), pick.buf);
    }
    scenes[m.scene] = n;
  });
  console.log('frames written:', JSON.stringify(scenes), 'to', framesRoot);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  preview.kill();
}
process.exit(exitCode);
