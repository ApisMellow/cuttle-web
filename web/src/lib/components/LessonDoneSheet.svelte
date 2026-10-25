<script lang="ts">
  // Lesson-done sheet (docs/tutorial-design.md §4.4, §8.2, §9; plan T4).
  // A non-modal dialog that rises over the action bar. It focuses its heading
  // on arrival; Escape means "Lessons". Presentational: it never saves
  // progress (the store does, when the sheet appears) and never navigates.
  // Ochre marks the lesson-done pips and the primary button, as in the design.
  import { onMount } from 'svelte';

  import { settings } from '../stores/settings.svelte';

  interface LessonDoneSheetProps {
    /** The lesson that just finished, 1-5. */
    lesson: number;
    /** The lesson's "Done" summary line (fixed lesson text). */
    doneLine: string;
    /** Every finished lesson, this one included. */
    done: readonly number[];
    /** Lesson 5: "You've learned Cuttle", Play a game instead of Next lesson. */
    final: boolean;
    onnext?: () => void;
    onlessons?: () => void;
    onplay?: () => void;
  }

  let { lesson, doneLine, done, final, onnext, onlessons, onplay }: LessonDoneSheetProps = $props();

  const uid = $props.id();
  const headingId = `lesson-done-title-${uid}`;
  const LESSONS = [1, 2, 3, 4, 5] as const;

  function osReduces(): boolean {
    try {
      return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    } catch {
      return false;
    }
  }

  const still = $derived(settings.reducedMotion || osReduces());
  const heading = $derived(final ? "You've learned Cuttle" : `Lesson ${lesson} done`);
  const doneCount = $derived(LESSONS.filter((n) => done.includes(n)).length);

  let titleEl = $state<HTMLElement>();

  onMount(() => {
    titleEl?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onlessons?.();
  }
</script>

<!-- Non-modal on purpose: the board stays readable behind it and the coach
     never traps focus (design §9). -->
<div
  class="done"
  role="dialog"
  aria-modal="false"
  aria-labelledby={headingId}
  tabindex="-1"
  data-testid="coach-lesson-done"
  data-reduced={still ? 'true' : 'false'}
  {onkeydown}
>
  <h2 id={headingId} class="done__title" tabindex="-1" bind:this={titleEl}>{heading}</h2>
  <p class="done__line">{doneLine}</p>

  <!-- T14: the finale fills all five pips in turn, once the sheet has risen. -->
  <ol class="done__pips" aria-hidden="true" data-finale={final ? 'true' : undefined}>
    {#each LESSONS as n, i (n)}
      <li
        class="done__pip"
        class:done__pip--done={done.includes(n)}
        class:done__pip--new={n === lesson && done.includes(n)}
        style:--i={final ? i : undefined}
      ></li>
    {/each}
  </ol>
  <span class="done__sr">{doneCount} of 5 lessons done</span>

  <div class="done__actions">
    {#if final}
      <button type="button" class="done__button done__button--primary" data-testid="coach-play" onclick={() => onplay?.()}>
        Play a game
      </button>
    {:else}
      <button type="button" class="done__button done__button--primary" data-testid="coach-next-lesson" onclick={() => onnext?.()}>
        Next lesson
      </button>
    {/if}
    <button type="button" class="done__button done__button--ghost" data-testid="coach-lessons" onclick={() => onlessons?.()}>
      Lessons
    </button>
  </div>
</div>

<style>
  .done {
    position: fixed;
    z-index: 2;
    right: 0;
    bottom: 0;
    left: 0;
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    padding: var(--cu-space-5, 24px) var(--cu-gutter-sheet, 16px) calc(var(--cu-space-4, 16px) + var(--cu-safe-bottom, 0px));
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-top: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px) 0 0;
    box-shadow: 0 -8px 24px rgb(0 0 0 / 45%);
    font-family: var(--cu-font-ui, system-ui, sans-serif);
    animation: done-rise var(--cu-dur-slow, 320ms) var(--cu-ease-out, ease-out);
  }

  .done[data-reduced='true'] {
    animation: none;
  }

  @keyframes done-rise {
    from {
      transform: translateY(100%);
    }
  }

  .done__title {
    margin: 0;
    font-family: var(--cu-font-display, Georgia, serif);
    font-size: var(--cu-text-xl, 25px);
    font-weight: var(--cu-weight-regular, 400);
    line-height: var(--cu-leading-tight, 1.1);
    outline: none;
  }

  .done__line {
    margin: var(--cu-space-2, 8px) 0 0;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-md, 16px);
    line-height: 1.35;
  }

  /* Five pips: done in ochre, the rest in the hairline colour. The one that
     just completed lands with the overshoot. */
  .done__pips {
    display: flex;
    gap: var(--cu-space-2, 8px);
    margin: var(--cu-space-4, 16px) 0;
    padding: 0;
    list-style: none;
  }

  .done__pip {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--cu-ink-line, #4a3d57);
  }

  .done__pip--done {
    background: var(--cu-ochre, #f0b54a);
  }

  .done__pip--new {
    animation: done-pip 320ms var(--cu-ease-land, ease-out);
  }

  .done[data-reduced='true'] .done__pip--new {
    animation: none;
  }

  @keyframes done-pip {
    from {
      transform: scale(0.4);
    }
  }

  /* T14, the finale ("You've learned Cuttle"): the pips start as hairline
     dots and an ochre fill pops into each in turn, 90 ms apart, after the
     sheet's rise. Transform and opacity only, on a fill layer over the dot.
     Reduced motion: every pip is simply ochre. */
  .done__pips[data-finale='true'] .done__pip {
    position: relative;
    background: var(--cu-ink-line, #4a3d57);
    animation: none;
  }

  .done__pips[data-finale='true'] .done__pip::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--cu-ochre, #f0b54a);
    animation: done-pip-fill 360ms var(--cu-ease-land, ease-out) both;
    animation-delay: calc(var(--cu-dur-slow, 320ms) + var(--i) * 90ms);
  }

  .done[data-reduced='true'] .done__pips[data-finale='true'] .done__pip::after {
    animation: none;
  }

  @keyframes done-pip-fill {
    0% {
      opacity: 0;
      transform: scale(0.3);
    }
    55% {
      opacity: 1;
      transform: scale(1.45);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .done__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .done__actions {
    display: flex;
    gap: var(--cu-space-3, 12px);
  }

  .done__button {
    box-sizing: border-box;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-4, 16px);
    border-radius: var(--cu-radius-control, 999px);
    font-family: inherit;
    font-size: var(--cu-text-md, 16px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .done__button:focus-visible {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: 2px;
  }

  .done__button--primary {
    flex: 1 1 auto;
    border: none;
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
  }

  .done__button--ghost {
    border: 1px solid var(--cu-ink-line, #4a3d57);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
  }
</style>
