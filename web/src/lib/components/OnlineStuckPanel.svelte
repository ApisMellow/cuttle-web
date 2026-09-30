<script lang="ts">
  // Two-phone W13b: the SPEC §2.10 stuck-state screen, online. Shown in place
  // of the board when the online store reports `stuck` (the server answered
  // ILLEGAL_MOVE or NO_LEGAL_MOVES, or this seat must act and nothing is
  // offered). It says plainly that the game can't go on, gives the game and
  // move number and the code (never the server's message, which can name a
  // card), lists the moves so far and offers one way on: leave the game.
  //
  // Differences from §2.10, by design online: no seed or dealer and no
  // scenario stanza to copy (the seed never leaves the server, SPEC
  // §2.12.5), and the move list is this seat's own recap lines (§4.6: never
  // raw Describe text, never a Decline, which would be a hold tell), built by
  // `formatRecapLine` from this seat's redacted history only. Nothing retries
  // (§2.10 rule 3).
  import type { AppliedMove, PlayerId } from '../bridge/schema';
  import { formatRecapLine, isRecapVisible } from '../recap';
  import type { OnlineStuck } from '../stores/tableSource';

  interface Props {
    stuck: OnlineStuck;
    history: readonly AppliedMove[];
    viewer: PlayerId;
    names: readonly [string, string];
    onleave: () => void;
  }

  let { stuck, history, viewer, names, onleave }: Props = $props();

  const lines = $derived.by(() => {
    const out: { seq: number; text: string }[] = [];
    for (const entry of history) {
      if (!isRecapVisible(entry)) continue;
      try {
        out.push({ seq: entry.seq, text: formatRecapLine(entry, viewer, names, { history }) });
      } catch {
        // Unreadable descriptions are skipped, never shown raw.
      }
    }
    return out;
  });
</script>

<section class="stuck" data-testid="online-stuck" aria-labelledby="online-stuck-heading">
  <h2 id="online-stuck-heading" class="stuck__heading">This game can’t go on</h2>
  <p class="stuck__body">The game hit a problem it can’t recover from. Nothing you do here will fix it, so leave this game and start a new one.</p>
  <p class="stuck__where">Game {stuck.game}, move {stuck.seq} · Error code: {stuck.code}</p>
  {#if lines.length > 0}
    <h3 class="stuck__subheading">Moves so far</h3>
    <ol class="stuck__moves">
      {#each lines as line (line.seq)}
        <li>{line.text}</li>
      {/each}
    </ol>
  {/if}
  <button type="button" class="stuck__leave" data-testid="online-leave-game" onclick={onleave}>Leave this game</button>
</section>

<style>
  .stuck {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-3, 12px);
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    padding: var(--cu-space-6, 32px) var(--cu-gutter-sheet, 16px) var(--cu-space-4, 16px);
    color: var(--cu-pearl, #eee8f1);
  }

  .stuck__heading {
    margin: 0;
    font-size: var(--cu-text-xl, 25px);
  }

  .stuck__body {
    margin: 0;
    font-size: var(--cu-text-md, 16px);
    line-height: var(--cu-leading-body, 1.4);
  }

  .stuck__where {
    margin: 0;
    color: var(--cu-muted, #b4a8be);
    font-size: var(--cu-text-sm, 14px);
    font-variant-numeric: tabular-nums;
  }

  .stuck__subheading {
    margin: var(--cu-space-2, 8px) 0 0;
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
  }

  .stuck__moves {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding-left: 1.6em;
    overflow-y: auto;
    font-size: var(--cu-text-sm, 14px);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .stuck__leave {
    flex: none;
    align-self: center;
    box-sizing: border-box;
    min-width: 200px;
    min-height: 48px;
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .stuck__leave:focus-visible {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: 2px;
  }
</style>
