// A-6 per-slot fallback: image load errors seen since the last handoff.
// Private to lib/theme/; the app clears it through `clearImageFailures`
// (re-exported from the theme index) at every handoff.
//
// A URL gets one retry: its first error bumps the attempt counter, which the
// bitmap components use as a `{#key}` so a fresh <img> requests it again.
// Its second error marks it failed, and every card showing it drops to the
// vector baseline together. Reactive, so all of that re-renders on its own.
//
// Cleared at each handoff so a transient failure doesn't stick for the
// whole session, and so one hot-seat player's failures never shape what the
// other player sees.

import { SvelteMap } from 'svelte/reactivity';

const MAX_ATTEMPTS = 2;

const errors = new SvelteMap<string, number>();

export function recordImageError(src: string): void {
  errors.set(src, (errors.get(src) ?? 0) + 1);
}

/** How many times `src` has failed; changes when a retry is due. */
export function imageAttempt(src: string): number {
  return errors.get(src) ?? 0;
}

/** True once `src` has used up its retry. */
export function imageFailed(src: string): boolean {
  return imageAttempt(src) >= MAX_ATTEMPTS;
}

/** Forgets every recorded error, so each image is tried afresh. */
export function clearImageFailures(): void {
  errors.clear();
}
