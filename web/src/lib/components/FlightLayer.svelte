<script lang="ts">
  // Tutorial card flights (docs/tutorial-design.md §8.4, §9; plan T10). FLIP on
  // clones: the board has no card-movement animation, so this layer draws
  // throwaway copies of the cards involved and flies them from where they were
  // to where the engine put them. No Board change, no board attribute, class
  // or state is written; the real destination is held invisible with a WAAPI
  // opacity animation (`fill: none`) while its clone is in the air, and
  // nothing awaits any of it (SPEC §5.9).
  //
  // Privacy: a clone shows only identities that are already public (see
  // `capture` in lib/tutorial/motion.ts). The opponent's hand is a Back unless
  // glasses are down, and a card he plays turns face up at the midpoint.
  //
  // SPEC §5.6 rule 2: this component is the CONTAINER of every clone, so it
  // sizes the box from a measured rect and clips it; Face and Back fill it.
  // The layer is `aria-hidden`, ignores the pointer, carries no testid, and
  // its clones carry none of `data-testid`, `data-staged`, `aria-pressed` or
  // `data-state`, so the coach's page reader (which scans the game screen's
  // root) can never mistake one for staging. Stacking order is the overlay's
  // job (T9): the layer is `position: fixed; inset: 0` with no z-index.
  //
  // Reduced motion (`motion` false, or no Element.animate): no clones and no
  // flips; each destination gets a static ochre ring for 600 ms.
  import { flushSync } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  import type { PlayerView } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import type { CardTheme } from '../theme';
  import {
    REDUCED_RING_MS,
    arriveFrames,
    flightAfter,
    flightScript,
    lastIndexed,
    oppHandSlots,
    readMotionTokens,
    ringTargets,
    toRect,
    type FlightActor,
    type FlightCapture,
    type FlightEnds,
    type FlightRoot,
    type RectLike,
    type FlightScript,
  } from '../tutorial/motion';

  interface FlightLayerProps {
    theme: CardTheme;
    /** False = the reduced-motion variant: rings only, no clone, no animate() call. */
    motion: boolean;
  }

  let { theme, motion }: FlightLayerProps = $props();

  interface Clone {
    id: string;
    run: number;
    actor: FlightActor;
  }
  interface Ring {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }

  const JACK_OFFSET_FALLBACK = 37; // tokens.css --cu-jack-offset
  const SCRUB = ['data-testid', 'data-staged', 'aria-pressed', 'data-state'];

  let layer = $state<HTMLElement>();
  let clones = $state<Clone[]>([]);
  let rings = $state<Ring[]>([]);
  let nextId = 0;
  /** Cleanup for every flight and ring still running (cancels animations and timers). */
  const live = new SvelteSet<() => void>();

  $effect(() => () => {
    for (const stop of [...live]) stop();
  });

  const canAnimate = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

  const rectOf = (el: Element | null): RectLike | null => (el ? toRect(el.getBoundingClientRect()) : null);

  function px(raw: string): number | null {
    const m = /^(-?\d*\.?\d+)px$/.exec(raw.trim());
    return m ? Number(m[1]) : null;
  }

  /** Measures every destination in the page as it is after the move. */
  function measureEnds(cap: FlightCapture, root: FlightRoot, host: HTMLElement): FlightEnds {
    const slots = oppHandSlots(root);
    const oppHand = root.querySelector('[data-testid="opp-hand"]');
    let landingEl: Element | null = null;
    if (cap.landing === 'drawFlip' || cap.landing === 'drawBack') {
      landingEl = cap.mine ? lastIndexed(root, 'hand-card-') : (slots[slots.length - 1] ?? null);
    } else if (cap.row) {
      landingEl = lastIndexed(root, `${cap.row}-${cap.by}-`);
    }
    const style = getComputedStyle(host);
    const width = px(style.getPropertyValue('--cuttle-card-width-hand')) ?? 60;
    const ratio = Number.parseFloat(style.getPropertyValue('--cuttle-card-aspect-ratio'));
    const jack =
      landingEl && cap.landing === 'jackSteal'
        ? px(getComputedStyle(landingEl).getPropertyValue('--jack-offset')) ?? px(style.getPropertyValue('--cu-jack-offset'))
        : null;
    return {
      landing: rectOf(landingEl),
      scrap: rectOf(root.querySelector('[data-testid="scrap-pile"]')),
      oppHand: rectOf(oppHand),
      oppCards: slots.map((slot) => toRect(slot.getBoundingClientRect())),
      card: { width, height: width * (ratio > 0 ? ratio : 1.3) },
      jackOffset: jack ?? JACK_OFFSET_FALLBACK,
    };
  }

  /** The real element a hold targets, found again in the page after the render. */
  function holdTarget(target: FlightScript['holds'][number]['target'], cap: FlightCapture, root: FlightRoot): Element | null {
    if (target === 'scrap') return root.querySelector('[data-testid="scrap-pile"]');
    if (target.startsWith('oppCard:')) return oppHandSlots(root)[Number(target.slice('oppCard:'.length))] ?? null;
    if (cap.landing === 'drawFlip' || cap.landing === 'drawBack') {
      const slots = oppHandSlots(root);
      return cap.mine ? lastIndexed(root, 'hand-card-') : (slots[slots.length - 1] ?? null);
    }
    return cap.row ? lastIndexed(root, `${cap.row}-${cap.by}-`) : null;
  }

  /** A theme Face may stamp `data-state` on its root; no clone may carry any staging marker. */
  function scrub(host: HTMLElement): void {
    for (const attr of SCRUB) {
      for (const el of host.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    }
  }

  function showRings(cap: FlightCapture, ends: FlightEnds): void {
    const spots = ringTargets(cap).map((name) => (name === 'landing' ? ends.landing : name === 'scrap' ? ends.scrap : ends.oppHand));
    const mine: Ring[] = [];
    for (const r of spots) {
      if (r && r.width > 0 && r.height > 0) mine.push({ id: nextId++, x: r.x, y: r.y, width: r.width, height: r.height });
    }
    if (mine.length === 0) return;
    rings = [...rings, ...mine];
    flushSync();
    const stop = (): void => {
      clearTimeout(timer);
      live.delete(stop);
      const ids = new Set(mine.map((ring) => ring.id));
      rings = rings.filter((ring) => !ids.has(ring.id));
    };
    const timer = setTimeout(stop, REDUCED_RING_MS);
    live.add(stop);
  }

  /**
   * Plays one move's flight. `capture` is what `motion.capture` recorded before
   * the apply; `root` is the board's root, searched for the destinations now
   * that the new state is rendered; `after` is the viewer's own post-apply
   * view, the only source for a card just drawn and for the opponent's hand
   * once glasses are down (without it a drawn card lands as a back). Never
   * throws and never awaits: a decorative layer must not touch the state path.
   */
  export function play(cap: FlightCapture, root: FlightRoot, after?: PlayerView | null): void {
    const host = layer;
    if (!host) return;
    try {
      const ends = measureEnds(cap, root, host);
      if (!motion || !canAnimate()) {
        showRings(cap, ends);
        return;
      }
      const tokens = readMotionTokens(host);
      const script = flightScript(cap, ends, flightAfter(cap, after), tokens);
      const run = nextId++;
      const stage = script.actors.filter((a) => a.box.width > 0 && a.box.height > 0);
      if (stage.length === 0 && script.holds.length === 0 && script.arrives.length === 0) return;

      clones = [...clones, ...stage.map((actor) => ({ id: `${run}:${actor.key}`, run, actor }))];
      flushSync();
      scrub(host);

      const animations: Animation[] = [];
      for (const actor of stage) {
        const el = [...host.querySelectorAll<HTMLElement>(`[data-run="${run}"]`)].find((c) => c.getAttribute('data-actor') === actor.key);
        if (!el) continue;
        const timing = { duration: actor.durationMs, delay: actor.delayMs, fill: 'both' as const };
        animations.push(el.animate(actor.frames, timing));
        const flipper = el.querySelector<HTMLElement>('[data-part="flipper"]');
        if (flipper && actor.flipFrames) animations.push(flipper.animate(actor.flipFrames, timing));
        const glasses = el.querySelector<HTMLElement>('[data-part="glasses"]');
        if (glasses && actor.glassesFrames) animations.push(glasses.animate(actor.glassesFrames, timing));
      }
      for (const hold of script.holds) {
        const el = holdTarget(hold.target, cap, root);
        if (el) animations.push(el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: hold.ms, fill: 'none' }));
      }
      for (const name of script.arrives) {
        const el = name === 'scrap' ? root.querySelector('[data-testid="scrap-pile"]') : null;
        if (el) animations.push(el.animate(arriveFrames(), { duration: tokens.med, fill: 'none' }));
      }

      const stop = (): void => {
        clearTimeout(timer);
        live.delete(stop);
        for (const a of animations) a.cancel();
        clones = clones.filter((c) => c.run !== run);
      };
      // Backstop for a browser (or a stub) that never reports a finish.
      const timer = setTimeout(stop, script.durationMs + 100);
      live.add(stop);
      const longest = animations.reduce<Animation | null>((best, a) => {
        const end = (t: Animation | null) => Number(t?.effect?.getComputedTiming().endTime ?? 0);
        return best === null || end(a) >= end(best) ? a : best;
      }, null);
      if (longest) longest.onfinish = stop;
    } catch {
      // A flight is decoration. Whatever went wrong, the game state is untouched.
    }
  }
