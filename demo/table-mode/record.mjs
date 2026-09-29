// Records the frames for the "table mode" proof movie (issue #37).
//
// One build (this tree, vite dev), filmed twice through the real UI on an
// iPhone 15 sized touch viewport (393x852 at 2x) with real touch input
// (Chromium CDP Input.dispatchTouchEvent):
//   - before: the Home toggle left off (normal mode). Blake's turn flips the
//     board and the handoff says "Pass the phone to Blake".
//   - after:  the Home toggle "Table mode" switched on by tapping it. Alice is
//     upright at the bottom edge, Blake's screens are turned 180 degrees.
// Both use the golden seed-42 deal (Alice acts first). The only test hook used
// is `newGame(seed, dealer)` to seed the deal, plus read-only `moves()` to pick
// a point card for Blake.
//
// Usage: node demo/table-mode/record.mjs [outDir]
//   (`npm run build:wasm` in web/ first; default outDir demo/table-mode/out)

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../web');
const outDir = resolve(process.argv[2] ?? join(here, 'out')); // out/ is gitignored
const PORT = Number(process.env.PORT ?? 4186);
const FPS = 10;

const { chromium, devices } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const URL_ = await serve(webDir, PORT);

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


  // Warm the dev server (vite optimizes deps on first load, which stalls screenshots).
  const warm = await newPhone();
  await warm.goto(URL_);
  await warm.getByTestId('name-input-0').waitFor();
  await sleep(2500);
  await warm.context().close();

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


  // A point on the card that is really the card (fanned cards overlap).
  async function grip(handIndex) {
    const id = `hand-card-${handIndex}`;
    const b = await tid(id).boundingBox();
    for (let fx = 0.1; fx < 1; fx += 0.1) {
      const p = { x: b.x + b.width * fx, y: b.y + b.height / 2 };
      const ok = await page.evaluate(([x, y, want]) => document.elementFromPoint(x, y)?.closest('[data-testid^="hand-card-"]')?.getAttribute('data-testid') === want, [p.x, p.y, id]);
      if (ok) return p;
    }
    throw new Error(`no grip on ${id}`);
  }
  async function pointCard() {
    const moves = await hook(() => window.__cuttleTestHook.moves());
    const m = moves.find((x) => x.kind === 1 && /as point card$/.test(x.description));
    if (!m) throw new Error('no point card');
    return m.handIndex;
  }
  const seq = () => hook(() => window.__cuttleTestHook.seq());
  const gateText = async () => (await tid('curtain-gate').innerText()).replace(/\s+/g, ' ');
  const handY = async () => {
    const b = await tid('player-hand').boundingBox();
    return b.y + b.height / 2;
  };

  async function home(url) {
    await page.goto(url);
    await tid('name-input-0').waitFor();
    await pause(500);
    await tid('name-input-0').fill('Alice');
    await tid('name-input-1').fill('Blake');
    await pause(600);
  }
  async function startGame() {
    await tap('new-game');
    await tid('curtain-gate').waitFor();
    await page.waitForFunction(() => window.__cuttleTestHook !== undefined);
    await hook(() => window.__cuttleTestHook.newGame('42', 1));
    await pause(700);
  }
  async function alicePlays() {
    const two = await pointCard();
    await pause(500);
    await tap(`hand-card-${two}`);
    await pause(600);
    await tap('zone-points');
    await tid('staging-bar').waitFor();
    await pause(900);
    await tap('staging-confirm');
    await tid('curtain-gate').waitFor();
  }
  async function skipRecap() {
    await tid('recap').waitFor({ timeout: 4000 }).catch(() => {});
    if (await tid('recap').count()) {
      await pause(1500);
      await tap('recap-dismiss');
    }
    await tid('board').waitFor();
  }
  async function swapPhone() {
    const old = page;
    page = await newPhone();
    cdp = undefined;
    await old.context().close();
  }

  // --- before: normal mode --------------------------------------------------------
  begin('before-alice');
  await home(URL_);
  await startGame();
  await gate();
  await tid('board').waitFor();
  const beforeAliceHandY = await handY();
  await pause(1600);
  await alicePlays();
  begin('before-blake');
  const beforeGate = await gateText();
  await pause(2800);
  await gate();
  await skipRecap();
  await pause(600);
  const beforeBlakeHandY = await handY();
  await pause(2200);

  // --- after: table mode ----------------------------------------------------------
  await swapPhone();
  begin('after-home');
  await home(URL_);
  await pause(800);
  await tap('table-mode-toggle');
  await pause(1600);
  const toggled = await tid('table-mode-toggle').locator('input').isChecked();
  await startGame();
  begin('after-alice');
  await gate();
  await tid('board').waitFor();
  const afterAliceHandY = await handY();
  await pause(2400);
  await alicePlays();
  begin('after-handoff');
  const afterGate = await gateText();
  await pause(3200);
  await gate();
  await skipRecap();
  begin('after-blake');
  await pause(500);
  const afterBlakeHandY = await handY();
  await pause(2800);

  begin('after-drag');
  const card = await pointCard();
  const cardEl = tid(`hand-card-${card}`);
  const pts = await centre('zone-points');
  await pause(400);
  const endDrag = await drag(await grip(card), [{ x: pts.x, y: pts.y + (pts.y > 426 ? -40 : 40), hold: 900 }, { ...pts, hold: 900 }]);
  const lit = await tid('zone-points').getAttribute('data-state');
  const dragging = await cardEl.getAttribute('data-dragging');
  await endDrag();
  await tid('staging-bar').waitFor();
  const seqStaged = await seq();
  await pause(2200);

  begin('after-confirm');
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  const seqDone = await seq();
  await pause(1500);
  await gate();
  await skipRecap();
  const backHandY = await handY();
  await pause(2600);

  begin('done');
  await pause(1200);
  const end = Date.now() - t0;
  running = false;
  await capture;

  const facts = { beforeGate, beforeAliceHandY, beforeBlakeHandY, toggled, afterGate, afterAliceHandY, afterBlakeHandY, lit, dragging, seqStaged, seqDone, backHandY };
  console.log(JSON.stringify(facts));
  if (!/Pass the phone to Blake/i.test(beforeGate)) throw new Error('normal mode handoff copy wrong');
  if (!(beforeAliceHandY > 426 && beforeBlakeHandY > 426)) throw new Error('normal mode: hand not at the bottom for both');
  if (!toggled) throw new Error('toggle did not turn on');
  if (!/Blake's turn/.test(afterGate) || /Pass the phone/.test(afterGate)) throw new Error('table mode handoff copy wrong');
  if (!(afterAliceHandY > 426)) throw new Error('table mode: Alice hand not at bottom');
  if (!(afterBlakeHandY < 426)) throw new Error('table mode: Blake hand not at physical top');
  if (lit !== 'highlighted' || dragging !== 'true') throw new Error('points not lit during the turned drag');
  if (seqStaged !== 1 || seqDone !== 2) throw new Error(`unexpected move counts ${seqStaged}/${seqDone}`);
  if (!(backHandY > 426)) throw new Error('Alice not back at the bottom');

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
      '-vf', 'pad=1400:2500:307:0:black', join(paddedRoot, name, 'f%05d.png')]);
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
