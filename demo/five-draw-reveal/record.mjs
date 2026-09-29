// Records the frames for the "a 5 shows you what you drew" proof movie (issue #27).
//
// Films two real builds through the real UI on an iPhone 15 sized touch
// viewport (393x852 at 2x):
//   - before: the base commit without the fix (what the unfixed build runs), vite dev
//   - after:  this tree with the fix, vite dev
// and writes numbered PNG frames at 10 fps into one directory per scene under
// <out>/frames/. Playwright is the web/ dev dependency; nothing new is installed.
//
// Both runs reach the same moment: the golden seed-42 deal (dealer Blake),
// where Alice plays a 2 for points and Blake plays the 5 as a one-off. The
// only test hook used is `newGame(seed, dealer)`, to seed that deal; every
// move is a tap.
//
// Usage: node demo/five-draw-reveal/record.mjs [outDir]
//   BEFORE_WEB=<web/ of an unfixed checkout> node demo/five-draw-reveal/record.mjs
//   (`npm run build:wasm` in both web/ dirs first; default outDir demo/five-draw-reveal/out)

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../web');
const outDir = resolve(process.argv[2] ?? join(here, 'out')); // out/ is gitignored
const PORT_AFTER = 4182;
const PORT_BEFORE = 4183;
const FPS = 10;

