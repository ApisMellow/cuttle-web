// P2 W14 (board polish, round-4) — a real-browser mount harness for Board
// and PointRow, used only by web/tests/e2e/*.spec.ts.
//
// Why this exists: GameScreen (SPEC §5.2) is still the P2 W12 skeleton in
// THIS worktree — the round-4 integrator wires the real board into it in a
// sibling worktree — so there is no live route this round-4 item can drive
// through app-shell.spec.ts's page.goto('/') + real-UI pattern to reach a
// rendered board (AGENTS.md "Developer playbook" — the app-shell tests
// reach positions through the real UI, never hand-navigation; there is no
// real UI here yet to reach through). Several of this item's acceptance
// criteria (elementFromPoint hit-testing, real layout heights, viewport fit)
// are undecidable under jsdom, which has no real layout engine.
//
// This module is fetched by the dev server like any other src file and
// mounted from an ALREADY-LOADED real page (a spec first does
// `page.goto('/')`, which boots the real app shell and loads
// `lib/styles/tokens.css` via App.svelte — the design tokens every
// component below reads). It never imports GameScreen, a store, Curtain,
// StagingBar or AmbiguityChooser, and it makes no bridge/wasm call: it is a
// pure Svelte `mount()` of the same presentational, props-in components the
// jsdom unit tests exercise, in a real browser instead of jsdom.
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';

import type { Card, PlayerId, PlayerView, PointEntry } from '../../../src/lib/bridge/schema';
import Board from '../../../src/lib/components/Board.svelte';
import PointRow from '../../../src/lib/components/PointRow.svelte';
import StagingBar from '../../../src/lib/components/StagingBar.svelte';
import { cardName } from '../../../src/lib/cardText';
import { plainMoveText, type NineReturn } from '../../../src/lib/recap';
import { vectorTheme } from '../../../src/lib/theme';

// The geometry specs measure Classic's corner index, so the harness pins
// Classic (Mythic is the app default since 2026-09-29).
const theme = vectorTheme;
const mounted: Array<{ instance: unknown; host: HTMLElement }> = [];

function freshHost(): HTMLElement {
  const host = document.createElement('div');
  // Pinned at the viewport origin, above whatever the real app (loaded by
  // the spec's own `page.goto('/')`, for its design tokens) happens to be
  // showing: without this, appending to `document.body` stacks our content
  // BELOW the app's own rendered height, which can push it out of the
  // viewport — `getBoundingClientRect`/`elementFromPoint` then read
  // coordinates the browser never actually painted.
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.zIndex = '999999';
  document.body.appendChild(host);
  return host;
}

export function card(Rank: Card['Rank'], Suit: Card['Suit']): Card {
  return { Rank, Suit };
}

export function pointEntry(overrides: Partial<PointEntry> & { Owner: PlayerId; Controller: PlayerId }): PointEntry {
  return { Card: card(4, 0), JackStack: [], JackOwners: [], ...overrides };
}

export function playerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    viewer: 0,
    active: 0,
    phase: 0,
    passesInARow: 0,
    winner: null,
    stalemate: false,
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 0, hand: null, points: [], permanents: [] },
    deckCount: 30,
    scrap: [],
    scoreboard: {
      you: { points: 0, threshold: 21, kings: 0, hasWon: false },
      opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
    },
    sevenRevealed: null,
    pending: null,
    ...overrides,
  };
}

/** Mounts a standalone PointRow (matches PointRow.svelte's own props; `theme` defaults to `vector`). */
export function mountPointRow(
  props: Omit<ComponentProps<typeof PointRow>, 'theme'> & Partial<Pick<ComponentProps<typeof PointRow>, 'theme'>>,
): HTMLElement {
  const host = freshHost();
  const instance = mount(PointRow, { target: host, props: { theme, ...props } });
  flushSync();
  mounted.push({ instance, host });
  return host;
}

/**
 * W22: the worst-case board the fit specs measure: an 8-card hand, two point
 * cards with Jacks on each side (one a 2-Jack stack), permanents on both.
 * W24: each permanents row holds a glasses 8, which lies sideways (wider
 * than an upright card), and the opponent's glasses put the watched marker
 * on the viewer's hand.
 */
