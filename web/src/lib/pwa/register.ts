// R18 (SPEC §5.8): registers the service worker that makes the game work
// offline, and wires the update policy in ./update.ts to the browser.
//
// Production builds only. The dev server never emits a worker
// (vite.config.ts `devOptions.enabled: false`), so dev and the e2e suite
// that runs against it are unaffected.
import { createUpdatePolicy, type UpdatePolicy, type UpdateScreen } from './update';

/** sessionStorage key carrying a Rematch across the update reload. */
export const REMATCH_KEY = 'cuttle-web:rematch-after-update';

export interface PendingRematch {
  names: [string, string];
  dealer: 0 | 1 | undefined;
}

let policy: UpdatePolicy | null = null;
let lastScreen: UpdateScreen = 'loading';

/** App.svelte reports every screen change; the policy acts only at safe points. */
export function reportScreen(screen: UpdateScreen): void {
  lastScreen = screen;
  policy?.setScreen(screen);
}

/**
 * Rematch is a safe point (the finished game is saved, none is in progress).
 * If an update is waiting, saves the rematch details, starts the takeover
 * and returns true: the caller must not start the game, because the page is
 * about to reload and `takePendingRematch()` starts it there.
 */
export function applyUpdateAtRematch(rematch: PendingRematch): boolean {
  if (!policy) return false;
  try {
    sessionStorage.setItem(REMATCH_KEY, JSON.stringify(rematch));
  } catch {
    return false;
  }
  if (policy.rematch()) return true;
  clearPendingRematch();
  return false;
}

function clearPendingRematch(): void {
  try {
    sessionStorage.removeItem(REMATCH_KEY);
  } catch {
    // Best-effort.
  }
}

/** On boot: the rematch a pre-update tap left behind, once; else null. */
export function takePendingRematch(): PendingRematch | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(REMATCH_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  clearPendingRematch();
  try {
    const v = JSON.parse(raw) as { names?: unknown; dealer?: unknown };
    if (!Array.isArray(v.names) || v.names.length !== 2 || v.names.some((n) => typeof n !== 'string')) return null;
    const dealer = v.dealer === 0 || v.dealer === 1 ? v.dealer : undefined;
    return { names: [v.names[0], v.names[1]], dealer };
  } catch {
    return null;
  }
}

/**
 * Review F4: sessionStorage key carrying an online Rematch across the update
 * reload. It holds the room code and the finished game's number only; the
 * seat (and its token) stays where it always is, in localStorage (seat.ts).
 */
export const ONLINE_REMATCH_KEY = 'cuttle-web:online-rematch-after-update';

export interface PendingOnlineRematch {
  /** The saved seat's room: the reloaded page resumes only that seat. */
  code: string;
  /** The finished game the rematch is for (the `rematch` frame's `game`). */
  game: number;
}

/**
 * The online result screen's Rematch is a safe point too (no move can be in
 * flight at game over). If an update is waiting, saves the rematch, starts
 * the takeover and returns true: the caller must not send the rematch; the
 * reloaded page resumes the seat and sends it (`takePendingOnlineRematch`).
 */
export function applyUpdateAtOnlineRematch(rematch: PendingOnlineRematch): boolean {
  if (!policy) return false;
  try {
    sessionStorage.setItem(ONLINE_REMATCH_KEY, JSON.stringify({ code: rematch.code, game: rematch.game }));
  } catch {
    return false;
  }
  if (policy.rematch()) return true;
  clearKey(ONLINE_REMATCH_KEY);
  return false;
}

/** On boot: the online rematch a pre-update tap left behind, once; else null. */
export function takePendingOnlineRematch(): PendingOnlineRematch | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ONLINE_REMATCH_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  clearKey(ONLINE_REMATCH_KEY);
  try {
    const v = JSON.parse(raw) as { code?: unknown; game?: unknown };
    if (typeof v.code !== 'string' || v.code === '') return null;
    if (typeof v.game !== 'number' || !Number.isInteger(v.game) || v.game < 1) return null;
    return { code: v.code, game: v.game };
  } catch {
    return null;
  }
}

function clearKey(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}

function isTyping(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const { registerSW } = await import('virtual:pwa-register');

  let registration: ServiceWorkerRegistration | undefined;
  let activateWaiting: (() => void) | null = null;

  const p = createUpdatePolicy({
    activate: () => activateWaiting?.(),
    reload: () => window.location.reload(),
    checkForUpdate: () => {
      // Offline, or the server is down: just try again later.
      registration?.update().catch(() => undefined);
    },
    hasWaiting: () => registration?.waiting != null,
    isTyping,
    now: () => Date.now(),
  });
  policy = p;
  p.setScreen(lastScreen);

  const updateSW = registerSW({
    // A new worker is installed and waiting. Never shown as a prompt: the
    // policy applies it at the next safe point.
    onNeedRefresh: () => p.updateReady(),
    // The new worker took control. Replaces the plugin's default of an
    // immediate reload, which could land mid-game.
    onNeedReload: () => p.controllerChanged(),
    onRegisteredSW: (_url, r) => {
      registration = r;
    },
  });
  activateWaiting = () => {
    // Straight to the waiting worker; workbox-window may not know about one
    // it stopped watching for. Falls back to the plugin's own path.
    const waiting = registration?.waiting;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else void updateSW(false);
  };

  // workbox-window only wires its "controlling" handler when it saw the
  // waiting worker itself, so listen directly. Only pages that already had a
  // worker: a first install never reloads.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => p.controllerChanged());
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') p.visible();
  });
  // Leaving a name field may be the moment a deferred update becomes safe.
  document.addEventListener('focusout', () => setTimeout(() => p.poke(), 0));
}
