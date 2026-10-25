<script lang="ts">
  // SPEC §4.8 (issue #53): an Ace's or a 6's wipe, played over the board.
  // The wiped cards are drawn as throwaway clones where they sat in their
  // rows, then fade and travel into the scrap pile's box over
  // WIPE_EFFECT_MS. The board under it already shows the rows after the
  // wipe; nothing here writes to it.
  //
  // Presentational only. GameScreen mounts this inside the board branch
  // (curtain `none`) while the source's `wipeEffect` is up for this viewer,
  // so it is never behind a curtain. It shows only cards that were on the
  // public rows (SPEC §3.2), through the theme's Face.
  //
  // `hold` (pass-and-play's before-the-pass show): the layer takes the
  // pointer, and a tap anywhere ends it early. As DrawRevealPanel: a click
  // counts only if its press landed on the layer after mount, and a key
  // counts only if it went down after mount and is not an auto-repeat, so a
  // finger or a key held from the previous screen can't skip it. Without
  // `hold` the layer ignores the pointer.
  //
  // Positions are measured from the DOM (as FlightLayer does) and expressed
  // in the layer's own box, so table mode's 180° turn needs nothing extra.
  //
  // Reduced motion (the setting or the OS): no clones and no travel; each
  // emptied row gets a static ochre outline for the same time.
  import type { PlayerId } from '../bridge/schema';
  import { WIPE_EFFECT_MS, type WipeEffect, type WipedCard } from '../globalEffect';
  import '../styles/card-geometry.css';
  import type { CardTheme } from '../theme/types';

  interface WipeEffectProps {
    wipe: WipeEffect;
    /** The viewer whose board is on show (decides which side each card was on). */
    viewer: PlayerId;
    /** The game screen's root, searched for the rows and the scrap pile. */
    root: HTMLElement | undefined;
    /** True when the game screen is turned 180° (table mode). */
    rotated?: boolean;
    reducedMotion?: boolean;
    /** The before-the-pass hold: a tap or a fresh key ends it early. */
    hold?: boolean;
    ondone: () => void;
    theme: CardTheme;
  }

  let { wipe, viewer, root, rotated = false, reducedMotion = false, hold = false, ondone, theme }: WipeEffectProps = $props();

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  interface Clone {
    id: number;
    card: WipedCard['card'];
    box: Box;
    dx: number;
    dy: number;
  }

  const JACK_STEP = 10;
  const GAP = 6;

  function reducedMotionQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  }

  const still = $derived(reducedMotion || (reducedMotionQuery()?.matches ?? false));

  let layer = $state<HTMLElement>();
  let clones = $state<Clone[]>([]);
  let outlines = $state<Array<{ id: string; box: Box }>>([]);

  // ---- Once-only end ------------------------------------------------------
  let done = false;
  function finish(): void {
    if (done) return;
    done = true;
    ondone();
  }

  $effect(() => {
    const timer = setTimeout(finish, WIPE_EFFECT_MS);
    return () => clearTimeout(timer);
  });

  // ---- Measuring ----------------------------------------------------------
  function px(raw: string): number | null {
    const m = /^(-?\d*\.?\d+)px$/.exec(raw.trim());
    return m ? Number(m[1]) : null;
  }

  /** A screen rect in the layer's own coordinates (the layer turns with the game screen). */
  function local(r: DOMRect, base: DOMRect): Box {
    if (rotated) {
      return { x: base.right - r.right, y: base.bottom - r.bottom, width: r.width, height: r.height };
    }
    return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
  }

  function rowEl(scope: HTMLElement, seat: PlayerId, row: WipedCard['row']): Element | null {
    const zone = scope.querySelector(seat === viewer ? '[data-testid="player-zone"]' : '[data-testid="opponent-zone"]');
    if (zone === null) return null;
    return zone.querySelector(row === 'points' ? '.point-row__cards' : '.permanent-row__cards') ?? zone;
  }

  $effect(() => {
    const host = layer;
    const scope = root;
    if (!host || !scope) return;
    try {
      const base = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const ratio = Number.parseFloat(style.getPropertyValue('--cuttle-card-aspect-ratio'));
      const aspect = ratio > 0 ? ratio : 1.3;
      const near = px(style.getPropertyValue('--cuttle-card-width-field')) ?? 60;
      const far = px(style.getPropertyValue('--cuttle-card-width-field-far')) ?? 52;
      const scrapEl = scope.querySelector('[data-testid="scrap-pile"]');
      const scrap = scrapEl ? local(scrapEl.getBoundingClientRect(), base) : null;

      if (still) {
        const marked: Array<{ id: string; box: Box }> = [];
        for (const w of wipe.cards) {
          const id = `${w.seat}:${w.row}`;
          const el = rowEl(scope, w.seat, w.row);
          if (el && !marked.some((o) => o.id === id)) marked.push({ id, box: local(el.getBoundingClientRect(), base) });
        }
        outlines = marked;
        return;
      }

      clones = wipe.cards.map((w, id) => {
        const el = rowEl(scope, w.seat, w.row);
        const row = el ? local(el.getBoundingClientRect(), base) : { x: 0, y: 0, width: 0, height: 0 };
        const width = w.seat === viewer ? near : far;
        const height = width * aspect;
        const lift = w.jack >= 0 ? (w.jack + 1) * JACK_STEP : 0;
        const box = { x: row.x + w.slot * (width + GAP) + lift, y: row.y + lift, width, height };
        const dx = scrap ? scrap.x + scrap.width / 2 - (box.x + width / 2) : 0;
        const dy = scrap ? scrap.y + scrap.height / 2 - (box.y + height / 2) : 0;
        return { id, card: w.card, box, dx, dy };
      });
    } catch {
      // Decoration only: whatever went wrong, the timer still ends it.
    }
  });

  // ---- Input (the hold only) ----------------------------------------------
  let pressedInside = false;

  $effect(() => {
    if (!hold) return;
    function onkeydown(event: KeyboardEvent): void {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) finish();
    }
    window.addEventListener('keydown', onkeydown, true);
    return () => window.removeEventListener('keydown', onkeydown, true);
  });
