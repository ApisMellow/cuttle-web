<script lang="ts" module>
  /** What the line is, so the bubble can tune its accent (plan §5, T5 owns the source of truth). */
  export type CoachTone = 'main' | 'nudge' | 'success' | 'blake' | 'error';
</script>

<script lang="ts">
  // Tutorial coach bubble (docs/tutorial-design.md §7.3, §8.2, §9; plan T4).
  // Presentational: copy, placement and state come in as props, taps go out as
  // callbacks. It reads no game state and no store but the reduced-motion
  // setting. Ochre stays reserved for the game's own Confirm, so Next is an
  // iris-ringed pill. Its testids are contract for T9 and T12.
  import { settings } from '../stores/settings.svelte';
  import type { BubblePlacement } from '../tutorial/placement';

  interface CoachBubbleProps {
    /** The line, fixed lesson text; announced politely. */
    text: string;
    tone: CoachTone;
    /** Step id such as "1.5", exposed as data-step for tests and e2e. */
    stepId: string;
    /** idle | selected | staged-right | staged-wrong | refused | done | next | appear | blake | error */
    stage: string;
    showNext: boolean;
    onnext?: () => void;
    onshowme?: () => void;
    onleave?: () => void;
    /** 1-5, for the "N of 5" count. */
    lessonNumber: number;
    placement: BubblePlacement;
    /** Counter; every change shakes the bubble once (design §8.2). */
    shake: number;
    /** Display-face line above the copy ("You win!"). */
    headline?: string;
    /** Present = the lesson hit a snag: Restart lesson and Leave only. */
    error?: { onrestart?: () => void };
  }

  let {
    text,
    tone,
    stepId,
    stage,
    showNext,
    onnext,
    onshowme,
    onleave,
    lessonNumber,
    placement,
    shake,
    headline,
    error,
  }: CoachBubbleProps = $props();

  function osReduces(): boolean {
    try {
      return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    } catch {
      return false;
    }
  }

  // Either the OS preference or the in-app setting asks for the calm variant.
  const still = $derived(settings.reducedMotion || osReduces());

  let root = $state<HTMLElement>();

  // Nudge: translateX 0, -6, 6, -4, 4, 0 over 280 ms. Transform only; nothing
  // awaits it (SPEC §5.9). Reduced motion: the new copy alone.
  let lastShake: number | undefined;
  $effect(() => {
    const n = shake;
    const previous = lastShake;
    lastShake = n;
    if (previous === undefined || n === previous) return;
    if (still || !root || typeof root.animate !== 'function') return;
    root.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-6px)' },
        { transform: 'translateX(6px)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 280, easing: 'ease-in-out' },
    );
  });
</script>

<section
  bind:this={root}
  class="coach"
  aria-label="Coach"
  data-testid="coach-bubble"
  data-step={stepId}
  data-stage={stage}
  data-tone={tone}
  data-notch={placement.notch ?? 'none'}
  data-reduced={still ? 'true' : 'false'}
  style:left="{placement.x}px"
  style:top="{placement.y}px"
