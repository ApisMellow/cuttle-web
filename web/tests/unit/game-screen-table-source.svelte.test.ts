// @vitest-environment jsdom
// Two-phone W10 (docs/two-phone-plan.md §7): GameScreen reads a TableSource
// passed as a prop, not the `game` singleton. These tests drive ONE mounted
// GameScreen with an asynchronous fake source (FakeTableSource), the shape
// the online store will have: apply returns before the new state arrives,
// `pending` holds in between, and states can arrive unasked.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { lastMoveLine } from '../../src/lib/recap';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { FakeTableSource } from './fake-table-source.svelte';
import { Kind, Phase, appliedMove, envelope, playerView } from './game-test-support';

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return {
    Card: null,
    HandIndex: 0,
    Target: null,
    JackTarget: null,
    ScrapIndex: 0,
    DiscardA: 0,
    DiscardB: 0,
    SubMove: null,
    ...overrides,
  };
}

function point(card: PointEntry['Card'], owner: PlayerId): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const SEVEN = { Rank: 7, Suit: 1 } as const;
const TWO = { Rank: 2, Suit: 0 } as const;
const FOUR = { Rank: 4, Suit: 0 } as const;

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

/** Alice to act: Draw, or the Ace for points. */
function aliceToAct(): Envelope {
  return envelope({
    state: aliceView(),
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE })],
    descriptions: ['draw a card', 'play ace as point card'],
  });
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

function sourceAt(env: Envelope, settleMode: 'on-send' | 'on-state' = 'on-send'): FakeTableSource {
  const source = new FakeTableSource({ settle: settleMode });
  source.push(env);
  return source;
}

beforeEach(() => {
  session.setNames('Alice', 'Blake');
  settings.revealPreference = 'two-step';
});

afterEach(cleanup);

describe('W10: GameScreen reads the TableSource it is given', () => {
  it('renders the source board and applies the staged index through source.apply', async () => {
    const source = sourceAt(aliceToAct());
    render(source);
    expect(q('board')).not.toBeNull();
    await click('deck-pile');
    expect(q('staging-confirm')).not.toBeNull();
    await click('staging-confirm');
    expect(source.applied).toEqual([0]);
  });
});

