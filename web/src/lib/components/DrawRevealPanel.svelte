<script lang="ts">
  // SPEC §4.7 (issue #27) — the 5's draw, shown to the player who drew.
  // The drawn cards leave a face-down deck, travel into the hand and turn
  // face up. A tap anywhere, Continue, or DRAW_REVEAL_MS of waiting goes on,
  // exactly once per mount.
  //
  // Presentational only. The privacy gate lives with the integrator:
  // GameScreen mounts this only while `game.drawReveal` is up AND the
  // exposed envelope is that player's own (`viewer === drawReveal.to`), at
  // curtain `none` or an `ack` (never behind a withheld curtain). `hand` is
  // that envelope's own `you.hand`; `drawn` holds indices into it. Nothing
  // here keeps a copy past its own unmount.
  //
  // Keyboard (same rule as the deck's issue #24 guard): an auto-repeat
  // keydown never presses Continue, and a click that a held key produces on
  // its keyup (Space) is ignored until a fresh keydown. Focus moves to
  // Continue on mount so a keyboard user lands on it.
  //
  // Reduced motion (settings or the OS): no travel and no flip; the faces
  // are simply there. The 3 s wait is unchanged.
  import type { Card } from '../bridge/schema';
  import { DRAW_REVEAL_MS } from '../drawReveal';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface DrawRevealPanelProps {
    /** The drawer's own hand (`you.hand` of their own envelope). */
    hand: Card[];
    /** Indices into `hand` of the drawn cards. */
    drawn: number[];
    reducedMotion?: boolean;
    oncontinue: () => void;
    theme?: CardTheme;
  }

  let { hand, drawn, reducedMotion = false, oncontinue, theme = getTheme(DEFAULT_THEME_ID) }: DrawRevealPanelProps = $props();

  function reducedMotionQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  }

  let osReduced = $state(reducedMotionQuery()?.matches ?? false);
  $effect(() => {
    const mql = reducedMotionQuery();
    if (mql === null) return;
    const update = (): void => {
      osReduced = mql.matches;
    };
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  });

  const still = $derived(reducedMotion || osReduced);
  const titleId = $props.id();
  const count = $derived(drawn.length);
  const title = $derived(count === 1 ? 'You drew 1 card' : `You drew ${count} cards`);

  // ---- Once-only continue -------------------------------------------------
  let done = false;
  function continueOnce(): void {
    if (done) return;
    done = true;
    oncontinue();
  }

  $effect(() => {
    const timer = setTimeout(continueOnce, DRAW_REVEAL_MS);
    return () => clearTimeout(timer);
  });

  // ---- Keyboard guard -----------------------------------------------------
  let heldKey = false;
  let button: HTMLButtonElement | undefined = $state();

  $effect(() => {
    button?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat) {
      heldKey = true;
      event.preventDefault();
      return;
    }
    heldKey = false;
  }

  function onButtonClick(event: MouseEvent): void {
    event.stopPropagation();
    if (heldKey) {
      heldKey = false;
      return;
    }
    continueOnce();
  }

  function onPanelClick(): void {
    continueOnce();
  }

  /** Arrival order of a drawn card (0, 1), staggering its travel. */
  function order(i: number): number {
    return drawn.indexOf(i);
  }
</script>

<!-- The whole panel is a pointer convenience; Continue is the control. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class={['draw-reveal', { 'draw-reveal--still': still }]}
  data-testid="draw-reveal"
  data-motion={still ? 'reduced' : 'full'}
  style={`--draw-reveal-ms: ${DRAW_REVEAL_MS}ms`}
  onclick={onPanelClick}
