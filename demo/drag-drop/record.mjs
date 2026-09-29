// Records the frames for the "drag a card onto a zone" proof movie (issue #26).
//
// Films two real builds through the real UI on an iPhone 15 sized touch
// viewport (393x852 at 2x), with real touch input (Chromium CDP
// Input.dispatchTouchEvent, so the browser's own gesture handling runs):
//   - before: BEFORE_WEB = the web/ dir of an unfixed checkout, vite dev
//   - after:  this tree, vite dev
// Both use the golden seed-42 deal: Alice holds 2 of hearts and acts first.
// The only test hook used is `newGame(seed, dealer)` to seed that deal.
//
// Usage: BEFORE_WEB=<web/ of an unfixed checkout> node demo/drag-drop/record.mjs [outDir]
//   (`npm run build:wasm` in both web/ dirs first; default outDir demo/drag-drop/out)

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../web');
const outDir = resolve(process.argv[2] ?? join(here, 'out')); // out/ is gitignored
const PORT_AFTER = Number(process.env.PORT_AFTER ?? 4184);
const PORT_BEFORE = Number(process.env.PORT_BEFORE ?? 4185);
const FPS = 10;

const { chromium, devices } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const beforeWeb = process.env.BEFORE_WEB ? resolve(process.env.BEFORE_WEB) : null;
if (!beforeWeb) throw new Error('set BEFORE_WEB to the web/ directory of an unfixed checkout');
const servers = [];
async function serve(dir, port) {
  const url = `http://127.0.0.1:${port}/`;
  servers.push(spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: dir, stdio: 'ignore' }));
  for (let i = 0; i < 100; i++) {
    try {
      const html = await (await fetch(url)).text();
      if (html.includes('<title>')) return url;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`dev server on ${port} did not come up`);
}
const BEFORE_URL = await serve(beforeWeb, PORT_BEFORE);
const AFTER_URL = await serve(webDir, PORT_AFTER);

