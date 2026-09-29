<script lang="ts">
  // SPEC §4.6 (R20), docs/design.md §8 — "while you were away". Mounted by
  // Curtain only at curtain.kind === 'recap'. `entries` arrives already
  // filtered (unseen + `isRecapVisible`, SPEC §4.6); this component never
  // filters it.
  //
  // Each line: a theme `mini` face for every card the line names, then the
  // sentence. Both come from `lib/recap.ts`: `recapCards(entry)` picks the
  // cards (from `card` and `targetCard` only, never `index`) in sentence
  // order, and `formatRecapLine` writes the text. This component builds no
  // card text itself (AGENTS.md "Recap and staging text").
  //
  // Layout (orchestrator ruling C2, R13.4): heading, list, then a footer
  // anchored to the bottom holding "+N earlier" (above the dismiss pill, in
  // the lower two-thirds, 44 px tall) and "See the board" (the two-step
  // pill's position, design.md §8).
  //
  // A null viewer is a caller contract violation (recap implies someone is
  // looking). It renders a neutral empty state with the dismiss pill and no
  // line or face, rather than throwing or guessing a perspective.
  import '../styles/card-geometry.css';

  import type { AppliedMove, PlayerId } from '../bridge/schema';
  import { formatRecapLine, recapCards } from '../recap';
  import { keyActivationGuard, type KeyActivationGuard } from '../keyGuard';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface RecapPanelProps {
    entries: AppliedMove[];
    viewer: PlayerId | null;
    names: readonly [string, string];
    onadvance: () => void;
    theme?: CardTheme;
  }

  let { entries, viewer, names, onadvance, theme = getTheme(DEFAULT_THEME_ID) }: RecapPanelProps = $props();

  /** SPEC §4.6: "At most the last 6 entries, oldest first." */
  const MAX_VISIBLE = 6;

  let expanded = $state(false);

  const hiddenCount = $derived(viewer === null ? 0 : Math.max(0, entries.length - MAX_VISIBLE));
  const visible = $derived(
    viewer === null ? [] : expanded || hiddenCount === 0 ? entries : entries.slice(entries.length - MAX_VISIBLE),
  );
  const lines = $derived(
    viewer === null
      ? []
      : visible.map((entry) => ({ seq: entry.seq, cards: recapCards(entry), text: formatRecapLine(entry, viewer, names) })),
  );

  function expand(): void {
    expanded = true;
  }

  // r16 (desktop keyboard; review B1): focus starts on the heading, not
  // <body> and not a button, so no key press from the screen before can
  // dismiss this; Tab reaches the buttons. A button click produced by a
  // key that went down before this screen mounted (or an auto-repeat) is
  // ignored (lib/keyGuard.ts).
  let heading: HTMLHeadingElement | undefined = $state();
  let guard: KeyActivationGuard | null = null;
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

  function guarded(fn: () => void): () => void {
    return () => {
      if (guard !== null && !guard.allows()) return;
      fn();
    };
  }
</script>

<div class="recap" data-testid="recap">
  <h2 class="recap__heading" tabindex="-1" bind:this={heading}>While you were away</h2>

  {#if viewer === null}
    <p class="recap__empty">Nothing to show.</p>
  {:else}
    <ul class="recap__list">
      {#each lines as line (line.seq)}
        <li class="recap__line">
          {#each line.cards as card, i (i)}
            <span class="recap__face"><theme.Face {card} size="mini" /></span>
          {/each}
          <span class="recap__text">{line.text}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="recap__footer">
    {#if hiddenCount > 0 && !expanded}
      <button type="button" class="recap__expand" data-testid="recap-expand" onclick={expand}>
        +{hiddenCount} earlier
      </button>
    {/if}
    <button type="button" class="recap__dismiss" data-testid="recap-dismiss" onclick={guarded(onadvance)}>
      See the board
    </button>
  </div>
</div>

<style>
  /* design.md §8: the recap switches to --cu-ink, the first screen that
     belongs to the viewer. */
  .recap {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
    padding: var(--cu-space-6, 32px) var(--cu-gutter-sheet, 16px) 0;
    background: var(--cu-ink, #241c2b);
    color: var(--cu-pearl, #eee8f1);
    font-family: var(--cu-font-ui, sans-serif);
  }

  /* A focus landing spot (r16), not a control. */
  .recap__heading:focus {
    outline: none;
  }

  .recap__heading {
    margin: 0 0 var(--cu-space-4, 16px);
    font-size: var(--cu-text-xl, 25px);
    font-weight: 700;
  }

  .recap__list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  .recap__empty {
    flex: 1;
    margin: 0;
    font-size: var(--cu-text-md, 16px);
    color: var(--cu-muted, #b4a8be);
  }

  .recap__line {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2, 8px);
    padding: var(--cu-space-2, 8px) 0;
    font-size: var(--cu-text-md, 16px);
  }

  /* SPEC §5.6 rule 2: the container owns the card box; the face fills it. */
  .recap__face {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-mini);
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
  }

  .recap__text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* C2 / R13.4: bottom-anchored, so both controls sit in the lower two
     thirds; the dismiss pill's centre lands at 82% of 844 like the gate's. */
  .recap__footer {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--cu-space-2, 8px);
    padding: var(--cu-space-3, 12px) 0 calc(18vh - 24px);
  }

  .recap__expand {
    box-sizing: border-box;
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--cu-space-4, 16px);
    border: none;
    background: none;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-md, 16px);
    text-decoration: underline;
    cursor: pointer;
  }

  .recap__dismiss {
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
</style>
