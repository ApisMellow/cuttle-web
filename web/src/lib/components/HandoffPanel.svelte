<script lang="ts">
  // SPEC §4.5 (amended 2026-09-27), docs/design.md §8, orchestrator ruling
  // A1 ("same screen, armed") — the ONE screen Curtain shows for both the
  // `handoff` and `reveal` kinds. It stays mounted across handoff -> reveal
  // so a ring press that started in handoff carries over into the hold.
  //
  // Content: "Pass the phone to NAME" ("Pass to NAME" off a phone), the neutral label, the hold ring and
  // the two-step pill (RevealGate). Nothing else.
  //
  // Redaction: this component never sees a HandoffReason. Curtain passes
  // the already-neutral `label` ("Your turn" / "Your response", from
  // `handoffLabel`), so there is no reason value here that could reach
  // text, a class, an attribute or the layout. Zero game state: it takes no
  // view, history or card. The label sits in a fixed-height slot, so the
  // layout doesn't depend on which of the two strings (or none, after a
  // restore into `reveal`) is shown.
  import type { PlayerId } from '../bridge/schema';
  import RevealGate from './RevealGate.svelte';

  interface HandoffPanelProps {
    name: string;
    /** The player the screen is for; RevealGate keys its latch and press on it. */
    player: PlayerId;
    /** The neutral label from `handoffLabel(reason)`; '' when unknown. */
    label: string;
    stage: 'handoff' | 'reveal';
    /** Bumped by Curtain for every new curtain state (RevealGate's latch). */
    epoch?: number;
    revealPreference: 'hold' | 'two-step';
    onadvance: () => void;
  }

  let { name, player, label, stage, epoch = 0, revealPreference, onadvance }: HandoffPanelProps = $props();

  // Amended 2026-09-28 (playtest friction, SPEC §4.5): "Pass the phone to"
  // only on a phone — a coarse pointer on a small screen, either way up.
  // Anywhere else (a laptop, a desktop, a tablet) the wording is
  // device-neutral: "Pass to". It depends on the device alone, never on
  // game state or the HandoffReason, so it can't vary between turns.
  // Without matchMedia (jsdom, very old browsers) it keeps the phone wording.
  const PHONE_QUERY = '(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 767px)';

  function isPhone(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia(PHONE_QUERY).matches;
  }

  const prompt = isPhone() ? 'Pass the phone to' : 'Pass to';

  // On mount only: this instance stays up across handoff -> reveal, and a
  // player who has Tabbed to the pill keeps their focus.
  let textEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    textEl?.focus({ preventScroll: true });
  });
</script>

<div class="gate" data-testid="curtain-gate">
  <!-- r16 review B1: focus lands on this text when the curtain comes up —
       never on a control, so the previous player's key presses can't
       activate anything. One Tab reaches the "I'm NAME" pill. Same DOM for
       every HandoffReason. -->
  <div class="gate__text" tabindex="-1" bind:this={textEl}>
    <p class="gate__prompt">{prompt}</p>
    <p class="gate__name">{name}</p>
    <p class="gate__label">{label}</p>
  </div>
  <RevealGate {name} {player} {stage} {epoch} {revealPreference} {onadvance} />
</div>

<style>
  /* design.md §8 (positions at 844): text block at 30-44%, ring at 62%,
     pill at 82%. RevealGate positions its controls against this box. */
  .gate {
    position: relative;
    height: 100%;
    text-align: center;
    font-family: var(--cu-font-ui, sans-serif);
  }

  /* Focused programmatically as a landing spot, never as a control. */
  .gate__text:focus {
    outline: none;
  }

  .gate__text {
    position: absolute;
    top: 30%;
    left: var(--cu-gutter-sheet, 16px);
    right: var(--cu-gutter-sheet, 16px);
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .gate__prompt {
    margin: 0 0 var(--cu-space-2, 8px);
    font-size: var(--cu-text-lg, 20px);
    color: var(--cu-muted, #b4a8be);
  }

  .gate__name {
    margin: 0 0 var(--cu-space-2, 8px);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--cu-font-display, serif);
    font-size: var(--cu-text-name, 44px);
    color: var(--cu-pearl, #eee8f1);
  }

  /* Fixed-height slot: the same box for "Your turn", "Your response" and ''. */
  .gate__label {
    margin: 0;
    height: 1.5em;
    line-height: 1.5em;
    font-size: var(--cu-text-md, 16px);
    color: var(--cu-muted, #b4a8be);
  }
</style>