const browser = await chromium.launch();
let exitCode = 0;
try {
  async function newPhone() {
    const context = await browser.newContext({
      ...devices['iPhone 15'],
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    // Finger indicator: glides between taps; follows the real touch while one is down.
    await context.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const ring = document.createElement('div');
        ring.id = '__tap-ring';
        const glide = 'left .55s ease-in-out,top .55s ease-in-out,transform .12s';
        ring.style.cssText =
          'position:fixed;left:-100px;top:-100px;width:44px;height:44px;border:4px solid rgba(255,64,129,.95);' +
          'background:rgba(255,64,129,.25);border-radius:50%;pointer-events:none;z-index:2147483647;' +
          'transform:translate(-50%,-50%);transition:' + glide;
        document.body.appendChild(ring);
        const at = (e) => {
          const t = e.touches[0];
          if (!t) return;
          ring.style.left = t.clientX + 'px';
          ring.style.top = t.clientY + 'px';
        };
        document.addEventListener('touchstart', (e) => {
          ring.style.transition = 'transform .12s';
          at(e);
          ring.style.transform = 'translate(-50%,-50%) scale(.7)';
        }, { capture: true, passive: true });
        document.addEventListener('touchmove', at, { capture: true, passive: true });
        document.addEventListener('touchend', () => {
          ring.style.transform = 'translate(-50%,-50%)';
          ring.style.transition = glide;
        }, { capture: true, passive: true });
      });
    });
    return context.newPage();
  }

  // Warm both dev servers first (vite optimizes deps on first load, which stalls screenshots).
  for (const u of [BEFORE_URL, AFTER_URL]) {
    const warm = await newPhone();
    await warm.goto(u);
    await warm.getByTestId('name-input-0').waitFor();
    await sleep(2500);
    await warm.context().close();
  }

  let page = await newPhone();
  const scenes = {};
  let running = true;
  const t0 = Date.now();
  const marks = [];
  const shots = [];
  const capture = (async () => {
    while (running) {
      try {
        shots.push({ at: Date.now() - t0, buf: await page.screenshot({ type: 'png', timeout: 3000 }) });
      } catch {
        /* page swap raced the shot; drop the frame */
      }
    }
  })();
  const begin = (name) => marks.push({ scene: name, at: Date.now() - t0 });
  const pause = sleep;
  const tid = (id) => page.getByTestId(id);
  const hook = (fn, arg) => page.evaluate(fn, arg);

  async function centre(id) {
    const b = await tid(id).boundingBox();
    if (!b) throw new Error(`${id} has no box`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function glideTo({ x, y }) {
    await page.evaluate(([px, py]) => {
      const r = document.getElementById('__tap-ring');
      r.style.left = px + 'px';
      r.style.top = py + 'px';
    }, [x, y]);
    await pause(700);
  }
  async function tap(id) {
    const p = await centre(id);
    await glideTo(p);
    await page.touchscreen.tap(p.x, p.y);
  }
  async function gate() {
    await tap('reveal-two-step');
    await pause(350);
    await tap('reveal-two-step');
  }

  // Real touch drag: smooth, many small steps, optional holds.
  let cdp;
  async function drag(from, waypoints) {
    cdp ??= await page.context().newCDPSession(page);
    await glideTo(from);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await pause(250);
    let last = from;
    for (const w of waypoints) {
      const steps = 34;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const e = k * k * (3 - 2 * k); // ease in and out
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: last.x + (w.x - last.x) * e, y: last.y + (w.y - last.y) * e }],
        });
        await pause(28);
      }
      last = w;
      await pause(w.hold ?? 0);
    }
    return async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
  }

  async function findTwo() {
    const moves = await hook(() => window.__cuttleTestHook.moves());
    const m = moves.find((x) => x.kind === 1 && /^play 2. as point card$/.test(x.description));
    if (!m) throw new Error('no 2 for points');
    return m.handIndex;
  }
  async function grip(handIndex) {
    const b = await tid(`hand-card-${handIndex}`).boundingBox();
    return { x: b.x + 16, y: b.y + b.height / 2 };
  }
  async function start(url) {
    await page.goto(url);
    await tid('name-input-0').waitFor();
    await pause(500);
    await tid('name-input-0').fill('Alice');
    await tid('name-input-1').fill('Blake');
    await pause(400);
    await tap('new-game');
    await tid('curtain-gate').waitFor();
    await page.waitForFunction(() => window.__cuttleTestHook !== undefined);
    await hook(() => window.__cuttleTestHook.newGame('42', 1));
    await pause(500);
    await gate();
    await tid('board').waitFor();
    await pause(900);
  }
  const seq = () => hook(() => window.__cuttleTestHook.seq());

  // --- before: unfixed build ----------------------------------------------------
  begin('before-setup');
  await start(BEFORE_URL);
  const bTwo = await findTwo();
  begin('before-drag');
  await pause(600);
  const bTarget = await centre('zone-points');
  const bEnd = await drag(await grip(bTwo), [{ x: bTarget.x, y: bTarget.y + 30, hold: 700 }, { ...bTarget, hold: 900 }]);
  const bDuring = await tid('zone-points').getAttribute('data-state');
  await bEnd();
  await pause(1800);
  const beforeStaged = await tid('staging-bar').count();
  const beforeSeq = await seq();

  // --- after: the fix -----------------------------------------------------------
  let old = page;
  page = await newPhone();
  cdp = undefined;
  await old.context().close();
  begin('after-setup');
  await start(AFTER_URL);
  const two = await findTwo();
  const card = tid(`hand-card-${two}`);
  const home = await card.boundingBox();

  begin('after-illegal');
  await pause(500);
  const perm = await centre('zone-permanents');
  const endIllegal = await drag(await grip(two), [{ ...perm, hold: 1000 }]);
  const illegalDuring = await tid('zone-permanents').getAttribute('data-state');
  const illegalDragging = await card.getAttribute('data-dragging');
  await endIllegal();
  await pause(2000);
  const illegalStaged = await tid('staging-bar').count();
  const backBox = await card.boundingBox();
  const snapped = Math.abs(backBox.x - home.x) < 1 && Math.abs(backBox.y - home.y) < 1;

  begin('after-drag');
  await pause(500);
  const pts = await centre('zone-points');
  const endDrag = await drag(await grip(two), [{ x: pts.x, y: pts.y + 40, hold: 900 }, { ...pts, hold: 800 }]);
  const lit = await tid('zone-points').getAttribute('data-state');
  const dragging = await card.getAttribute('data-dragging');
  await endDrag();
  await tid('staging-bar').waitFor();
  const stagedText = (await tid('staging-bar').innerText()).replace(/\s+/g, ' ');
  const seqStaged = await seq();
  await pause(2200);

  begin('after-confirm');
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  const seqDone = await seq();
  await pause(1200);
  await gate();
  await tid('recap').waitFor();
  await pause(2200);
  await tap('recap-dismiss');
  await tid('board').waitFor();
  await pause(1500);

  // --- tap path, fresh game -----------------------------------------------------
  old = page;
  page = await newPhone();
  cdp = undefined;
  await old.context().close();
  begin('tap-setup');
  await start(AFTER_URL);
  const two2 = await findTwo();
  begin('tap');
  await pause(500);
  await tap(`hand-card-${two2}`);
  await pause(600);
  await tap('zone-points');
  await tid('staging-bar').waitFor();
  await pause(1200);
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  const tapSeq = await seq();
  await pause(2200);

  begin('done');
  await pause(1500);
  const end = Date.now() - t0;
  running = false;
  await capture;

  console.log('first shot at', shots[0]?.at, 'of', marks[0].at);
  const facts = { bDuring, beforeStaged, beforeSeq, illegalDuring, illegalDragging, illegalStaged, snapped, lit, dragging, stagedText, seqStaged, seqDone, tapSeq };
  console.log(JSON.stringify(facts));
  if (beforeStaged !== 0 || beforeSeq !== 0) throw new Error('unfixed build staged a card from a drag');
  if (illegalDuring !== 'normal' || illegalDragging !== 'true') throw new Error('illegal zone lit, or card not dragging');
  if (illegalStaged !== 0 || !snapped) throw new Error('illegal drop did not snap back cleanly');
  if (lit !== 'highlighted' || dragging !== 'true') throw new Error('points not lit during the drag');
  if (!/2/.test(stagedText) || seqStaged !== 0) throw new Error('drop did not stage (or committed early)');
  if (seqDone !== 1 || tapSeq !== 1) throw new Error('confirm did not commit exactly one move');

  const framesRoot = join(outDir, 'frames-raw');
  const paddedRoot = join(outDir, 'frames');
  rmSync(framesRoot, { recursive: true, force: true });
  rmSync(paddedRoot, { recursive: true, force: true });
  marks.forEach((m, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].at : end;
    const dir = join(framesRoot, m.scene);
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let t = m.at; t < to; t += 1000 / FPS) {
      let pick = null;
      for (const s of shots) if (s.at <= t) pick = s;
      if (!pick) pick = shots[0];
      writeFileSync(join(dir, `f${String(++n).padStart(5, '0')}.png`), pick.buf);
    }
    scenes[m.scene] = n;
  });
  // Centre each phone frame on a taller black canvas: the burned-in subtitles
  // land in the empty band below the phone instead of over the cards.
  for (const name of Object.keys(scenes)) {
    mkdirSync(join(paddedRoot, name), { recursive: true });
    const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', join(framesRoot, name, 'f%05d.png'),
      '-vf', 'pad=1400:2184:307:0:black', join(paddedRoot, name, 'f%05d.png')]);
    if (r.status !== 0) throw new Error(`pad failed for ${name}: ${r.stderr}`);
  }
  console.log('frames written:', JSON.stringify(scenes));
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  for (const sv of servers) sv.kill();
}
process.exit(exitCode);
