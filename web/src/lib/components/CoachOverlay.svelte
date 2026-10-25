<script lang="ts">
  // Learn to play: the coach overlay (docs/tutorial-design.md §7, §9; plan T9).
  // It sits beside GameScreen, never inside it: App renders both in one
  // `{#key lessonId}`, and the overlay finds the GameScreen root as its
  // sibling. The CoachController reads that root's DOM and the lesson table;
  // nothing here reads the staging store or writes the board.
  //
  // Layers, bottom to top (design §7.1): the scrim and rings
  // (CoachSpotlight), the flight layer (FlightLayer, plus the deal and the landing flash), the
  // ghost demo, the bubble (the one layer that takes input), the done sheet.
  //
  // The fade rule (plan review focus 1): `.game-screen` is `isolation:
  // isolate`, so this sibling paints above GameMenu, RulesSheet, ScrapBrowser,
  // CardDetailPopover and AmbiguityChooser whatever their z-index. While any
  // of them is open the whole overlay goes to opacity 0 and takes no pointer
  // events, so their controls stay reachable. An appear step waiting for one
  // (5.3's popover) completes first; the next step's coach shows once it
  // closes.
  //
  // Progress (design §4.4, §10): the lesson is marked done when the done
  // sheet MOUNTS, never at the last move.
  //
  // Motion (design §8.4-§8.6, plan T11). The overlay attaches itself as the
  // lesson's motion while mounted; the table calls it around every move:
  //   - Alice's move: `capture` before the apply, then after one `tick()`
  //     the FlightLayer plays it against the GameScreen root and Alice's
  //     post-apply view; the landing ring flashes ochre as the card lands,
  //     and a winning move (lessons 1 and 5 only) adds the wave, the meter
  //     pulse and the "You win!" headline.
  //   - Blake's reply: `snapshot` of seat 0's view before, `captureReply`
  //     from the seat-0 log entry after. Never his Move.
  //   - Lesson 1 opens with the deal (§8.5); any tap off the coach's own
  //     controls finishes it at once.
  // Nothing awaits an animation: the table's timers alone move the lesson
  // on (SPEC §5.9). Every effect is transform and opacity on WAAPI, and
  // reduced motion (or no Element.animate) leaves only the calm variants:
  // the FlightLayer's static rings and the static headline.
  import { flushSync, onMount, tick, untrack, type Snippet } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  import type { AppliedMove, Card, Move, PlayerView } from '../bridge/schema';
  import { settings } from '../stores/settings.svelte';
  import { getTheme } from '../theme';
  import { CoachController, type CoachClock, type CoachFrames } from '../tutorial/coach.svelte';
  import {
    capture,
    captureReply,
    flipFrames,
    lastIndexed,
    motionOn,
    oppHandSlots,
    readMotionTokens,
    snapshot,
    toRect,
    type FlightCapture,
    type FlightRoot,
    type FlightSnapshot,
    type RectLike,
  } from '../tutorial/motion';
  import type { TutorialTable } from '../tutorial/table.svelte';
  import { tutorial, type LessonMotion } from '../tutorial/tutorial.svelte';
  import type { LessonId } from '../tutorial/types';
  import CoachBubble from './CoachBubble.svelte';
  import CoachSpotlight from './CoachSpotlight.svelte';
  import FlightLayer from './FlightLayer.svelte';
  import GhostDemo from './GhostDemo.svelte';
  import LessonDoneSheet from './LessonDoneSheet.svelte';

  /** The store calls the overlay makes (the app's `tutorial` by default). */
  interface CoachOverlayStore {
    readonly done: readonly LessonId[];
    leave(): void;
    exitHome(): void;
    finishLesson(id: LessonId): void;
    nextLesson(): void;
    /** Hooks this overlay up as the lesson's motion (T11); returns the detach. */
    attachMotion?(table: TutorialTable, sink: LessonMotion): () => void;
  }

  interface CoachOverlayProps {
    /** The lesson's table, the same object GameScreen has as its source. Fixed for the overlay's life. */
    table: TutorialTable;
    store?: CoachOverlayStore;
    /** Layer 3, the card flights: FlightLayer by default; a test may pass its own. */
    flights?: Snippet;
    /** The GameScreen root; by default the `game-screen` sibling of this overlay. */
    screen?: HTMLElement;
    /** Test seams for the controller's demo timers and measuring frames. */
    clock?: CoachClock;
    frames?: CoachFrames;
  }

  let { table, store = tutorial, flights, screen, clock, frames }: CoachOverlayProps = $props();

  const motion = $derived(motionOn(settings.reducedMotion));
  const theme = $derived(getTheme(settings.themeId));
  const lessonId = $derived(table.lesson.id);

  let rootEl = $state<HTMLDivElement>();
  let coach = $state.raw<CoachController | null>(null);

  /** Whether the last input was a key (design §9: Next takes focus only then). */
  let lastInputKey = false;

  // --- Win (design §8.6): lessons 1 and 5 only, once the engine says Alice won.
  const WIN_HEADLINE = 'You win!';
  const won = $derived(table.lesson.win && table.envelope?.state.winner === 0);
  const headline = $derived(won ? WIN_HEADLINE : undefined);

  onMount(() => {
    const screenEl =
      untrack(() => screen) ??
      rootEl?.parentElement?.querySelector<HTMLElement>(':scope > [data-testid="game-screen"]') ??
      null;
    if (!screenEl) return;
    boardRoot = screenEl;
    const controller = new CoachController({
      table: untrack(() => table),
      root: screenEl,
      bubble: () => rootEl?.querySelector<HTMLElement>('[data-testid="coach-bubble"]') ?? null,
      reducedMotion: () => !motionOn(settings.reducedMotion),
      headline: () => headline,
      clock: untrack(() => clock),
      frames: untrack(() => frames),
    });
    coach = controller;
    const detach = untrack(() => store.attachMotion?.(table, lessonMotion));
    // Lesson start: focus goes to the coach's copy, so a screen reader starts there.
    void tick().then(() => {
      if (untrack(() => table.lesson.deal)) startDeal();
      rootEl?.querySelector<HTMLElement>('[data-testid="coach-bubble"] [aria-live]')?.focus();
    });
    return () => {
      destroyed = true;
      detach?.();
      endDeal(false);
      for (const stop of [...beats]) stop();
      controller.dispose();
    };
  });

  const covered = $derived(coach?.covered ?? false);
  const stage = $derived(coach?.stage ?? 'idle');
  const finished = $derived(table.phase === 'finished');
  const doneList = $derived([...new Set<LessonId>([...store.done, lessonId])]);
  /** The win text is in the live copy too, so a screen reader hears it (the headline isn't announced). */
  const bubbleText = $derived(
    coach === null ? '' : headline && !coach.text.includes(headline) ? `${headline} ${coach.text}` : coach.text,
  );

  // =========================================================================
  // Motion (T11)
  // =========================================================================

  /** The GameScreen root: what flights measure and search, never this overlay. */
  let boardRoot: HTMLElement | null = null;
  let destroyed = false;
  let layer = $state<{ play(cap: FlightCapture, root: FlightRoot, after?: PlayerView | null): void }>();

  const canAnimate = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
  /** Full motion: neither the OS nor the setting asks for calm, and the browser can animate. */
  const lively = (): boolean => motionOn(settings.reducedMotion) && canAnimate();

  /** Runs after the new state has rendered; a motion failure is swallowed (decoration never breaks a lesson). */
  function afterRender(fn: () => void): void {
    void tick().then(() => {
      if (destroyed) return;
      try {
        fn();
      } catch {
        // Motion is decoration.
      }
    });
  }

  let learnerCap: FlightCapture | null = null;
  let replySnap: FlightSnapshot | null = null;

  /** What the table calls around every move. Each argument is seat-0 data (TutorialTableDeps). */
  const lessonMotion: LessonMotion = {
    beforeApply(move: Move, view0: PlayerView) {
      learnerCap = null;
      if (boardRoot) learnerCap = capture(move, view0, boardRoot);
    },
    afterApply() {
      const cap = learnerCap;
      learnerCap = null;
      // Seat 0's post-apply view, read now: a drawn card and Blake's hand under glasses come only from it.
      const after = table.envelope?.state ?? null;
      const root = boardRoot;
      if (!cap || !root) return;
      afterRender(() => {
        layer?.play(cap, root, after);
        if (!lively()) return;
        flashLanding(cap, root);
        if (table.lesson.win && after?.winner === 0) winBeats(root);
      });
    },
    beforeReply(view0: PlayerView) {
      replySnap = boardRoot ? snapshot(view0, boardRoot) : null;
    },
    afterReply(entry: AppliedMove) {
      const snap = replySnap;
      replySnap = null;
      const root = boardRoot;
      if (!snap || !root) return;
      const cap = captureReply(snap, entry);
      const after = table.envelope?.state ?? null;
      afterRender(() => layer?.play(cap, root, after));
    },
  };

  // --- Beats: the ochre landing flash and the win (design §8.2, §8.6) ---------

  interface Flash {
    id: number;
    box: RectLike;
    delay: number;
  }
  let flashes = $state<Flash[]>([]);
  let nextId = 0;
  /** Cleanup for every running beat and deal piece (cancels its timer). */
  const beats = new SvelteSet<() => void>();

  /** A WAAPI keyframe (the DOM `Keyframe` type isn't visible to the linter in .svelte files). */
  type Frame = Record<string, string | number>;

  const RING_PAD = 6; // the spotlight's hole padding (placement.ts holePad)
  const FLASH_MS = 360;
  // When the moving card arrives where the flash is drawn (motion.ts flight timelines).
  const SCUTTLE_LANDS_MS = 300 + 80 + 320;
  const ONEOFF_LANDS_MS = 300 + 240 + 320;

  /** Where Alice's card ends up, and when it gets there. */
  function landingOf(cap: FlightCapture, root: FlightRoot, flight: number): { el: Element | null; at: number } {
    const scrap = () => root.querySelector('[data-testid="scrap-pile"]');
    switch (cap.landing) {
      case 'toRow':
      case 'jackSteal':
        return { el: cap.row ? lastIndexed(root, `${cap.row}-0-`) : null, at: flight };
      case 'drawFlip':
      case 'drawBack':
        return { el: lastIndexed(root, 'hand-card-'), at: flight };
      case 'scuttle':
        return { el: scrap(), at: SCUTTLE_LANDS_MS };
      case 'oneOff':
        return { el: scrap(), at: ONEOFF_LANDS_MS };
      default:
        return { el: scrap(), at: 0 };
    }
  }

  /** Design §7.1: the ring goes ochre on a successful drop, as the card lands. */
  function flashLanding(cap: FlightCapture, root: FlightRoot): void {
    const tokens = readMotionTokens(rootEl ?? (root as Element));
    const { el, at } = landingOf(cap, root, tokens.flight);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const flash: Flash = {
      id: nextId++,
      box: { x: r.x - RING_PAD, y: r.y - RING_PAD, width: r.width + RING_PAD * 2, height: r.height + RING_PAD * 2 },
      delay: at,
    };
    flashes = [...flashes, flash];
    flushSync();
    const node = rootEl?.querySelector<HTMLElement>(`[data-flash="${flash.id}"]`);
    const anim = node?.animate(
      [
        { opacity: 0, transform: 'scale(1.14)', easing: tokens.easeLand },
        { opacity: 1, transform: 'scale(1)', offset: 0.3 },
        { opacity: 1, transform: 'scale(1)', offset: 0.72, easing: 'ease-in' },
        { opacity: 0, transform: 'scale(1.03)' },
      ],
      { duration: FLASH_MS, delay: at, fill: 'none' },
    );
    const stop = (): void => {
      clearTimeout(timer);
      beats.delete(stop);
      anim?.cancel();
      if (!destroyed) flashes = flashes.filter((f) => f.id !== flash.id);
    };
    const timer = setTimeout(stop, at + FLASH_MS + 50);
    beats.add(stop);
  }

  /**
   * The win (design §8.6): once the winning card has landed, Alice's point
   * cards rise in a wave and her score meter pulses once. Board elements are
   * animated with `fill: none`, so nothing about them is left changed.
   */
  function winBeats(root: FlightRoot): void {
    const tokens = readMotionTokens(rootEl ?? (root as Element));
    const start = tokens.flight + 60;
    const points = [...root.querySelectorAll('[data-testid^="point-0-"]')].filter((el) =>
      /^point-0-\d+$/.test(el.getAttribute('data-testid') ?? ''),
    );
    const anims: Animation[] = [];
    points.forEach((el, i) => {
      anims.push(
        el.animate(
          [
            { transform: 'translateY(0)' },
            { transform: 'translateY(-10px)', offset: 0.45 },
            { transform: 'translateY(0)' },
          ],
          { duration: 420, delay: start + i * 70, easing: 'cubic-bezier(0.6, 0, 0.3, 1)', fill: 'none' },
        ),
      );
    });
    // Coupling point: ScoreBar's meter track (it carries no testid; it isn't a tap target).
    const meter = root.querySelector('[data-testid="score-bar"] [data-side="you"] .score-bar__meter');
    if (meter) {
      anims.push(
        meter.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(1.6)', offset: 0.4 }, { transform: 'scaleY(1)' }], {
          duration: 300,
          delay: start,
          easing: 'ease-out',
          fill: 'none',
        }),
      );
    }
    const stop = (): void => {
      clearTimeout(timer);
      beats.delete(stop);
      for (const a of anims) a.cancel();
    };
    const timer = setTimeout(stop, start + points.length * 70 + 420 + 50);
    beats.add(stop);
  }

  // --- The deal (design §8.5): lesson 1 only --------------------------------

  interface DealCard {
    id: number;
    box: RectLike;
    face: Card | null;
    size: 'hand' | 'field' | 'mini';
  }
  let dealCards = $state<DealCard[]>([]);
  let dealAnims: Animation[] = [];
  let dealTimer: ReturnType<typeof setTimeout> | null = null;
  let dealing = false;

  const DEAL_CARD_MS = 360;
  const DEAL_FLIP_MS = 160;
  /** Points fade in first; the cards start leaving the deck a little after. */
  const DEAL_LEAD_MS = 120;
  /** Blake's cards go 70 ms apart (design §8.5); Alice's at `--cu-dur-deal-stagger`. */
  const BLAKE_STAGGER_MS = 70;
  const DEAL_ARC_PX = 18;

  /** Same exclusion as the coach's beat-skip (coach.svelte.ts OWN_CONTROLS): these act on their own first tap. */
  const OWN_CONTROLS = '[data-testid="coach-bubble"] button, [data-testid="coach-lesson-done"] button, [data-testid="menu-button"]';
  const ownsInput = (target: EventTarget | null): boolean =>
    typeof Element !== 'undefined' && target instanceof Element && target.closest(OWN_CONTROLS) !== null;

  /** A card leaving the deck: laid out at its destination, it starts over the deck and lands with a small overshoot. */
  function dealFrames(from: RectLike, to: RectLike): Frame[] {
    const dx = from.x + from.width / 2 - (to.x + to.width / 2);
    const dy = from.y + from.height / 2 - (to.y + to.height / 2);
    const sx = to.width > 0 ? from.width / to.width : 1;
    const sy = to.height > 0 ? from.height / to.height : 1;
    const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
    return [
      { offset: 0, opacity: 0, transform: `translate(${r2(dx)}px, ${r2(dy)}px) scale(${r2(sx)}, ${r2(sy)})`, easing: 'ease-out' },
      { offset: 0.12, opacity: 1, transform: `translate(${r2(dx * 0.9)}px, ${r2(dy * 0.9)}px) scale(${r2(sx)}, ${r2(sy)})`, easing: 'linear' },
      {
        offset: 0.55,
        opacity: 1,
        transform: `translate(${r2(dx * 0.4)}px, ${r2(dy * 0.4 - DEAL_ARC_PX)}px) rotate(-3deg) scale(${r2((sx + 1) / 2 + 0.05)}, ${r2((sy + 1) / 2 + 0.05)})`,
        easing: 'cubic-bezier(0.3, 1.25, 0.5, 1)',
      },
      { offset: 1, opacity: 1, transform: 'translate(0px, 0px) rotate(0deg) scale(1, 1)' },
    ];
  }

  function onDealInput(event: Event): void {
    if (!dealing || ownsInput(event.target)) return;
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    endDeal(true);
  }

  /** Ends the deal: `finish()` jumps every piece to its end (a tap), then the clones go. */
  function endDeal(finish: boolean): void {
    if (dealTimer !== null) clearTimeout(dealTimer);
    dealTimer = null;
    const anims = dealAnims;
    dealAnims = [];
    for (const a of anims) {
      try {
        if (finish) a.finish();
        else a.cancel();
      } catch {
        // An animation that can't finish (no end) is simply left.
      }
    }
    if (!dealing) return;
    dealing = false;
    if (!destroyed) dealCards = [];
    globalThis.removeEventListener?.('pointerdown', onDealInput, true);
    globalThis.removeEventListener?.('keydown', onDealInput, true);
  }

  /**
   * Design §8.5. The board is already complete underneath: the real hand
   * cards are only held invisible while their clones fly, the point cards
   * fade in, the meters fill, and the coach appears once the last card lands.
   * Input is never blocked. Reduced motion: the board appears complete.
   */
  function startDeal(): void {
    const root = boardRoot;
    if (!root || destroyed || !lively()) return;
    try {
      const deckEl = root.querySelector('[data-testid="deck-pile"]');
      const deck = deckEl ? toRect(deckEl.getBoundingClientRect()) : null;
      const view = table.envelope?.state;
      if (!deck || deck.width <= 0 || !view) return;
      const tokens = readMotionTokens(rootEl ?? root);
      const aliceGap = tokens.dealStagger > 0 ? tokens.dealStagger : 80;

      const flights: { el: Element; face: Card | null; delay: number; size: DealCard['size'] }[] = [];
      view.you.hand.forEach((card, i) => {
        const el = root.querySelector(`[data-testid="hand-card-${i}"]`);
        if (el) flights.push({ el, face: card, delay: DEAL_LEAD_MS + i * aliceGap, size: 'hand' });
      });
      oppHandSlots(root).forEach((el, j) => {
        // Interleaved with Alice's: his first card goes between her first two.
        flights.push({ el, face: null, delay: DEAL_LEAD_MS + aliceGap / 2 + j * BLAKE_STAGGER_MS, size: 'mini' });
      });
      const cards: DealCard[] = [];
      const placed: { card: DealCard; el: Element; delay: number }[] = [];
      for (const f of flights) {
        const box = toRect(f.el.getBoundingClientRect());
        if (box.width <= 0 || box.height <= 0) continue;
        const card: DealCard = { id: nextId++, box, face: f.face, size: box.width < 44 ? 'mini' : f.size };
        cards.push(card);
        placed.push({ card, el: f.el, delay: f.delay });
      }
      if (placed.length === 0) return;
      const end = Math.max(...placed.map((p) => p.delay + DEAL_CARD_MS));

      dealing = true;
      dealCards = cards;
      flushSync();
      const anims: Animation[] = [];
      for (const { card, el, delay } of placed) {
        const clone = rootEl?.querySelector<HTMLElement>(`[data-deal="${card.id}"]`);
        if (!clone) continue;
        const timing = { duration: DEAL_CARD_MS, delay, fill: 'both' as const };
        anims.push(clone.animate(dealFrames(deck, card.box), timing));
        const flipper = clone.querySelector<HTMLElement>('[data-part="flipper"]');
        if (flipper && card.face) anims.push(flipper.animate(flipFrames(DEAL_CARD_MS - DEAL_FLIP_MS, DEAL_FLIP_MS, DEAL_CARD_MS), timing));
        // The real card is held invisible until its clone lands; nothing is written to it.
        anims.push(el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: delay + DEAL_CARD_MS, fill: 'none' }));
      }
      for (const el of root.querySelectorAll('[data-testid^="point-"]')) {
        if (!/^point-[01]-\d+$/.test(el.getAttribute('data-testid') ?? '')) continue;
        anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: tokens.med, easing: 'ease-out', fill: 'none' }));
      }
      // The meters fill from empty, as their own 200 ms transition would.
      for (const fill of root.querySelectorAll<HTMLElement>('[data-testid="score-bar"] .score-bar__meter > span')) {
        const value = Number.parseFloat(fill.style.getPropertyValue('--fill'));
        if (!Number.isFinite(value)) continue;
        anims.push(
          fill.animate([{ transform: 'scaleX(0)' }, { transform: `scaleX(${value})` }], {
            duration: tokens.med,
            delay: DEAL_LEAD_MS,
            easing: 'ease-out',
            fill: 'backwards',
          }),
        );
      }
      // The coach (scrim, rings, bubble) appears once the last card lands.
      const coachIn: Frame[] = [{ opacity: 0 }, { opacity: 0, offset: end / (end + tokens.med) }, { opacity: 1 }];
      for (const sel of ['.coach-spotlight', '[data-testid="coach-bubble"]']) {
        const el = rootEl?.querySelector(sel);
        if (el) anims.push(el.animate(coachIn, { duration: end + tokens.med, easing: 'ease-out', fill: 'none' }));
      }
      dealAnims = anims;
      globalThis.addEventListener?.('pointerdown', onDealInput, true);
      globalThis.addEventListener?.('keydown', onDealInput, true);
      // Backstop: a browser (or a stub) that never reports a finish still loses the clones.
      dealTimer = setTimeout(() => endDeal(false), end + tokens.med + 100);
    } catch {
      endDeal(false);
    }
  }

  // A `next` step's Next takes focus only when the last input was a key; a
  // touch or mouse player keeps focus where it is (design §9).
  let focusedNextFor: string | null = null;
  $effect(() => {
    const id = stage === 'next' ? (table.step?.id ?? null) : null;
    untrack(() => {
      if (id === null || id === focusedNextFor) {
        if (id === null) focusedNextFor = null;
        return;
      }
      focusedNextFor = id;
      if (!lastInputKey) return;
      void tick().then(() => rootEl?.querySelector<HTMLElement>('[data-testid="coach-next"]')?.focus());
    });
  });

  /** The done sheet just mounted: the lesson is done (design §10). */
  function markDone(): void {
    untrack(() => store.finishLesson(lessonId));
  }

  function restart(): void {
    table.restart();
  }
