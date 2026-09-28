<script lang="ts">
  // SPEC §5.2 GameScreen — the board host; owns the curtain overlay (P2 W13).
  //
  // Composes Board, Curtain, StagingBar, AmbiguityChooser and CounterPrompt
  // against the game store and one StagingStore. Implements no rule: every
  // legality question is answered by the envelope's `legalMoves`.
  //
  // What mounts, by curtain kind (SPEC §4.2, §4.5; AGENTS.md "Redaction"):
  //   handoff / reveal / recap -> Curtain only. The board is NOT in the DOM.
  //     One `{#if}` branch spans all three, so Curtain stays mounted across
  //     handoff -> reveal (ruling A1: the press carries into the hold).
  //   ack (real or synthetic)  -> CounterPrompt only. The board is not
  //     mounted on EITHER path: at a synthetic ack the one-off has already
  //     resolved, so a board (or a score) would show post-resolution state
  //     on one path and pre-resolution state on the other (R14).
  //   none                     -> Board + the action bar (+ AmbiguityChooser).
  //   result                   -> never reached here; App routes to ResultScreen.
  //
  // Stuck curtain (brief): if `engine.view` fails while the curtain leaves
  // reveal/recap, the store keeps the curtain and sets `game.error`, and
  // RevealGate's latch means no retry can come from the curtain. App's
  // route switch checks `game.error` before the game screen, so the W12
  // error screen (the stand-in for SPEC §2.10's StuckState) takes over,
  // with "New game" as the only action. SPEC §2.9/§2.10: no auto-retry.
  //
  // STUBS for the next round-4 items (not built here):
  //   - SevenRevealPanel (R16): phase SevenChoosing at curtain none.
  //   - DiscardPicker (R15): phase AwaitingDiscard at curtain none.
  //   - ScrapBrowser (R6, 3's pick mode): the scrap-pile tap is a no-op.
  // Each has a marked slot below; none renders a testid.
  import { untrack } from 'svelte';

  import type { Envelope, PlayerId } from '../bridge/schema';
  import { MoveKind, Phase } from '../enums';
  import { counterPromptEntries, formatRecapLine, isRecapVisible } from '../recap';
  import { game } from '../stores/game.svelte';
  import { session } from '../stores/session.svelte';
  import { settings } from '../stores/settings.svelte';
  import { StagingStore, type StagingEnv } from '../stores/staging.svelte';
  import { resolveBoardTap, type TargetKey } from '../targetKey';
  import { installTestHook } from '../testHook';
  import { getTheme } from '../theme';
  import AmbiguityChooser from './AmbiguityChooser.svelte';
  import Board from './Board.svelte';
  import CounterPrompt from './CounterPrompt.svelte';
  import Curtain from './Curtain.svelte';
  import StagingBar from './StagingBar.svelte';

  const theme = $derived(getTheme(settings.themeId));

  /** The board's envelope: only at curtain `none` (never merely because one is held). */
  function boardEnvelope(): Envelope | null {
    return game.curtain.kind === 'none' ? game.envelope : null;
  }

  function stagingEnv(): StagingEnv | null {
    const env = boardEnvelope();
    if (env === null) return null;
    return { legalMoves: env.legalMoves, descriptions: env.descriptions, handSize: env.state.you.hand.length };
  }

  const staging = new StagingStore(stagingEnv, (index) => game.apply(index));

  // SPEC §5.3: staging clears on every apply and every viewer change.
  $effect(() => {
    void game.viewer;
    void game.seq;
    void game.curtain.kind;
    untrack(() => staging.reset());
  });

  const board = $derived(boardEnvelope());
  const withheld = $derived(
    game.curtain.kind === 'handoff' || game.curtain.kind === 'reveal' || game.curtain.kind === 'recap',
  );

  // R10.1: the deck is live exactly when the engine offers Draw.
  const deckEnabled = $derived(board !== null && board.legalMoves.some((m) => m.Kind === MoveKind.Draw));

  // R20: the viewer's own last move verbatim (R20.1); the opponent's as the
  // §4.6 per-viewer line. Built from the last `isRecapVisible` history entry,
  // never from `lastMove` (R14): after a real counter window `lastMove` is the
  // Decline, after a synthetic ack it is the move itself, so reading it would
  // tell the acting player whether the opponent held a 2.
  const lastMoveText = $derived.by(() => {
    const env = board;
    if (env === null) return '';
    const history = game.history;
    let i = history.length - 1;
    while (i >= 0 && !isRecapVisible(history[i])) i--;
    if (i < 0) return '';
    const last = history[i];
    if (last.by === env.state.viewer) return last.description;
    try {
      return formatRecapLine(last, env.state.viewer, session.names);
    } catch {
      return '';
    }
  });

  function onBoardTap(key: TargetKey): void {
    const viewer = board?.state.viewer;
    if (viewer === undefined) return;
    staging.tap(resolveBoardTap(key, staging.highlighted, viewer));
  }

  function report(err: unknown): void {
    console.error(err);
  }

  function advanceCurtain(): void {
    game.advanceCurtain().catch(report);
  }

  // ---- CounterPrompt (SPEC §4.3) -----------------------------------------
  // Both paths get the same entries (history), viewer (the ack's `to`) and
  // names. Only `options` differs: the Counter moves of a real window.
  const ackTo = $derived<PlayerId | null>(game.curtain.kind === 'ack' ? game.curtain.to : null);
  const ackEntries = $derived(ackTo === null ? [] : counterPromptEntries(game.history));
  const counterOptions = $derived.by(() => {
    const curtain = game.curtain;
    const env = game.envelope;
    if (curtain.kind !== 'ack' || curtain.synthetic || env === null) return [];
    const out: { index: number; description: string }[] = [];
    env.legalMoves.forEach((m, index) => {
      if (m.Kind === MoveKind.Counter) out.push({ index, description: env.descriptions[index] });
    });
    return out;
  });

  function resolveAck(): void {
    const curtain = game.curtain;
    if (curtain.kind !== 'ack') return;
    if (curtain.synthetic) {
      // No bridge call: advance the local curtain machine (SPEC §4.3).
      advanceCurtain();
      return;
    }
    const env = game.envelope;
    const decline = env?.legalMoves.findIndex((m) => m.Kind === MoveKind.Decline) ?? -1;
    if (decline >= 0) game.apply(decline).catch(report);
  }

  function applyCounter(index: number): void {
    game.apply(index).catch(report);
  }

  // ---- Test hook (SPEC §6.5), compiled out of production -----------------
  $effect(() => {
    if (!import.meta.env.DEV) return;
    return installTestHook({
      curtain: () => game.curtain,
      envelope: () => game.envelope,
      viewer: () => game.viewer,
      seq: () => game.seq,
      newGame: (seed, dealer) => game.newGame({ seed, dealer }),
    });
  });
