<script lang="ts">
  // Tutorial "ghost hand" (docs/tutorial-design.md §8.3, §9; plan T8). Not a
  // drawn hand (art hold): a fingertip dot plus a ghost card, which is the
  // active theme's own <Face> at hand size. Nothing here takes input: the
  // layer is aria-hidden, carries no testid and ignores the pointer, and a
  // pointerdown anywhere stops the running demo.
  //
  // SPEC §5.6 rule 2: this component is the CONTAINER of the ghost card, so it
  // sizes the box from the app tokens (card-geometry.css) and clips it; the
  // Face fills the box. Only `transform` and `opacity` ever animate, through
  // WAAPI, and nothing awaits an animation (SPEC §5.9).
  //
  // With `motion` false nothing moves: static numbered markers show the order
  // (1 the card, 2 the target, 3 Confirm once staged) joined by a dashed line.
  import { untrack } from 'svelte';

  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import type { CardTheme } from '../theme';
  import {
    DRAG_TRAVEL_MS,
    dragDemoFrames,
    dragRingFrames,
    readMotionTokens,
    tapDemoFrames,
  } from '../tutorial/motion';
  import type { Box } from '../tutorial/placement';

  type GhostDemoSpec = { kind: 'drag'; from: Box; to: Box; card: Card } | { kind: 'tap'; at: Box[] };

  interface GhostDemoProps {
    /** What to show; null shows nothing. Boxes are viewport rects and may be re-measured freely. */
    demo: GhostDemoSpec | null;
    /** Every change replays the demo (Show me, step entry, the idle replay). */
    playKey: number;
    /** False = the reduced-motion variant: static markers, no animate() call. */
    motion: boolean;
    /** Where Confirm is, once staged; only used for the static "3" marker. */
    confirmBox?: Box;
    theme: CardTheme;
  }

  let { demo, playKey, motion, confirmBox, theme }: GhostDemoProps = $props();

  const RING_PAD = 6; // matches CoachSpotlight's hole padding
  const MARKER_SHIFT = 26; // keeps two markers on one spot from stacking
  // T14: the Confirm "3" sits above the pill's top-right corner, its right
  // edge on the pill's: it never reaches the label (it covered the "m").
  const CORNER_X = 14; // the marker centre's inset from Confirm's right edge (its radius)
  const CORNER_Y = -10; // ... and its offset from Confirm's top edge (up)

  const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

  /** A target this much wider than tall is a labelled button (4.2's counter option). */
  const WIDE = 2;
  /** On such a button the tap lands this far in from its right end: clear of the centred label (T14). */
  const TAP_END_INSET = 28;
  /** Where a tap lands: a card's centre, or near a wide labelled button's right end. */
  const tapPoint = (b: Box) => (b.width > b.height * WIDE ? { x: b.x + b.width - TAP_END_INSET, y: b.y + b.height / 2 } : centre(b));
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

  // ─── Animated variant ─────────────────────────────────────────────────

  /** Consecutive taps on one spot are one run ("tap twice"); runs play in turn. */
  const tapRuns = $derived.by(() => {
    if (demo?.kind !== 'tap') return [];
    const runs: { at: { x: number; y: number }; times: 1 | 2 }[] = [];
    for (const box of demo.at) {
      const c = tapPoint(box);
      const last = runs[runs.length - 1];
      if (last && last.times === 1 && near(last.at, c)) last.times = 2;
      else runs.push({ at: c, times: 1 });
    }
    let delay = 0;
    return runs.map((run) => {
      const placed = { ...run, delay };
      delay += tapDemoFrames(run.times).durationMs;
      return placed;
    });
  });

  let root = $state<HTMLElement>();

  // Replays on playKey, on motion flipping and on the demo kind changing. The
  // boxes are read untracked: the controller re-measures them every frame,
  // and a moved box must not restart the demo.
  // `kind` is derived so a re-measured demo object of the same kind is not a change.
  const kind = $derived(demo?.kind);

  $effect(() => {
    const on = motion;
    void playKey;
    const el = root;
    if (!on || !kind || !el) return;
    return untrack(() => play(el, kind));
  });

  function play(el: HTMLElement, kind: 'drag' | 'tap'): (() => void) | undefined {
    if (typeof el.animate !== 'function') return undefined; // jsdom, very old browsers
    const spec = demo;
    if (!spec) return undefined;
    const animations: Animation[] = [];
    const part = (name: string) => [...el.querySelectorAll<HTMLElement>(`[data-part="${name}"]`)];

    if (kind === 'drag' && spec.kind === 'drag') {
      const token = readMotionTokens(el).demoTravel;
      const opts = { travelMs: token > 0 ? token : DRAG_TRAVEL_MS };
      const frames = dragDemoFrames(spec.from, spec.to, opts);
      const timing = { duration: frames.durationMs, fill: 'both' as const };
      const dot = part('dot')[0];
      const ghost = part('ghost')[0];
      const ring = part('target-ring')[0];
      if (dot) animations.push(dot.animate(frames.dot, timing));
      if (ghost) animations.push(ghost.animate(frames.card, timing));
      if (ring) animations.push(ring.animate(dragRingFrames(opts), timing));
    } else if (kind === 'tap' && spec.kind === 'tap') {
      const dots = part('tap-dot');
      const ripples = part('tap-ripple');
      tapRuns.forEach((run, i) => {
        const frames = tapDemoFrames(run.times);
        const timing = { duration: frames.durationMs, delay: run.delay, fill: 'both' as const };
        if (dots[i]) animations.push(dots[i].animate(frames.dot, timing));
        if (ripples[i]) animations.push(ripples[i].animate(frames.ripple, timing));
      });
    }

    const stop = () => {
      for (const a of animations) a.cancel();
    };
    window.addEventListener('pointerdown', stop, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', stop);
      stop();
    };
  }

  // ─── Reduced-motion variant ───────────────────────────────────────────

  const markers = $derived.by(() => {
    if (!demo) return [];
    const spots =
      demo.kind === 'drag' ? [centre(demo.from), centre(demo.to)] : demo.at.map((box) => tapPoint(box));
    // Confirm is a wide pill with a label: its "3" rides just above the
    // top-right corner so it never covers the word.
    if (confirmBox) spots.push({ x: confirmBox.x + confirmBox.width - CORNER_X, y: confirmBox.y + CORNER_Y });
    return spots.map((spot, i) => {
      const clash = spots.slice(0, i).filter((other) => near(other, spot)).length;
      return { n: i + 1, x: spot.x + clash * MARKER_SHIFT, y: spot.y };
    });
  });

  /** The dashed iris line from marker 1 to marker 2, a rotated div (drag only). */
  const line = $derived.by(() => {
    if (demo?.kind !== 'drag') return null;
    const a = centre(demo.from);
    const b = centre(demo.to);
    return {
      x: a.x,
      y: a.y,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      deg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    };
  });