</script>

<div class="flight-layer" bind:this={layer} aria-hidden="true" style="pointer-events: none">
  {#each clones as clone (clone.id)}
    {@const a = clone.actor}
    <div
      class="flight"
      data-part="flight"
      data-run={clone.run}
      data-actor={a.key}
      aria-hidden="true"
      style:left="{a.box.x}px"
      style:top="{a.box.y}px"
      style:width="{a.box.width}px"
      style:height="{a.box.height}px"
      style:pointer-events="none"
    >
      <div class="flight__flipper" data-part="flipper">
        {#if a.back}
          <span class="flight__side" data-side="back"><theme.Back size={a.size} /></span>
        {/if}
        {#if a.face}
          <span class="flight__side" data-side="face" style:transform={a.back ? 'rotateY(180deg)' : undefined}>
            <theme.Face card={a.face} size={a.size} />
            {#if a.glassesFrames}
              <!-- T12b: the glasses face, exactly as PermanentRow draws a glasses
                   8 (variant glasses, field size, a landscape box). It is laid
                   out one card-height wide, centred and turned -90deg inside the
                   upright clone, so the clone's own 90deg turn leaves it level:
                   the card lands looking like the card that replaces it. -->
              <span
                class="flight__glasses"
                data-part="glasses"
                style:left="{(a.box.width - a.box.height) / 2}px"
                style:top="{(a.box.height - a.box.width) / 2}px"
                style:width="{a.box.height}px"
                style:height="{a.box.width}px"
                style:transform="rotate(-90deg)"
              >
                <theme.Face card={a.face} size="field" variant="glasses" />
              </span>
            {/if}
          </span>
        {/if}
      </div>
    </div>
  {/each}
  {#each rings as ring (ring.id)}
    <div
      class="flight-ring"
      data-part="ring"
      style:left="{ring.x - 4}px"
      style:top="{ring.y - 4}px"
      style:width="{ring.width + 8}px"
      style:height="{ring.height + 8}px"
    ></div>
  {/each}
</div>

<style>
  /* The perspective sits on the layer so a flipping clone has depth. */
  .flight-layer {
    position: fixed;
    inset: 0;
    overflow: hidden;
    perspective: 900px;
  }

  /* A clone is a box at a measured rect; only its transform and opacity are
     animated. Dark nothing: it is created and animated in one synchronous step. */
  .flight {
    position: absolute;
    transform-style: preserve-3d;
    transform-origin: 50% 50%;
    will-change: transform, opacity;
  }

  .flight__flipper {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
  }

  /* SPEC §5.6 rule 2: the container owns and clips the card box. Both sides
     hide their back, so a half-turn swaps one for the other. */
  .flight__side {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 8px 16px rgb(0 0 0 / 42%);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  /* T12b: the glasses face over the plain 8. Its box is set inline (landscape,
     centred, turned back); hidden until its fade-in starts, and the fade is
     opacity only. */
  .flight__glasses {
    position: absolute;
    display: block;
    overflow: hidden;
    opacity: 0;
  }

  /* Reduced motion: the change is still marked, with nothing moving. */
  .flight-ring {
    position: absolute;
    box-sizing: border-box;
    border: var(--cu-ring-width, 3px) solid var(--cu-ochre, #f0b54a);
    border-radius: var(--cu-radius-well, 10px);
  }
</style>
