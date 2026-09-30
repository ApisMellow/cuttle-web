// Two-phone W11 (docs/two-phone-plan.md §7 "Server origin"): the server
// origin comes from VITE_CUTTLE_SERVER at build time, never a hard-coded
// host. A dev build may override it from localStorage. W14: a production
// build accepts an https origin only (plain http to loopback is dev-only).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEV_SERVER_OVERRIDE_KEY,
  parseServerOrigin,
  resolveServerOrigin,
  webSocketUrl,
} from '../../src/lib/online/config';
import { onlineAvailable } from '../../src/lib/online/provider';
import { fakeStorage } from './game-test-support';

describe('parseServerOrigin', () => {
  it('accepts an https origin, with or without a trailing slash', () => {
    expect(parseServerOrigin('https://cuttle.example.com')).toBe('https://cuttle.example.com');
    expect(parseServerOrigin('https://cuttle.example.com/')).toBe('https://cuttle.example.com');
    expect(parseServerOrigin('  https://Cuttle.Example.com:8443  ')).toBe('https://cuttle.example.com:8443');
    expect(parseServerOrigin('https://cuttle.203-0-113-10.sslip.io')).toBe('https://cuttle.203-0-113-10.sslip.io');
  });

  it('accepts plain http only for a loopback host', () => {
    expect(parseServerOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(parseServerOrigin('http://localhost:8080')).toBe('http://localhost:8080');
    expect(parseServerOrigin('http://cuttle.example.com')).toBeNull();
  });

  it('rejects empty, relative, pathful and non-http values', () => {
    for (const bad of [undefined, null, '', '   ', 42, '/api', 'cuttle.example.com', 'wss://cuttle.example.com',
      'ftp://cuttle.example.com', 'https://cuttle.example.com/api', 'https://cuttle.example.com?x=1',
      'https://cuttle.example.com#x', 'https://user:pw@cuttle.example.com', 'javascript:alert(1)']) {
      expect(parseServerOrigin(bad), String(bad)).toBeNull();
    }
  });
});

describe('resolveServerOrigin', () => {
  it('is null when VITE_CUTTLE_SERVER is unset, so Play online stays hidden', () => {
    expect(resolveServerOrigin({ env: {} })).toBeNull();
    expect(resolveServerOrigin({ env: { VITE_CUTTLE_SERVER: '' } })).toBeNull();
  });

  it('reads the build-time VITE_CUTTLE_SERVER', () => {
    expect(resolveServerOrigin({ env: { VITE_CUTTLE_SERVER: 'https://cuttle.example.com' } })).toBe(
      'https://cuttle.example.com',
    );
  });

  it('is null for an invalid build-time value', () => {
    expect(resolveServerOrigin({ env: { VITE_CUTTLE_SERVER: 'cuttle.example.com' } })).toBeNull();
  });

  it('lets a dev build override the origin from localStorage', () => {
    const storage = fakeStorage();
    storage.setItem(DEV_SERVER_OVERRIDE_KEY, 'http://127.0.0.1:8080');
    expect(resolveServerOrigin({ env: { DEV: true, VITE_CUTTLE_SERVER: 'https://cuttle.example.com' }, storage })).toBe(
      'http://127.0.0.1:8080',
    );
    expect(resolveServerOrigin({ env: { DEV: true }, storage })).toBe('http://127.0.0.1:8080');
  });

  it('accepts only an https origin from a production build', () => {
    expect(resolveServerOrigin({ env: { DEV: false, VITE_CUTTLE_SERVER: 'http://127.0.0.1:8080' } })).toBeNull();
    expect(resolveServerOrigin({ env: { VITE_CUTTLE_SERVER: 'http://localhost:8080' } })).toBeNull();
    expect(resolveServerOrigin({ env: { DEV: true, VITE_CUTTLE_SERVER: 'http://localhost:8080' } })).toBe(
      'http://localhost:8080',
    );
  });

  it('ignores the override in a production build', () => {
    const storage = fakeStorage();
    storage.setItem(DEV_SERVER_OVERRIDE_KEY, 'http://127.0.0.1:8080');
    expect(resolveServerOrigin({ env: { DEV: false, VITE_CUTTLE_SERVER: 'https://cuttle.example.com' }, storage })).toBe(
      'https://cuttle.example.com',
    );
    expect(resolveServerOrigin({ env: {}, storage })).toBeNull();
  });

  it('falls back to the build value when the override is invalid or storage throws', () => {
    const storage = fakeStorage();
    storage.setItem(DEV_SERVER_OVERRIDE_KEY, 'not a url');
    const env = { DEV: true, VITE_CUTTLE_SERVER: 'https://cuttle.example.com' };
    expect(resolveServerOrigin({ env, storage })).toBe('https://cuttle.example.com');
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(resolveServerOrigin({ env, storage: throwing })).toBe('https://cuttle.example.com');
  });
});

describe('webSocketUrl', () => {
  it('maps https to wss and http to ws, at /api/play with no query', () => {
    expect(webSocketUrl('https://cuttle.example.com')).toBe('wss://cuttle.example.com/api/play');
    expect(webSocketUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/api/play');
  });
});

describe('onlineAvailable', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives from serverOrigin() in a production build', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_CUTTLE_SERVER', 'https://cuttle.example.com');
    expect(onlineAvailable()).toBe(true);
    // Not an origin serverOrigin() accepts: hidden, not merely non-empty.
    vi.stubEnv('VITE_CUTTLE_SERVER', 'http://cuttle.example.com');
    expect(onlineAvailable()).toBe(false);
    vi.stubEnv('VITE_CUTTLE_SERVER', 'http://127.0.0.1:8080');
    expect(onlineAvailable()).toBe(false);
    vi.stubEnv('VITE_CUTTLE_SERVER', '');
    expect(onlineAvailable()).toBe(false);
  });

  it('always shows the mode in a dev build (the fake backs it)', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_CUTTLE_SERVER', '');
    expect(onlineAvailable()).toBe(true);
  });
});

describe('Pages workflow', () => {
  const workflow = readFileSync(join(__dirname, '..', '..', '..', '.github', 'workflows', 'pages.yml'), 'utf8');

  it('passes VITE_CUTTLE_SERVER from the CUTTLE_SERVER_ORIGIN repo variable, not a secret', () => {
    expect(workflow).toMatch(/^\s+VITE_CUTTLE_SERVER: \$\{\{ vars\.CUTTLE_SERVER_ORIGIN \}\}\s*$/m);
    expect(workflow).not.toMatch(/secrets\.CUTTLE_SERVER/);
  });

  it('hard-codes no server host', () => {
    // Comments may name the Pages site; no executable line may hold a URL.
    const code = workflow.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/https?:\/\//);
  });
});