export function worstCaseView(): PlayerView {
  return playerView({
    you: {
      hand: [card(1, 0), card(2, 1), card(3, 2), card(4, 3), card(5, 0), card(6, 1), card(7, 2), card(8, 3)],
      frozenHandIndices: [],
      points: [
        pointEntry({ Card: card(9, 0), Owner: 0, Controller: 0, JackStack: [card(11, 0), card(11, 1)], JackOwners: [1, 0] }),
        pointEntry({ Card: card(8, 2), Owner: 0, Controller: 0, JackStack: [card(11, 2)], JackOwners: [0] }),
      ],
      permanents: [card(13, 3), card(8, 1)],
      // Wire-true: the opponent's glasses below mean the bridge marks this viewer watched.
      watched: true,
    },
    opponent: {
      handCount: 5,
      hand: null,
      points: [
        pointEntry({ Card: card(6, 2), Owner: 1, Controller: 1, JackStack: [card(11, 0), card(11, 1)], JackOwners: [0, 1] }),
        pointEntry({ Card: card(3, 3), Owner: 1, Controller: 1, JackStack: [card(11, 3)], JackOwners: [1] }),
      ],
      permanents: [card(12, 3), card(8, 0)],
    },
    deckCount: 20,
    scrap: [card(2, 0)],
  });
}

interface MountBoardOptions {
  view: PlayerView;
  /** W24: receives every Board tap (default: ignored). */
  ontap?: (key: string) => void;
  /** Appends a fixed-height placeholder below the board, standing in for
   * StagingBar's reserved `--cu-zone-action` box (out of scope for this
   * item) so "the action bar showing" (the brief's fit-check wording) is
   * represented in the total page height without importing StagingBar or
   * its store. */
  withActionBarPlaceholder?: boolean;
}

export interface MountedBoard {
  /** The single-column wrapper: board stacked above the action-bar
   * placeholder, exactly as GameScreen (SPEC §5.2) composes them. Its
   * height IS the page height a fit check cares about. */
  root: HTMLElement;
  board: HTMLElement;
  actionBar: HTMLElement | null;
}

export function mountBoard({ view, ontap = () => {}, withActionBarPlaceholder = true }: MountBoardOptions): MountedBoard {
  const root = freshHost();
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.width = '100%';

  const board = document.createElement('div');
  root.appendChild(board);
  const instance = mount(Board, {
    target: board,
    props: {
      view,
      names: ['Alice', 'Blake'],
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      dimmedHand: new Set<number>(),
      selectedHand: null,
      inert: false,
      deckEnabled: true,
      ontap,
    },
  });
  flushSync();
  mounted.push({ instance, host: root });

  let actionBar: HTMLElement | null = null;
  if (withActionBarPlaceholder) {
    actionBar = document.createElement('div');
    actionBar.setAttribute('data-testid', 'action-bar-placeholder');
    actionBar.style.height = 'var(--cu-zone-action, 64px)';
    actionBar.style.boxSizing = 'border-box';
    actionBar.style.flex = 'none';
    root.appendChild(actionBar);
  }
  return { root, board, actionBar };
}

export function unmountAll(): void {
  for (const { instance, host } of mounted.splice(0)) {
    if (instance) unmount(instance as never);
    host.remove();
  }
}

interface MountGameColumnOptions {
  view: PlayerView;
  highlighted?: Set<string>;
  staged?: Set<string>;
  selectedHand?: number | null;
  /** When set, the real StagingBar fills the action bar with this description. */
  stagedDescription?: string;
  /** W24: receives every Board tap (default: ignored). */
  ontap?: (key: string) => void;
}

export interface MountedGameColumn {
  root: HTMLElement;
  board: HTMLElement;
  actionBar: HTMLElement;
}

/**
 * W22: the board as GameScreen composes it, in a viewport-filling column —
 * `100dvh` tall, safe-area padding from the `--cu-safe-*` tokens, the board
 * host as the flexible middle and the action bar pinned below it. The
 * `.game-screen` / `.game-screen__action-bar` rules are scoped to
 * GameScreen.svelte, so their layout-relevant declarations are mirrored
 * inline here (GameScreen itself needs the game store, which this harness
 * never touches). Used by board-fit.spec.ts's short-viewport check, where
 * the board region scrolls and the hand and action bar must stay on screen.
 */
