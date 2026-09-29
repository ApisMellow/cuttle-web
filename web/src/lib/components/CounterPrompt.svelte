<script lang="ts">
  // P2 W13, SPEC §4.3 (R14), §6.3 Counter/Decline rows, design.md §8 ("the
  // ack and counter prompts reuse this frame") — ONE component for the real
  // counter window and the synthetic acknowledgment.
  //
  // Privacy (R14): the acting player must not be able to tell "the opponent
  // had no 2" from "the opponent declined". The two paths therefore differ
  // in exactly one thing, the counter buttons in `options`, which are empty
  // on the synthetic path. Everything else is built from props that are the
  // same on both paths: the history-derived chain (`counterPromptEntries`),
  // the viewer and the names. No view-derived value (scores, pending,
  // hand, board) renders here, because at a synthetic ack the one-off has
  // already resolved and those values would differ. The component never
  // learns which path it is on.
  //
  // "Let it resolve" is a one-tap confirm (SPEC §6.3: Decline commits no
  // card). It sits in the dismiss-pill slot, bottom-anchored, and the
  // options region above it is always present, so its position does not
  // depend on how many buttons the region holds. A counter is a card play,
  // so it stages first and applies only on Confirm (R12).
  //
  // Once-only: after any callback fires, further taps are ignored until the
  // curtain moves on and this instance unmounts. Nothing here runs on a
  // timer; nothing auto-advances.
  import '../styles/card-geometry.css';

  import { tick } from 'svelte';

  import { keyActivationGuard, type KeyActivationGuard } from '../keyGuard';

  import type { AppliedMove, PlayerId } from '../bridge/schema';
  // Amended 2026-09-28: option and staged text go through `plainMoveText`
  // ("Counter with 2♣: stop their card."), never raw engine text. Same on
  // both paths; the synthetic ack simply has no options.
  import { formatRecapLines, plainMoveText, recapCards } from '../recap';
  import type { ChooserCandidate } from '../stores/staging.svelte';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';
  import StagingBar from './StagingBar.svelte';

  interface CounterPromptProps {
    /** `counterPromptEntries(history)`: the one-off, then each 2 played on it. */
    entries: AppliedMove[];
    /** The player deciding (the ack's `to`). */
    viewer: PlayerId;
    names: readonly [string, string];
    /** One per legal Counter move (engine index + description). `[]` on the synthetic ack. */
    options: ChooserCandidate[];
    onresolve: () => void;
    oncounter: (index: number) => void;
    theme?: CardTheme;
  }

  let { entries, viewer, names, options, onresolve, oncounter, theme = getTheme(DEFAULT_THEME_ID) }: CounterPromptProps =
    $props();

  // Playtest 2026-09-29: each 2 names what it stops ("to stop your 5♥"),
  // read from the entry before it in `entries` — the same run on both paths.
  const lines = $derived.by(() => {
    const texts = formatRecapLines(entries, viewer, names);
    return entries.map((entry, k) => ({ seq: entry.seq, cards: recapCards(entry), text: texts[k] }));
  });

  let staged = $state<ChooserCandidate | null>(null);
  let acted = false;

  function resolve(): void {
    if (acted || staged !== null) return; // W25: a staged counter locks it
    acted = true;
    onresolve();
  }


  function stage(option: ChooserCandidate): void {
    if (acted) return;
    staged = option;
    focusSoon('[data-testid="staging-confirm"]');
  }

  function confirmCounter(): void {
    if (acted || staged === null) return;
    acted = true;
    oncounter(staged.index);
  }

  function cancelCounter(): void {
    staged = null;
    focusSoon('[data-testid^="counter-option-"]');
  }

  // r16 (desktop keyboard; review B1): focus never falls to <body> here,
  // and never lands on a control by itself: on arrival it goes to the
  // heading (Tab reaches the options and "Let it resolve"), identically on
  // the real and synthetic paths (R14). A click produced by a key that went
  // down before this screen mounted, or by an auto-repeat, is ignored
  // (lib/keyGuard.ts), so a key held or mashed on the reveal can't resolve
  // or counter. Staging a counter moves focus to Confirm; Cancel brings it
  // back to the first option.
  let root: HTMLDivElement | undefined = $state();
  let heading: HTMLHeadingElement | undefined = $state();
  let guard: KeyActivationGuard | null = null;

  function focusSoon(selector: string): void {
    void tick().then(() => root?.querySelector<HTMLElement>(selector)?.focus());
  }

  function guarded(fn: () => void): () => void {
    return () => {
      if (guard !== null && !guard.allows()) return;
      fn();
    };
  }

  $effect(() => {
    heading?.focus({ preventScroll: true });
  });

  $effect(() => {
    const g = keyActivationGuard();
    guard = g;
    return () => {
      g.dispose();
      if (guard === g) guard = null;
    };
  });
