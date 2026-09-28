import { svelte } from '@sveltejs/vite-plugin-svelte';
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

export default defineConfig({
  base,
  plugins: [svelte()],
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
