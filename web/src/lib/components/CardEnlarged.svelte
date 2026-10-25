<script lang="ts">
  // Issue #54 — the held card, enlarged. Display only: the scrim and its
  // contents take no pointer events, so the release reaches GameScreen's
  // window handlers. The card is drawn by the theme's Face (SPEC §5.6): this
  // container sizes the box and the face fills it.
  import type { Card } from '../bridge/schema';
  import '../styles/card-geometry.css';
  import type { CardTheme } from '../theme/types';

  interface CardEnlargedProps {
    card: Card;
    theme: CardTheme;
  }

  let { card, theme }: CardEnlargedProps = $props();
</script>

<div class="card-enlarged" data-testid="card-enlarged" aria-hidden="true">
  <div class="card-enlarged__card">
    <theme.Face {card} size="hand" />
  </div>
</div>

<style>
  .card-enlarged {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(26 20 32 / 0.85);
    pointer-events: none;
  }

  /* About 90% of the short side, keeping the card aspect (width ÷ height =
     1 ÷ --cuttle-card-aspect-ratio). */
  .card-enlarged__card {
    width: min(90vw, calc(90dvh / var(--cuttle-card-aspect-ratio)));
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
    pointer-events: none;
  }
</style>