describe('W10: pending apply', () => {
  it('disables Confirm and makes the board inert while the source is pending', async () => {
    const source = sourceAt(aliceToAct());
    render(source);
    await click('deck-pile');
    const confirm = q('staging-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    source.pending = true;
    await settle();
    expect((q('staging-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(q('board')?.getAttribute('data-inert')).toBe('true');
    (q('staging-confirm') as HTMLButtonElement).click();
    await settle();
    expect(source.applied).toEqual([]);

    source.pending = false;
    await settle();
    expect((q('staging-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(q('board')?.getAttribute('data-inert')).toBe('false');
  });

  it('a double Confirm applies once, and nothing new can be staged until the state arrives', async () => {
    const source = sourceAt(aliceToAct());
    render(source);
    await click('deck-pile');
    const confirm = q('staging-confirm') as HTMLButtonElement;
    confirm.click();
    confirm.click();
    await settle();
    expect(source.applied).toEqual([0]);
    expect(source.pending).toBe(true);

    // The send has settled but the state has not come back: the old
    // position is still on show and must not take a second move.
    await click('deck-pile');
    expect(q('staging-confirm')).toBeNull();
    await click('deck-pile');
    expect(source.applied).toEqual([0]);

    // The new state arrives; the board takes moves again.
    const after = aliceToAct();
    after.seq = 1;
    after.history = [appliedMove({ by: 0, kind: Kind.Draw, seq: 1, index: 0 })];
    source.respond(after);
    await settle();
    expect(q('board')?.getAttribute('data-inert')).toBe('false');
    await click('deck-pile');
    expect((q('staging-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('holds Confirm disabled while an on-state apply is in flight, then clears', async () => {
    const source = sourceAt(aliceToAct(), 'on-state');
    render(source);
    await click('deck-pile');
    (q('staging-confirm') as HTMLButtonElement).click();
    await settle();
    expect(source.applied).toEqual([0]);
    const inFlight = q('staging-confirm') as HTMLButtonElement | null;
    // Either the bar is still up and disabled, or it is gone; never live.
    if (inFlight !== null) expect(inFlight.disabled).toBe(true);
    (inFlight ?? document.body).click();
    await settle();
    expect(source.applied).toEqual([0]);

    const after = aliceToAct();
    after.seq = 1;
    after.history = [appliedMove({ by: 0, kind: Kind.Draw, seq: 1, index: 0 })];
    source.respond(after);
    await settle();
    expect(q('staging-confirm')).toBeNull();
    expect(q('board')?.getAttribute('data-inert')).toBe('false');
  });

  it('the counter prompt sends nothing while the source is pending', async () => {
    const source = sourceAt(
      envelope({
        state: aliceView({ active: 0, phase: Phase.AwaitingCounter, you: { hand: [TWO], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
        legalMoves: [mv({ Kind: Kind.Counter, HandIndex: 0, Card: TWO }), mv({ Kind: Kind.Decline })],
        descriptions: ['counter with two', 'decline'],
        history: [appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: FOUR, description: 'play 4♣ as one-off' })],
      }),
    );
    source.curtain = { kind: 'ack', to: 0 };
    source.pending = true;
    render(source);
    expect(q('counter-prompt')).not.toBeNull();
    await click('counter-resolve');
    expect(source.applied).toEqual([]);
  });
});

describe('W10: pending blocks the 7 tray too', () => {
  // The 7's revealed cards call GameScreen's tap handler directly, not
  // through Board's inert wrapper, so this reaches the handler's own guard.
  const EIGHT_D = { Rank: 8, Suit: 1 } as const;
  function sevenEnvelope(): Envelope {
    return envelope({
      state: aliceView({
        phase: Phase.SevenChoosing,
        sevenRevealed: [EIGHT_D],
        pending: { playedBy: 0, card: { Rank: 7, Suit: 2 }, target: null, counterChain: [] },
      }),
      legalMoves: [mv({ Kind: Kind.SevenPick, Card: EIGHT_D, SubMove: mv({ Kind: Kind.PlayPoint, Card: EIGHT_D }) })],
      descriptions: ['7: play 8♦ as point card'],
    });
  }

  it('a revealed card selects when idle', async () => {
    render(sourceAt(sevenEnvelope()));
    await click('seven-card-0');
    expect(q('zone-points')?.dataset.state).toBe('highlighted');
  });

  it('a revealed card takes no tap while a move is in flight', async () => {
    const source = sourceAt(sevenEnvelope());
    source.pending = true;
    render(source);
    await click('seven-card-0');
    expect(q('zone-points')?.dataset.state).not.toBe('highlighted');
  });
});

describe('W10: an unasked state (the opponent moved)', () => {
  it('updates the board and hands the turn over', async () => {
    const waiting = envelope({ state: aliceView({ active: 1 }), legalMoves: [], descriptions: [] });
    const source = sourceAt(waiting);
    render(source);
    await click('deck-pile');
    expect(q('staging-confirm')).toBeNull();

    const history = [appliedMove({ by: 1, kind: Kind.PlayPoint, seq: 1, card: SEVEN, description: 'play 7♦ as point card' })];
    const moved = envelope({
      state: aliceView({ opponent: { handCount: 3, hand: null, points: [point(SEVEN, 1)], permanents: [] } }),
      legalMoves: aliceToAct().legalMoves,
      descriptions: aliceToAct().descriptions,
      history,
    });
    source.push(moved);
    await settle();

    const line = lastMoveLine(history, 0, session.names);
    expect(line).not.toBe('');
    expect(host?.textContent).toContain(line);
    await click('deck-pile');
    expect(q('staging-confirm')).not.toBeNull();
  });

  it('clears a staged move when a new state arrives', async () => {
    const source = sourceAt(aliceToAct());
    render(source);
    await click('deck-pile');
    expect(q('staging-confirm')).not.toBeNull();
    const next = aliceToAct();
    next.seq = 1;
    next.history = [appliedMove({ by: 1, kind: Kind.Draw, seq: 1 })];
    source.push(next);
    await settle();
    expect(q('staging-confirm')).toBeNull();
  });
});

describe('W10: a late answer after unmount', () => {
  it('a state that arrives after GameScreen unmounts does not throw', async () => {
    const source = sourceAt(aliceToAct(), 'on-state');
    render(source);
    await click('deck-pile');
    (q('staging-confirm') as HTMLButtonElement).click();
    await settle();
    cleanup();
    const after = aliceToAct();
    after.seq = 1;
    expect(() => source.respond(after)).not.toThrow();
    await settle();
    expect(source.applied).toEqual([0]);
  });

  it('a failure that arrives after unmount is reported, not thrown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const source = sourceAt(aliceToAct(), 'on-state');
      render(source);
      await click('deck-pile');
      (q('staging-confirm') as HTMLButtonElement).click();
      await settle();
      cleanup();
      source.fail(new Error('socket closed'));
      await settle();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('W10: the key guard still blocks held keys', () => {
  it('an auto-repeated Enter cannot fire Confirm; a fresh press can', async () => {
    const source = sourceAt(aliceToAct());
    render(source);
    await click('deck-pile');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    (q('staging-confirm') as HTMLButtonElement).click();
    flushSync();
    expect(source.applied).toEqual([]);
    expect(q('staging-confirm')).not.toBeNull();

    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: false }));
    (q('staging-confirm') as HTMLButtonElement).click();
    await settle();
    expect(source.applied).toEqual([0]);
  });
});