>
  <p class="draw-reveal__title" id={titleId}>{title}</p>

  <div class="draw-reveal__deck" aria-hidden="true">
    <span class="draw-reveal__card"><theme.Back size="hand" /></span>
  </div>

  <div class="draw-reveal__hand" role="group" aria-labelledby={titleId} style={`--hand-count: ${hand.length}`}>
    {#each hand as card, i (i)}
      {@const isDrawn = drawn.includes(i)}
      <span
        class={['draw-reveal__slot', { 'draw-reveal__slot--drawn': isDrawn }]}
        data-draw-slot
        data-drawn={isDrawn ? 'true' : 'false'}
        style={isDrawn ? `--draw-order: ${order(i)}` : undefined}
      >
        {#if isDrawn && !still}
          <span class="draw-reveal__flip">
            <span class="draw-reveal__side draw-reveal__side--back" data-draw-back><theme.Back size="hand" /></span>
            <span class="draw-reveal__side draw-reveal__side--face" data-draw-face><theme.Face {card} size="hand" state="highlighted" /></span>
          </span>
        {:else}
          <span class="draw-reveal__side" data-draw-face><theme.Face {card} size="hand" state={isDrawn ? 'highlighted' : 'normal'} /></span>
        {/if}
      </span>
    {/each}
  </div>

  <button
    type="button"
    class="draw-reveal__continue"
    data-testid="draw-reveal-continue"
    bind:this={button}
    onkeydown={onKeydown}
    onclick={onButtonClick}
  >
    Continue
  </button>
  <!-- The countdown bar: decoration for the 3 s wait. -->
  <span class="draw-reveal__timer" aria-hidden="true"></span>
</div>

<style>
  /* Takes the board's place: the full height GameScreen leaves between the
     safe areas, hand at the bottom where the real hand sits. */
  .draw-reveal {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: var(--cu-space-4, 16px);
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    min-height: 0;
    margin: 0 auto;
    padding: var(--cu-space-5, 24px) var(--cu-gutter-board, 10px) var(--cu-space-4, 16px);
    overflow: hidden;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .draw-reveal__title {
    margin: 0 0 auto;
    padding-top: var(--cu-space-5, 24px);
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-lg, 22px);
    font-weight: var(--cu-weight-bold, 700);
    text-align: center;
  }

  .draw-reveal__deck {
    display: flex;
    justify-content: center;
    margin-bottom: auto;
  }

  /* SPEC §5.6 rule 2: containers own the box. */
  .draw-reveal__card,
  .draw-reveal__slot {
    position: relative;
    display: block;
    flex: none;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
  }

  .draw-reveal__card {
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 1px 3px rgb(0 0 0 / 40%);
  }

  /* PlayerHand's fan (design.md §6), so the row reads as the real hand. */
  .draw-reveal__hand {
    container-type: inline-size;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 4px;
    width: 100%;
    padding-top: 12px;
  }

  .draw-reveal__slot + .draw-reveal__slot {
    margin-left: max(
      calc(44px - var(--cuttle-card-width-hand)),
      min(
        4px,
        calc(
          (100cqi - var(--cuttle-card-width-hand) - 1px) / (var(--hand-count) - 1) -
            var(--cuttle-card-width-hand)
        )
      )
    );
  }

  .draw-reveal__slot--drawn {
    z-index: 1;
    transform: translateY(-12px);
  }

  .draw-reveal__side {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: -2px 0 4px rgb(0 0 0 / 30%);
  }

  /* Travel: from the deck (above) down into the hand, face down. */
  .draw-reveal:not(.draw-reveal--still) .draw-reveal__slot--drawn {
    animation: draw-reveal-travel 520ms var(--cu-ease-out, ease-out) both;
    animation-delay: calc(var(--draw-order, 0) * 160ms);
  }

  /* Flip: face down to face up once it has landed. */
  .draw-reveal__flip {
    position: absolute;
    inset: 0;
    display: block;
    transform-style: preserve-3d;
    animation: draw-reveal-flip 360ms ease-in-out both;
    animation-delay: calc(560ms + var(--draw-order, 0) * 160ms);
  }

  .draw-reveal__flip > .draw-reveal__side {
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  .draw-reveal__side--back {
    transform: rotateY(180deg);
  }

  @keyframes draw-reveal-travel {
    from {
      transform: translateY(-34vh) scale(0.92);
    }
    to {
      transform: translateY(-12px) scale(1);
    }
  }

  @keyframes draw-reveal-flip {
    from {
      transform: rotateY(180deg);
    }
    to {
      transform: rotateY(0deg);
    }
  }

  .draw-reveal__continue {
    flex: none;
    box-sizing: border-box;
    min-width: 200px;
    min-height: 48px;
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .draw-reveal__continue:focus-visible {
    outline: 3px solid var(--cu-pearl, #eee8f1);
    outline-offset: 2px;
  }

  .draw-reveal__timer {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 3px;
    background: var(--cu-iris, #5ccfc4);
    transform-origin: left center;
    animation: draw-reveal-timer var(--draw-reveal-ms, 3000ms) linear both;
  }

  @keyframes draw-reveal-timer {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }

  .draw-reveal--still .draw-reveal__timer {
    animation: none;
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .draw-reveal__slot--drawn,
    .draw-reveal__flip,
    .draw-reveal__timer {
      animation: none;
    }
  }
</style>
