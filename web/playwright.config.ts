import { defineConfig, devices } from '@playwright/test';

// SPEC §7.4: real browser, 390x844 portrait (a phone viewport), single
// chromium project. `webServer` runs the Vite dev server so `npm run
// test:e2e` is a one-shot command with no manual build/server step.
//
// Round 2 W7 F5: scripts/ci.sh picks a free port per run and exports it as
// CUTTLE_E2E_PORT, so several loop worktrees (up to 4 per round) running
// the gate at once each get their own dev server instead of fighting over
// one fixed port — which, now that F1 makes a port clash fail loudly
// instead of silently reusing another worktree's server, would otherwise
// turn into spurious failures. A plain `npm run test:e2e`
// (CUTTLE_E2E_PORT unset) falls back to 4173, unchanged from before.
const PORT = Number(process.env.CUTTLE_E2E_PORT) || 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