const { chromium, devices } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- two dev servers (the test hook that seeds the golden deal is DEV-only) ---
// after:  this tree. before: a checkout of the commit this fix is based on
//         (BEFORE_WEB = its web/ directory), i.e. what the unfixed build runs.
const beforeWeb = process.env.BEFORE_WEB ? resolve(process.env.BEFORE_WEB) : null;
if (!beforeWeb) throw new Error('set BEFORE_WEB to the web/ directory of an unfixed checkout (the base commit)');
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
    await pause(700); // glide finishes, viewer sees where the finger is going
    await page.touchscreen.tap(x, y);
  }

  // Hand-off gate: two taps reveal the next player's screen.
  async function gate() {
    await tapWithIndicator(tid('reveal-two-step'));
    await pause(350);
    await tapWithIndicator(tid('reveal-two-step'));
  }

  async function dismissRecap() {
    await tid('recap').waitFor();
    await pause(1800); // let the recap be read
    await tapWithIndicator(tid('recap-dismiss'));
  }

  const hook = (fn, arg) => page.evaluate(fn, arg);
  async function findMove(pattern, kind) {
    const moves = await hook(() => window.__cuttleTestHook.moves());
    const m = moves.find((x) => x.kind === kind && pattern.test(x.description));
    if (!m) throw new Error(`no legal move matching ${pattern}`);
    return m;
  }
  const handCount = () => tid('player-hand').locator('[data-testid^="hand-card-"]').count();
  const squashedBody = () => page.evaluate(() => (document.body.textContent ?? '').replace(/\s+/g, ''));

  // Alice plays the 2 for points; Blake's screen; Blake plays the 5 one-off
  // (setup scene), then Alice resolves it and draws (five scene).
  async function playToFive(url, prefix) {
    begin(`${prefix}-setup`);
    await page.goto(url);
    await tid('name-input-0').waitFor();
    await pause(500);
    await tid('name-input-0').fill('Alice');
    await tid('name-input-1').fill('Blake');
    await pause(400);
    await tapWithIndicator(tid('new-game'));
    await tid('curtain-gate').waitFor();
    await page.waitForFunction(() => window.__cuttleTestHook !== undefined);
    await hook(() => window.__cuttleTestHook.newGame('42', 1)); // seed the golden deal only
    await pause(500);
    await gate();
    await tid('board').waitFor();
    await pause(700);

    const two = await findMove(/^play 2. as point card$/, 1);
    await tapWithIndicator(tid(`hand-card-${two.handIndex}`));
    await tapWithIndicator(tid('zone-points'));
    await tapWithIndicator(tid('staging-confirm'));
    await tid('curtain-gate').waitFor();
    await pause(600);
    await gate();
    await dismissRecap();
    await tid('board').waitFor();
    await pause(600);

    // Blake plays the 5 as a one-off.
    const five = await findMove(/^play 5. as one-off$/, 4);
    await tapWithIndicator(tid(`hand-card-${five.handIndex}`));
    await pause(500);
    await tapWithIndicator(tid('zone-oneoff'));
    await pause(500);
    await tapWithIndicator(tid('staging-confirm'));
    await tid('curtain-gate').waitFor();
    if ((await tid('draw-reveal').count()) !== 0) throw new Error('reveal shown before the pass');

    begin(`${prefix}-five`);
    await pause(500);
    // Alice takes the phone, lets the 5 resolve, and draws.
    await gate();
    await dismissRecap();
    await tid('counter-prompt').waitFor();
    await pause(1200);
    await tapWithIndicator(tid('counter-resolve'));
    await tid('board').waitFor();
    if ((await tid('draw-reveal').count()) !== 0) throw new Error("Alice's screen showed a reveal");
    await pause(900);
    await tapWithIndicator(tid('deck-pile'));
    await pause(500);
    await tapWithIndicator(tid('staging-confirm'));
    await tid('curtain-gate').waitFor();
    await pause(800);
    await gate();
    await tid('recap').waitFor();
    await pause(1800);
  }

  // --- before: the unfixed build ------------------------------------------------
  await playToFive(BEFORE_URL, 'before');
  begin('before-result');
  await tapWithIndicator(tid('recap-dismiss'));
  await tid('board').waitFor();
  const beforeReveal = await tid('draw-reveal').count();
  const beforeHand = await handCount();
  await pause(4500); // long enough for any 3 s reveal that might exist
  const beforeRevealLater = await tid('draw-reveal').count();

  // --- after: the fixed build of the fix ------------------------------------
  const old = page;
  page = await newPhone();
  await old.context().close();
  await playToFive(AFTER_URL, 'after');

  begin('after-reveal');
  await tapWithIndicator(tid('recap-dismiss'));
  await tid('draw-reveal').waitFor();
  const revealText = (await tid('draw-reveal').innerText()).replace(/\s+/g, ' ');
  const labels = await page
    .locator('[data-testid="draw-reveal"] [data-draw-slot][data-drawn="true"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, '')));
  await pause(1000); // backs travel, flip face up; it self-continues at 3 s, so tap before that
  await tapWithIndicator(tid('draw-reveal-continue'));
  await tid('board').waitFor();
  const afterHand = await handCount();
  await pause(2200);

  // --- privacy: Blake draws and passes; Alice's screens show none of it ------
  begin('after-pass');
  await tapWithIndicator(tid('deck-pile'));
  await pause(500);
  await tapWithIndicator(tid('staging-confirm'));
  await tid('curtain-gate').waitFor();
  let leaks = 0;
  const check = async () => {
    const body = await squashedBody();
    for (const l of labels) if (body.includes(l)) leaks++;
  };
  await check();
  await pause(2200);
  await gate();
  await tid('recap').waitFor();
  await check();
  await pause(2200);
  await tapWithIndicator(tid('recap-dismiss'));
  await tid('board').waitFor();
  await check();
  const aliceReveal = await tid('draw-reveal').count();
  await pause(2500);

  begin('done');
  await pause(2000);
  const end = Date.now() - t0;

  running = false;
  await capture;

  const facts = { beforeReveal, beforeRevealLater, beforeHand, revealText, labels, afterHand, leaks, aliceReveal };
  console.log(JSON.stringify(facts));
  if (beforeReveal !== 0 || beforeRevealLater !== 0) throw new Error('unfixed build showed a reveal');
  if (beforeHand !== 7) throw new Error(`before hand ${beforeHand}, expected 7`);
  if (!/You drew 2 cards/.test(revealText)) throw new Error('fixed build did not say "You drew 2 cards"');
  if (labels.length !== 2) throw new Error('expected two face-up drawn cards');
  if (afterHand !== 7) throw new Error(`local hand ${afterHand}, expected 7`);
  if (leaks !== 0 || aliceReveal !== 0) throw new Error("drawn cards leaked onto Alice's screens");

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
  for (const sv of servers) sv.kill();
}
process.exit(exitCode);
