<script lang="ts">
  // Tutorial spotlight (docs/tutorial-design.md §7.1 layers 1-2, §8.1-§8.2;
  // plan T4). "Ink settles over the board and clears around the one thing to
  // look at": one full-screen SVG scrim in --cu-curtain at 0.62 with a rounded
  // window per hole, and a ring per hole. The scrim is plain ink, never the
  // curtain's dot field. Nothing here takes a pointer event, and the whole
  // layer is aria-hidden. Motion is opacity and transform only.
  import { settings } from '../stores/settings.svelte';
  import { PLACEMENT, type Box } from '../tutorial/placement';

  interface CoachSpotlightProps {
    /** Target rects in viewport coordinates, unpadded; at most two. */
    holes: Box[];
    /** iris = play here; ochre = a successful drop (200 ms flash, T9 drives it). */
    ring: 'iris' | 'ochre';
    visible: boolean;
  }

  let { holes, ring, visible }: CoachSpotlightProps = $props();

  const uid = $props.id();
  const maskId = `coach-mask-${uid}`;
  const RADIUS = 10; // matches --cu-radius-well
  const pad = PLACEMENT.holePad;

  function osReduces(): boolean {
    try {
      return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    } catch {
      return false;
    }
  }

  const still = $derived(settings.reducedMotion || osReduces());

  const padded = $derived(
    holes.map((h) => ({ x: h.x - pad, y: h.y - pad, width: h.width + pad * 2, height: h.height + pad * 2 })),
  );
</script>

<div
  class="coach-spotlight"
  aria-hidden="true"
  style="pointer-events: none"
  data-visible={visible ? 'true' : 'false'}
  data-ring={ring}
  data-reduced={still ? 'true' : 'false'}
>
  <svg class="coach-spotlight__scrim" width="100%" height="100%" aria-hidden="true" focusable="false">
    <defs>
      <mask id={maskId}>
        <rect x="0" y="0" width="100%" height="100%" fill="white" />
        {#each padded as hole, i (i)}
          <rect
            class="coach-spotlight__window"
            x={hole.x}
            y={hole.y}
            width={hole.width}
            height={hole.height}
            rx={RADIUS}
            ry={RADIUS}
            fill="black"
          />
        {/each}
      </mask>
    </defs>
    <rect class="coach-spotlight__shade" x="0" y="0" width="100%" height="100%" mask="url(#{maskId})" />
  </svg>

  {#each padded as hole, i (i)}
    <div
      class="coach-spotlight__ring"
      data-coach-hole=""
      style="left: {hole.x}px; top: {hole.y}px; width: {hole.width}px; height: {hole.height}px"
    ></div>
  {/each}
</div>

<style>
  .coach-spotlight {
    position: fixed;
    inset: 0;
    opacity: 0;
    transition: opacity var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach-spotlight[data-visible='true'] {
    opacity: 1;
    animation: coach-spotlight-in var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach-spotlight[data-reduced='true'] {
    transition: none;
    animation: none;
  }

  @keyframes coach-spotlight-in {
    from {
      opacity: 0;
    }
  }

  .coach-spotlight__scrim {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .coach-spotlight__shade {
    fill: var(--cu-curtain, #1a1420);
    fill-opacity: 0.62;
  }

  /* The ring is two stacked borders, iris and ochre; the flip between them is
     an opacity cross-fade, so only transform and opacity ever animate. */
  .coach-spotlight__ring {
    position: absolute;
    box-sizing: border-box;
    border-radius: var(--cu-radius-well, 10px);
    opacity: 0.9;
    animation:
      coach-spotlight-ring-in var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out),
      coach-spotlight-pulse 1400ms var(--cu-ease-in-out, ease-in-out) 3;
  }

  .coach-spotlight__ring::before,
  .coach-spotlight__ring::after {
    content: '';
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    border: var(--cu-ring-width, 3px) solid transparent;
    border-radius: inherit;
    transition: opacity var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach-spotlight__ring::before {
    border-color: var(--cu-iris, #5ccfc4);
    opacity: 1;
  }

  .coach-spotlight__ring::after {
    border-color: var(--cu-ochre, #f0b54a);
    opacity: 0;
  }

  .coach-spotlight[data-ring='ochre'] .coach-spotlight__ring::before {
    opacity: 0;
  }

  .coach-spotlight[data-ring='ochre'] .coach-spotlight__ring::after {
    opacity: 1;
  }

  /* A new ring fades in over 200 ms. A ring that goes away just goes: holes
     move instantly (design §8.2), so there is nothing to carry over. */
  @keyframes coach-spotlight-ring-in {
    from {
      opacity: 0;
    }
  }

  /* Three pulses, then steady (design §8.2). Reduced motion: a steady ring. */
  @keyframes coach-spotlight-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.9;
    }
    50% {
      transform: scale(1.06);
      opacity: 0.55;
    }
  }

  .coach-spotlight[data-reduced='true'] .coach-spotlight__ring {
    animation: none;
  }

  .coach-spotlight[data-reduced='true'] .coach-spotlight__ring::before,
  .coach-spotlight[data-reduced='true'] .coach-spotlight__ring::after {
    transition: none;
  }
</style>
