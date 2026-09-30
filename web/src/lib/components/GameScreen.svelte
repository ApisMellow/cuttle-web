<script lang="ts">
  // SPEC §5.2 GameScreen — the board host; owns the curtain overlay (P2 W13).
  //
  // Composes Board, Curtain, StagingBar, AmbiguityChooser and CounterPrompt
  // against a `TableSource` and one StagingStore. Implements no rule: every
  // legality question is answered by the envelope's `legalMoves`.
  //
  // Two-phone W10 (docs/two-phone-plan.md §7): the source arrives as the
  // `source` prop, never from the `game` singleton, so the online store can
  // drive this same screen. Pass-and-play passes `game` (App.svelte). While
  // `source.pending` is true (a move sent, its result not yet in; the local
  // store is never pending) the board is inert, Confirm is disabled, and no
  // path here calls `source.apply` (`applyMove`).
  //
  // What mounts, by curtain kind (SPEC §4.2, §4.5; AGENTS.md "Redaction"):
  //   handoff / reveal / recap -> Curtain only. The board is NOT in the DOM.
  //     One `{#if}` branch spans all three, so Curtain stays mounted across
  //     handoff -> reveal (ruling A1: the press carries into the hold).
  //   ack (the counter window) -> CounterPrompt only. The board is not
  //     mounted: the one-off has not resolved yet, and the prompt is a
  //     full-screen decision.
  //   none                     -> Board + the action bar (+ AmbiguityChooser).
  //   result                   -> never reached here; App routes to ResultScreen.
  //
  // Issue #27 draw reveal (SPEC §4.7): while `source.drawReveal` is up and the
  // exposed envelope is its drawer's own, at `none` or an `ack` (never a
  // withheld curtain), DrawRevealPanel takes the place of the board or the
  // counter prompt. Continuing (tap, key, or 3 s) calls
  // `source.dismissDrawReveal()`, which brings the board, the counter prompt,
  // or (before the pass) the saved handoff. Before the pass it gets only the
  // drawn cards; the menu (`menuOpen`) pauses its 3 s wait.
  //
  // Stuck curtain (brief): if `engine.view` fails while the curtain leaves
  // reveal/recap, the store keeps the curtain and sets `game.error`, and
  // RevealGate's latch means no retry can come from the curtain. App's
  // route switch checks `game.error` before the game screen, so the W12
  // error screen (the stand-in for SPEC §2.10's StuckState) takes over,
  // with "New game" as the only action. SPEC §2.9/§2.10: no auto-retry.
  //
  // P2 W15 pickers, all inside the board branch (curtain `none` only):
  //   - SevenRevealPanel (R16): phase SevenChoosing, and only when the view
  //     is the actor's (`viewer === active`, `sevenRevealed` present). It
  //     takes the hand's slot; a revealed card is a `seven:<i>` root.
  //   - DiscardPicker (R15): phase AwaitingDiscard. The cards are picked on
  //     the real hand; the prompt holds the action bar until a pair stages.
  //   - ScrapBrowser (R6): an idle scrap-pile tap opens browse mode; a 3's
  //     scrap-pick collapse opens pick mode (StagingStore.scrapPick).
  import { tick, untrack } from 'svelte';

  import type { Card, Envelope, PlayerId } from '../bridge/schema';
  import { deckReason, handCardReason, targetReason } from '../blockedReason';
  import { cardEffectLine, cardName } from '../cardText';
  import { MoveKind, Phase } from '../enums';
  import { counterPromptEntries, discardPromptLine, lastMoveLine, optionContext, plainMoveText, stagedHeading } from '../recap';
  import { session } from '../stores/session.svelte';
  import { settings } from '../stores/settings.svelte';
  import { StagingStore, type StagingEnv } from '../stores/staging.svelte';
  import { MoveNotSent, type TableSource } from '../stores/tableSource';
  import { resolveBoardTap, type TargetKey } from '../targetKey';
  import { DragGesture, dropKeyAt, dropTarget, targetKeyFromTestId, testIdForKey, type HandDrag } from '../dragDrop';
  import { keyActivationGuard, type KeyActivationGuard } from '../keyGuard';
  import { screenRotated, toViewDelta } from '../tableMode';
  import { installTestHook } from '../testHook';
  import { clearImageFailures, getTheme } from '../theme';
  import AmbiguityChooser from './AmbiguityChooser.svelte';
  import Board from './Board.svelte';
  import CardDetailPopover from './CardDetailPopover.svelte';
  import CounterPrompt from './CounterPrompt.svelte';
  import Curtain from './Curtain.svelte';
  import DiscardPicker from './DiscardPicker.svelte';
  import DrawRevealPanel from './DrawRevealPanel.svelte';
  import GameMenu from './GameMenu.svelte';
  import ScrapBrowser from './ScrapBrowser.svelte';
  import SevenRevealPanel from './SevenRevealPanel.svelte';
  import StagingBar from './StagingBar.svelte';

  interface GameScreenProps {
    /** The game this screen shows and moves (W10). Fixed for the component's life. */
    source: TableSource;
  }

  let { source }: GameScreenProps = $props();

  const theme = $derived(getTheme(settings.themeId));

  // Two-phone W12: an online source brings the room's names, a status line
  // and the response hold; pass-and-play (no `online`) is exactly as before.
  const online = $derived(source.online ?? null);
  const names = $derived<[string, string]>(online?.names ?? session.names);

  /**
   * W10: the single path from this screen to `source.apply`. Refuses while a
   * move is already in flight, so no second move is ever sent before the
   * first one's result is in (the local store is never pending, so for
   * pass-and-play this is `source.apply` exactly).
   */
  function applyMove(index: number): Promise<void> {
    if (source.pending) return Promise.resolve();
    return source.apply(index);
  }

  // ---- Table mode (issue #37, SPEC §5.10) ---------------------------------
  // With the phone lying flat between the players, every screen addressed to
  // player 2 (seat 1) is turned 180° here, at the game-screen root: the
  // curtain screens, the counter prompt, the draw reveal, the board and every
  // picker on it. Player 1's side is then always at the phone's bottom edge
  // and player 2's at its top. Orientation only: what mounts behind which
  // curtain is exactly as in normal pass-and-play.
  //
  // The setting is latched: this re-reads it only when the curtain, the
  // viewer or the move count changes, so a change never turns the screen in
  // the middle of a turn or a staged move. The turn itself is instant, so
  // reduced motion needs nothing extra.
  const tableLatched = $derived.by(() => {
    void source.seq;
    void source.curtain;
    void source.viewer;
    return untrack(() => settings.tableMode);
  });
  // W12: each online player has their own phone, so nothing ever turns.
  const rotated = $derived(online === null && screenRotated(tableLatched, source.curtain, source.viewer));

  /** The board's envelope: only at curtain `none` (never merely because one is held). */
  function boardEnvelope(): Envelope | null {
    return source.curtain.kind === 'none' ? source.envelope : null;
  }

  function stagingEnv(): StagingEnv | null {
    const env = boardEnvelope();
    if (env === null) return null;
    return {
      legalMoves: env.legalMoves,
      descriptions: env.descriptions,
      handSize: env.state.you.hand.length,
      hand: env.state.you.hand,
      revealed: sevenCards(env),
      scrap: env.state.scrap,
    };
  }

  /**
   * R16 privacy gate (SPEC §3.2): the 7's revealed cards, only from the
   * board's own envelope (so only at curtain `none`), only at
   * PhaseSevenChoosing and only when the viewer is the actor. The engine
   * already withholds them from everyone else; this does not rely on it.
   */
  function sevenCards(env: Envelope): Card[] | null {
    const view = env.state;
    if (view.phase !== Phase.SevenChoosing || view.viewer !== view.active) return null;
    return view.sevenRevealed;
  }

  const staging = new StagingStore(stagingEnv, applyMove);
  // W10: nothing on the board takes a tap while a move is in flight.
  const boardInert = $derived(staging.inert || source.pending);

  // SPEC §5.3: staging clears on every apply and every viewer change.
  // The browse sheet closes on the same boundaries.
  let browsingScrap = $state(false);
  // Playtest 2026-09-29: one line in the action bar saying why a tap did
  // nothing (the deck with a full hand, a 9 onto a card their Queen
  // protects). Built from public board state only (lib/blockedReason.ts);
  // cleared by the next tap and on the same boundaries as staging, so it
  // never survives a curtain.
  let notice = $state<string | null>(null);
  $effect(() => {
    void source.viewer;
    void source.seq;
    void source.curtain.kind;
    untrack(() => {
      endDrag();
      staging.reset();
      browsingScrap = false;
      notice = null;
    });
  });

  // A-6: bitmap image errors are forgotten at every handoff, so a transient
  // failure gets retried and the next player never inherits the previous
  // player's fallbacks.
  $effect(() => {
    if (source.curtain.kind === 'handoff') untrack(clearImageFailures);
  });

  const board = $derived(boardEnvelope());

  /**
   * SPEC §4.7 privacy gate for the draw reveal, independent of the store's
   * own: only at `none` or an `ack`, and only when the exposed envelope and
   * the store's viewer are both the drawer. The cards come from that
   * envelope; the store holds indices only.
   *
   * Before the pass the phone is about to change hands, so the panel gets
   * ONLY the drawn cards (every one of them marked drawn), never the rest of
   * the hand. At the drawer's own next view it gets the whole hand with the
   * drawn indices marked.
   */
  const drawReveal = $derived.by((): { hand: Card[]; indices: number[] } | null => {
    const reveal = source.drawReveal;
    const env = source.envelope;
    const kind = source.curtain.kind;
    if (reveal === null || env === null || (kind !== 'none' && kind !== 'ack')) return null;
    if (env.state.viewer !== reveal.to || source.viewer !== reveal.to) return null;
    const hand = env.state.you.hand;
    if (!reveal.beforePass) return { hand, indices: reveal.indices };
    const drawnCards = reveal.indices.flatMap((i) => (hand[i] === undefined ? [] : [hand[i]]));
    return { hand: drawnCards, indices: drawnCards.map((_, i) => i) };
  });
  const revealed = $derived(board === null ? null : sevenCards(board));
  const withheld = $derived(
    source.curtain.kind === 'handoff' || source.curtain.kind === 'reveal' || source.curtain.kind === 'recap',
  );

  // R9.3 (W21): the dimmed-card detail popover. `staging.inspect` is a hand
  // index into the VIEWER'S OWN hand only (staging.svelte.ts's #selectHand
  // never sets it from anything else), so this never reads the opponent's
  // hand or the deck. `staging.reset()` (viewer/curtain change, every apply)
  // already clears `inspect`, so this can't survive past its own turn.
  const inspectCard = $derived(board === null || staging.inspect === null ? null : (board.state.you.hand[staging.inspect] ?? null));
  // Playtest 2026-09-29: the popover says why, from public state only.
  const inspectReason = $derived(board === null || staging.inspect === null ? undefined : handCardReason(staging.inspect, board.state));

  // R10.1: the deck is live exactly when the engine offers Draw.
  const deckEnabled = $derived(board !== null && board.legalMoves.some((m) => m.Kind === MoveKind.Draw));

  // R20: the board's centre line, `lastMoveLine` (lib/recap.ts, SPEC §4.6
  // amended 2026-09-28): the last `isRecapVisible` history entry as a
  // sentence for this viewer — "You played 7♥ for points." for the viewer's
  // own move, never the raw engine description — plus a resolved 5's draw
  // count. Never from `lastMove`: after a counter window `lastMove` is the
  // Decline, which the recap never shows.
  // Playtest 2026-09-29: while the viewer picks discards for a 4, the line
  // says so ("Alice's 4♠: choose 2 to discard.").
  const lastMoveText = $derived.by(() => {
    if (board === null) return '';
    if (staging.discard !== null) {
      const prompt = discardPromptLine(source.history, names, staging.discard.need);
      if (prompt !== '') return prompt;
    }
    return lastMoveLine(source.history, board.state.viewer, names);
  });

  // Plain text for one of the viewer's own options (SPEC §4.6, §6.4). A 9
  // says which way its target goes — back to them, or (a card they stole)
  // back to you — read from public board state (review B2). Playtest
  // 2026-09-29: a 9, a 2 or a Jack names its target, and a 5 its real draw
  // count, from the same board state and the viewer's own hand
  // (`optionContext`).
  function optionText(index: number | null, description: string): string {
    const move = index === null || board === null ? undefined : board.legalMoves[index];
    return plainMoveText(description, move === undefined || board === null ? {} : optionContext(move, board.state));
  }

  // ---- Card labels (ROADMAP "Card labels") --------------------------------
  // A selected card's name and one-line effect fill the action bar (empty
  // while a card is selected), and a staged move's card names the staging
  // line. Both read only the board's own envelope (so only at curtain
  // `none`): the viewer's own hand, the 7's revealed cards (already
  // actor-only, `revealed`), or the viewer's own staged legal move. Never
  // another hand, the deck or anything behind the curtain; `staging.reset()`
  // clears the selection on every apply and viewer change.
  const selectedCard = $derived.by((): Card | null => {
    if (board === null || staging.state !== 'selected' || staging.chooser !== null || staging.scrapPick !== null) {
      return null;
    }
    if (staging.selectedHand !== null) return board.state.you.hand[staging.selectedHand] ?? null;
    if (staging.selectedReveal !== null && revealed !== null) return revealed[staging.selectedReveal] ?? null;
    return null;
  });
  const hint = $derived(selectedCard === null ? null : { name: cardName(selectedCard, theme), effect: cardEffectLine(selectedCard) });

  // The staged card is named only when the move uses its ability: a
  // one-off, or a permanent (a Jack steal included), directly or as a 7's
  // pick. Playing it for points or scuttling with it uses no ability.
  // A 2 aimed at a card is headed with what it does ("Scrap K♦").
  const stagedTitle = $derived.by((): string | undefined => {
    if (board === null || staging.stagedIndex === null) return undefined;
    const move = board.legalMoves[staging.stagedIndex];
    return move === undefined ? undefined : stagedHeading(move, board.state, theme);
  });

  // ---- Desktop keyboard (W25) ---------------------------------------------
  // A click that a key press produced (Enter/Space on a focused button)
  // moves focus to the first lit target, so the next Tab or Enter is on a
  // target rather than wrapping through the rest of the page. A pointer
  // click never moves focus. Escape clears a selection or a staged move.
  let keyboardActivation = false;
  /** r16: whether the last input was a key (vs a pointer); gates the focus rescue below. */
  let lastInputKeyboard = false;
  let screenEl: HTMLDivElement | undefined = $state();

  function focusFirstTarget(): void {
    void tick().then(() => {
      for (const key of staging.highlighted) {
        const el = screenEl?.querySelector<HTMLElement>(`[data-testid="${testIdForKey(key)}"]`);
        if (el) {
          el.focus();
          return;
        }
      }
    });
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    keyboardActivation = event.key === 'Enter' || event.key === ' ';
    lastInputKeyboard = true;
    // Issue #24 (a second deck press commits a staged draw, so a held key
    // must not count as one) is covered by `freshKey()` in onBoardTap: an
    // auto-repeated key never activates any board target, the deck included.
    if (event.key !== 'Escape' || board === null) return;
    if (staging.state === 'staged' || staging.chooser !== null || staging.scrapPick !== null) staging.cancel();
    else staging.clearSelection();
  }

  // r16 re-review B2 (R12): a held key must never walk select -> target ->
  // stage -> Confirm. Focus moves to the next control after each keyboard
  // step, and the browser clicks the focused button on every auto-repeat,
  // so every board tap and every staging control ignores a click produced
  // by an auto-repeated key (lib/keyGuard.ts). Pointer clicks are untouched.
  let keyGuard: KeyActivationGuard | null = null;
  $effect(() => {
    const g = keyActivationGuard();
    keyGuard = g;
    return () => {
      g.dispose();
      if (keyGuard === g) keyGuard = null;
    };
  });

  function freshKey(): boolean {
    return keyGuard === null || keyGuard.allows();
  }

  /** Wraps a control's handler so an auto-repeated key can't fire it. */
  function fresh<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      if (freshKey()) fn(...args);
    };
  }

  function onBoardTap(key: TargetKey): void {
    const viewer = board?.state.viewer;
    if (viewer === undefined || board === null) return;
    // W10: the 7's reveal tray and a drag reach here without Board's inert
    // check; a move in flight takes no tap from anywhere.
    if (source.pending) return;
    if (!freshKey()) {
      keyboardActivation = false;
      return;
    }
    const fromKeyboard = keyboardActivation;
    keyboardActivation = false;
    notice = null;
    // Captured before the tap: which card was selected, and whether this
    // tap lands on a lit target. A refused tap (unlit) gets a reason when
    // one is knowable from public state; the tap itself behaves as before.
    const wasSelected = staging.state === 'selected' && staging.chooser === null ? selectedCard : null;
    const lit = staging.highlighted.has(resolveBoardTap(key, staging.highlighted, viewer));
    const drawLegal = deckEnabled;
    tapStaging(key, viewer);
    if (key === 'deck' && !drawLegal) notice = deckReason(board.state);
    else if (wasSelected !== null && !lit) notice = targetReason(wasSelected, key, board.state);
    if (fromKeyboard && staging.state === 'selected' && staging.chooser === null && staging.scrapPick === null) {
      focusFirstTarget();
    } else if (fromKeyboard) {
      // r16: a key press that staged a move (or opened the chooser or the
      // 3's pick) goes straight to Confirm (or the first option), not seven
      // Tabs away.
      void tick().then(() => focusBest());
    }
  }

  // ---- Drag and drop (issue #26, SPEC §6.1) --------------------------------
  // A pointer extra on top of the tap path, never a second path. Pressing a
  // hand card arms the gesture; once the pointer has moved 8 px it is a
  // drag, which selects the card with the same tap a player would make.
  // Releasing over a lit target makes the tap on that target (so a chooser,
  // the 3's pick or a stage follows exactly as for a tap); releasing
  // anywhere else snaps the card back and clears the selection, like a tap
  // on an unlit target or empty space. Nothing here applies: Confirm is
  // still the only commit (R12). The card itself moves (HandCard's
  // `dragOffset`); there is no ghost copy, and `endDrag()` runs on every
  // apply, viewer change and curtain change with the staging reset above.
  const gesture = new DragGesture();
  let drag = $state<HandDrag | null>(null);
  // The click a browser may fire on the dragged card after a drag (a mouse
  // released over the card, a short touch drag inside the browser's own tap
  // slop) is not a tap: it would re-select the card. Only a click on THAT
  // card, and only shortly after, is swallowed; Confirm, the chooser and any
  // other control take their taps at once.
  let swallowClick: { handIndex: number; until: number } | null = null;
  const SWALLOW_CLICK_MS = 400;

  function armClickSwallow(handIndex: number): void {
    swallowClick = { handIndex, until: performance.now() + SWALLOW_CLICK_MS };
  }

  function endDrag(): void {
    gesture.cancel();
    drag = null;
  }

  /** A hand card may start a drag only where a tap on it would select it for a play. */
  function canDrag(handIndex: number): boolean {
    return (
      board !== null &&
      handIndex < board.state.you.hand.length &&
      !boardInert &&
      staging.state !== 'staged' &&
      staging.chooser === null &&
      staging.scrapPick === null &&
      staging.discard === null &&
      !staging.dimmedHand.has(handIndex)
    );
  }

  function onDragPointerdown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || gesture.phase !== 'idle' || board === null) return;
    const target = event.target;
    if (!(target instanceof Element) || screenEl === undefined || !screenEl.contains(target)) return;
    const cardEl = target.closest('[data-testid="player-hand"] [data-testid^="hand-card-"]');
    const key = cardEl === null ? null : targetKeyFromTestId(cardEl.getAttribute('data-testid') ?? '');
    if (key === null || !key.startsWith('hand:')) return;
    const handIndex = Number(key.slice('hand:'.length));
    if (!canDrag(handIndex)) return;
    gesture.down(event.pointerId, handIndex, event.clientX, event.clientY);
  }

  function onDragPointermove(event: PointerEvent): void {
    const step = gesture.move(event.pointerId, event.clientX, event.clientY);
    if (step === null) return;
    const handIndex = gesture.handIndex as number;
    if (step === 'start' && !beginDrag(handIndex)) return;
    // Issue #37: the gesture measures on the screen; the card moves in the
    // (possibly turned) view's own frame. `elementFromPoint` on drop needs
    // no such care: it takes screen coordinates and sees through transforms.
    drag = { handIndex, ...toViewDelta(gesture.dx, gesture.dy, rotated) };
  }

  /** Selects the card as a tap would (unless it already is). False, and the gesture is dropped, if it can't be dragged. */
  function beginDrag(handIndex: number): boolean {
    if (!canDrag(handIndex)) {
      endDrag();
      return false;
    }
    if (!(staging.state === 'selected' && staging.selectedHand === handIndex)) onBoardTap(`hand:${handIndex}`);
    if (staging.state !== 'selected' || staging.selectedHand !== handIndex || staging.chooser !== null) {
      endDrag();
      return false;
    }
    return true;
  }

  function onDragPointerup(event: PointerEvent): void {
    const handIndex = gesture.handIndex;
    if (gesture.up(event.pointerId) !== 'drop' || handIndex === null) return;
    armClickSwallow(handIndex);
    // Hit-test before the card drops back into place: while dragging it has
    // pointer events off, so this finds what is under it.
    const key = dropKeyAt(document.elementFromPoint(event.clientX, event.clientY));
    drag = null;
    const viewer = board?.state.viewer;
    if (board === null || viewer === undefined) return;
    const target = dropTarget(key, staging.highlighted, viewer);
    if (target !== null) {
      onBoardTap(target);
      return;
    }
    // Snap back, unselected: what a tap on an unlit target or empty space does.
    const card = selectedCard;
    staging.clearSelection();
    notice = card !== null && key !== null && !key.startsWith('hand:') ? targetReason(card, key, board.state) : null;
  }

  /** The system took the pointer (a call, a gesture): the card goes back, still selected, and nothing is dropped. */
  function onDragPointercancel(event: PointerEvent): void {
    if (event.pointerId !== gesture.pointerId) return;
    if (gesture.phase === 'dragging' && gesture.handIndex !== null) armClickSwallow(gesture.handIndex);
    endDrag();
  }

  $effect(() => {
    // Non-passive, so a drag in progress can stop the board scrolling. Only
    // once the drag has started: under the threshold a touch still scrolls
    // and still taps.
    const onTouchmove = (event: TouchEvent): void => {
      if (gesture.phase === 'dragging' && event.cancelable) event.preventDefault();
    };
    // A press that may become a drag never starts the browser's own
    // drag-and-drop (a bitmap face's <img> would, and cancel the pointer).
    const onDragstart = (event: DragEvent): void => {
      if (gesture.phase !== 'idle') event.preventDefault();
    };
    const onClick = (event: MouseEvent): void => {
      const pending = swallowClick;
      swallowClick = null;
      if (pending === null || performance.now() >= pending.until) return;
      const target = event.target;
      const card = target instanceof Element ? target.closest('[data-testid^="hand-card-"]') : null;
      if (card?.getAttribute('data-testid') !== testIdForKey(`hand:${pending.handIndex}`)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('touchmove', onTouchmove, { passive: false });
    window.addEventListener('dragstart', onDragstart);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('touchmove', onTouchmove);
      window.removeEventListener('dragstart', onDragstart);
      window.removeEventListener('click', onClick, true);
      endDrag();
    };
  });

  // r16 (desktop keyboard): whatever unmounts the focused element (a
  // curtain lifting, the chooser or the scrap sheet closing, Cancel or
  // Confirm leaving the bar) used to drop focus to <body>. When that
  // happens on the live board, focus goes to the next sensible control:
  // Confirm when a move is staged, the chooser's or the scrap pick's first
  // option, the first lit target while a card is selected, else the first
  // card to play (the 7's reveal, then the hand), then Pass, then the deck.
  // Focus that is anywhere else (the menu, a card) is left alone.
  function bestFocusTarget(): HTMLElement | null {
    const find = (selector: string) => document.querySelector<HTMLElement>(selector);
    if (staging.stagedDescription !== null) return find('[data-testid="staging-confirm"]');
    if (staging.chooser !== null) return find('[data-testid^="ambiguity-chooser-option-"]');
    if (staging.scrapPick !== null) return find('[data-testid^="scrap-pick-"]');
    if (browsingScrap) return find('[data-testid="scrap-browser-close"]');
    if (staging.state === 'selected') {
      for (const key of staging.highlighted) {
        const el = screenEl?.querySelector<HTMLElement>(`[data-testid="${testIdForKey(key)}"]`);
        if (el) return el;
      }
    }
    for (const selector of [
      '[data-testid="seven-card-0"]',
      '[data-testid^="hand-card-"][data-dimmed="false"]',
      '[data-testid^="hand-card-"]',
      '[data-testid="pass"]',
      '[data-testid="deck-pile"]',
    ]) {
      const el = screenEl?.querySelector<HTMLElement>(selector);
      if (el) return el;
    }
    return null;
  }

  function focusBest(): void {
    bestFocusTarget()?.focus();
  }

  // No `board === null` guard (review N1): every control `bestFocusTarget`
  // can return lives in the board branch, and staging and the scrap sheet
  // reset at every curtain, so behind a curtain it finds nothing to focus.
  // Issue #27: `drawReveal` is tracked too. While the reveal is up the board
  // branch is unmounted, so this finds nothing and never takes focus from
  // the panel's Continue; when Continue unmounts at the drawer's next board
  // (nothing else here changes then), focus lands on the board.
  $effect(() => {
    void board;
    void drawReveal;
    void staging.state;
    void staging.stagedIndex;
    void staging.chooser;
    void staging.scrapPick;
    void browsingScrap;
    void source.seq;
    void tick().then(() => {
      // Keyboard players only: a touch or mouse player has no focus to
      // lose, and moving it would scroll the board under their finger.
      if (!lastInputKeyboard) return;
      const active = document.activeElement;
      if (active === null || active === document.body) focusBest();
    });
  });

  function tapStaging(key: TargetKey, viewer: PlayerId): void {
    // R6: with nothing selected, the scrap pile opens the browser. When the
    // scrap is a lit target (a dead-end 7) or a card is selected, the tap
    // belongs to staging (SPEC §6.1: an unlit tap clears the selection).
    if (key === 'scrap' && staging.state === 'idle' && !staging.highlighted.has('scrap') && !boardInert) {
      browsingScrap = true;
      return;
    }
    // Issue #24: a deck re-tap on a staged draw commits it, like Confirm.
    staging.tap(resolveBoardTap(key, staging.highlighted, viewer))?.catch(report);
  }

  function report(err: unknown): void {
    // W12: a move the online source could not send is not a fault; its
    // notice is already on screen and the staged move is kept.
    if (err instanceof MoveNotSent) return;
    console.error(err);
  }

  function advanceCurtain(): void {
    source.advanceCurtain().catch(report);
  }

  // ---- CounterPrompt (SPEC §4.3) -----------------------------------------
  // The counter window only (ruling 2026-09-29): the entries come from
  // history, the options are the window's Counter moves.
  const ackTo = $derived<PlayerId | null>(source.curtain.kind === 'ack' ? source.curtain.to : null);
  const ackEntries = $derived(ackTo === null ? [] : counterPromptEntries(source.history));
  const counterOptions = $derived.by(() => {
    const curtain = source.curtain;
    const env = source.envelope;
    if (curtain.kind !== 'ack' || env === null) return [];
    const out: { index: number; description: string }[] = [];
    env.legalMoves.forEach((m, index) => {
      if (m.Kind === MoveKind.Counter) out.push({ index, description: env.descriptions[index] });
    });
    return out;
  });

  function resolveAck(): void {
    const curtain = source.curtain;
    if (curtain.kind !== 'ack') return;
    const env = source.envelope;
    const decline = env?.legalMoves.findIndex((m) => m.Kind === MoveKind.Decline) ?? -1;
    if (decline >= 0) applyMove(decline).catch(report);
  }

  function applyCounter(index: number): void {
    applyMove(index).catch(report);
  }

  // ---- In-game menu (SPEC §5.2, §5.5 R17.2, §5.6 rule 5) ------------------
  // One menu button, drawn in one of two places and never both: in the score
  // bar's reserved slot on the live board (design.md §6), and pinned top
  // right over every other game screen: handoff, reveal, recap and the
  // counter prompt (design.md §8: rules stay reachable mid-curtain). The
  // button and the panel hold no game state and call no store method that
  // moves the curtain, so opening the menu at a withheld curtain can't
  // bring the board in (it stays unmounted, gated on `board` as always).
  // GameMenu is mounted outside every curtain branch, so a Rules sheet
  // opened from it outlives nothing it shouldn't: it shows rules text only.
  let menuOpen = $state(false);
  let menuButton: HTMLButtonElement | undefined = $state();

  function closeMenu(): void {
    menuOpen = false;
    menuButton?.focus();
  }

  // Home keeps the game: the save already holds this exact position (SPEC
  // §5.7, written on every apply and curtain step), and goHome() writes
  // nothing. Resume on the home screen restores it like a reload would.
  function menuHome(): void {
    menuOpen = false;
    source.goHome();
  }

  // R4.3: only after GameMenu's confirm, which names the game.
  // W12: never while a move is in flight. Online, New game asks for a
  // rematch, and the store sends it only at game over (mid-game it is a
  // no-op).
  function menuNewGame(): void {
    menuOpen = false;
    if (source.pending) return;
    source.newGame().catch(report);
  }

  // ---- Test hook (SPEC §6.5), compiled out of production -----------------
  $effect(() => {
    if (!import.meta.env.DEV) return;
    return installTestHook({
      curtain: () => source.curtain,
      envelope: () => source.envelope,
      viewer: () => source.viewer,
      seq: () => source.seq,
      newGame: (seed, dealer) => source.newGame({ seed, dealer }),
    });
  });
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onpointerdown={(event) => {
    keyboardActivation = false;
    lastInputKeyboard = false;
    onDragPointerdown(event);
  }}
  onpointermove={onDragPointermove}
  onpointerup={onDragPointerup}
  onpointercancel={onDragPointercancel}
/>

<div
  data-testid="game-screen"
  class={['game-screen', rotated && 'game-screen--rotated']}
  data-table-rotated={rotated ? 'true' : 'false'}
  bind:this={screenEl}
>
  <h1 class="game-screen__sr-only">{names[0]} vs {names[1]}</h1>

  {#if withheld}
    <Curtain
      history={source.history}
      curtain={source.curtain}
      {names}
      revealPreference={settings.revealPreference}
      recapEntries={source.curtain.kind === 'recap' ? source.curtain.entries : []}
      viewer={source.curtain.kind === 'recap' ? source.curtain.to : null}
      tableMode={tableLatched}
      onadvance={advanceCurtain}
      {theme}
    />
  {:else if drawReveal !== null}
    <DrawRevealPanel
      hand={drawReveal.hand}
      drawn={drawReveal.indices}
      reducedMotion={settings.reducedMotion}
      paused={menuOpen}
      oncontinue={() => source.dismissDrawReveal()}
      {theme}
    />
  {:else if ackTo !== null}
    <CounterPrompt
      entries={ackEntries}
      viewer={ackTo}
      {names}
      options={counterOptions}
      onresolve={resolveAck}
      oncounter={applyCounter}
      disabled={source.pending}
      {theme}
    />
  {:else if online?.respondingName}
    <!-- W12: the response hold (SPEC §2.12.5). The envelope on show is the
         pre-move one, so the board stays down until the state arrives.
         Placeholder text; W13b draws the real panel. -->
    <div class="game-screen__online-panel" data-testid="online-responding" role="status">
      <p>{online.respondingName} is responding…</p>
    </div>
  {:else if board !== null}
    {#if theme.Table}
      <!-- A-6: the theme's playmat, behind the board only (never behind a
           curtain). Decorative; a theme without one shows the ink table. -->
      <theme.Table />
    {/if}
    <Board
      view={board.state}
      {names}
      highlighted={staging.highlighted}
      staged={staging.staged}
      dimmedHand={staging.dimmedHand}
      selectedHand={staging.selectedHand}
      inert={boardInert}
      {deckEnabled}
      ontap={onBoardTap}
      ontapblank={() => staging.clearSelection()}
      {lastMoveText}
      {theme}
      handTray={revealed === null ? undefined : sevenTray}
      menu={menuButtonSnippet}
      centerOverlay={staging.chooser === null ? undefined : chooserSheet}
      {drag}
    />

    {#snippet chooserSheet()}
      <!-- r16: on the centre strip, not over the hand (design.md §6). -->
      {#if staging.chooser !== null}
        <AmbiguityChooser
          candidates={staging.chooser.candidates}
          onchoose={fresh((index: number) => staging.choose(index))}
          oncancel={fresh(() => staging.cancel())}
          describe={(candidate) => optionText(candidate.index, candidate.description)}
        />
      {/if}
    {/snippet}

    {#snippet sevenTray()}
      {#if revealed !== null}
        <SevenRevealPanel
          cards={revealed}
          hand={board?.state.you.hand ?? []}
          selected={staging.selectedReveal}
          staged={staging.staged}
          ontap={(key) => onBoardTap(key)}
          {theme}
        />
      {/if}
    {/snippet}

    <div class="game-screen__action-bar">
      {#if staging.stagedDescription !== null}
        <StagingBar
          description={optionText(staging.stagedIndex, staging.stagedDescription)}
          title={stagedTitle}
          disabled={boardInert}
          onconfirm={fresh(() => {
            staging.confirm().catch(report);
          })}
          oncancel={fresh(() => staging.cancel())}
        />
      {:else if staging.discard !== null}
        <DiscardPicker need={staging.discard.need} picked={staging.discard.picked.length} />
      {:else if hint !== null}
        <!-- Card labels: the selected card's name and what it does, in the
             bar's reserved space (nothing else uses it while selecting). -->
        <p class="game-screen__hint" data-card-hint>
          <span class="game-screen__hint-name" data-card-label="name">{hint.name}</span>
          <span class="game-screen__hint-effect" data-card-label="effect">{hint.effect}</span>
        </p>
      {:else if staging.passAvailable}
        <button type="button" class="game-screen__pass" data-testid="pass"
          disabled={boardInert}
          onclick={fresh(() => {
            if (boardInert) return;
            staging.tap('pass');
          })}
        >
          Pass
        </button>
      {:else if notice !== null}
        <!-- Playtest 2026-09-29: why the last tap did nothing. -->
        <p class="game-screen__hint game-screen__notice" role="status" data-blocked-reason>{notice}</p>
      {/if}
    </div>

    {#if staging.scrapPick !== null}
      <ScrapBrowser
        mode="pick"
        cards={board.state.scrap}
        picks={staging.scrapPick.candidates}
        onpick={fresh((index: number) => staging.pickScrap(index))}
        onclose={fresh(() => staging.cancel())}
        {theme}
      />
    {:else if browsingScrap}
      <ScrapBrowser mode="browse" cards={board.state.scrap} onclose={() => (browsingScrap = false)} {theme} />
    {/if}

    {#if inspectCard !== null}
      <CardDetailPopover card={inspectCard} reason={inspectReason} onclose={() => (staging.inspect = null)} {theme} />
    {/if}
  {:else if online !== null}
    <!-- W12: an online source with no state yet (connecting, or the deal
         not in). Placeholder text; W13b styles it. -->
    <div class="game-screen__online-panel" data-testid="online-waiting" role="status">
      <p>Waiting for the game…</p>
    </div>
  {/if}

  {#if online !== null && (online.statusText !== null || online.notice !== null)}
    <!-- W12: the connection status line and the last move's notice, as plain
         text (W13b makes them pretty). Fixed strings and room names only. -->
    <div class="game-screen__online-status">
      {#if online.statusText !== null}
        <p data-testid="online-status" role="status">
          {online.statusText}
          {#if online.statusAction !== null}
            <button type="button" class="game-screen__online-retry" data-testid="online-retry" onclick={() => online.runStatusAction()}>
              {online.statusAction}
            </button>
          {/if}
        </p>
      {/if}
      {#if online.notice !== null}
        <p data-testid="online-notice" role="status">{online.notice}</p>
      {/if}
    </div>
  {/if}

  {#if board === null || drawReveal !== null}
    <div class="game-screen__menu-float">
      {@render menuButtonSnippet()}
    </div>
  {/if}

  <GameMenu
    open={menuOpen}
    anchor={board === null || drawReveal !== null ? 'screen' : 'column'}
    {names}
    onclose={closeMenu}
    onhome={menuHome}
    onnewgame={menuNewGame}
  />
</div>

{#snippet menuButtonSnippet()}
  <button
    type="button"
    class="game-screen__menu-button"
    data-testid="menu-button"
    aria-label="Menu"
    aria-haspopup="dialog"
    aria-expanded={menuOpen ? 'true' : 'false'}
    bind:this={menuButton}
    onclick={() => (menuOpen = true)}
  >
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  </button>
{/snippet}

<style>
  /* W22 (iPhone 15 pass): exactly the visible viewport (`100dvh` tracks
     Mobile Safari's toolbars), never taller, so the page itself never
     scrolls. The safe-area padding keeps everything tappable clear of the
     Dynamic Island and the home indicator. Board is the flexible middle and
     the only region that scrolls; the action bar below it is pinned. */
  .game-screen {
    position: relative;
    /* A theme playmat (z-index -1) paints above this background, below the board. */
    isolation: isolate;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    box-sizing: border-box;
    padding: var(--cu-safe-top, 0px) 0 var(--cu-safe-bottom, 0px);
    overflow: hidden;
    background: var(--cu-ink);
    color: var(--cu-pearl);
    font-family: var(--cu-font-ui);
  }

  /* Issue #37 (SPEC §5.10): table mode turns player 2's screens. The screen
     is exactly the viewport, so the turn about its centre maps it onto
     itself. Its fixed-position overlays (curtain, prompt, menu, sheets) now
     sit in this box instead of the viewport, which is the same rectangle,
     and turn with it. The safe-area insets swap so the Dynamic Island and
     the home indicator stay clear on the physical top and bottom edges. */
  .game-screen--rotated {
    --cu-safe-top: env(safe-area-inset-bottom, 0px);
    --cu-safe-bottom: env(safe-area-inset-top, 0px);
    transform: rotate(180deg);
  }

  /* Amended 2026-09-28 (playtest friction, design.md §4): on a desktop
     the 560 px column sits in a lot of empty space and its phone-sized text
     reads small, so the type scale steps up for everything inside the game
     screen. Desktop only: both phone targets (393x852, 430x932) are far
     below the width gate, so their layout is untouched. Card sizes are not
     touched here. */
  @media (min-width: 1024px) and (min-height: 700px) {
    .game-screen {
      --cu-text-xs: 15px;
      --cu-text-sm: 17px;
      --cu-text-md: 19px;
      --cu-text-lg: 28px;
      /* Card labels: room for the staged card's name plus a two-line
         description at the larger desktop type, so staging never grows
         the bar. */
      --cu-zone-action: 76px;
      /* Card labels: in-play badges read at laptop distance too. */
      --cu-text-badge: 12px;
    }
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
    min-height: var(--cu-zone-action, 60px);
    margin: 0 auto;
    border-top: 1px solid var(--cu-ink-line, #4a3d57);
    background: var(--cu-ink-raised, #30263a);
  }

  /* The menu button (design.md §6: 44x44, far right of the score bar). Off
     the board it floats top right of the SCREEN, matching the full-width
     curtain and prompt screens it sits on: in a box the score bar's height,
     centred like the bar's slot, the board gutter from the right edge. On
     a phone the column is the screen, so this is the board's spot exactly. */
  .game-screen__menu-float {
    position: fixed;
    z-index: 10;
    top: var(--cu-safe-top, 0px);
    right: 0;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: var(--cu-zone-score, 44px);
    padding-right: var(--cu-gutter-board, 10px);
    pointer-events: none;
  }

  .game-screen__menu-float > .game-screen__menu-button {
    pointer-events: auto;
  }

  .game-screen__menu-button {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: var(--cu-tap-min, 44px);
    height: var(--cu-tap-min, 44px);
    padding: 0;
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: transparent;
    color: var(--cu-muted, #b4a8be);
    cursor: pointer;
  }

  .game-screen__menu-button:hover {
    color: var(--cu-pearl, #eee8f1);
  }

  .game-screen__menu-button:focus-visible {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: -2px;
  }

  /* Card labels: one paragraph, name then effect, at most two lines
     inside the reserved bar (design.md §6: staging never reflows). */
  .game-screen__hint {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    margin: 0 var(--cu-space-4, 16px);
    font-size: var(--cu-text-sm, 14px);
    line-height: 1.25;
    color: var(--cu-pearl, #eee8f1);
  }

  .game-screen__hint-name {
    margin-right: 0.4em;
    color: var(--cu-ochre, #f0b54a);
    font-weight: var(--cu-weight-bold, 700);
  }

  .game-screen__pass {
    align-self: center;
    box-sizing: border-box;
    min-width: 160px;
    min-height: 48px;
    font-weight: var(--cu-weight-bold, 700);
    padding: 0 var(--cu-space-5, 24px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-md, 16px);
    cursor: pointer;
  }

  /* W12 placeholders (W13b restyles): plain text, every testid box at
     least 44 px tall (SPEC §5.1). */
  .game-screen__online-panel {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-4, 16px);
    text-align: center;
    font-size: var(--cu-text-md, 16px);
  }

  .game-screen__online-status {
    flex: none;
    width: 100%;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    font-size: var(--cu-text-sm, 14px);
  }

  .game-screen__online-status p {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-3, 12px);
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    margin: 0;
    padding: 0 var(--cu-space-4, 16px);
    text-align: center;
  }

  .game-screen__online-retry {
    box-sizing: border-box;
    min-width: var(--cu-tap-min, 44px);
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-4, 16px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-size: var(--cu-text-sm, 14px);
    font-weight: var(--cu-weight-bold, 700);
    cursor: pointer;
  }

  .game-screen__pass:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
