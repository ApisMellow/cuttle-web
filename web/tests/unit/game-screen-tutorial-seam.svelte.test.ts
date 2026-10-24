// @vitest-environment jsdom
// Tutorial T2 (docs/tutorial-plan.md §6 T2; docs/tutorial-design.md §5.5.1,
// §6.3): the three optional TableSource fields GameScreen reads for the
// tutorial, and nothing else.
//
//   - `names`: GameScreen shows `online?.names ?? source.names ??
//     session.names`. The tutorial never writes the pass-and-play session's
//     names, so its own pair has to win over them.
//   - `allowsNewGame`: `false` hides the menu's New game; absent keeps it.
//     Online never offers it, whatever the field says.
//   - `refusals`: GameScreen keys the CounterPrompt on it. CounterPrompt is
//     once-only (`acted`), so when the tutorial's gate refuses "Let it
//     resolve" and nothing else changes, only a remount gives the learner a
//     working prompt again. With the field absent the key is the constant 0,
//     so pass-and-play and online never remount.
//
// ONE mounted GameScreen per test, driven through a FakeTableSource whose
// `refuse` option stands in for the tutorial's apply gate.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Envelope, Move, PlayerView } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import type { OnlineTableInfo } from '../../src/lib/stores/tableSource';
import { loadThemeCatalog, resetThemeCatalogForTests } from '../../src/lib/theme';
import { FakeTableSource } from './fake-table-source.svelte';
import { Kind, Phase, appliedMove, envelope, playerView } from './game-test-support';
import { THEMES_URL, fakeFetch, mythicRoutes } from './theme-fixture';

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const TWO = { Rank: 2, Suit: 2 } as const;
const FOUR = { Rank: 4, Suit: 0 } as const;

/** Index 0 is the Counter, index 1 the Decline ("Let it resolve"). */
const COUNTER_INDEX = 0;
const DECLINE_INDEX = 1;

function aliceView(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, NINE], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 4, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

/** Alice to act on the live board: Draw, or the Ace for points. */
function aliceToAct(): Envelope {
  return envelope({
    state: aliceView(),
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE })],
    descriptions: ['draw a card', 'play ace as point card'],
  });
}

/** Blake's 4 is pending and Alice holds one 2: one Counter and the Decline. */
function counterWindowEnvelope(): Envelope {
  return envelope({
    state: aliceView({
      phase: Phase.AwaitingCounter,
      you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 3, hand: null, points: [], permanents: [] },
      pending: { playedBy: 1, card: FOUR, target: null, counterChain: [] },
    }),
    legalMoves: [mv({ Kind: Kind.Counter, HandIndex: 0, Card: TWO }), mv({ Kind: Kind.Decline })],
    descriptions: ['counter with 2♥', 'decline'],
    history: [appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: FOUR, description: 'play 4♣ as one-off' })],
  });
}

/** The online fields an online source adds, all quiet: no status, no hold, nothing missed. */
function onlineInfo(names: [string, string]): OnlineTableInfo {
  return {
    names,
    statusText: null,
    statusAction: null,
    respondingName: null,
    notice: null,
    runStatusAction() {},
    statusTone: null,
    respondingCard: null,
    waitingText: null,
    missed: [],
    dismissMissed() {},
    stuck: null,
    leaveGame() {},
  };
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(source: FakeTableSource): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source } });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

function heading(): string {
  return host?.querySelector('h1')?.textContent?.trim() ?? '';
}

function boardSource(): FakeTableSource {
  const source = new FakeTableSource();
  source.push(aliceToAct());
  return source;
}

/** A counter window at `{kind:'ack', to:0}` whose gate refuses the Decline. */
function counterWindow(opts: { refuseDecline: boolean }): FakeTableSource {
  const source = new FakeTableSource({ refuse: (i) => opts.refuseDecline && i === DECLINE_INDEX });
  source.push(counterWindowEnvelope());
  source.curtain = { kind: 'ack', to: 0 };
  return source;
}

beforeEach(() => {
  localStorage.clear();
  resetThemeCatalogForTests();
  session.setNames('Player 1', 'Player 2');
  settings.revealPreference = 'two-step';
  settings.setThemeId('vector');
});

afterEach(() => {
  cleanup();
  settings.setThemeId('vector');
});

describe('T2: source names win over session names', () => {
  it('shows the source names, and leaves the session names as they were', () => {
    const source = boardSource();
    source.names = ['Alice', 'Blake'];
    render(source);
    expect(heading()).toBe('Alice vs Blake');
    expect(session.names).toEqual(['Player 1', 'Player 2']);
  });

  it('with names absent, the session names show (unchanged)', () => {
    render(boardSource());
    expect(heading()).toBe('Player 1 vs Player 2');
  });

  it('online names still win over source names', () => {
    const source = boardSource();
    source.names = ['Alice', 'Blake'];
    source.online = onlineInfo(['Blake', 'Alice']);
    render(source);
    expect(heading()).toBe('Blake vs Alice');
  });
});

