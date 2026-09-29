<script lang="ts">
  // SPEC §4.5 (R13.3), docs/design.md §8-9, orchestrator ruling A1 ("same
  // screen, armed") — the two reveal controls, shared by the `handoff` and
  // `reveal` curtain kinds. HandoffPanel places them; this component owns
  // their behaviour. It takes no HandoffReason and no game state.
  //
  // Stages (the curtain kind, passed in as `stage`):
  //   - handoff: the FIRST explicit action arms the screen by calling
  //     onadvance() once (handoff -> reveal). That action is a tap on the
  //     "I'm NAME" pill, or a pointerdown on the ring. A ring press keeps
  //     running as the 600 ms hold.
  //   - reveal: completing a hold, or tapping "Show my hand", calls
  //     onadvance() once (reveal -> next).
  //
  // Once-only latch (B1): at most one onadvance() per machine state. The
  // state is identified by (stage, epoch, name); `epoch` is a counter the
  // Curtain bumps for every new curtain state, so two players who share a
  // name still get distinct keys. The latch stores the key it fired for, so
  // a new stage, epoch or name on the SAME
  // instance re-opens it with no reset code to forget (OQ-13). Nothing here
  // is kept in a local "armed" flag: the pill text and the latch both derive
  // from props.
  //
  // Press carry-over: a hold survives exactly one prop change, handoff ->
  // reveal for the same player id, which is the transition its own
  // pointerdown caused. It is keyed on the id, never the display name, so
  // two players with the same name never share a press. Any other change
  // (new player, new epoch within a stage, reveal -> handoff) aborts a
  // running hold and resets the ring.
  //
  // Both controls are always in the DOM and both always work (SPEC §4.5).
  // `revealPreference` and `prefers-reduced-motion` pick only which one is
  // PRIMARY (`data-primary`, a visual emphasis). Under reduced motion the
  // ring fills in three discrete steps (design.md §9) and the hold still
  // takes HOLD_DURATION_MS.
  //
  // jsdom has no `window.matchMedia`, so detection is defensive.
  import type { PlayerId } from '../bridge/schema';
  import { createHoldGate, HOLD_DURATION_MS, type HoldGate } from '../curtain';
  import { keyActivationGuard, type KeyActivationGuard } from '../keyGuard';

  interface RevealGateProps {
    name: string;
    /** The player the screen is for. Identity for the latch and carry-over;
     *  `name` is display only (two players may share a name). */
    player: PlayerId;
    stage: 'handoff' | 'reveal';
    /** Bumped by Curtain for every new curtain state; re-opens the latch. */
    epoch?: number;
    revealPreference: 'hold' | 'two-step';
    onadvance: () => void;
  }

  let { name, player, stage, epoch = 0, revealPreference, onadvance }: RevealGateProps = $props();

  // ---- Reduced motion -----------------------------------------------------
  function reducedMotionQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  }

  let reducedMotion = $state(reducedMotionQuery()?.matches ?? false);

  $effect(() => {
    const mql = reducedMotionQuery();
    if (mql === null) return;
    const update = (): void => {
      reducedMotion = mql.matches;
    };
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  });

  const primary = $derived(reducedMotion ? 'two-step' : revealPreference);

  // ---- Once-only latch (B1) -----------------------------------------------
  const stateKey = $derived(JSON.stringify([stage, epoch, name]));
  let firedFor = $state<string | null>(null);

  /** Calls onadvance() unless it already fired for the current machine state. */
  function advanceOnce(): void {
    if (firedFor === stateKey) return;
    firedFor = stateKey;
    onadvance();
  }

  // ---- Hold path ----------------------------------------------------------
  let holdProgress = $state(0);
  let gate: HoldGate | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  function abortHold(): void {
    gate?.dispose();
    gate = null;
    stopPolling();
    holdProgress = 0;
  }

  function onRingDown(): void {
    if (stage === 'handoff') advanceOnce();
    // A fresh gate per press: a completed gate ignores later pointerdowns.
    gate?.dispose();
    stopPolling();
    const current = createHoldGate({
      onReveal: () => {
        stopPolling();
        holdProgress = 1;
        gate = null;
        advanceOnce();
      },
    });
    gate = current;
    current.pointerdown();
    holdProgress = 0;
    pollHandle = setInterval(() => {
      holdProgress = current.progress();
    }, 16);
  }

  function onRingUp(): void {
    if (gate === null) return;
    abortHold();
  }

  // Abort a running hold on every prop change except the carry-over one.
  // Keyed on the player id, not the display name: two players may share one.
  // `name` is read so that any prop change re-runs this and aborts; it is not
  // part of the carry test.
  let previous: { stage: string; epoch: number; player: PlayerId; name: string } | null = null;
  $effect.pre(() => {
    const current = { stage, epoch, player, name };
    if (previous !== null) {
      const carry = previous.stage === 'handoff' && current.stage === 'reveal' && previous.player === current.player;
      if (!carry) abortHold();
    }
    previous = current;
  });

  $effect(() => () => abortHold());

  /** design.md §9: three discrete steps, each shown once its third is complete. */
  function stepped(p: number): number {
    return p >= 1 ? 1 : Math.floor(p * 3) / 3;
  }
  const ringProgress = $derived(reducedMotion ? stepped(holdProgress) : holdProgress);

  // ---- Two-step path ------------------------------------------------------
  const pillText = $derived(stage === 'reveal' ? 'Show my hand' : `I'm ${name}`);

  function onPillClick(): void {
    abortHold();
    advanceOnce();
  }

  // ---- Keyboard (r16, desktop) -------------------------------------------
  // Review B1 (privacy): nothing here takes focus on arrival (HandoffPanel
  // focuses its text, and one Tab reaches the pill, which comes first in
  // the DOM), and a pill click produced by a key that went down before this
  // screen mounted, or by an auto-repeat, is ignored (lib/keyGuard.ts). So
  // the previous player's key presses can't walk through the curtain.
  // The ring also works from the keyboard: Space or Enter held on it is a
  // press and hold, released early (or on blur) it resets, like a pointer.
  let guard: KeyActivationGuard | null = null;
  $effect(() => {
    const g = keyActivationGuard();
    guard = g;
    return () => {
      g.dispose();
      if (guard === g) guard = null;
    };
  });

  function onPillActivate(): void {
    if (guard !== null && !guard.allows()) return;
    onPillClick();
  }

  function isHoldKey(event: KeyboardEvent): boolean {
    return event.key === ' ' || event.key === 'Enter';
  }

  function onRingKeydown(event: KeyboardEvent): void {
    if (!isHoldKey(event)) return;
    event.preventDefault();
    if (event.repeat || gate !== null) return;
    onRingDown();
  }

  function onRingKeyup(event: KeyboardEvent): void {
    if (!isHoldKey(event)) return;
    event.preventDefault();
    onRingUp();
  }
