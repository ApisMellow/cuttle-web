// Two-phone W11 (docs/two-phone-plan.md §10): the service worker must never
// cache or intercept calls to the game server. Workbox's precache and
// navigation routes match same-origin requests only, so the one way to break
// this is a `runtimeCaching` route. This cheap source check fails if one is
// added. W14 adds the full guard test (built worker, navigateFallback deny).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function configWithoutComments(): string {
  const raw = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('service worker and the game server', () => {
  it('declares no Workbox runtimeCaching route that could match the server origin', () => {
    const config = configWithoutComments();
    expect(config).toContain('VitePWA(');
    expect(config).not.toMatch(/runtimeCaching/);
  });

  it('does not route the service worker with a custom handler either', () => {
    const config = configWithoutComments();
    // injectManifest would hand routing to hand-written worker code.
    expect(config).not.toMatch(/injectManifest/);
    expect(config).not.toMatch(/strategies\s*:/);
  });
});