</script>

<div data-testid="game-screen" class="game-screen">
  <h1 class="game-screen__sr-only">{session.names[0]} vs {session.names[1]}</h1>

  {#if withheld}
    <Curtain
      curtain={game.curtain}
      names={session.names}
      revealPreference={settings.revealPreference}
      recapEntries={game.curtain.kind === 'recap' ? game.curtain.entries : []}
      viewer={game.curtain.kind === 'recap' ? game.curtain.to : null}
      onadvance={advanceCurtain}
      {theme}
    />
  {:else if ackTo !== null}
    <CounterPrompt
      entries={ackEntries}
      viewer={ackTo}
      names={session.names}
      options={counterOptions}
      onresolve={resolveAck}
      oncounter={applyCounter}
      {theme}
    />
  {:else if board !== null}
    <Board
      view={board.state}
      names={session.names}
      highlighted={staging.highlighted}
      staged={staging.staged}
      dimmedHand={staging.dimmedHand}
      selectedHand={staging.selectedHand}
      inert={staging.inert}
      {deckEnabled}
      ontap={onBoardTap}
      {lastMoveText}
      {theme}
    />

    <!-- STUB(W14 SevenRevealPanel, R16): phase SevenChoosing. -->
    <!-- STUB(W14 DiscardPicker, R15): phase AwaitingDiscard. -->
    <!-- STUB(W15 ScrapBrowser, R6): the scrap tap reaches staging as a no-op. -->
    {#if board.state.phase === Phase.SevenChoosing || board.state.phase === Phase.AwaitingDiscard}
      <p class="game-screen__stub">This step isn't playable yet.</p>
    {/if}

    <div class="game-screen__action-bar">
      {#if staging.stagedDescription !== null}
        <StagingBar
          description={staging.stagedDescription}
          disabled={staging.inert}
          onconfirm={() => {
            staging.confirm().catch(report);
          }}
          oncancel={() => staging.cancel()}
        />
      {:else if staging.passAvailable}
        <button type="button" class="game-screen__pass" data-testid="pass" onclick={() => staging.tap('pass')}>
          Pass
        </button>
      {/if}
    </div>

    {#if staging.chooser !== null}
      <AmbiguityChooser
        candidates={staging.chooser.candidates}
        onchoose={(index) => staging.choose(index)}
        oncancel={() => staging.cancel()}
      />
    {/if}
  {/if}
</div>

<style>
  .game-screen {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    box-sizing: border-box;
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
    overflow-x: hidden;
  }

  .game-screen__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* design.md §6: always reserved, so staging never reflows the board. */
  .game-screen__action-bar {
    flex: none;
    display: flex;
    flex-direction: column;
    justify-content: center;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    min-height: var(--cu-zone-action, 64px);
    margin: 0 auto;
  }

  .game-screen__pass {
    align-self: center;
    box-sizing: border-box;
    min-width: 120px;
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  .game-screen__stub {
    margin: 0;
    padding: var(--cu-space-2, 8px) var(--cu-gutter-board, 12px);
    color: var(--cu-muted);
    font-size: var(--cu-text-sm, 14px);
    text-align: center;
  }
</style>
