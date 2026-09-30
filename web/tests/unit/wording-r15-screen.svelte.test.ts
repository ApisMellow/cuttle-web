// @vitest-environment jsdom
// Playtest 2026-09-29 wording round (loop r15), wired into the real
// GameScreen / StagingStore: a blocked card or tap says why, the discard
// picker's centre line names the 4, and the counter prompt names what each
// 2 stops. Light tier for the look; the reasons read public state only, and
// the privacy check below proves the opponent's hand never reaches them.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Envelope, Move, PlayerView } from '../../src/lib/bridge/schema';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';

const bridge = vi.hoisted(() => ({
  newGame: vi.fn(),
  apply: vi.fn(),
  view: vi.fn(),
  snapshot: vi.fn(() => '"fake-engine-state"'),
  restore: vi.fn(),
  legalMoves: vi.fn(),
  describe: vi.fn(),
}));

vi.mock('../../src/lib/bridge/engine', () => bridge);

const { default: GameScreen } = await import('../../src/lib/components/GameScreen.svelte');
const { default: CounterPrompt } = await import('../../src/lib/components/CounterPrompt.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

const c = (Rank: Card['Rank'], Suit: Card['Suit'] = 0): Card => ({ Rank, Suit });

// Blake's hand is visible to the store (glasses-style) so a leak would show.
const BLAKE_HAND = [c(2, 1), c(5, 2)];

function view(overrides: Partial<PlayerView>): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    opponent: { handCount: 2, hand: [...BLAKE_HAND], points: [], permanents: [] },
    ...overrides,
  });
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  game.envelope = null;
  game.history = [];
  game.seq = 0;
  game.viewer = null;
  game.curtain = { kind: 'none' };
  game.lastSeenSeq = { 0: 0, 1: 0 };
  game.error = null;
  game.screen = 'home';
  game.notice = null;
  session.setNames('Alice', 'Blake');
  session.lastDealer = null;
  settings.revealPreference = 'two-step';
});

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function start(env: Envelope): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, env, { seed: '1' });
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: game } });
  flushSync();
  return host;
}

function reason(el: HTMLElement): string | null {
  return el.querySelector('[data-blocked-reason]')?.textContent ?? null;
}

describe('blocked cards and taps give a reason (public state only)', () => {
  it('a Jack facing their Queen: the popover says the Queen protects their cards', async () => {
    const state = view({
      you: { hand: [c(7), c(11, 0)], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 2, hand: [...BLAKE_HAND], points: [{ Card: c(9, 3), Owner: 1, JackStack: [], JackOwners: [], Controller: 1 }], permanents: [c(12, 3)] },
    });
    const el = await start(envelope({ state, legalMoves: [mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: c(7) })], descriptions: ['play 7♣ as point card'] }));
    await click(el, 'hand-card-1');
    const popover = q(el, 'card-detail-popover')!;
    expect(popover.textContent).toContain('Their Queen protects their cards from your Jack.');
    expect(popover.textContent).not.toContain('No legal moves');
    // Blake's hand (2♦, 5♥) never reaches the popover.
    expect(popover.innerHTML).not.toContain('♦');
    expect(popover.innerHTML).not.toContain('♥');
  });

  it('after selecting a card, the no-moves popover leaves no zone lit', async () => {
    const state = view({ you: { hand: [c(7), c(11, 1)], frozenHandIndices: [], points: [], permanents: [], watched: false } });
    const el = await start(envelope({ state, legalMoves: [mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: c(7) })], descriptions: ['play 7♣ as point card'] }));
    await click(el, 'hand-card-0');
    expect(q(el, 'zone-points')).not.toBeNull();
    await click(el, 'hand-card-1');
    expect(q(el, 'card-detail-popover')).not.toBeNull();
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-state="highlighted"]')).toBeNull();
  });

  it('the disabled deck with 8 cards says the hand is full; the next tap clears it', async () => {
    const hand = Array.from({ length: 8 }, (_, i) => c(10, (i % 4) as Card['Suit']));
    const state = view({ you: { hand, frozenHandIndices: [], points: [], permanents: [], watched: false } });
    const el = await start(envelope({ state, legalMoves: [mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: hand[0] })], descriptions: ['play 10♣ as point card'] }));
    await click(el, 'deck-pile');
    expect(reason(el)).toBe('Your hand is full (8 cards).');
    await click(el, 'hand-card-0');
    expect(reason(el)).toBeNull();
  });

  it('a 9 tapped onto a card their Queen protects says so, instead of silently doing nothing', async () => {
    const state = view({
      you: { hand: [c(9, 3)], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 2, hand: [...BLAKE_HAND], points: [], permanents: [c(12, 2), c(13, 1)] },
    });
    const moves = [
      mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: c(9, 3) }),
      mv({ Kind: Kind.OneOff, HandIndex: 0, Card: c(9, 3), Target: { Owner: 1, Zone: 1, Index: 0 } }),
    ];
    const el = await start(envelope({ state, legalMoves: moves, descriptions: ['play 9♠ as point card', 'play 9♠ as one-off'] }));
    await click(el, 'hand-card-0');
    await click(el, 'perm-1-1'); // the King: not lit
    expect(reason(el)).toBe('Their Queen protects that card from your 9.');
    expect(q(el, 'staging-bar')).toBeNull();
    // The Queen itself is a target and stages with its name.
    await click(el, 'hand-card-0');
    expect(reason(el)).toBeNull();
    await click(el, 'perm-1-0');
    expect(q(el, 'staging-bar')?.textContent).toContain('Play 9♠: send Q♥ back to their hand; they can’t play it next turn.');
  });
});