</script>

<!-- A pointer convenience during the hold (aria-hidden); a fresh key or the timer does the same. -->
<div
  class={['wipe-effect', { 'wipe-effect--hold': hold }]}
  data-testid="wipe-effect"
  data-mode={wipe.mode}
  data-motion={still ? 'reduced' : 'full'}
  aria-hidden="true"
  style:pointer-events={hold ? 'auto' : 'none'}
  style={`--wipe-ms: ${WIPE_EFFECT_MS}ms`}
  bind:this={layer}
  onpointerdown={() => (pressedInside = true)}
  onclick={(event) => {
    event.stopPropagation();
    if (!hold || !pressedInside) return;
    finish();
  }}
>
  {#each clones as clone (clone.id)}
    <span
      class="wipe-effect__clone"
      data-part="wipe-clone"
      style:left="{clone.box.x}px"
      style:top="{clone.box.y}px"
      style:width="{clone.box.width}px"
      style:height="{clone.box.height}px"
      style:--dx="{clone.dx}px"
      style:--dy="{clone.dy}px"
    >
      <theme.Face card={clone.card} size="field" />
    </span>
  {/each}
  {#each outlines as outline (outline.id)}
    <span
      class="wipe-effect__outline"
      data-part="wipe-outline"
      style:left="{outline.box.x - 4}px"
      style:top="{outline.box.y - 4}px"
      style:width="{outline.box.width + 8}px"
      style:height="{outline.box.height + 8}px"
    ></span>
  {/each}
</div>

<style>
  /* Over the whole game screen; it turns with it in table mode. */
  .wipe-effect {
    position: fixed;
    inset: 0;
    z-index: 15;
    overflow: hidden;
  }

  .wipe-effect--hold {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* SPEC §5.6 rule 2: the clone is the container; the Face fills it. */
  .wipe-effect__clone {
    position: absolute;
    display: block;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 6px 14px rgb(0 0 0 / 40%);
    will-change: transform, opacity;
    animation: wipe-sweep var(--wipe-ms, 1200ms) ease-in both;
  }

  @keyframes wipe-sweep {
    0% {
      opacity: 1;
      transform: none;
    }
    25% {
      opacity: 1;
      transform: none;
    }
    100% {
      opacity: 0;
      transform: translate(var(--dx, 0px), var(--dy, 0px)) scale(0.6);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .wipe-effect__clone {
      animation: none;
    }
  }

  /* Reduced motion: the emptied rows are marked, with nothing moving. */
  .wipe-effect__outline {
    position: absolute;
    box-sizing: border-box;
    border: var(--cu-ring-width, 3px) solid var(--cu-ochre, #f0b54a);
    border-radius: var(--cu-radius-well, 10px);
  }
</style>
