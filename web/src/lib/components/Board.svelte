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
  import type { PlayerId, PlayerView } from '../bridge/schema';
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
    ontap: (key: string) => void;
    /** The caller-formatted last-move line (e.g. via `lib/recap.ts`); the centre strip's middle slot renders it (design §6). */
    lastMoveText?: string;
    theme?: CardTheme;
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
  }: BoardProps = $props();

  const opponentId = $derived((1 - view.viewer) as PlayerId);

  // The single place `inert` is honoured (Board brief: "inert makes every
  // tap a no-op"). Every descendant receives THIS function as its ontap, so
  // none of them needs to know about `inert` at all.
  function tap(key: string): void {
    if (!inert) ontap(key);
  }
</script>

<div class="board" data-testid="board" data-inert={inert ? 'true' : 'false'}>
  <ScoreBar scoreboard={view.scoreboard} opponentName={names[opponentId]} />
  <OpponentZone
    opponent={view.opponent}
    {opponentId}
    pointTotal={view.scoreboard.opponent.points}
    {highlighted}
    {staged}
    ontap={tap}
    {theme}
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
  />
  <PlayerZone
    you={view.you}
    viewerId={view.viewer}
    pointTotal={view.scoreboard.you.points}
    {highlighted}
    {staged}
    {dimmedHand}
    {selectedHand}
    ontap={tap}
    {theme}
  />
</div>

<style>
  .board {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-2, 8px);
    background: var(--cu-ink, #241c2b);
    max-width: var(--cu-board-max, 560px);
    margin: 0 auto;
    overflow-x: hidden;
  }
</style>
