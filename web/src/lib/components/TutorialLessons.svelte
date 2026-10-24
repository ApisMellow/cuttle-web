<script lang="ts">
  // Learn to play: the lessons screen (docs/tutorial-design.md §4.2, §10;
  // plan §4 B7, T7). An ordinary full screen like Home. Five lessons in
  // order; any row starts its lesson, finished ones included. The primary pill
  // starts the first unfinished lesson. Back and Escape return Home.
  //
  // Reads progress when it mounts (design §10) and writes nothing: progress
  // is saved only when a lesson's done sheet appears (T9).
  import { onMount, untrack } from 'svelte';

  import { LESSONS } from '../tutorial/lessons';
  import { tutorial, type TutorialStore } from '../tutorial/tutorial.svelte';
  import type { LessonId } from '../tutorial/types';

  interface Props {
    /** The app's tutorial by default; tests pass their own store. */
    store?: TutorialStore;
  }
  let { store = tutorial }: Props = $props();

  // Once, at creation: this screen mounts fresh each time it is opened.
  untrack(() => store.reload());

  const continueLabel = $derived.by(() => {
    if (store.nextUnfinished === null) return 'Play again from lesson 1';
    if (store.done.length === 0) return 'Start';
    return `Continue: lesson ${store.nextUnfinished}`;
  });

  function startNext(): void {
    store.start(store.nextUnfinished ?? 1);
  }

  function isDone(id: LessonId): boolean {
    return store.done.includes(id);
  }

  let titleEl = $state<HTMLElement>();
  onMount(() => {
    titleEl?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    store.exitHome();
  }
</script>

<svelte:window {onkeydown} />

<div class="lessons" data-testid="tutorial-lessons">
  <button type="button" class="lessons__back" data-testid="tutorial-lessons-back" onclick={() => store.exitHome()}>
    <span class="lessons__back-mark" aria-hidden="true">‹</span>
    Home
  </button>

  <h1 class="lessons__title" tabindex="-1" bind:this={titleEl}>Learn to play</h1>
  <p class="lessons__lede">Five lessons, about a minute each. Leave any time.</p>

  <ol class="lessons__list">
    {#each LESSONS as lesson (lesson.id)}
      {@const finished = isDone(lesson.id)}
      <li class="lessons__item">
        <button
          type="button"
          class={['lessons__row', finished && 'lessons__row--done', lesson.id === store.nextUnfinished && 'lessons__row--next']}
          data-testid={`tutorial-lesson-${lesson.id}`}
          data-done={finished ? 'true' : 'false'}
          onclick={() => store.start(lesson.id)}
        >
          <span class="lessons__num">{lesson.id}</span>
          <span class="lessons__text">
            <span class="lessons__name">{lesson.title}</span>
            <span class="lessons__sub">{lesson.subtitle}</span>
          </span>
          {#if finished}
            <span class="lessons__check" aria-hidden="true">✓</span>
            <span class="lessons__sr">done</span>
          {/if}
        </button>
      </li>
    {/each}
  </ol>

  <button type="button" class="lessons__continue" data-testid="tutorial-continue" onclick={startNext}>
    {continueLabel}
  </button>
</div>

<style>
  .lessons {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    box-sizing: border-box;
    padding: calc(var(--cu-space-2) + var(--cu-safe-top)) var(--cu-gutter-sheet)
      calc(var(--cu-space-5) + var(--cu-safe-bottom));
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
  }

  .lessons__back {
    display: inline-flex;
    align-items: center;
    gap: var(--cu-space-1);
    align-self: flex-start;
    box-sizing: border-box;
    min-height: var(--cu-tap-min);
    min-width: var(--cu-tap-min);
    margin-left: calc(-1 * var(--cu-space-2));
    padding: 0 var(--cu-space-2);
    border: none;
    border-radius: var(--cu-radius-control);
    background: transparent;
    color: var(--cu-pearl);
    font-family: inherit;
    font-size: var(--cu-text-md);
    cursor: pointer;
  }

  .lessons__back-mark {
    font-size: var(--cu-text-lg);
    line-height: 1;
  }

  .lessons__title {
    margin: var(--cu-space-3) 0 0;
    font-family: var(--cu-font-display);
    font-size: var(--cu-text-xl);
    font-weight: var(--cu-weight-regular);
    line-height: var(--cu-leading-tight);
    outline: none;
  }

  .lessons__lede {
    margin: var(--cu-space-2) 0 var(--cu-space-5);
    color: var(--cu-muted);
    font-size: var(--cu-text-sm);
    line-height: var(--cu-leading-body);
  }

  /* The five lessons read as one path: a hairline runs down through the
     numerals, and turns ochre ("you chose this") behind each finished one. */
  .lessons__list {
    /* The pill below sits at the foot of the screen (margin-top: auto); this
       keeps it clear of the list on a short screen. */
    margin: 0 0 var(--cu-space-5);
    padding: var(--cu-space-1) 0;
    list-style: none;
    border: 1px solid var(--cu-ink-line);
    border-radius: var(--cu-radius-sheet);
    background: var(--cu-ink-raised);
  }

  .lessons__item {
    position: relative;
  }

  .lessons__item:not(:last-child)::after {
    content: '';
    position: absolute;
    left: calc(var(--cu-space-4) + 17px);
    top: calc(50% + 18px);
    bottom: calc(-50% + 18px);
    width: 2px;
    background: var(--cu-ink-line);
    pointer-events: none;
  }

  .lessons__item:has(.lessons__row--done):not(:last-child)::after {
    background: var(--cu-ochre);
  }

  .lessons__row {
    display: flex;
    align-items: center;
    gap: var(--cu-space-3);
    box-sizing: border-box;
    width: 100%;
    min-height: 56px;
    padding: var(--cu-space-2) var(--cu-space-4);
    border: none;
    border-radius: var(--cu-radius-well);
    background: transparent;
    color: var(--cu-pearl);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }

  .lessons__row:focus-visible,
  .lessons__back:focus-visible,
  .lessons__continue:focus-visible {
    outline: 2px solid var(--cu-iris);
    outline-offset: 2px;
  }

  .lessons__num {
    display: grid;
    place-items: center;
    flex: none;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    border: 1px solid var(--cu-ink-line);
    border-radius: 50%;
    background: var(--cu-ink);
    color: var(--cu-muted);
    font-family: var(--cu-font-display);
    font-size: var(--cu-text-lg);
    line-height: 1;
    font-variant-numeric: lining-nums;
  }

  .lessons__row--done .lessons__num {
    border-color: var(--cu-ochre);
    color: var(--cu-pearl);
  }

  /* The lesson the pill below would start: the "you can" accent. */
  .lessons__row--next .lessons__num {
    border: 2px solid var(--cu-iris);
    color: var(--cu-pearl);
  }

  .lessons__text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .lessons__name {
    font-size: var(--cu-text-md);
    font-weight: var(--cu-weight-bold);
  }

  .lessons__sub {
    color: var(--cu-muted);
    font-size: var(--cu-text-sm);
  }

  .lessons__check {
    flex: none;
    color: var(--cu-ochre);
    font-size: var(--cu-text-lg);
    font-weight: var(--cu-weight-bold);
  }

  .lessons__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .lessons__continue {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min);
    margin-top: auto;
    padding: 0 var(--cu-space-4);
    border: none;
    border-radius: var(--cu-radius-control);
    background: var(--cu-ochre);
    color: var(--cu-on-accent);
    font-family: inherit;
    font-size: var(--cu-text-md);
    font-weight: var(--cu-weight-bold);
    cursor: pointer;
  }
</style>
