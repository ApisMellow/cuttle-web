// Records the frames for the "a 5 shows you what you drew" proof movie
// (issues #27 and #23).
//
// Films real builds through the real UI on an iPhone 15 sized touch viewport
// (393x852 at 2x):
//   - before: BEFORE_WEB = the web/ dir of an unfixed checkout (current main), vite dev
//   - after:  this tree, vite dev
// and writes numbered PNG frames at 10 fps into one directory per scene under
// <out>/frames/, each padded onto a taller black canvas so the burned-in
// subtitles land in a band under the phone. Playwright is the web/ dev
// dependency; nothing new is installed.
//
// Three runs, all through taps:
//   1. before, seed 42 (dealer Blake): Alice plays a 2 for points, Blake plays
//      the 5 as a one-off. Alice holds no 2, yet the old build asks her to
//      "let it resolve", and nobody sees the drawn cards.
//   2. after, seed 42: the same moves. No prompt for Alice. Blake sees only his
//      two drawn cards, then the pass to Alice. Her screens never show them.
//   3. after, seed 21 (dealer Blake): Alice plays an 8 for points and keeps a
//      2. Blake plays a 5. Alice is asked to counter, straight after the pass
//      gate, with no recap screen first.
// The only test hook used is `newGame(seed, dealer)`, to seed the deals.
//
// Usage: BEFORE_WEB=<web/ of an unfixed checkout> node demo/five-draw-reveal/record.mjs [outDir]
//   (`npm run build:wasm` in both web/ dirs first; default outDir demo/five-draw-reveal/out)

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../web');
const outDir = resolve(process.argv[2] ?? join(here, 'out')); // out/ is gitignored
const PORT_AFTER = Number(process.env.PORT_AFTER ?? 4182);
const PORT_BEFORE = Number(process.env.PORT_BEFORE ?? 4183);
const FPS = 10;

