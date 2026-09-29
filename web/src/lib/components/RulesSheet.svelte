<script lang="ts">
  // SPEC §5.5 (R17), amended 2026-09-28 (playtest friction): a short rules
  // cheat-sheet. One line per one-off rank, then how to win and how points
  // and permanents work, in plain words.
  //
  // The win is checked as soon as a play resolves, not at the end of a
  // turn (engine/apply.go v0.2.0 resolveOneOffWith checkWin, lines 773-776),
  // and a 2 that pops a last Jack can win it for the card's owner mid-turn
  // (lines 709-715) — hence "as soon as".
  //
  // Every line is sourced from the engine this build runs,
  // github.com/ApisMellow/cuttle@v0.2.0: RULES.md ("Win Condition", "Hand
  // Limit", "Turn Structure", "One-Offs", "Permanents", "Notes"), checked
  // against engine/apply.go and engine/win.go. It is a summary, not the full
  // RULES.md text; the build-time RULES.md screen with the engine-commit
  // footer (R17.1) is still to come. Nothing here decides legality — the
  // engine's legal-move list does that.
  //
  // No card glyphs: ranks are words or numerals and suits are named
  // (SPEC §5.6 rule 1: only the theme draws a rank with its suit).

  interface RulesSheetProps {
    onclose: () => void;
  }

  let { onclose }: RulesSheetProps = $props();

  const ONE_OFFS: Array<[string, string]> = [
    ['Ace', 'Scrap every point card on the table, both sides.'],
    ['2', 'Stop a one-off as it’s played, even on their turn (a 2 can stop a 2). Or on your turn: scrap one royal or glasses 8.'],
    ['3', 'Take any one card from the scrap into your hand.'],
    ['4', 'Your opponent discards 2 cards of their choice (or all they have, if fewer).'],
    ['5', 'Draw 2 cards (never past 8 in your hand).'],
    ['6', 'Scrap every royal and glasses 8 on the table, both sides.'],
    ['7', 'Look at the top 2 cards of the deck and play one right away. The other goes back on top. If neither can be played, scrap one instead.'],
    // engine/apply.go (v0.2.0) resolveOneOffWith, case Nine: the card goes
    // to its OWNER's hand (a stolen point card goes home), and the freeze
    // only matters to the opponent, whose turn is next (review B2).
    ['9', 'Send one of their table cards back to its owner’s hand. If it’s theirs, they can’t play it on their next turn. If it’s a card they stole from you, it comes back to you.'],
  ];

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose();
  }

  // Focus moves into the sheet when it opens and back to whatever opened it
  // (the Rules button) when it closes (review N3).
  let dialog: HTMLDivElement | undefined = $state();
  $effect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.focus();
    return () => opener?.focus();
  });
</script>

<svelte:window {onkeydown} />

<div class="rules" data-testid="rules-sheet" role="dialog" aria-modal="true" aria-labelledby="rules-title" tabindex="-1" bind:this={dialog}>
  <div class="rules__body">
    <h2 class="rules__title" id="rules-title">How to play</h2>

    <section>
      <h3>Win</h3>
      <p>You win as soon as you have 21 or more points on your side (fewer with Kings in play).</p>
      <p>Each King you have lowers that goal: 1 King 14, 2 Kings 10, 3 Kings 7, 4 Kings 5.</p>
    </section>

    <section>
      <h3>One-offs</h3>
      <p>Play the card for its effect, then it goes to the scrap. A 10 is points only.</p>
      <ul class="rules__list">
        {#each ONE_OFFS as [rank, text] (rank)}
          <li><b>{rank}:</b> {text}</li>
        {/each}
      </ul>
    </section>

    <section>
      <h3>Your turn</h3>
      <p>Do one thing: draw a card, play a card for points, scuttle, play a permanent, or play a one-off. You can hold at most 8 cards.</p>
      <p>If the deck is empty and you can’t play, you pass. Three passes in a row and nobody wins.</p>
    </section>

    <section>
      <h3>Points</h3>
      <p>Ace to 10 can go down as point cards. An Ace is worth 1, the rest their number.</p>
      <p>Scuttle: play a higher number card from your hand onto one of their point cards. On a tie, the higher suit wins (clubs, diamonds, hearts, spades, lowest first). Both cards go to the scrap.</p>
    </section>

    <section>
      <h3>Permanents</h3>
      <ul class="rules__list">
        <li><b>Jack:</b> steal one of their point cards. It counts for you until the Jack is scrapped or stolen back, or a 9 sends that card home.</li>
        <li><b>Queen:</b> their cards can’t target your other cards. It doesn’t stop an Ace, a 6 or a scuttle.</li>
        <li><b>King:</b> you need fewer points to win.</li>
        <li><b>8 as glasses:</b> you can see their hand. An 8 can also just be 8 points.</li>
      </ul>
    </section>

  </div>

  <div class="rules__footer">
    <button type="button" class="rules__close" data-testid="rules-close" onclick={onclose}>Close</button>
  </div>
</div>

<style>
  /* A full-viewport sheet: readable at 393 wide, capped to a comfortable
     column on a desktop. The body scrolls; the Close pill stays put. */
  .rules {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: var(--cu-safe-top, 0px) 0 var(--cu-safe-bottom, 0px);
    background: var(--cu-ink, #241c2b);
    color: var(--cu-pearl, #eee8f1);
    font-family: var(--cu-font-ui, sans-serif);
  }

  .rules:focus {
    outline: none;
  }

  .rules__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    box-sizing: border-box;
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: var(--cu-space-5, 24px) var(--cu-gutter-sheet, 16px) var(--cu-space-3, 12px);
    font-size: var(--cu-text-md, 16px);
    line-height: var(--cu-leading-body, 1.4);
  }

  .rules__title {
    margin: 0 0 var(--cu-space-3, 12px);
    font-size: var(--cu-text-xl, 25px);
  }

  h3 {
    margin: var(--cu-space-4, 16px) 0 var(--cu-space-1, 4px);
    font-size: var(--cu-text-md, 16px);
    color: var(--cu-ochre, #f0b54a);
  }

  p {
    margin: 0 0 var(--cu-space-2, 8px);
  }

  .rules__list {
    margin: 0;
    padding-left: 1.1em;
  }

  .rules__list li {
    margin-bottom: var(--cu-space-1, 4px);
  }

  .rules__footer {
    flex: none;
    display: flex;
    justify-content: center;
    padding: var(--cu-space-3, 12px) var(--cu-gutter-sheet, 16px);
    border-top: 1px solid var(--cu-ink-line, #4a3d57);
  }

  .rules__close {
    box-sizing: border-box;
    min-width: 160px;
    min-height: 48px;
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-iris, #5ccfc4);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  @media (min-width: 1024px) {
    .rules:focus {
    outline: none;
  }

  .rules__body {
      font-size: 18px;
    }
  }
</style>