</script>

<div class="counter-prompt" data-testid="counter-prompt" bind:this={root}>
  <h2 class="counter-prompt__heading" tabindex="-1" bind:this={heading}>Your response</h2>

  <ul class="counter-prompt__list">
    {#each lines as line (line.seq)}
      <li class="counter-prompt__line">
        {#each line.cards as card, i (i)}
          <span class="counter-prompt__face"><theme.Face {card} size="mini" /></span>
        {/each}
        <span class="counter-prompt__text">{line.text}</span>
      </li>
    {/each}
  </ul>

  <div class="counter-prompt__options">
    {#if staged !== null}
      <!-- r16 re-review B2 (R12): focus moves to Confirm when a counter is
           staged, so a held Enter's auto-repeats must not confirm it. -->
      <StagingBar description={plainMoveText(staged.description)} onconfirm={guarded(confirmCounter)} oncancel={guarded(cancelCounter)} />
    {:else}
      {#each options as option (option.index)}
        <button
          type="button"
          class="counter-prompt__option"
          data-testid={`counter-option-${option.index}`}
          onclick={guarded(() => stage(option))}
        >
          {plainMoveText(option.description)}
        </button>
      {/each}
    {/if}
  </div>

  <div class="counter-prompt__footer">
    <!-- W25: disabled only while a counter is staged. Unstaged (the only
         state the synthetic ack can be in) it carries no disabled attribute,
         so the two paths stay identical (R14). -->
    <button
      type="button"
      class="counter-prompt__resolve"
      data-testid="counter-resolve"
      disabled={staged !== null}
      onclick={guarded(resolve)}
    >
      Let it resolve
    </button>
  </div>
</div>

<style>
  /* design.md §8: the recap frame, reused. Full viewport, --cu-ink. */
  .counter-prompt {
    position: fixed;
    inset: 0;
    /* r16 (desktop): the board's 560 px column, centred, like every other
       game screen's content; a phone is narrower than the cap. The page
       behind it is the same ink, so nothing else changes. */
    max-width: var(--cu-board-max, 560px);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: calc(var(--cu-space-6, 32px) + var(--cu-safe-top, 0px)) var(--cu-gutter-sheet, 16px)
      var(--cu-safe-bottom, 0px);
    background: var(--cu-ink, #241c2b);
    color: var(--cu-pearl, #eee8f1);
    font-family: var(--cu-font-ui, sans-serif);
    overflow: hidden;
  }

  /* A focus landing spot (r16), not a control. */
  .counter-prompt__heading:focus {
    outline: none;
  }

  .counter-prompt__heading {
    margin: 0 0 var(--cu-space-4, 16px);
    font-size: var(--cu-text-xl, 25px);
    font-weight: 700;
  }

  .counter-prompt__list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  .counter-prompt__line {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2, 8px);
    padding: var(--cu-space-2, 8px) 0;
    font-size: var(--cu-text-md, 16px);
  }

  /* SPEC §5.6 rule 2: the container owns the card box; the face fills it. */
  .counter-prompt__face {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-mini);
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
  }

  .counter-prompt__text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* Fixed height whatever it holds, so the resolve pill never moves. */
  .counter-prompt__options {
    flex: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: var(--cu-space-2, 8px);
    height: 112px;
    overflow-y: auto;
  }

  .counter-prompt__option {
    box-sizing: border-box;
    min-height: 44px;
    padding: 0 var(--cu-space-4, 16px);
    border: 1px solid var(--cu-iris, #5ccfc4);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  /* Same slot as the recap's "See the board" pill (design.md §8). */
  .counter-prompt__footer {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--cu-space-3, 12px) 0 calc(18vh - 24px);
  }

  .counter-prompt__resolve {
    box-sizing: border-box;
    width: 240px;
    height: 48px;
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: 999px;
    background: var(--cu-iris, #5ccfc4);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  .counter-prompt__resolve:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
