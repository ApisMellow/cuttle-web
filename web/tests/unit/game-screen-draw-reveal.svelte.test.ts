// @vitest-environment jsdom
// Issue #27 — GameScreen's draw reveal (SPEC §4.7), strict tier. ONE
// mounted GameScreen per test, driven through the real `game`/`session`
// singletons; only the `lib/bridge/engine` calls are faked, so every step
// runs the store's real apply/advanceCurtain code.
//
// Privacy: the drawn cards are in the DOM only on the drawer's own screen.
// The handoff that follows, and every screen of the opponent's, carries no
// form of them (text, markup, attribute or accessible name).
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, BridgeResult, Card, Envelope, Move, PlayerView } from '../../src/lib/bridge/schema';
import { DRAW_REVEAL_MS } from '../../src/lib/drawReveal';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';
import { expectNoLeak, label } from './glasses-leak-scan';

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
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');

// ---------------------------------------------------------------------------
// Fixtures: Alice (P0) plays 5♥; she draws 9♠ and Q♦. Blake (P1) holds 4♣.
// ---------------------------------------------------------------------------

const FIVE: Card = { Rank: 5, Suit: 2 };
const SIX: Card = { Rank: 6, Suit: 0 };
const KING: Card = { Rank: 13, Suit: 0 };
const D1: Card = { Rank: 9, Suit: 3 };
const D2: Card = { Rank: 12, Suit: 1 };
const B_CARD: Card = { Rank: 4, Suit: 0 };

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

function you(hand: Card[]): PlayerView['you'] {
  return { hand, frozenHandIndices: [], points: [], permanents: [], watched: false };
}

function opp(handCount: number): PlayerView['opponent'] {
  return { handCount, hand: null, points: [], permanents: [] };
}

const FIVE_DESC = 'play 5♥ as one-off';
const SIX_DESC = 'play 6♣ as one-off';

function fiveEntry(drawn: number | null, withIndex: boolean): AppliedMove {
  return appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: FIVE, description: FIVE_DESC, drawn, ...(withIndex ? { index: 0 } : {}) });
}

function aliceOpening(): Envelope {
  return envelope({
    state: playerView({ viewer: 0, active: 0, you: you([FIVE, KING]), opponent: opp(1) }),
    legalMoves: [mv({ Kind: Kind.OneOff, Card: FIVE, HandIndex: 0 })],
    descriptions: [FIVE_DESC],
  });
}

function blakeBoard(history: AppliedMove[]): Envelope {
  return envelope({
    state: playerView({ viewer: 1, active: 1, you: you([B_CARD]), opponent: opp(3) }),
    history,
    legalMoves: [mv({ Kind: Kind.Draw })],
    descriptions: ['draw a card'],
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  game.goHome();
  game.error = null;
  game.lastSeenSeq = { 0: 0, 1: 0 };
  session.setNames('Alice', 'Blake');
  session.lastDealer = null;
  settings.revealPreference = 'two-step';
  settings.reducedMotion = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  await settle();
}

/** Text with whitespace removed, so a face's "9" + "♠" spans read as "9♠". */
function squashed(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, '').toLowerCase();
}

function expectNoDrawnCards(el: HTMLElement, where: string): void {
  expectNoLeak(el, [D1, D2], where);
  for (const c of [D1, D2]) expect(squashed(el).includes(label(c).toLowerCase()), `${where}: ${label(c)} in the text`).toBe(false);
}

/** Alice plays the 5 through the UI; `blakeCards` is Blake's hand count after it. */
async function alicePlaysFive(blakeCards: number): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, aliceOpening(), { seed: '1' });
  const el = render();
  const played = fiveEntry(2, true);
  bridge.apply.mockImplementation(
    (): BridgeResult => envelope({ state: playerView({ viewer: 0, active: 1, you: you([KING, D1, D2]), opponent: opp(blakeCards) }), lastMove: played, history: [played] }),
  );
  await click(el, 'hand-card-0');
  await click(el, 'zone-oneoff');
  await click(el, 'staging-confirm');
  return el;
}

/** handoff -> reveal -> recap -> next, through the two-step pill and the recap button. */
async function passThePhone(el: HTMLElement): Promise<void> {
  await click(el, 'reveal-two-step');
  await click(el, 'reveal-two-step');
  if (q(el, 'recap') !== null) await click(el, 'recap-dismiss');
}

