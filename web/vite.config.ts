import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// SPEC §1.3 / §2.3: static build artifacts (cuttle.wasm, wasm_exec.js) live
// in web/static/ and are fetched at runtime from root-relative paths
// ('/cuttle.wasm', '/wasm_exec.js'). Vite's default publicDir is "public";
// pointed at "static" so those artifacts land in dist/ untouched by the
// bundler and are served at "/" in both dev and build (see
// docs/assumptions.md).
export default defineConfig({
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
