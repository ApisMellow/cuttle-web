// R18 update policy (SPEC §5.8). Beta builds ship often, so a new build has
// to reach players, but it must never reload the page in the middle of a
// game. The new service worker installs in the background and waits. It
// takes over in one of two ways:
//
//   1. The app is closed and opened again. With no page left on the old
//      worker, the browser activates the waiting one on its own, and the
//      next launch runs the new build. No code here is involved.
//   2. The player is at a safe point: the home screen (and not typing a
//      name), the loading screen, or the boot-failure screen. This module
//      asks the waiting worker to take over, then reloads once it has.
//
// The game itself is in localStorage (SPEC §5.7), which a worker swap never
// touches, so the reload comes back to the same home screen with Resume.
//
// Pure logic with injected effects, so it is unit-tested without a worker
// (tests/unit/pwa-update.test.ts). lib/pwa/register.ts wires it up.

/** The shell's screens (App.svelte). */
export type UpdateScreen = 'loading' | 'boot-failed' | 'error' | 'home' | 'result' | 'game';

/** Screens where a reload loses nothing the player is looking at. */
const SAFE_SCREENS: ReadonlySet<UpdateScreen> = new Set(['loading', 'boot-failed', 'home']);

/** How often, at most, to ask the server for a new build. */
export const UPDATE_CHECK_INTERVAL_MS = 60_000;

export interface UpdatePolicyDeps {
  /** Tell the waiting worker to take over (SKIP_WAITING). */
  activate(): void;
  /** Reload the page onto the worker now in control. */
  reload(): void;
  /** Ask the browser to look for a new sw.js. Must not throw. */
  checkForUpdate(): void;
  /**
   * True when the registration holds a waiting worker. Read straight off the
   * registration (workbox-window stops reporting updates found more than 60 s
   * after registration, so its events alone can miss one in a long session).
   */
  hasWaiting(): boolean;
  /** True while the player is typing (a focused text field). */
  isTyping(): boolean;
  now(): number;
}

export interface UpdatePolicy {
  /** The shell's current screen. */
  setScreen(screen: UpdateScreen): void;
  /** A new worker has installed and is waiting. */
  updateReady(): void;
  /** A new worker has taken control of this page. */
  controllerChanged(): void;
  /** The app came back to the foreground. */
  visible(): void;
  /** Something that might end "typing" happened; re-check the safe point. */
  poke(): void;
  /**
   * The player tapped Rematch on the result screen: a safe point, since the
   * finished game is saved and no game is in progress. If an update is
   * waiting, starts the takeover and returns true; the caller must then NOT
   * start the game itself, but leave it to the reloaded page. Returns false
   * when there is nothing to apply (or a takeover already started and did not
   * finish, so a second tap just plays).
   */
  rematch(): boolean;
}

export function createUpdatePolicy(deps: UpdatePolicyDeps): UpdatePolicy {
  let screen: UpdateScreen = 'loading';
  let ready = false;
  let activated = false;
  let reloadPending = false;
  let reloaded = false;
  let lastCheck = -Infinity;
  let rematchTakeover = false;

  function safe(): boolean {
    return rematchTakeover || (SAFE_SCREENS.has(screen) && !deps.isTyping());
  }

  function check(): void {
    const now = deps.now();
    if (now - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = now;
    deps.checkForUpdate();
  }

  function settle(): void {
    if (!safe()) return;
    if (reloadPending && !reloaded) {
      reloaded = true;
      deps.reload();
      return;
    }
    if (!ready && deps.hasWaiting()) ready = true;
    if (ready && !activated) {
      activated = true;
      deps.activate();
    }
  }

  return {
    setScreen(next) {
      screen = next;
      if (next === 'home') check();
      settle();
    },
    updateReady() {
      ready = true;
      settle();
    },
    controllerChanged() {
      reloadPending = true;
      settle();
    },
    visible() {
      check();
      settle();
    },
    poke() {
      settle();
    },
    rematch() {
      if (rematchTakeover) {
        // The takeover did not finish; stop treating the result screen as safe.
        rematchTakeover = false;
        return false;
      }
      if (reloaded) return false;
      if (!ready && !deps.hasWaiting()) return false;
      ready = true;
      rematchTakeover = true;
      // settle() sends whichever step is next: the reload if the new worker
      // already took control, else the activation.
      settle();
      return true;
    },
  };
}
