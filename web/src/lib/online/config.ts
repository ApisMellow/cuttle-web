// Two-phone W11 (docs/two-phone-plan.md §7 "Server origin"): where the game
// server lives. The Pages workflow sets VITE_CUTTLE_SERVER at build time;
// when it's unset, `serverOrigin()` is null and Play online stays hidden.
// A dev build (vite dev server) may point at a local server by setting
// localStorage[DEV_SERVER_OVERRIDE_KEY], e.g. to http://127.0.0.1:8080.
// W14 wires the full setting.

/** localStorage key read only in dev builds. */
export const DEV_SERVER_OVERRIDE_KEY = 'cuttle.online.devServer';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Returns the normalized origin (scheme://host[:port]) for a server setting,
 * or null when it isn't one. Only https, or plain http to a loopback host;
 * no path, query, fragment or credentials.
 */
export function parseServerOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  // A bare "?" or "#" parses to an empty search/hash; reject those too.
  if (/[?#]/.test(trimmed)) return null;
  return url.origin;
}

export interface OriginEnv {
  VITE_CUTTLE_SERVER?: string;
  DEV?: boolean;
}

export interface ResolveOptions {
  env: OriginEnv;
  storage?: Pick<Storage, 'getItem'>;
}

/** The server origin for these build values, or null if online play is off. */
export function resolveServerOrigin({ env, storage }: ResolveOptions): string | null {
  if (env.DEV === true && storage) {
    let override: string | null;
    try {
      override = storage.getItem(DEV_SERVER_OVERRIDE_KEY);
    } catch {
      override = null;
    }
    const parsed = parseServerOrigin(override);
    if (parsed !== null) return parsed;
  }
  return parseServerOrigin(env.VITE_CUTTLE_SERVER);
}

function defaultStorage(): Pick<Storage, 'getItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The configured server origin for this build, or null if online play is off. */
export function serverOrigin(): string | null {
  return resolveServerOrigin({
    env: { VITE_CUTTLE_SERVER: import.meta.env.VITE_CUTTLE_SERVER as string | undefined, DEV: import.meta.env.DEV },
    storage: defaultStorage(),
  });
}

/** The play socket's URL. It never carries the token or any query. */
export function webSocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/play';
  url.search = '';
  url.hash = '';
  return url.toString();
}
