<script module lang="ts">
  // Module-level so it's a real named export other files can import (a
  // Svelte instance-script `export const` is a component-instance export,
  // not an ES module binding). The text lives in lib/cardText.ts.
  import { NO_MOVES_REASON } from '../cardText';

  export const DEFAULT_REASON = NO_MOVES_REASON;
</script>

<script lang="ts">
  // PRD R9, SPEC §6.1 (W21, R9.3) — the dimmed-card detail popover.
  //
  // Presentational only: no store or bridge import. The integrator
  // (GameScreen) reads `StagingStore.inspect` and hands this component the
  // one card it names, plus `onclose` to clear it. This component never
  // resolves `inspect` itself and never reaches into any hand but the one
  // it's given.
  //
  // Privacy (AGENTS.md redaction rules): `reason` is chosen by the
  // integrator with `handCardReason` (lib/blockedReason.ts, playtest
  // 2026-09-29) from public board state and the viewer's own hand only (a
  // frozen card, an opponent Queen, no opponent points), so it can never
  // encode anything about the opponent's hand or the deck. Without one it
  // falls back to the generic line. `inspect` only ever fires for the
  // VIEWER'S OWN hand (SPEC §3.2).
  import type { Card } from '../bridge/schema';
  import { cardEffectLine, cardName } from '../cardText';
  import '../styles/card-geometry.css';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';

  interface CardDetailPopoverProps {
    /** The viewer's own hand card being inspected (SPEC §3.2 — never the opponent's). */
    card: Card;
    reason?: string;
    onclose: () => void;
    /** Injectable for testing / future theme wiring; defaults to the app default. */
    theme?: CardTheme;
  }

  let { card, reason = DEFAULT_REASON, onclose, theme = getTheme(DEFAULT_THEME_ID) }: CardDetailPopoverProps = $props();

  // Card labels: the card's short name (the theme's, else Classic) and one
  // line on what it does, from lib/cardText.ts, the source the chooser, the
  // staging bar and the Rules sheet share. Only ever for `card`, the
  // viewer's own hand card.
  const name = $derived(cardName(card, theme));
  const effect = $derived(cardEffectLine(card));
</script>

<!-- design.md §5/§11 bottom-sheet family, same chrome as AmbiguityChooser/
     ScrapBrowser. Unlike those two, this sheet also dismisses on tap-away
     (brief: "closes on tap-away or with a close button") — the scrim here
     carries its own onclick, which the other two sheets deliberately don't. -->
<div
  class="card-detail-popover__scrim"
  data-testid="card-detail-popover-scrim"
  aria-hidden="true"
  onclick={onclose}
></div>
<div
  class="card-detail-popover"
  data-testid="card-detail-popover"
  role="dialog"
  aria-modal="true"
  aria-labelledby="card-detail-popover-name"
  aria-describedby="card-detail-popover-effect card-detail-popover-reason"
>
  <div class="card-detail-popover__card">
    <div class="card-detail-popover__face">
      <theme.Face {card} size="field" />
    </div>
    <div class="card-detail-popover__label">
      <p id="card-detail-popover-name" class="card-detail-popover__name" data-card-label="name">{name}</p>
      <p id="card-detail-popover-effect" class="card-detail-popover__effect" data-card-label="effect">{effect}</p>
    </div>
  </div>
  <p id="card-detail-popover-reason" class="card-detail-popover__reason">{reason}</p>
  <button type="button" class="card-detail-popover__close" data-testid="card-detail-popover-close" onclick={onclose}>
    Close
  </button>
</div>

<style>
  .card-detail-popover__scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgb(26 20 32 / 0.72);
  }

  /* design.md §5, §11: a bottom sheet — ink-raised, top corners only at
     --cu-radius-sheet, --cu-gutter-sheet padding, inside the board column. */
  .card-detail-popover {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 31;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--cu-space-3, 12px);
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    padding: var(--cu-gutter-sheet, 16px) var(--cu-gutter-sheet, 16px)
      calc(var(--cu-gutter-sheet, 16px) + env(safe-area-inset-bottom));
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    border-radius: var(--cu-radius-sheet, 18px) var(--cu-radius-sheet, 18px) 0 0;
  }

  /* Card labels: the face with its name and effect beside it. */
  .card-detail-popover__card {
    display: flex;
    align-items: center;
    gap: var(--cu-space-3, 12px);
    max-width: 100%;
  }

  .card-detail-popover__label {
    min-width: 0;
  }

  .card-detail-popover__name {
    margin: 0 0 var(--cu-space-1, 4px);
    color: var(--cu-ochre, #f0b54a);
    font-size: var(--cu-text-lg, 20px);
    font-weight: var(--cu-weight-bold, 700);
    line-height: 1.15;
  }

  .card-detail-popover__effect {
    margin: 0;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    line-height: var(--cu-leading-body, 1.4);
  }

  /* SPEC §5.6 rule 2: the container owns the box. */
  .card-detail-popover__face {
    flex: none;
    width: var(--cuttle-card-width-field);
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
    border-radius: 8%;
  }

  .card-detail-popover__reason {
    margin: 0;
    max-width: 100%;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-md, 16px);
    text-align: center;
  }

  .card-detail-popover__close {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min, 44px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }
</style>