</script>

{#snippet defaultFlights()}
  <FlightLayer bind:this={layer} {theme} {motion} />
{/snippet}

<svelte:window
  onkeydowncapture={() => (lastInputKey = true)}
  onpointerdowncapture={() => (lastInputKey = false)}
/>

<div
  class="coach-overlay"
  data-coach-overlay
  data-covered={covered ? 'true' : 'false'}
  data-coach-targets={coach?.targets.join(' ') ?? ''}
  data-reduced={motion ? 'false' : 'true'}
  style:opacity={covered ? '0' : null}
  style:pointer-events={covered ? 'none' : null}
  bind:this={rootEl}
>
  {#if coach}
    <CoachSpotlight holes={[...coach.holes]} ring="iris" visible={coach.targets.length > 0} />
    {@render (flights ?? defaultFlights)()}
    <!-- The deal's clones and the landing flash: layer 3 with the flights, aria-hidden, no testid, no input. -->
    <div class="coach-motion" aria-hidden="true" style="pointer-events: none">
      {#each dealCards as card (card.id)}
        <div
          class="coach-motion__card"
          data-deal={card.id}
          style:left="{card.box.x}px"
          style:top="{card.box.y}px"
          style:width="{card.box.width}px"
          style:height="{card.box.height}px"
        >
          <div class="coach-motion__flipper" data-part="flipper">
            <span class="coach-motion__side"><theme.Back size={card.size} /></span>
            {#if card.face}
              <span class="coach-motion__side" style:transform="rotateY(180deg)"><theme.Face card={card.face} size={card.size} /></span>
            {/if}
          </div>
        </div>
      {/each}
      {#each flashes as flash (flash.id)}
        <div
          class="coach-motion__flash"
          data-flash={flash.id}
          style:left="{flash.box.x}px"
          style:top="{flash.box.y}px"
          style:width="{flash.box.width}px"
          style:height="{flash.box.height}px"
        ></div>
      {/each}
    </div>
    <GhostDemo demo={coach.demo} playKey={coach.playKey} {motion} confirmBox={coach.confirmBox} {theme} />
    {#if stage === 'error'}
      <!-- The board takes no tap while the lesson is stuck; the menu row
           above it stays live, and so do the bubble's Restart and Leave. -->
      <div class="coach-overlay__block" data-coach-block aria-hidden="true" style:top="{coach.blockTop}px"></div>
    {/if}
    <CoachBubble
      text={bubbleText}
      {headline}
      tone={coach.tone}
      stepId={table.step?.id ?? ''}
      {stage}
      showNext={stage === 'next'}
      onnext={() => table.next()}
      onshowme={() => coach?.showMe()}
      onleave={() => store.leave()}
      lessonNumber={lessonId}
      placement={coach.placement}
      shake={coach.shake}
      error={stage === 'error' ? { onrestart: restart } : undefined}
    />
    {#if finished}
      <div class="coach-overlay__done" {@attach markDone}>
        <LessonDoneSheet
          lesson={lessonId}
          doneLine={table.lesson.done}
          done={doneList}
          final={lessonId === 5}
          onnext={() => store.nextLesson()}
          onlessons={() => store.leave()}
          onplay={() => store.exitHome()}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  /* No box of its own: every layer is fixed. The opacity carries the fade
     (design §7.1) and pointer-events: none is inherited by the bubble and the
     sheet, the only layers that take input. */
  .coach-overlay {
    transition: opacity var(--cu-dur-med, 200ms) var(--cu-ease-out, ease-out);
  }

  .coach-overlay[data-reduced='true'] {
    transition: none;
  }

  /* Layer 3's own pieces: the deal and the landing flash. Fixed to the
     viewport like the flight layer; only transform and opacity animate. */
  .coach-motion {
    position: fixed;
    inset: 0;
    overflow: hidden;
    perspective: 900px;
  }

  /* SPEC §5.6 rule 2: the clone box is the container; Face and Back fill it. */
  .coach-motion__card {
    position: absolute;
    transform-style: preserve-3d;
    will-change: transform, opacity;
  }

  .coach-motion__flipper {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
  }

  .coach-motion__side {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    border-radius: 7%;
    box-shadow: 0 8px 16px rgb(0 0 0 / 42%);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  /* Ochre means "done" (design §8.1). Invisible outside its animation. */
  .coach-motion__flash {
    position: absolute;
    box-sizing: border-box;
    border: var(--cu-ring-width, 3px) solid var(--cu-ochre, #f0b54a);
    border-radius: var(--cu-radius-well, 10px);
    opacity: 0;
  }

  .coach-overlay__block {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
  }
</style>