</script>

<div class="ghost-demo" bind:this={root} aria-hidden="true" style="pointer-events: none">
  {#if demo && motion}
    {#if demo.kind === 'drag'}
      {@const from = centre(demo.from)}
      <div
        class="ghost-demo__ring"
        data-part="target-ring"
        style:left="{demo.to.x - RING_PAD}px"
        style:top="{demo.to.y - RING_PAD}px"
        style:width="{demo.to.width + RING_PAD * 2}px"
        style:height="{demo.to.height + RING_PAD * 2}px"
      ></div>
      <div class="ghost-demo__anchor" data-part="ghost" style:left="{from.x}px" style:top="{from.y}px">
        <div class="ghost-demo__card" data-part="ghost-card">
          <theme.Face card={demo.card} size="hand" state="normal" />
        </div>
      </div>
      <div class="ghost-demo__anchor" data-part="dot" style:left="{from.x}px" style:top="{from.y}px">
        <div class="ghost-demo__dot"></div>
      </div>
    {:else}
      {#each tapRuns as run, i (i)}
        <div class="ghost-demo__anchor" data-part="tap-ripple" style:left="{run.at.x}px" style:top="{run.at.y}px">
          <div class="ghost-demo__ripple"></div>
        </div>
        <div class="ghost-demo__anchor" data-part="tap-dot" style:left="{run.at.x}px" style:top="{run.at.y}px">
          <div class="ghost-demo__dot"></div>
        </div>
      {/each}
    {/if}
  {:else if demo}
    {#if line}
      <div
        class="ghost-demo__line"
        data-part="line"
        style:left="{line.x}px"
        style:top="{line.y}px"
        style:width="{line.length}px"
        style:transform="rotate({line.deg}deg)"
      ></div>
    {/if}
    {#each markers as marker (marker.n)}
      <div class="ghost-demo__marker" data-part="marker" style:left="{marker.x}px" style:top="{marker.y}px">
        {marker.n}
      </div>
    {/each}
  {/if}
</div>

<style>
  .ghost-demo {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }

  /* A zero-size anchor at the point of interest. The anchor is what WAAPI
     moves, so each part keeps a fixed layout box and only paints with
     transform and opacity. Dark until its animation starts. */
  .ghost-demo__anchor {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    will-change: transform, opacity;
  }

  /* The fingertip: a 36 px pearl circle at 85%, a 2 px iris ring, a soft
     shadow. The familiar touch-indicator idiom, built from UI primitives. */
  .ghost-demo__dot {
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    margin: -18px 0 0 -18px;
    border: 2px solid var(--cu-iris, #5ccfc4);
    border-radius: 50%;
    background: var(--cu-pearl, #eee8f1);
    box-shadow: 0 3px 10px rgb(0 0 0 / 40%);
    opacity: 0.85;
  }

  .ghost-demo__ripple {
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    margin: -18px 0 0 -18px;
    border: 2px solid var(--cu-iris, #5ccfc4);
    border-radius: 50%;
  }

  /* SPEC §5.6 rule 2: the container owns the card box. The same hand-size
     token HandCard uses, centred on the anchor; the Face fills it and is
     clipped. The shadow is the "lifted" look; the opacity is animated. */
  .ghost-demo__card {
    box-sizing: border-box;
    flex: none;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    margin: calc(var(--cuttle-card-width-hand) * var(--cuttle-card-aspect-ratio) / -2) 0 0
      calc(var(--cuttle-card-width-hand) / -2);
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 10px 18px rgb(0 0 0 / 45%);
  }

  .ghost-demo__ring {
    position: absolute;
    box-sizing: border-box;
    border: var(--cu-ring-width, 3px) solid var(--cu-ochre, #f0b54a);
    border-radius: var(--cu-radius-well, 10px);
    opacity: 0;
  }

  /* Reduced motion: numbered markers in the order of the action. */
  .ghost-demo__marker {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
    border: 2px solid var(--cu-iris, #5ccfc4);
    border-radius: 50%;
    background: var(--cu-pearl, #eee8f1);
    color: var(--cu-on-accent, #241c2b);
    font-family: var(--cu-font-ui, system-ui, sans-serif);
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 1;
    box-shadow: 0 2px 6px rgb(0 0 0 / 40%);
  }

  .ghost-demo__line {
    position: absolute;
    height: 0;
    border-top: 2px dashed var(--cu-iris, #5ccfc4);
    transform-origin: 0 50%;
  }
</style>
