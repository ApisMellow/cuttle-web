// R18 (SPEC §5.8): registers the service worker that makes the game work
// offline, and wires the update policy in ./update.ts to the browser.
//
// Production builds only. The dev server never emits a worker
// (vite.config.ts `devOptions.enabled: false`), so dev and the e2e suite
// that runs against it are unaffected.
import { createUpdatePolicy, type UpdatePolicy, type UpdateScreen } from './update';

let policy: UpdatePolicy | null = null;
let lastScreen: UpdateScreen = 'loading';

/** App.svelte reports every screen change; the policy acts only at safe points. */
export function reportScreen(screen: UpdateScreen): void {
  lastScreen = screen;
  policy?.setScreen(screen);
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
  activateWaiting = () => void updateSW(false);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') p.visible();
  });
  // Leaving a name field may be the moment a deferred update becomes safe.
  document.addEventListener('focusout', () => setTimeout(() => p.poke(), 0));
}
