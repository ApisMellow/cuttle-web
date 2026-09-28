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
import { DEFAULT_THEME_ID, getTheme } from '../../../src/lib/theme';

const theme = getTheme(DEFAULT_THEME_ID);
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
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [] },
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

interface MountBoardOptions {
  view: PlayerView;
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

export function mountBoard({ view, withActionBarPlaceholder = true }: MountBoardOptions): MountedBoard {
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
      names: ['Ada', 'Bel'],
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      dimmedHand: new Set<number>(),
      selectedHand: null,
      inert: false,
      deckEnabled: true,
      ontap: () => {},
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