// ---------------------------------------------------------------------------
// Before the pass (Blake holds no cards: no ack to disguise, §4.3)
// ---------------------------------------------------------------------------

describe('before the pass: the drawer\'s screen, then the handoff', () => {
  it('the drawn cards show face up in the drawer\'s hand; the board and the curtain are not in the DOM', async () => {
    const el = await alicePlaysFive(0);
    const panel = q(el, 'draw-reveal');
    expect(panel).not.toBeNull();
    expect(squashed(panel!)).toContain(label(D1).toLowerCase());
    expect(squashed(panel!)).toContain(label(D2).toLowerCase());
    expect(panel!.querySelectorAll('[data-draw-slot][data-drawn="true"]').length).toBe(2);
    expect(q(el, 'board')).toBeNull();
    expect(q(el, 'curtain')).toBeNull();
    expect(panel!.textContent).toContain('You drew 2 cards');
  });

  it('Continue brings the pass screen, and it holds no form of the drawn cards', async () => {
    const el = await alicePlaysFive(0);
    await click(el, 'draw-reveal-continue');
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expect(q(el, 'curtain-gate')!.textContent).toContain('Blake');
    expectNoDrawnCards(el, 'handoff after the reveal');
  });

  it('after 3 seconds with no tap, the pass screen comes up on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const el = await alicePlaysFive(0);
    expect(q(el, 'draw-reveal')).not.toBeNull();
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 1);
    await settle();
    expect(q(el, 'draw-reveal')).not.toBeNull();
    vi.advanceTimersByTime(1);
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expectNoDrawnCards(el, 'handoff after the timer');
  });

  it('a tap anywhere on the reveal continues too', async () => {
    const el = await alicePlaysFive(0);
    await click(el, 'draw-reveal');
    expect(q(el, 'curtain-gate')).not.toBeNull();
  });

  it('Blake\'s screens after the pass (gate, board) never carry the drawn cards or a reveal', async () => {
    const el = await alicePlaysFive(0);
    await click(el, 'draw-reveal-continue');
    bridge.view.mockImplementation((): BridgeResult => blakeBoard([fiveEntry(2, false)]));
    await click(el, 'reveal-two-step');
    expectNoDrawnCards(el, 'Blake\'s reveal gate');
    await click(el, 'reveal-two-step');
    expectNoDrawnCards(el, 'Blake\'s recap');
    if (q(el, 'recap') !== null) await click(el, 'recap-dismiss');
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'draw-reveal')).toBeNull();
    expectNoDrawnCards(el, 'Blake\'s board');
  });

  it('reduced motion: the panel says so and shows the faces without the face-down stage', async () => {
    settings.reducedMotion = true;
    const el = await alicePlaysFive(0);
    expect(q(el, 'draw-reveal')?.dataset.motion).toBe('reduced');
    expect(el.querySelector('[data-draw-back]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic ack: nothing before the pass; the draw waits for Alice's next view
// ---------------------------------------------------------------------------

describe('when the 5 could still be answered: no reveal before the pass (R14)', () => {
  it('Alice\'s screen goes straight to the ack handoff: no reveal, no drawn card anywhere', async () => {
    const el = await alicePlaysFive(3);
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expectNoDrawnCards(el, 'ack handoff');
  });

  it('Blake\'s ack and board carry no reveal and no drawn card; Alice\'s next board shows them', async () => {
    const el = await alicePlaysFive(3);
    const five = fiveEntry(2, false);
    bridge.view.mockImplementation((): BridgeResult => blakeBoard([five]));
    await passThePhone(el);
    expect(q(el, 'counter-prompt')).not.toBeNull();
    expect(q(el, 'draw-reveal')).toBeNull();
    expectNoDrawnCards(el, 'Blake\'s ack');
    await click(el, 'counter-resolve');
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'draw-reveal')).toBeNull();
    expectNoDrawnCards(el, 'Blake\'s board');

    const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 2, index: 0, description: 'draw a card' });
    bridge.apply.mockImplementation(
      (): BridgeResult => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(3) }), lastMove: blakeDraw, history: [five, blakeDraw] }),
    );
    await click(el, 'deck-pile');
    await click(el, 'staging-confirm');
    expectNoDrawnCards(el, 'handoff to Alice');
    const history = [five, appliedMove({ by: 1, kind: Kind.Draw, seq: 2, description: 'draw a card' })];
    bridge.view.mockImplementation(
      (): BridgeResult => envelope({ state: playerView({ viewer: 0, active: 0, you: you([KING, D1, D2]), opponent: opp(2) }), history, legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    await passThePhone(el);
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'board')).toBeNull();
    await click(el, 'draw-reveal-continue');
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'board')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ack as Alice's first own view: the same reveal on both R14 paths
// ---------------------------------------------------------------------------

