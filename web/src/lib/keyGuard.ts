// r16 review B1 (privacy): a key press must never carry from one screen into
// the next player's curtain. Rapid Enter presses on the previous screen's
// Confirm used to walk straight through "I'm NAME", "Show my hand" and the
// recap, putting the next hand on the previous player's screen.
//
// Two defences, used together by the curtain-side screens (RevealGate,
// RecapPanel, CounterPrompt):
//   1. None of them focuses an activating control on arrival; each focuses
//      its non-activating text instead (one Tab reaches the control).
//   2. This guard: a click that a key produced counts only if that key went
//      down AFTER the screen mounted and is not an auto-repeat. Enter
//      activates on keydown, Space on keyup; both are covered.
//
// A click with no key event in flight (a pointer, or a test's `.click()`)
// is always allowed. The guard knows a click came from a key because
// activation runs in the same task as the key event's dispatch; the flag is
// cleared on the next task.

export interface KeyActivationGuard {
  /** False only for a click produced by a stale or repeated key. */
  allows(): boolean;
  dispose(): void;
}

const ACTIVATING = new Set(['Enter', ' ']);

export function keyActivationGuard(target: Window = window): KeyActivationGuard {
  const downSinceMount = new Set<string>();
  let current: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function mark(fresh: boolean): void {
    current = fresh;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      current = null;
      timer = null;
    }, 0);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!ACTIVATING.has(event.key)) return;
    const fresh = !event.repeat;
    if (fresh) downSinceMount.add(event.key);
    // Enter activates on this keydown; it must be a fresh press.
    mark(fresh && downSinceMount.has(event.key));
  }

  function onKeyup(event: KeyboardEvent): void {
    if (!ACTIVATING.has(event.key)) return;
    // Space activates on keyup; its keydown must have come after mount.
    mark(downSinceMount.has(event.key));
    downSinceMount.delete(event.key);
  }

  target.addEventListener('keydown', onKeydown, true);
  target.addEventListener('keyup', onKeyup, true);

  return {
    allows: () => current !== false,
    dispose() {
      target.removeEventListener('keydown', onKeydown, true);
      target.removeEventListener('keyup', onKeyup, true);
      if (timer !== null) clearTimeout(timer);
    },
  };
}
