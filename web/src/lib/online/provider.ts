// Which OnlineActions the app uses, and whether Play on two phones shows at all.
//
// W12 calls `setOnlineActions(realActions)` at startup. Until then the fake
// backs local dev (`vite dev`) so the screens can be exercised; a production
// build with no valid server origin hides the mode (docs/two-phone-plan.md
// §7). config.ts's serverOrigin() is the one reader of VITE_CUTTLE_SERVER.
import { createFakeOnlineActions, type OnlineActions } from './actions';
import { serverOrigin } from './config';

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