describe('R14: at Alice\'s ack the reveal is identical on the real window and the synthetic ack', () => {
  async function toAliceAck(real: boolean): Promise<{ el: HTMLDivElement; html: string }> {
    const five = fiveEntry(2, false);
    const opening = envelope({
      state: playerView({ viewer: 1, active: 1, you: you([SIX]), opponent: opp(3) }),
      history: [five],
      legalMoves: [mv({ Kind: Kind.OneOff, Card: SIX, HandIndex: 0 })],
      descriptions: [SIX_DESC],
    });
    await startGameMocked(game, bridge, opening, { seed: '2' });
    const el = render();
    const six = appliedMove({ by: 1, kind: Kind.OneOff, seq: 2, card: SIX, description: SIX_DESC, index: 0 });
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: playerView({ viewer: 1, active: 0, phase: real ? Phase.AwaitingCounter : Phase.Normal, you: you([]), opponent: opp(3) }),
          lastMove: six,
          history: [five, six],
        }),
    );
    await click(el, 'hand-card-0');
    await click(el, 'zone-oneoff');
    await click(el, 'staging-confirm');
    expectNoDrawnCards(el, 'handoff to Alice');
    const history = [five, appliedMove({ by: 1, kind: Kind.OneOff, seq: 2, card: SIX, description: SIX_DESC })];
    bridge.view.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: playerView({
            viewer: 0,
            active: 0,
            phase: real ? Phase.AwaitingCounter : Phase.Normal,
            you: you([KING, D1, D2]),
            opponent: opp(0),
            pending: real ? { playedBy: 1, card: SIX, target: null, counterChain: [] } : null,
          }),
          history,
          legalMoves: real ? [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 3 }, HandIndex: 1 }), mv({ Kind: Kind.Decline })] : [],
          descriptions: real ? ['counter with 2♠', 'decline'] : [],
        }),
    );
    await passThePhone(el);
    const panel = q(el, 'draw-reveal');
    expect(panel, `${real ? 'real' : 'synthetic'}: reveal at the ack`).not.toBeNull();
    expect(q(el, 'counter-prompt')).toBeNull();
    // `$props.id()` differs per mount; everything else must match.
    const html = panel!.outerHTML.replace(/(id|aria-labelledby)="[^"]*"/g, '$1=""');
    return { el, html };
  }

  it('the reveal comes before the counter prompt, with the same markup on both paths', async () => {
    const real = await toAliceAck(true);
    cleanup();
    game.goHome();
    const synthetic = await toAliceAck(false);
    expect(synthetic.html).toBe(real.html);
  });

  it('continuing shows the counter prompt', async () => {
    const { el } = await toAliceAck(true);
    await click(el, 'draw-reveal-continue');
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'counter-prompt')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The integrator's own gate (defense in depth, SPEC §4.7)
// ---------------------------------------------------------------------------

describe('GameScreen renders a reveal only on its drawer\'s own view', () => {
  it('not behind a withheld curtain, even if the store held one', async () => {
    const el = await alicePlaysFive(3); // ack handoff to Blake is up
    game.drawReveal = { to: 0, indices: [0] };
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
  });

  it('not on another player\'s view, even if the store held one', async () => {
    const el = await alicePlaysFive(0);
    await click(el, 'draw-reveal-continue');
    bridge.view.mockImplementation((): BridgeResult => blakeBoard([fiveEntry(2, false)]));
    await passThePhone(el);
    expect(game.viewer).toBe(1);
    game.drawReveal = { to: 0, indices: [0] };
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'board')).not.toBeNull();
  });
});
