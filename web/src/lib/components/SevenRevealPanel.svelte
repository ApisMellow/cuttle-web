<script lang="ts">
  // SPEC §5.2, §6.3 SevenPick row (R16) — the 7's reveal: the top one or two
  // deck cards, shown to the acting player only. Tapping one selects it as
  // the root of a move exactly as a hand card would (`seven:<i>`), and its
  // sub-moves' targets light on the real board.
  //
  // Presentational only. The privacy gate lives with the integrator:
  // GameScreen mounts this inside the board branch (curtain `none`) and only
  // when `view.viewer === view.active` at PhaseSevenChoosing with
  // `sevenRevealed` present (SPEC §3.2). This component keeps no copy of
  // `cards`: it renders exactly what it is given on each render, so nothing
  // survives an unmount behind the curtain.
  //
  // Placement (design.md §6): it takes the hand zone's slot, the same height
  // budget, while the choice is open. No hand card has a legal play in this
  // phase (apply.go:25-26 enumerates SevenPick moves only).
  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme, CardVisualState } from '../theme/types';

  interface SevenRevealPanelProps {
    /** `view.sevenRevealed` (1 or 2 cards). */
    cards: Card[];
    /** `StagingStore.selectedReveal`. */
    selected: number | null;
    /** `StagingStore.staged` (`seven:<i>` keys). */
    staged: ReadonlySet<string>;
    ontap: (key: `seven:${number}`) => void;
    theme?: CardTheme;
  }

  let { cards, selected, staged, ontap, theme = getTheme(DEFAULT_THEME_ID) }: SevenRevealPanelProps = $props();

  function stateOf(i: number): CardVisualState {
    if (staged.has(`seven:${i}`)) return 'staged';
    if (selected === i) return 'highlighted';
    return 'normal';
  }
</script>

<div class="seven-reveal" data-testid="seven-reveal" role="group" aria-label="Top of the deck">
  <div class="seven-reveal__text">
    <p class="seven-reveal__title">Top of the deck</p>
    <p class="seven-reveal__hint">{cards.length === 1 ? 'Play this card' : 'Pick one to play'}</p>
  </div>
  <div class="seven-reveal__cards">
    {#each cards as card, i (i)}
      <button
        type="button"
        class="seven-reveal__card"
        data-testid={`seven-card-${i}`}
        data-staged={staged.has(`seven:${i}`) ? 'true' : 'false'}
        aria-pressed={selected === i}
        onclick={() => ontap(`seven:${i}`)}
      >
        <theme.Face {card} size="hand" state={stateOf(i)} />
      </button>
    {/each}
  </div>
</div>

<style>
  .seven-reveal {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-4, 16px);
    box-sizing: border-box;
    /* W22: inside PlayerZone's pinned hand slot. Revealed cards don't
       lift, so the panel reaches up into most of the slot's 12px lift room
       and the slot keeps the hand's height (no reflow when a 7 resolves). */
    margin-top: -8px;
    padding: var(--cu-space-1, 4px) var(--cu-space-3, 12px);
    background: var(--cu-ink-raised, #30263a);
    border-radius: var(--cu-radius-well, 10px);
  }

  .seven-reveal__text {
    min-width: 0;
  }

  .seven-reveal__title {
    margin: 0;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    font-weight: 700;
  }

  .seven-reveal__hint {
    margin: 0;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-sm, 14px);
  }

  .seven-reveal__cards {
    display: flex;
    flex: none;
    gap: var(--cu-space-3, 12px);
  }

  /* SPEC §5.6 rule 2: the container owns the box; the ring reserve keeps a
     highlight or staged ring inside it (design.md §7). */
  .seven-reveal__card {
    display: block;
    flex: none;
    box-sizing: content-box;
    width: var(--cuttle-card-width-hand);
    aspect-ratio: var(--cuttle-card-aspect);
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 1px 3px rgb(0 0 0 / 40%);
    cursor: pointer;
  }
</style>