describe('T2: menu hides New game when allowsNewGame is false', () => {
  async function openMenu(source: FakeTableSource): Promise<void> {
    render(source);
    await loadThemeCatalog({ fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    await settle();
    await click('menu-button');
    expect(q('game-menu')).not.toBeNull();
  }

  it('false: no New game; Home, Rules and the card styles stay', async () => {
    const source = boardSource();
    source.allowsNewGame = false;
    await openMenu(source);
    expect(q('menu-new-game')).toBeNull();
    expect(q('menu-home')).not.toBeNull();
    expect(q('menu-rules')).not.toBeNull();
    expect(q('menu-theme-option-vector')).not.toBeNull();
    expect(q('menu-theme-option-mythic')).not.toBeNull();
  });

  it('absent: New game is offered, as today', async () => {
    await openMenu(boardSource());
    expect(q('menu-new-game')).not.toBeNull();
  });

  it('true: New game is offered', async () => {
    const source = boardSource();
    source.allowsNewGame = true;
    await openMenu(source);
    expect(q('menu-new-game')).not.toBeNull();
  });

  it('an online source: no New game, as today, even with allowsNewGame true', async () => {
    const source = boardSource();
    source.online = onlineInfo(['Alice', 'Blake']);
    source.allowsNewGame = true;
    await openMenu(source);
    expect(q('menu-new-game')).toBeNull();
    expect(q('menu-home')).not.toBeNull();
  });
});

describe('T2: the refusals key on the counter prompt (design §5.5.1)', () => {
  it('a refused Decline remounts a fresh prompt', async () => {
    const source = counterWindow({ refuseDecline: true });
    render(source);
    const first = q('counter-prompt');
    expect(first).not.toBeNull();

    await click('counter-resolve');
    expect(source.applied).toEqual([DECLINE_INDEX]);
    expect(source.refusals).toBe(1);
    expect(source.pending).toBe(false);
    expect(source.curtain).toEqual({ kind: 'ack', to: 0 });

    // A fresh instance: its "Let it resolve" works again, and it is a new node.
    const second = q('counter-prompt');
    expect(second).not.toBeNull();
    await click('counter-resolve');
    expect(source.applied).toEqual([DECLINE_INDEX, DECLINE_INDEX]);
    expect(source.refusals).toBe(2);
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
    const third = q('counter-prompt');
    expect(third).not.toBeNull();
    expect(third).not.toBe(second);
  });

  it('the fresh prompt can counter', async () => {
    const source = counterWindow({ refuseDecline: true });
    render(source);
    await click('counter-resolve');
    expect(source.refusals).toBe(1);

    await click(`counter-option-${COUNTER_INDEX}`);
    const confirm = q('counter-prompt')?.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]') ?? null;
    expect(confirm).not.toBeNull();
    expect(confirm?.disabled).toBe(false);
    await click('staging-confirm');
    expect(source.applied).toEqual([DECLINE_INDEX, COUNTER_INDEX]);
  });

  it('no remount without refusals: pending and an equal history keep the same, still-staged prompt', async () => {
    const source = counterWindow({ refuseDecline: false });
    expect(source.refusals).toBeUndefined();
    render(source);
    await click(`counter-option-${COUNTER_INDEX}`);
    const prompt = q('counter-prompt');
    expect(prompt?.querySelector('[data-testid="staging-confirm"]')).not.toBeNull();

    source.pending = true;
    await settle();
    source.pending = false;
    await settle();
    expect(q('counter-prompt')).toBe(prompt);
    expect(prompt?.querySelector('[data-testid="staging-confirm"]')).not.toBeNull();

    source.history = source.history.map((entry) => ({ ...entry }));
    await settle();
    expect(q('counter-prompt')).toBe(prompt);
    expect(prompt?.querySelector('[data-testid="staging-confirm"]')).not.toBeNull();

    // The same position resent whole (a reconnect): still the same prompt.
    source.push($state.snapshot(source.envelope) as Envelope);
    await settle();
    expect(q('counter-prompt')).toBe(prompt);
    expect(prompt?.querySelector('[data-testid="staging-confirm"]')).not.toBeNull();

    // And it is still live: Confirm sends the counter.
    await click('staging-confirm');
    expect(source.applied).toEqual([COUNTER_INDEX]);
  });
});