export function mountGameColumn({
  view,
  highlighted = new Set<string>(),
  staged = new Set<string>(),
  selectedHand = null,
  stagedDescription,
  ontap = () => {},
}: MountGameColumnOptions): MountedGameColumn {
  const root = freshHost();
  Object.assign(root.style, {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100dvh',
    boxSizing: 'border-box',
    paddingTop: 'var(--cu-safe-top, 0px)',
    paddingBottom: 'var(--cu-safe-bottom, 0px)',
    background: 'var(--cu-ink)',
    color: 'var(--cu-pearl)',
    fontFamily: 'var(--cu-font-ui)',
    overflow: 'hidden',
  });

  const boardHost = document.createElement('div');
  Object.assign(boardHost.style, { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' });
  root.appendChild(boardHost);
  const boardInstance = mount(Board, {
    target: boardHost,
    props: {
      view,
      names: ['Alice', 'Blake'],
      highlighted,
      staged,
      dimmedHand: new Set<number>(),
      selectedHand,
      inert: false,
      deckEnabled: true,
      ontap,
    },
  });

  const actionBar = document.createElement('div');
  actionBar.setAttribute('data-testid', 'action-bar-placeholder');
  Object.assign(actionBar.style, {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minHeight: 'var(--cu-zone-action, 64px)',
  });
  root.appendChild(actionBar);
  let barInstance: unknown = null;
  if (stagedDescription !== undefined) {
    barInstance = mount(StagingBar, { target: actionBar, props: { description: stagedDescription } });
  }
  flushSync();
  mounted.push({ instance: boardInstance, host: root });
  if (barInstance) mounted.push({ instance: barInstance, host: actionBar });
  return { root, board: boardHost.querySelector('[data-testid="board"]') as HTMLElement, actionBar };
}

// ---------------------------------------------------------------------------
// Card labels: the staging line's fit (staging-fit.spec.ts)
// ---------------------------------------------------------------------------

export interface StagingFitCase {
  description: string;
  title?: string;
}

/**
 * Every staged text shape the staging line can show, built by the real
 * `plainMoveText` from engine Describe strings, with the name GameScreen
 * adds when the move uses the card's ability. The widest tokens are used
 * ("10", the widest suit) so the check is the worst case.
 */
export function stagingFitCases(): StagingFitCase[] {
  const S = String.fromCodePoint(0x2660);
  const H = String.fromCodePoint(0x2665);
  const D = String.fromCodePoint(0x2666);
  const named = (rank: Card['Rank'], text: string, nine?: NineReturn): StagingFitCase => ({
    description: plainMoveText(text, nine),
    title: cardName(card(rank, 3)),
  });
  const plain = (text: string): StagingFitCase => ({ description: plainMoveText(text) });
  return [
    named(1, `play A${S} as one-off`),
    named(2, `play 2${S} as one-off`),
    named(3, `play 3${S} as one-off — take 10${H} from the scrap`),
    named(3, `7: play 3${S} as one-off — take 10${H} from the scrap`),
    named(4, `play 4${S} as one-off`),
    named(5, `play 5${S} as one-off`),
    named(6, `play 6${S} as one-off`),
    named(7, `play 7${S} as one-off`),
    named(9, `play 9${S} as one-off`),
    named(9, `play 9${S} as one-off`, 'theirs'),
    named(9, `play 9${S} as one-off`, 'yours'),
    named(9, `7: play 9${S} as one-off`, 'theirs'),
    named(12, `play Q${S} as permanent`),
    named(13, `play K${S} as permanent`),
    named(8, `play 8${S} as permanent`),
    named(11, `play J${S} (steal opponent point)`),
    plain(`scuttle opponent's 10${D} with 10${S}`),
    plain(`play 10${S} as point card`),
    plain(`7: no legal play — scrap 10${S}`),
    plain('draw a card'),
    plain(`Discard 10${S} and 10${H}`),
  ];
}

export interface StagingFit {
  description: string;
  overflows: boolean;
  barHeight: number;
  reserved: number;
}

/**
 * Mounts the real StagingBar in an action-bar box that mirrors
 * GameScreen's (scoped styles, so mirrored inline here, like
 * mountGameColumn), including GameScreen's desktop type step at >= 1024 x
 * 700, and measures each case: the description must not overflow its
 * clamp and the bar must not grow past its reserved height.
 */
export function measureStagingFit(cases: StagingFitCase[]): StagingFit[] {
  const out: StagingFit[] = [];
  const desktop = window.matchMedia('(min-width: 1024px) and (min-height: 700px)').matches;
  for (const c of cases) {
    const root = freshHost();
    root.style.width = '100%';
    if (desktop) {
      for (const [k, v] of Object.entries({
        '--cu-text-xs': '15px',
        '--cu-text-sm': '17px',
        '--cu-text-md': '19px',
        '--cu-text-lg': '28px',
        '--cu-zone-action': '76px',
      })) {
        root.style.setProperty(k, v);
      }
    }
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      width: '100%',
      maxWidth: 'var(--cu-board-max, 560px)',
      minHeight: 'var(--cu-zone-action, 60px)',
      margin: '0 auto',
      fontFamily: 'var(--cu-font-ui)',
    });
    root.appendChild(bar);
    const instance = mount(StagingBar, { target: bar, props: { description: c.description, title: c.title } });
    flushSync();
    const p = bar.querySelector('.staging-bar__description') as HTMLElement;
    out.push({
      description: `${c.title ?? ''} ${c.description}`.trim(),
      overflows: p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1,
      barHeight: bar.getBoundingClientRect().height,
      reserved: parseFloat(getComputedStyle(bar).minHeight),
    });
    unmount(instance);
    root.remove();
  }
  return out;
}
