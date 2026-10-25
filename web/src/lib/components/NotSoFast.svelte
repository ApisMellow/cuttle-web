<script lang="ts" module>
  /** Issue #93 (SPEC §4.3): how long the beat stays up before it dismisses itself. */
  export const NOT_SO_FAST_MS = 3000;
  /** The win headline's lead before "Not So Fast!" cuts in. */
  export const NOT_SO_FAST_CUE_MS = 700;
</script>

<script lang="ts">
  // Issue #93 (SPEC §4.3), the winner's screen: the win starts to play out
  // ("You win!", over the board where the winning card has just landed),
  // then "Not So Fast!" cuts in. Not a dialog, no buttons: a tap anywhere
  // or NOT_SO_FAST_MS of waiting calls `ondismiss`, exactly once per mount.
  //
  // Presentational only. GameScreen mounts this inside the board branch
  // (curtain `none`) while `source.notSoFast` is set, so it is never behind
  // a curtain. It shows fixed strings only: no card, count or name.
  //
  // Pointer (iOS finger lift, as DrawRevealPanel): a click dismisses only
  // if its press landed on the banner after it mounted, so the finger that
  // confirmed the winning move can't dismiss it on its way up.
  //
  // Reduced motion (settings or the OS): no animation; the cue and the
  // timing are the same.

  interface NotSoFastProps {
    ondismiss: () => void;
    reducedMotion?: boolean;
  }

  let { ondismiss, reducedMotion = false }: NotSoFastProps = $props();

  function reducedMotionQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  }

  const still = $derived(reducedMotion || (reducedMotionQuery()?.matches ?? false));

  let done = false;
  function dismissOnce(): void {
    if (done) return;
    done = true;
    ondismiss();
  }

  let cut = $state(false);
  $effect(() => {
    const cue = setTimeout(() => (cut = true), NOT_SO_FAST_CUE_MS);
    const timer = setTimeout(dismissOnce, NOT_SO_FAST_MS);
    return () => {
      clearTimeout(cue);
      clearTimeout(timer);
    };
  });

  let pressedInside = false;
</script>

<!-- A pointer convenience over the board; the 3 s wait is the keyboard path. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div
  class={['not-so-fast', { 'not-so-fast--still': still, 'not-so-fast--cut': cut }]}
  data-testid="not-so-fast"
  data-stage={cut ? 'cut' : 'cue'}
  data-motion={still ? 'reduced' : 'full'}
  role="status"
  onpointerdown={() => (pressedInside = true)}
  onclick={(event) => {
    event.stopPropagation();
    if (event.detail !== 0 && !pressedInside) return;
    dismissOnce();
  }}
>
  {#if cut}
    <p class="not-so-fast__banner">Not So Fast!</p>
  {:else}
    <p class="not-so-fast__headline">You win!</p>
  {/if}
</div>

<style>
  /* Over the whole game screen (the board stays up underneath), so a tap
     anywhere lands here. Fixed to the game screen's own box, which table
     mode turns with everything else. */
  .not-so-fast {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: var(--cu-space-4, 16px);
    background: rgb(0 0 0 / 0.25);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .not-so-fast__headline,
  .not-so-fast__banner {
    max-width: 100%;
    margin: 0;
    padding: var(--cu-space-3, 12px) var(--cu-space-5, 24px);
    border-radius: var(--cu-radius-well, 10px);
    font-weight: var(--cu-weight-bold, 700);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .not-so-fast__headline {
    color: var(--cu-ochre, #f0b54a);
    font-size: var(--cu-text-lg, 22px);
    animation: not-so-fast-rise 500ms var(--cu-ease-out, ease-out) both;
  }

  .not-so-fast__banner {
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: calc(var(--cu-text-lg, 22px) * 1.4);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
    animation: not-so-fast-cut 260ms ease-out both;
  }

  @keyframes not-so-fast-rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes not-so-fast-cut {
    from {
      opacity: 0;
      transform: scale(1.4);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .not-so-fast--still .not-so-fast__headline,
  .not-so-fast--still .not-so-fast__banner {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .not-so-fast__headline,
    .not-so-fast__banner {
      animation: none;
    }
  }
</style>