>
  {#if placement.notch}
    <span
      class="coach__notch coach__notch--{placement.notch}"
      aria-hidden="true"
      style:left="{placement.notchX - placement.x}px"
    ></span>
  {/if}

  {#if headline}
    <p class="coach__headline">{headline}</p>
  {/if}

  <div class="coach__body">
    {#if tone === 'success'}
      <span class="coach__chip" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
          <path d="M3.5 8.5 6.6 11.5 12.5 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    {/if}
    <p class="coach__copy" aria-live="polite" tabindex="-1">{#key text}<span class="coach__line">{text}</span>{/key}</p>
  </div>

  <div class="coach__footer">
    {#if error}
      <button type="button" class="coach__button coach__button--ghost" data-testid="coach-restart" onclick={() => error.onrestart?.()}>
        Restart lesson
      </button>
      <button type="button" class="coach__button coach__button--text" data-testid="coach-leave" onclick={() => onleave?.()}>
        Leave
      </button>
    {:else}
      <button type="button" class="coach__button coach__button--text" data-testid="coach-show-me" onclick={() => onshowme?.()}>
        Show me
      </button>
      <button type="button" class="coach__button coach__button--text" data-testid="coach-leave" onclick={() => onleave?.()}>
        Leave
      </button>
      <span class="coach__count">{lessonNumber} of 5</span>
      {#if showNext}
        <button type="button" class="coach__button coach__button--next" data-testid="coach-next" onclick={() => onnext?.()}>
          Next
        </button>
      {/if}
    {/if}
  </div>
</section>

<style>
  /* Raised ink, hairline, well radius, a soft shadow like the chooser panel
     (design §7.3). The one accent is the rail on the left edge: it says what
     kind of line this is without adding a colour that is not in the tokens. */
  .coach {
    position: fixed;
    z-index: 1;
    box-sizing: border-box;
    width: min(320px, calc(100% - 32px));
    padding: var(--cu-space-3, 12px) var(--cu-space-4, 16px) var(--cu-space-1, 4px);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-well, 10px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 45%);
    font-family: var(--cu-font-ui, system-ui, sans-serif);
    animation: coach-in var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach[data-reduced='true'] {
    animation: none;
  }

  @keyframes coach-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  /* The rail. */
  .coach::before {
    content: '';
    position: absolute;
    top: 12px;
    bottom: 52px;
    left: 6px;
    width: 3px;
    border-radius: 2px;
    background: transparent;
  }

  .coach[data-tone='nudge']::before {
    background: var(--cu-frost, #a9d2f5);
  }

  .coach[data-tone='success']::before {
    background: var(--cu-iris, #5ccfc4);
  }

  .coach[data-tone='blake']::before {
    background: var(--cu-muted, #b4a8be);
  }

  .coach[data-tone='error']::before {
    background: var(--cu-suit-red-on-ink, #ff8a96);
  }

  /* The notch: a rotated square that shares the bubble's fill and hairline. */
  .coach__notch {
    position: absolute;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    background: var(--cu-ink-raised, #30263a);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    transform: rotate(45deg);
  }

  .coach__notch--up {
    top: -7px;
    border-right: none;
    border-bottom: none;
  }

  .coach__notch--down {
    bottom: -7px;
    border-top: none;
    border-left: none;
  }

  .coach__headline {
    margin: 0 0 var(--cu-space-1, 4px);
    font-family: var(--cu-font-display, Georgia, serif);
    font-size: var(--cu-text-xl, 25px);
    line-height: var(--cu-leading-tight, 1.1);
  }

  .coach__body {
    display: flex;
    align-items: flex-start;
    gap: var(--cu-space-2, 8px);
  }

  .coach__copy {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-size: var(--cu-text-md, 16px);
    line-height: 1.35;
    outline: none;
  }

  .coach__line {
    display: inline;
    animation: coach-line var(--cu-dur-fast, 120ms) linear;
  }

  .coach[data-reduced='true'] .coach__line {
    animation: none;
  }

  @keyframes coach-line {
    from {
      opacity: 0;
    }
  }

  /* The success chip lands with the slight overshoot (design §8.2). */
  .coach__chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-top: 0;
    border-radius: 50%;
    background: var(--cu-iris, #5ccfc4);
    color: var(--cu-on-accent, #241c2b);
    animation: coach-chip 240ms var(--cu-ease-land, ease-out);
  }

  .coach[data-reduced='true'] .coach__chip {
    animation: none;
  }

  @keyframes coach-chip {
    from {
      transform: scale(0.6);
    }
  }

  .coach__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--cu-space-1, 4px);
    margin-top: var(--cu-space-1, 4px);
  }

  .coach__button {
    box-sizing: border-box;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-2, 8px);
    border: none;
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-family: inherit;
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .coach__button:focus-visible {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: -2px;
    border-radius: var(--cu-radius-control, 999px);
  }

  .coach__button--text {
    color: var(--cu-muted, #b4a8be);
    font-weight: var(--cu-weight-regular, 400);
  }

  .coach__button--text:hover {
    color: var(--cu-pearl, #eee8f1);
  }

  .coach__button--ghost {
    padding: 0 var(--cu-space-3, 12px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
  }

  /* Next: pearl text, a 1 px iris ring. Never ochre (design §7.3). */
  .coach__button--next {
    padding: 0 var(--cu-space-4, 16px);
    border: 1px solid var(--cu-iris, #5ccfc4);
    border-radius: var(--cu-radius-control, 999px);
  }

  .coach__count {
    margin-left: auto;
    padding: 0 var(--cu-space-2, 8px);
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-xs, 12px);
    font-variant-numeric: tabular-nums;
  }
</style>
