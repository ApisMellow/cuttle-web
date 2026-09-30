// Which OnlineActions the app uses, and whether Play on two phones shows at all.
//
// W12 calls `setOnlineActions(realActions)` at startup. Until then the fake
// backs local dev (`vite dev`) so the screens can be exercised; a production
// build with no VITE_CUTTLE_SERVER hides the mode (docs/two-phone-plan.md §7).
import { createFakeOnlineActions, type OnlineActions } from './actions';

let actions: OnlineActions = createFakeOnlineActions();

export function getOnlineActions(): OnlineActions {
  return actions;
}

export function setOnlineActions(next: OnlineActions): void {
  actions = next;
}

export function onlineAvailable(): boolean {
  const server = import.meta.env.VITE_CUTTLE_SERVER as string | undefined;
  return Boolean(server) || import.meta.env.DEV;
}