</script>

<div
  class={['reveal', { 'reveal--armed': stage === 'reveal' }]}
  data-primary={primary}
  style={`--cu-dur-hold: ${HOLD_DURATION_MS}ms`}
>
  <!-- r16: the pill comes first in the DOM (both are absolutely placed, so
       nothing moves on screen): one Tab from the focused text reaches it. -->
  <button type="button" class="reveal__pill" data-testid="reveal-two-step" onclick={onPillActivate}>
    {pillText}
  </button>

  <button
    type="button"
    class="reveal__ring"
    data-testid="reveal-hold"
    style={`--cu-hold-progress: ${ringProgress}`}
    onpointerdown={onRingDown}
    onpointerup={onRingUp}
    onpointercancel={onRingUp}
    onpointerleave={onRingUp}
    onkeydown={onRingKeydown}
    onkeyup={onRingKeyup}
    onblur={onRingUp}
  >
    Hold
  </button>
</div>

<style>
  /* design.md §8: ring at 62%, pill at 82% of the screen. The wrapper is
     layout-transparent; HandoffPanel's root is the positioning box. */
  .reveal {
    display: contents;
  }

  .reveal__ring {
    position: absolute;
    top: 62%;
    left: 50%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    width: 132px;
    height: 132px;
    border-radius: 50%;
    border: none;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
    background:
      radial-gradient(closest-side, var(--cu-curtain, #1a1420) 79%, transparent 80%),
      conic-gradient(
        var(--cu-iris, #5ccfc4) calc(var(--cu-hold-progress) * 360deg),
        var(--cu-ink-line, #4a3d57) 0
      );
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .reveal__pill {
    position: absolute;
    top: 82%;
    left: 50%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    width: 240px;
    height: 48px;
    padding: 0 var(--cu-space-5, 24px);
    border: 2px solid var(--cu-iris, #5ccfc4);
    border-radius: 999px;
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  /* data-primary: the primary control is emphasised, the other recedes.
     Both stay fully functional. */
  .reveal[data-primary='hold'] .reveal__ring {
    color: var(--cu-pearl, #eee8f1);
    font-weight: 700;
  }

  .reveal[data-primary='two-step'] .reveal__pill {
    background: var(--cu-iris, #5ccfc4);
    color: var(--cu-on-accent, #241c2b);
    font-weight: 700;
  }

  /* design.md §8: on the two-step path the armed pill carries an iris ring. */
  .reveal--armed .reveal__pill {
    box-shadow: 0 0 0 4px var(--cu-curtain, #1a1420), 0 0 0 6px var(--cu-iris, #5ccfc4);
  }
</style>
