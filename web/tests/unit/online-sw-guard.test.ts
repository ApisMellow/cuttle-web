// Two-phone W11 (docs/two-phone-plan.md §10): the service worker must never
// cache or intercept calls to the game server. Workbox's precache and
// navigation routes match same-origin requests only, so the one way to break
// this is a `runtimeCaching` route. This cheap source check fails if one is
// added. W14 adds the navigateFallback denylist check for the server's paths.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function configWithoutComments(): string {
  const raw = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
  return raw
    // Only block comments that open a line: globs like '**/*.{html}' hold "/*".
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
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

  it('denies the API and the play socket path on the navigation fallback', () => {
    const config = configWithoutComments();
    const match = config.match(/navigateFallbackDenylist:\s*(\[[^\]]*\])/);
    expect(match, 'navigateFallbackDenylist is declared').not.toBeNull();
    const denylist = new Function(`return ${match![1]}`)() as RegExp[];
    // Workbox tests each pattern against pathname + search of the navigation.
    const denied = (path: string) => denylist.some((re) => re.test(path));
    for (const path of ['/api/rooms', '/api/play', '/cuttle-web/api/rooms/ABCD/join', '/api', '/api/healthz?x=1']) {
      expect(denied(path), path).toBe(true);
    }
    // The gallery stays denied, and ordinary app navigations still fall back.
    expect(denied('/cuttle-web/gallery/')).toBe(true);
    for (const path of ['/', '/cuttle-web/', '/cuttle-web/#/join/ABCD', '/apiary', '/rapid/']) {
      expect(denied(path), path).toBe(false);
    }
  });
});
