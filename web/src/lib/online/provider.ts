// Which OnlineActions the app uses, and whether Play on two phones shows at all.
//
// W12: App calls `configureOnlineActions()` at startup. With a server
// origin configured it installs the real actions (REST create/join, the
// saved seat, the online store). Without one the fake stays, which backs
// local dev (`vite dev`) so the screens can be exercised; a production build
// with no valid server origin hides the mode (docs/two-phone-plan.md §7).
// config.ts's serverOrigin() is the one reader of VITE_CUTTLE_SERVER.
import { createFakeOnlineActions, type OnlineActions } from './actions';
import { serverOrigin } from './config';
import { createRealOnlineActions } from './realActions';
import { online } from '../stores/online.svelte';
import { onlineGame } from '../stores/onlineGame.svelte';

let actions: OnlineActions = createFakeOnlineActions();

export function getOnlineActions(): OnlineActions {
  return actions;
}

export function setOnlineActions(next: OnlineActions): void {
  actions = next;
}

/** A dev build always shows the mode (the fake backs it); otherwise it needs a server. */
export function onlineAvailable(): boolean {
  return import.meta.env.DEV || serverOrigin() !== null;
}

export interface ConfigureOptions {
  /** The server origin; defaults to this build's `serverOrigin()`. */
  origin?: string | null;
  /** Builds the real actions for an origin; defaults to the app's store and screens. */
  make?: (origin: string) => OnlineActions;
}

function makeReal(origin: string): OnlineActions {
  return createRealOnlineActions({ origin, store: onlineGame, ui: online });
}

/** Installs the real actions when a server is configured; otherwise keeps the fake. */
export function configureOnlineActions(options: ConfigureOptions = {}): 'real' | 'fake' {
  const origin = options.origin === undefined ? serverOrigin() : options.origin;
  if (origin === null) return 'fake';
  setOnlineActions((options.make ?? makeReal)(origin));
  return 'real';
}
