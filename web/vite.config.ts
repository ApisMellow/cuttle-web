import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// SPEC §1.3 / §2.3: static build artifacts (cuttle.wasm, wasm_exec.js) live
// in web/static/ and are fetched at runtime from root-relative paths
// ('/cuttle.wasm', '/wasm_exec.js'). Vite's default publicDir is "public";
// pointed at "static" so those artifacts land in dist/ untouched by the
// bundler and are served at "/" in both dev and build (see
// docs/assumptions.md).
// W16 (GitHub Pages deploy prep): the beta site is served at a subpath
// (https://apismellow.github.io/cuttle-web/), not at the origin root. Vite's
// `base` controls every asset URL it emits itself (index.html's script/link
// tags, JS-imported assets); `import.meta.env.BASE_URL` mirrors this value
// at runtime for the two runtime-fetched files vite never touches
// (web/src/lib/bridge/wasm.ts loads /wasm_exec.js and /cuttle.wasm out of
// publicDir by hand, not via import). CUTTLE_BASE lets the Pages workflow
// opt into the subpath without changing local dev or scripts/ci.sh, both of
// which stay at the '/' default.
const base = process.env.CUTTLE_BASE ?? '/';

// R10 (deploy safety, SPEC §2.3): the two runtime-fetched engine files keep
// fixed names in publicDir, so their URLs carry a content token instead. It
// is a hash of wasm_exec.js + cuttle.wasm as they are when the config
// loads (scripts/ci.sh and the Pages workflow build the wasm first), so a
// new engine gets a new URL and a browser can never pair a cached old
// engine with new JS. 'dev' when the files don't exist yet.
function engineVersion(): string {
  const hash = createHash('sha256');
  try {
    for (const name of ['wasm_exec.js', 'cuttle.wasm']) {
      hash.update(readFileSync(fileURLToPath(new URL(`./static/${name}`, import.meta.url))));
    }
  } catch {
    return 'dev';
  }
  return hash.digest('hex').slice(0, 16);
}

export default defineConfig({
  base,
  plugins: [
    svelte(),
    // R18 (SPEC §5.8): offline after one visit. `generateSW` precaches the
    // whole build; the service worker and its scope sit at `base`, so on
    // Pages they are /cuttle-web/sw.js and /cuttle-web/. Only `vite build`
    // emits a worker; the dev server never registers one.
    VitePWA({
      // Update policy (SPEC §5.8): a new worker installs in the background
      // and WAITS. It never calls skipWaiting on its own and never claims a
      // running page, so a game in progress keeps the engine it started
      // with. lib/pwa/update.ts decides when to let it take over: the next
      // launch, or when the player is on the home screen.
      registerType: 'prompt',
      // lib/pwa/register.ts registers the worker itself (prod builds only).
      injectRegister: false,
      // The hand-written static/manifest.webmanifest (W23) stays the one
      // manifest; the plugin doesn't generate a second.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{html,js,css,wasm,json,webmanifest,png,svg,webp,woff2}'],
        // The gallery is a separate page (pages.yml copies it in after the
        // build); this keeps it out even if it ever lands in static/.
        globIgnores: ['gallery/**'],
        // REQUIRED: the default is 2 MiB and the ~3.4 MiB raw .wasm would be
        // silently skipped, so the app would fail offline with no build
        // error (§2.2). tests/smoke/precache-manifest.mjs fails if it is.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // The engine files are fetched as cuttle.wasm?v=<hash> (R10). The
        // worker serves the copy from its own build, so the token can be
        // ignored when matching the precache.
        ignoreURLParametersMatching: [/^v$/],
        // Navigations in scope fall back to the app shell, except the gallery
        // and /api/ (REST and the /api/play socket): a navigation there must
        // reach the network, never be answered with the app shell (plan §10).
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/\/gallery(\/|$)/, /\/api(\/|\?|$)/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        // No runtimeCaching: nothing outside the build is ever cached.
      },
      devOptions: { enabled: false },
    }),
  ],
  define: {
    __CUTTLE_ENGINE_VERSION__: JSON.stringify(engineVersion()),
  },
  publicDir: 'static',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
  },
  // docs/vendor/svelte-5-llms.txt, "Component testing": Vitest runs under
  // Node, so without the `browser` export condition `svelte`'s package
  // exports resolve to the SSR stub (no real `mount`/`unmount`).
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
});