const { chromium, devices } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- two dev servers (the test hook that seeds the deal is DEV-only) ---
const beforeWeb = process.env.BEFORE_WEB ? resolve(process.env.BEFORE_WEB) : null;
if (!beforeWeb) throw new Error('set BEFORE_WEB to the web/ directory of an unfixed checkout (current main)');
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

  async function tap(id) {
    const box = await tid(id).boundingBox();
    if (!box) throw new Error(`${id} has no box`);
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
  async function gate() {
    await tap('reveal-two-step');
    await pause(350);
    await tap('reveal-two-step');
  }
  async function dismissRecap() {
    await tid('recap').waitFor();
    await pause(1800); // let the recap be read
    await tap('recap-dismiss');
  }
  async function findMove(pattern, kind) {
    const moves = await hook(() => window.__cuttleTestHook.moves());
    const m = moves.find((x) => x.kind === kind && pattern.test(x.description));
    if (!m) throw new Error(`no legal move matching ${pattern}`);
    return m;
  }
  const handCount = () => tid('player-hand').locator('[data-testid^="hand-card-"]').count();
  const squashedBody = () => page.evaluate(() => (document.body.textContent ?? '').replace(/\s+/g, ''));

  // Up to the moment Blake has staged the 5 as a one-off (Confirm not yet tapped).
  async function playToStagedFive(url, seed, alicePoint) {
    await page.goto(url);
    await tid('name-input-0').waitFor();
    await pause(500);
    await tid('name-input-0').fill('Alice');
    await tid('name-input-1').fill('Blake');
    // Classic faces print rank and suit as text, so drawn cards can be named and searched for.
    if ((await tid('theme-option-vector').count()) > 0) await tid('theme-option-vector').click();
    await pause(400);
    await tap('new-game');
    await tid('curtain-gate').waitFor();
    await page.waitForFunction(() => window.__cuttleTestHook !== undefined);
    await hook((s) => window.__cuttleTestHook.newGame(s, 1), seed);
    await pause(500);
    await gate();
    await tid('board').waitFor();
    await pause(900);

    const pt = await findMove(alicePoint, 1);
    await tap(`hand-card-${pt.handIndex}`);
    await tap('zone-points');
    await tap('staging-confirm');
    await tid('curtain-gate').waitFor();
    await pause(600);
    await gate();
    await dismissRecap();
    await tid('board').waitFor();
    await pause(600);

    const five = await findMove(/^play 5. as one-off$/, 4);
    await tap(`hand-card-${five.handIndex}`);
    await pause(500);
    await tap('zone-oneoff');
    await pause(700);
  }

  // === 1. before: the unfixed build, seed 42 ====================================
  begin('before-setup');
  await playToStagedFive(BEFORE_URL, '42', /^play 2. as point card$/);
  begin('before-five');
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  await pause(600);
  await gate();
  await dismissRecap();
  await tid('counter-prompt').waitFor();
  const beforePrompt = await tid('counter-resolve').count();
  await pause(2800);
  begin('before-result');
  await tap('counter-resolve');
  await tid('board').waitFor();
  const beforeReveal = await tid('draw-reveal').count();
  await pause(3800); // long enough for any 3 s reveal that might exist
  const beforeRevealLater = await tid('draw-reveal').count();

  // === 2. after: this tree, seed 42 =============================================
  let old = page;
  page = await newPhone();
  await old.context().close();
  begin('after-setup');
  await playToStagedFive(AFTER_URL, '42', /^play 2. as point card$/);
  begin('after-reveal');
  await tap('staging-confirm');
  await tid('draw-reveal').waitFor();
  const noCurtainAtReveal = (await tid('curtain-gate').count()) === 0;
  const noPromptAtReveal = (await tid('counter-prompt').count()) === 0;
  const revealText = (await tid('draw-reveal').innerText()).replace(/\s+/g, ' ');
  const labels = await page
    .locator('[data-testid="draw-reveal"] [data-draw-slot][data-drawn="true"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, '')));
  const slotCount = await page.locator('[data-testid="draw-reveal"] [data-draw-slot]').count();
  await pause(1400); // backs travel, flip face up; it self-continues at 3 s, so tap before that
  await tap('draw-reveal-continue');

  begin('after-pass');
  await tid('curtain-gate').waitFor();
  let leaks = 0;
  const check = async () => {
    const body = await squashedBody();
    for (const l of labels) if (body.includes(l)) leaks++;
  };
  await check();
  await pause(2000);
  await gate();
  await tid('recap').waitFor();
  const promptAtRecap = await tid('counter-prompt').count();
  await check();
  await pause(1800);
  await tap('recap-dismiss');
  await tid('board').waitFor();
  await check();
  const aliceReveal = await tid('draw-reveal').count();
  const alicePrompt = await tid('counter-prompt').count();
  await pause(2500);

  // === 3. after: an opponent who does hold a 2, seed 21 =========================
  old = page;
  page = await newPhone();
  await old.context().close();
  begin('two-setup');
  await playToStagedFive(AFTER_URL, '21', /^play 8. as point card$/);
  begin('two-counter');
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  await pause(600);
  await gate();
  await tid('counter-prompt').waitFor();
  const recapBeforePrompt = await tid('recap').count();
  await pause(3000);
  begin('two-resolve');
  await tap('counter-resolve');
  await tid('board').waitFor();
  await pause(1500);
  await tap('deck-pile');
  await pause(500);
  await tap('staging-confirm');
  await tid('curtain-gate').waitFor();
  await pause(900);
  await gate();
  await dismissRecap();
  await tid('draw-reveal').waitFor();
  const twoText = (await tid('draw-reveal').innerText()).replace(/\s+/g, ' ');
  await pause(1600);
  await tap('draw-reveal-continue');
  await pause(1000);
  begin('done');
  await pause(1500);
  const end = Date.now() - t0;

  running = false;
  await capture;

  const facts = {
    beforePrompt, beforeReveal, beforeRevealLater,
    noCurtainAtReveal, noPromptAtReveal, revealText, labels, slotCount,
    promptAtRecap, leaks, aliceReveal, alicePrompt, recapBeforePrompt, twoText,
  };
  console.log(JSON.stringify(facts));
  if (beforePrompt !== 1) throw new Error('unfixed build did not ask Alice to let it resolve');
  if (beforeReveal !== 0 || beforeRevealLater !== 0) throw new Error('unfixed build showed a reveal');
  if (!noCurtainAtReveal || !noPromptAtReveal) throw new Error('reveal was not immediate, or Alice was prompted');
  if (!/You drew 2 cards/.test(revealText)) throw new Error('fixed build did not say "You drew 2 cards"');
  if (labels.length !== 2 || slotCount !== 2) throw new Error('expected exactly two drawn cards in the reveal');
  if (promptAtRecap !== 0 || alicePrompt !== 0) throw new Error('Alice, holding no 2, was prompted');
  if (leaks !== 0 || aliceReveal !== 0) throw new Error("drawn cards leaked onto Alice's screens");
  if (recapBeforePrompt !== 0) throw new Error('a recap screen came before the counter prompt');

  // --- write frames, padded onto a taller black canvas (subtitle band under the phone)
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
  for (const name of Object.keys(scenes)) {
    mkdirSync(join(paddedRoot, name), { recursive: true });
    const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', join(framesRoot, name, 'f%05d.png'),
      '-vf', 'pad=1400:2500:307:0:black', join(paddedRoot, name, 'f%05d.png')]);
    if (r.status !== 0) throw new Error(`pad failed for ${name}: ${r.stderr}`);
  }
  console.log('frames written:', JSON.stringify(scenes), 'to', paddedRoot);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  for (const sv of servers) sv.kill();
}
process.exit(exitCode);