describe('(review B1, privacy) a reason never survives a curtain', () => {
  it('Alice\'s "Queen protects … from your 9" is gone when Blake\'s board comes up', async () => {
    const state = view({
      you: { hand: [c(9, 3)], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 2, hand: [...BLAKE_HAND], points: [], permanents: [c(12, 2), c(13, 1)] },
    });
    const moves = [
      mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: c(9, 3) }),
      mv({ Kind: Kind.OneOff, HandIndex: 0, Card: c(9, 3), Target: { Owner: 1, Zone: 1, Index: 0 } }),
    ];
    const el = await start(envelope({ state, legalMoves: moves, descriptions: ['play 9♠ as point card', 'play 9♠ as one-off'] }));
    await click(el, 'hand-card-0');
    await click(el, 'perm-1-1');
    expect(reason(el)).toBe('Their Queen protects that card from your 9.');

    // The phone goes to Blake: a curtain, then Blake's own board. Same
    // GameScreen instance throughout.
    game.curtain = { kind: 'handoff', to: 1, reason: 'turn' };
    flushSync();
    await tick();
    const blake = playerView({
      viewer: 1,
      active: 1,
      phase: Phase.Normal,
      you: { hand: [c(4, 1)], frozenHandIndices: [], points: [], permanents: [c(12, 2), c(13, 1)], watched: false },
      opponent: { handCount: 1, hand: null, points: [], permanents: [] },
    });
    game.envelope = envelope({ state: blake, legalMoves: [mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: c(4, 1) })], descriptions: ['play 4♦ as point card'] });
    game.viewer = 1;
    game.seq = game.seq + 1;
    game.curtain = { kind: 'none' };
    flushSync();
    await tick();
    flushSync();
    expect(q(el, 'board')).not.toBeNull();
    expect(el.querySelector('[data-blocked-reason]')).toBeNull();
    expect(el.textContent).not.toContain('from your 9');
  });
});

describe('discard picker centre line', () => {
  it('names the 4 and how many to choose', async () => {
    const hand = [c(3), c(6), c(10)];
    const state = view({ phase: Phase.AwaitingDiscard, you: { hand, frozenHandIndices: [], points: [], permanents: [], watched: false } });
    const moves = [mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 1 }), mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 2 }), mv({ Kind: Kind.DiscardPair, DiscardA: 1, DiscardB: 2 })];
    const history = [appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: c(4, 3), description: 'play 4♠ as one-off' })];
    const el = await start(envelope({ state, legalMoves: moves, descriptions: moves.map(() => 'discard'), history }));
    expect(q(el, 'discard-picker')).not.toBeNull();
    expect(q(el, 'center-zone')?.textContent).toContain("Blake's 4♠: choose 2 to discard.");
  });
});

describe('counter prompt names what each 2 stops', () => {
  it('the same lines with and without counter options (R14)', () => {
    const entries = [
      appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: c(5, 2), description: 'play 5♥ as one-off' }),
      appliedMove({ by: 1, kind: Kind.Counter, seq: 2, card: c(2, 0), description: 'counter with 2♣' }),
    ];
    const texts: string[] = [];
    for (const options of [[], [{ index: 1, description: 'counter with 2♦' }]]) {
      const h = document.createElement('div');
      document.body.append(h);
      const inst = mount(CounterPrompt, { target: h, props: { entries, viewer: 0, names: ['Alice', 'Blake'] as const, options, onresolve: () => {}, oncounter: () => {} } });
      flushSync();
      texts.push([...h.querySelectorAll('.counter-prompt__text')].map((n) => n.textContent).join('|'));
      unmount(inst);
      h.remove();
    }
    expect(texts[0]).toBe('You played 5♥ as a one-off to draw 2 cards.|Blake countered with 2♣ to stop your 5♥.');
    expect(texts[1]).toBe(texts[0]);
  });
});
