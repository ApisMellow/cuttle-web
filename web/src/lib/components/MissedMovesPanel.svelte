<script lang="ts">
  // Two-phone W13b (plan §7, SPEC §2.12.2 `lastSeq`, §2.12.9, §4.6): the
  // missed-moves recap. When a state arrives in the same game more than one
  // move past the last state this page saw (a reconnect in the same page),
  // the online store lists the other seat's moves this phone missed. A
  // reload or a resume starts from its first state and never recaps.
  //
  // Layout (review blocker 1): a compact strip between the board and the
  // action bar, in the flow, so it takes its height from the board (which
  // scrolls) and never lies over the hand or the deck. Closed, it is one
  // header row (heading, count, Show, Got it) and the latest line. Open, the
  // last 6 lines (+N earlier) scroll inside a short list whose height grows
  // only on tall screens. The board stays live under it (non-blocking).
  //
  // `entries` arrive filtered by the store (`isRecapVisible`, the other seat
  // only, from this seat's own redacted history); this component never
  // filters or re-reads history for identities. As in RecapPanel, each line
  // is a theme `mini` face for every card `recapCards` names (from `card`
  // and `targetCard` only) and the `formatRecapLine` sentence. Nothing here
  // builds card text (AGENTS.md "Recap and staging text"), reads `index`,
  // `drawn` or a hand, so it can't name a card this seat never saw.
  import '../styles/card-geometry.css';

  import type { AppliedMove, PlayerId } from '../bridge/schema';
  import { formatRecapLine, recapCards } from '../recap';
  import type { CardTheme } from '../theme/types';

  interface Props {
    entries: readonly AppliedMove[];
    viewer: PlayerId;
    names: readonly [string, string];
    /** This seat's redacted history, so a Counter names what it stopped (SPEC §4.6). */
    history: readonly AppliedMove[];
    theme: CardTheme;
    ondismiss: () => void;
  }

  let { entries, viewer, names, history, theme, ondismiss }: Props = $props();

  /** SPEC §4.6: at most the last 6, oldest first; "+N earlier" shows the rest. */
  const MAX_VISIBLE = 6;
  let open = $state(false);
  let expanded = $state(false);

  /** One line per readable entry; an entry the formatter can't read is skipped on its own, never shown raw. */
  const allLines = $derived.by(() => {
    const out: { seq: number; cards: ReturnType<typeof recapCards>; text: string }[] = [];
    for (const entry of entries) {
      try {
        out.push({ seq: entry.seq, cards: recapCards(entry), text: formatRecapLine(entry, viewer, names, { history }) });
      } catch {
        // skipped
      }
    }
    return out;
  });
  const hiddenCount = $derived(expanded ? 0 : Math.max(0, allLines.length - MAX_VISIBLE));
  const lines = $derived(hiddenCount === 0 ? allLines : allLines.slice(allLines.length - MAX_VISIBLE));
  const latest = $derived(allLines.at(-1) ?? null);
  const count = $derived(allLines.length === 1 ? '1 move' : `${allLines.length} moves`);
</script>

<section class="missed" data-testid="online-recap" aria-labelledby="online-recap-heading">
  <div class="missed__head">
    <h2 id="online-recap-heading" class="missed__heading">
      While you were away <span class="missed__count">· {count}</span>
    </h2>
    {#if allLines.length > 1}
      <button
        type="button"
        class="missed__toggle"
        data-testid="online-recap-toggle"
        aria-expanded={open ? 'true' : 'false'}
        onclick={() => (open = !open)}
      >
        {open ? 'Hide' : 'Show'}
      </button>
    {/if}
    <button type="button" class="missed__dismiss" data-testid="online-recap-dismiss" onclick={ondismiss}>Got it</button>
  </div>
  {#if open}
    <div class="missed__list">
      {#if hiddenCount > 0}
        <button type="button" class="missed__expand" data-testid="online-recap-expand" onclick={() => (expanded = true)}>
          +{hiddenCount} earlier
        </button>
      {/if}
      <ul class="missed__lines">
        {#each lines as line (line.seq)}
          <li class="missed__line">
            {#each line.cards as card, i (i)}
              <span class="missed__face"><theme.Face {card} size="mini" /></span>
            {/each}
            <span class="missed__text">{line.text}</span>
          </li>
        {/each}
      </ul>
    </div>
  {:else if latest !== null}
    <p class="missed__line missed__line--latest">
      {#each latest.cards as card, i (i)}
        <span class="missed__face"><theme.Face {card} size="mini" /></span>
      {/each}
      <span class="missed__text missed__text--one">{latest.text}</span>
    </p>
  {/if}
</section>

<style>
  .missed {
    flex: none;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    padding: 0 var(--cu-space-3, 12px) var(--cu-space-1, 4px);
    border-top: 2px solid var(--cu-iris, #5ccfc4);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
  }

  .missed__head {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2, 8px);
  }

  .missed__heading {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .missed__count {
    color: var(--cu-muted, #b4a8be);
    font-weight: normal;
  }

  .missed__toggle,
  .missed__dismiss {
    flex: none;
    box-sizing: border-box;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-3, 12px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .missed__toggle {
    background: transparent;
    color: var(--cu-pearl, #eee8f1);
    text-decoration: underline;
  }

  .missed__dismiss {
    background: var(--cu-iris, #5ccfc4);
    color: var(--cu-on-accent, #241c2b);
  }

  /* Open: short on a short screen (393x660 leaves the board only room for
     its own hand), taller only where the screen has room. */
  .missed__list {
    max-height: clamp(84px, calc(100dvh - 600px), 200px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .missed__lines {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .missed__line {
    display: flex;
    align-items: center;
    gap: var(--cu-space-2, 8px);
    margin: 0;
    padding: 2px 0;
    font-size: var(--cu-text-sm, 14px);
    line-height: 1.3;
  }

  .missed__line--latest {
    min-width: 0;
  }

  /* SPEC §5.6 rule 2: the container owns the card box; the face fills it. */
  .missed__face {
    display: block;
    flex: none;
    width: var(--cuttle-card-width-mini);
    aspect-ratio: var(--cuttle-card-aspect);
    overflow: hidden;
  }

  .missed__text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .missed__text--one {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .missed__expand {
    box-sizing: border-box;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    padding: 0;
    border: none;
    background: none;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-sm, 14px);
    text-decoration: underline;
    cursor: pointer;
  }

  .missed__toggle:focus-visible,
  .missed__dismiss:focus-visible,
  .missed__expand:focus-visible {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: 2px;
  }
</style>
