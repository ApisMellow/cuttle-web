<script lang="ts">
  // P2 W9 — the presentational board. Renders `view` through props only;
  // reports every tap through `ontap(key)`. No store import, no bridge call,
  // no legal-move derivation: the round-4 GameScreen composes this with the
  // staging/affordance layer.
  //
  // `inert` is enforced in exactly one place — the `tap` wrapper below — so
  // no child needs its own `inert` prop; every callback Board hands down is
  // already inert-checked.
  //
  // Redaction: this component's only source of state is `view:
  // PlayerView` (never `Envelope`/`history`) plus the caller-formatted
  // `lastMoveText` string. There is no code path here that can reach a card
  // identity this view does not already contain.
  import type { Snippet } from 'svelte';

  import type { PlayerId, PlayerView } from '../bridge/schema';
  import type { HandDrag } from '../dragDrop';
  import { parseTargetKey, type TargetKey } from '../targetKey';
  import { DEFAULT_THEME_ID, getTheme } from '../theme';
  import type { CardTheme } from '../theme/types';
  import CenterZone from './CenterZone.svelte';
  import OpponentZone from './OpponentZone.svelte';
  import PlayerZone from './PlayerZone.svelte';
  import ScoreBar from './ScoreBar.svelte';

  interface BoardProps {
    view: PlayerView;
    names: [string, string];
    highlighted: ReadonlySet<string>;
    staged: ReadonlySet<string>;
    dimmedHand: ReadonlySet<number>;
    selectedHand: number | null;
    inert: boolean;
    /** Whether Draw is legal now (the integrator reads the move list). Drives the deck's disabled styling only. */
    deckEnabled: boolean;
    /** Every tap, as the shared `TargetKey` (P2 W13). */
    ontap: (key: TargetKey) => void;
    /** The caller-formatted last-move line (e.g. via `lib/recap.ts`); the centre strip's middle slot renders it (design §6). */
    lastMoveText?: string;
    theme?: CardTheme;
    /** P2 W15: shown in the hand's slot instead of the hand (the integrator's SevenRevealPanel). */
    handTray?: Snippet;
    /** W25: a tap on empty board space or the score bar (anything that isn't a button). */
    ontapblank?: () => void;
    /** The in-game menu button, rendered in the score bar's reserved slot (design.md §6). */
    menu?: Snippet;
    /** r16: drawn over the centre strip (the integrator's ambiguity chooser). */
    centerOverlay?: Snippet;
    /** Issue #26: the hand card being dragged (GameScreen owns the gesture). Display only. */
    drag?: HandDrag | null;
  }

  let {
    view,
    names,
    highlighted,
    staged,
    dimmedHand,
    selectedHand,
    inert,
    deckEnabled,
    ontap,
    lastMoveText,
    theme = getTheme(DEFAULT_THEME_ID),
    handTray,
    ontapblank,
    menu,
    centerOverlay,
    drag = null,
  }: BoardProps = $props();

  const opponentId = $derived((1 - view.viewer) as PlayerId);

  // W24: while the OPPONENT has glasses in play, the viewer's hand is
  // exposed to them (R7), and the viewer's hand says so. R10: the bridge
  // says so too, in `you.watched`, computed by the same predicate that gates
  // the opponent's `opponent.hand` (SPEC §3.2). That flag is the only
  // source; nothing here inspects permanents or reads a hand.
  const watchedBy = $derived(view.you.watched ? names[opponentId] : null);

  // The single place `inert` is honoured (Board brief: "inert makes every
  // tap a no-op"). Every descendant receives THIS function as its ontap, so
  // none of them needs to know about `inert` at all.
  //
  // P2 W13: children report plain strings; this is also the one place they
  // are narrowed to the shared `TargetKey` vocabulary. A string outside it
  // is dropped rather than forwarded.
  function blankTap(event: MouseEvent): void {
    if (inert || ontapblank === undefined) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, [role="button"]') !== null) return;
    ontapblank();
  }

  function tap(key: string): void {
    if (inert) return;
    const parsed = parseTargetKey(key);
    if (parsed !== null) ontap(parsed);
  }
</script>

<!-- W25: a pointer convenience only. Every target is its own <button>, so
     keyboard users clear a selection by re-selecting or with Cancel. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="board" data-testid="board" data-inert={inert ? 'true' : 'false'} onclick={blankTap}>
  <ScoreBar
    scoreboard={view.scoreboard}
    opponentName={names[opponentId]}
    youName={names[view.viewer]}
    active={view.active === view.viewer ? 'you' : 'opponent'}
    {menu}
  />
  <OpponentZone
    opponent={view.opponent}
    {opponentId}
    pointTotal={view.scoreboard.opponent.points}
    goal={view.scoreboard.opponent.threshold}
    {highlighted}
    {staged}
    ontap={tap}
    {theme}
    {names}
  />
  <CenterZone
    deckCount={view.deckCount}
    {deckEnabled}
    deckHighlighted={highlighted.has('deck')}
    deckStaged={staged.has('deck')}
    scrap={view.scrap}
    scrapHighlighted={highlighted.has('scrap')}
    scrapStaged={staged.has('scrap')}
    oneOffHighlighted={highlighted.has('zone:oneoff')}
    oneOffStaged={staged.has('zone:oneoff')}
    {lastMoveText}
    ontap={tap}
    {theme}
    overlay={centerOverlay}
  />
  <PlayerZone
    you={view.you}
    viewerId={view.viewer}
    pointTotal={view.scoreboard.you.points}
    goal={view.scoreboard.you.threshold}
    {highlighted}
    {staged}
    {dimmedHand}
    {selectedHand}
    ontap={tap}
    {theme}
    {handTray}
    {watchedBy}
    {names}
    {drag}
  />
</div>

<style>
  /* W22 (iPhone 15 pass): the board is the one scrolling region of the
     game screen. It fills whatever height GameScreen leaves between the
     safe-area padding and the action bar; the score bar sticks to its top
     and the hand to its bottom (PlayerZone), so on a short viewport — Mobile
     Safari with its toolbars, about 393x660 — only the field scrolls and
     the hand and action bar never leave the screen.

     The centre strip takes `margin-block: auto` (CenterZone), so on a tall
     screen the spare height splits evenly either side of it (design.md §6)
     and the two players' areas stay anchored to the top and bottom. */
  .board {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    gap: var(--cu-gap-zone, 4px);
    box-sizing: border-box;
    width: 100%;
    min-height: 0;
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    /* GameScreen paints the ink table; transparent here so a theme's
       playmat (A-6) behind the board shows through. */
    background: transparent;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
</style>
