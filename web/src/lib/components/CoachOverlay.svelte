<script lang="ts">
  // Learn to play: the coach overlay (docs/tutorial-design.md §7, §9; plan T9).
  // It sits beside GameScreen, never inside it: App renders both in one
  // `{#key lessonId}`, and the overlay finds the GameScreen root as its
  // sibling. The CoachController reads that root's DOM and the lesson table;
  // nothing here reads the staging store or writes the board.
  //
  // Layers, bottom to top (design §7.1): the scrim and rings
  // (CoachSpotlight), the flight layer (a slot; T11 mounts FlightLayer), the
  // ghost demo, the bubble (the one layer that takes input), the done sheet.
  //
  // The fade rule (plan review focus 1): `.game-screen` is `isolation:
  // isolate`, so this sibling paints above GameMenu, RulesSheet, ScrapBrowser,
  // CardDetailPopover and AmbiguityChooser whatever their z-index. While any
  // of them is open the whole overlay goes to opacity 0 and takes no pointer
  // events, so their controls stay reachable. An appear step waiting for one
  // (5.3's popover) completes first; the next step's coach shows once it
  // closes.
  //
  // Progress (design §4.4, §10): the lesson is marked done when the done
  // sheet MOUNTS, never at the last move.
  import { onMount, tick, untrack, type Snippet } from 'svelte';

  import { settings } from '../stores/settings.svelte';
  import { getTheme } from '../theme';
  import { CoachController, type CoachClock, type CoachFrames } from '../tutorial/coach.svelte';
  import { motionOn } from '../tutorial/motion';
  import type { TutorialTable } from '../tutorial/table.svelte';
  import { tutorial } from '../tutorial/tutorial.svelte';
  import type { LessonId } from '../tutorial/types';
  import CoachBubble from './CoachBubble.svelte';
  import CoachSpotlight from './CoachSpotlight.svelte';
  import GhostDemo from './GhostDemo.svelte';
  import LessonDoneSheet from './LessonDoneSheet.svelte';

  /** The store calls the overlay makes (the app's `tutorial` by default). */
  interface CoachOverlayStore {
    readonly done: readonly LessonId[];
    leave(): void;
    exitHome(): void;
    finishLesson(id: LessonId): void;
    nextLesson(): void;
  }

  interface CoachOverlayProps {
    /** The lesson's table, the same object GameScreen has as its source. Fixed for the overlay's life. */
    table: TutorialTable;
    store?: CoachOverlayStore;
    /** Layer 3, the card flights (T11 mounts FlightLayer here). */
    flights?: Snippet;
    /** The GameScreen root; by default the `game-screen` sibling of this overlay. */
    screen?: HTMLElement;
    /** Test seams for the controller's demo timers and measuring frames. */
    clock?: CoachClock;
    frames?: CoachFrames;
  }

  let { table, store = tutorial, flights, screen, clock, frames }: CoachOverlayProps = $props();

  const motion = $derived(motionOn(settings.reducedMotion));
  const theme = $derived(getTheme(settings.themeId));
  const lessonId = $derived(table.lesson.id);

  let rootEl = $state<HTMLDivElement>();
  let coach = $state.raw<CoachController | null>(null);

  /** Whether the last input was a key (design §9: Next takes focus only then). */
  let lastInputKey = false;

  onMount(() => {
    const screenEl =
      untrack(() => screen) ??
      rootEl?.parentElement?.querySelector<HTMLElement>(':scope > [data-testid="game-screen"]') ??
      null;
    if (!screenEl) return;
    const controller = new CoachController({
      table: untrack(() => table),
      root: screenEl,
      bubble: () => rootEl?.querySelector<HTMLElement>('[data-testid="coach-bubble"]') ?? null,
      reducedMotion: () => !motionOn(settings.reducedMotion),
      clock: untrack(() => clock),
      frames: untrack(() => frames),
    });
    coach = controller;
    // Lesson start: focus goes to the coach's copy, so a screen reader starts there.
    void tick().then(() => rootEl?.querySelector<HTMLElement>('[data-testid="coach-bubble"] [aria-live]')?.focus());
    return () => controller.dispose();
  });

  const covered = $derived(coach?.covered ?? false);
  const stage = $derived(coach?.stage ?? 'idle');
  const finished = $derived(table.phase === 'finished');
  const doneList = $derived([...new Set<LessonId>([...store.done, lessonId])]);

  // A `next` step's Next takes focus only when the last input was a key; a
  // touch or mouse player keeps focus where it is (design §9).
  let focusedNextFor: string | null = null;
  $effect(() => {
    const id = stage === 'next' ? (table.step?.id ?? null) : null;
    untrack(() => {
      if (id === null || id === focusedNextFor) {
        if (id === null) focusedNextFor = null;
        return;
      }
      focusedNextFor = id;
      if (!lastInputKey) return;
      void tick().then(() => rootEl?.querySelector<HTMLElement>('[data-testid="coach-next"]')?.focus());
    });
  });

  /** The done sheet just mounted: the lesson is done (design §10). */
  function markDone(): void {
    untrack(() => store.finishLesson(lessonId));
  }

  function restart(): void {
    table.restart();
  }
</script>

<svelte:window
  onkeydowncapture={() => (lastInputKey = true)}
  onpointerdowncapture={() => (lastInputKey = false)}
/>

<div
  class="coach-overlay"
  data-coach-overlay
  data-covered={covered ? 'true' : 'false'}
  data-coach-targets={coach?.targets.join(' ') ?? ''}
  data-reduced={motion ? 'false' : 'true'}
  style:opacity={covered ? '0' : null}
  style:pointer-events={covered ? 'none' : null}
  bind:this={rootEl}
>
  {#if coach}
    <CoachSpotlight holes={[...coach.holes]} ring="iris" visible={coach.targets.length > 0} />
    {@render flights?.()}
    <GhostDemo demo={coach.demo} playKey={coach.playKey} {motion} confirmBox={coach.confirmBox} {theme} />
    {#if stage === 'error'}
      <!-- The board takes no tap while the lesson is stuck; the menu row
           above it stays live, and so do the bubble's Restart and Leave. -->
      <div class="coach-overlay__block" data-coach-block aria-hidden="true" style:top="{coach.blockTop}px"></div>
    {/if}
    <CoachBubble
      text={coach.text}
      tone={coach.tone}
      stepId={table.step?.id ?? ''}
      {stage}
      showNext={stage === 'next'}
      onnext={() => table.next()}
      onshowme={() => coach?.showMe()}
      onleave={() => store.leave()}
      lessonNumber={lessonId}
      placement={coach.placement}
      shake={coach.shake}
      error={stage === 'error' ? { onrestart: restart } : undefined}
    />
    {#if finished}
      <div class="coach-overlay__done" {@attach markDone}>
        <LessonDoneSheet
          lesson={lessonId}
          doneLine={table.lesson.done}
          done={doneList}
          final={lessonId === 5}
          onnext={() => store.nextLesson()}
          onlessons={() => store.leave()}
          onplay={() => store.exitHome()}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  /* No box of its own: every layer is fixed. The opacity carries the fade
     (design §7.1) and pointer-events: none is inherited by the bubble and the
     sheet, the only layers that take input. */
  .coach-overlay {
    transition: opacity var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach-overlay[data-reduced='true'] {
    transition: none;
  }

  .coach-overlay__block {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
  }
</style>
