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
  instance = mount(GameScreen, { target: host, props: { source: game } });
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

/** A pointer tap: the press lands on `id` first, then the click (SPEC §4.7: a lift alone never continues). */
async function tap(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
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

const TWO_C: Card = { Rank: 2, Suit: 0 };

/** Alice plays the 5 through the UI; Blake holds a 2, so the engine opens his counter window. */
async function alicePlaysFiveIntoWindow(): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, aliceOpening(), { seed: '1' });
  const el = render();
  const played = fiveEntry(null, true);
  bridge.apply.mockImplementation(
    (): BridgeResult =>
      envelope({ state: playerView({ viewer: 0, active: 1, phase: Phase.AwaitingCounter, you: you([KING]), opponent: opp(2) }), lastMove: played, history: [played] }),
  );
  await click(el, 'hand-card-0');
  await click(el, 'zone-oneoff');
  await click(el, 'staging-confirm');
  return el;
}

/**
 * From `alicePlaysFiveIntoWindow`: the phone goes to Blake, whose counter
 * prompt comes straight after the gate; he lets it resolve, so the 5 draws
 * on HIS apply and his own turn follows with no curtain. Returns the
 * history as Blake's board holds it.
 */
async function blakeLetsItResolve(el: HTMLElement): Promise<AppliedMove[]> {
  const five = fiveEntry(null, false);
  bridge.view.mockImplementation(
    (): BridgeResult =>
      envelope({
        state: playerView({ viewer: 1, active: 1, phase: Phase.AwaitingCounter, you: you([B_CARD, TWO_C]), opponent: opp(1), pending: { playedBy: 0, card: FIVE, target: null, counterChain: [] } }),
        history: [five],
        legalMoves: [mv({ Kind: Kind.Decline }), mv({ Kind: Kind.Counter, Card: TWO_C, HandIndex: 1 })],
        descriptions: ['decline', 'counter with 2♣'],
      }),
  );
  await passThePhone(el);
  expect(q(el, 'counter-prompt')).not.toBeNull();
  const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2, description: 'decline', drawn: 2 });
  bridge.apply.mockImplementation(
    (): BridgeResult =>
      envelope({
        state: playerView({ viewer: 1, active: 1, you: you([B_CARD, TWO_C]), opponent: opp(3) }),
        lastMove: { ...decline, index: 0 },
        history: [five, { ...decline, index: 0 }],
        legalMoves: [mv({ Kind: Kind.Draw })],
        descriptions: ['draw a card'],
      }),
  );
  await click(el, 'counter-resolve');
  return [five, decline];
}

/** From Blake's board: he draws, and the phone comes back to Alice's next board. */
async function blakeDrawsBackToAlice(el: HTMLElement, before: AppliedMove[]): Promise<void> {
  const blakeDraw = appliedMove({ by: 1, kind: Kind.Draw, seq: 3, description: 'draw a card' });
  bridge.apply.mockImplementation(
    (): BridgeResult => envelope({ state: playerView({ viewer: 1, active: 0, you: you([B_CARD, B_CARD]), opponent: opp(3) }), lastMove: { ...blakeDraw, index: 0 }, history: [...before, { ...blakeDraw, index: 0 }] }),
  );
  await click(el, 'deck-pile');
  await click(el, 'staging-confirm');
  expectNoDrawnCards(el, 'handoff to Alice');
  const history = [...before, blakeDraw];
  bridge.view.mockImplementation(
    (): BridgeResult => envelope({ state: playerView({ viewer: 0, active: 0, you: you([KING, D1, D2]), opponent: opp(2) }), history, legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
  );
  await passThePhone(el);
}

/** handoff -> reveal -> recap -> next, through the two-step pill and the recap button. */
async function passThePhone(el: HTMLElement): Promise<void> {
  await click(el, 'reveal-two-step');
  await click(el, 'reveal-two-step');
  if (q(el, 'recap') !== null) await click(el, 'recap-dismiss');
}

// ---------------------------------------------------------------------------
// Before the pass (Blake holds no 2: no counter window, §4.3 ruling 2026-09-29)
// ---------------------------------------------------------------------------

describe('before the pass: the drawer\'s screen, then the handoff', () => {
  it('ruling 2026-09-29: Blake holding cards but no 2 changes nothing: the reveal comes first, then the pass', async () => {
    const el = await alicePlaysFive(3);
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'counter-prompt')).toBeNull();
    await click(el, 'draw-reveal-continue');
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expect(game.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expectNoDrawnCards(el, 'turn handoff');
  });

  it('the drawn cards show face up; the board and the curtain are not in the DOM', async () => {
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

  it('privacy: ONLY the drawn cards, never the rest of the hand, while the phone is about to change hands', async () => {
    const el = await alicePlaysFive(0);
    const panel = q(el, 'draw-reveal')!;
    const slots = [...panel.querySelectorAll<HTMLElement>('[data-draw-slot]')];
    expect(slots.length).toBe(2);
    expect(slots.map((s) => s.dataset.drawn)).toEqual(['true', 'true']);
    // Alice's kept King is nowhere on the screen, in any form.
    expectNoLeak(el, [KING], 'before-the-pass reveal');
  });

  it('privacy: the gate itself, even if the store paired a before-the-pass reveal with more indices', async () => {
    const el = await alicePlaysFive(0);
    game.drawReveal = { to: 0, indices: [2], beforePass: true };
    await settle();
    const slots = [...q(el, 'draw-reveal')!.querySelectorAll<HTMLElement>('[data-draw-slot]')];
    expect(slots.length).toBe(1);
    expect(squashed(slots[0])).toContain(label(D2).toLowerCase());
    expectNoLeak(el, [KING, D1], 'before-the-pass reveal, one index');
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
    await tap(el, 'draw-reveal');
    expect(q(el, 'curtain-gate')).not.toBeNull();
  });

  it('a finger still down from Confirm (its lift, with no press on the reveal) does not skip it', async () => {
    const el = await alicePlaysFive(0);
    const panel = q(el, 'draw-reveal')!;
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    q(el, 'draw-reveal-continue')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await settle();
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'curtain-gate')).toBeNull();
  });

  it('the game menu pauses the 3 s wait; closing it resumes with the time left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const el = await alicePlaysFive(0);
    vi.advanceTimersByTime(1000);
    await click(el, 'menu-button');
    expect(q(el, 'game-menu')).not.toBeNull();
    vi.advanceTimersByTime(DRAW_REVEAL_MS * 5);
    await settle();
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'curtain-gate')).toBeNull();
    await click(el, 'menu-close');
    expect(q(el, 'game-menu')).toBeNull();
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 1000 - 1);
    await settle();
    expect(q(el, 'draw-reveal')).not.toBeNull();
    vi.advanceTimersByTime(1);
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expectNoDrawnCards(el, 'handoff after a paused reveal');
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
// Counter window: Blake holds a 2 and lets it resolve; the draw waits for
// Alice's next own view
// ---------------------------------------------------------------------------

describe('when Blake can answer (he holds a 2): no reveal before the pass', () => {
  it('Alice\'s screen goes straight to the counter handoff: no reveal, no drawn card anywhere', async () => {
    const el = await alicePlaysFiveIntoWindow();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'curtain-gate')).not.toBeNull();
    expect(game.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'counter' });
    expectNoDrawnCards(el, 'counter handoff');
  });

  it('Blake\'s prompt and board carry no reveal and no drawn card; Alice\'s next board shows them', async () => {
    const el = await alicePlaysFiveIntoWindow();
    const before = await blakeLetsItResolve(el);
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'draw-reveal')).toBeNull();
    expectNoDrawnCards(el, 'Blake\'s board');
    await blakeDrawsBackToAlice(el, before);
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'board')).toBeNull();
    // Her own screen, after the pass: the whole hand, the drawn cards marked.
    const slots = [...q(el, 'draw-reveal')!.querySelectorAll<HTMLElement>('[data-draw-slot]')];
    expect(slots.map((s) => s.dataset.drawn)).toEqual(['false', 'true', 'true']);
    expect(squashed(slots[0])).toContain(label(KING).toLowerCase());
    await click(el, 'draw-reveal-continue');
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'board')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The counter window as Alice's first own view
// ---------------------------------------------------------------------------

describe('at Alice\'s counter window the reveal comes before the prompt', () => {
  async function toAliceAck(): Promise<HTMLDivElement> {
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
          state: playerView({ viewer: 1, active: 0, phase: Phase.AwaitingCounter, you: you([]), opponent: opp(3) }),
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
            phase: Phase.AwaitingCounter,
            you: you([KING, D1, D2]),
            opponent: opp(0),
            pending: { playedBy: 1, card: SIX, target: null, counterChain: [] },
          }),
          history,
          legalMoves: [mv({ Kind: Kind.Counter, Card: { Rank: 2, Suit: 3 }, HandIndex: 1 }), mv({ Kind: Kind.Decline })],
          descriptions: ['counter with 2♠', 'decline'],
        }),
    );
    await passThePhone(el);
    return el;
  }

  it('the reveal is up first, and the prompt is not', async () => {
    const el = await toAliceAck();
    expect(q(el, 'draw-reveal')).not.toBeNull();
    expect(q(el, 'counter-prompt')).toBeNull();
  });

  it('continuing shows the counter prompt', async () => {
    const el = await toAliceAck();
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
    const el = await alicePlaysFiveIntoWindow(); // the counter handoff to Blake is up
    game.drawReveal = { to: 0, indices: [0], beforePass: false };
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
    game.drawReveal = { to: 0, indices: [0], beforePass: false };
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'board')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Focus: the board's keyboard rescue and the reveal's Continue
// ---------------------------------------------------------------------------

describe('focus around the reveal at Alice\'s next board (keyboard)', () => {
  /** Alice's 5 into Blake's window; he lets it resolve and draws; the phone comes back to Alice. */
  async function toAliceNextBoardReveal(): Promise<HTMLDivElement> {
    const el = await alicePlaysFiveIntoWindow();
    const before = await blakeLetsItResolve(el);
    await blakeDrawsBackToAlice(el, before);
    return el;
  }

  it('Continue keeps focus while the reveal is up: the board\'s focus rescue does not take it', async () => {
    const el = await toAliceNextBoardReveal();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await settle();
    await settle();
    expect(document.activeElement).toBe(q(el, 'draw-reveal-continue'));
  });

  it('Enter on Continue brings the board with focus on it, not on the page body', async () => {
    const el = await toAliceNextBoardReveal();
    const cont = q(el, 'draw-reveal-continue')!;
    const down = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    cont.dispatchEvent(down);
    cont.click(); // the click a browser fires on a fresh Enter keydown
    await settle();
    await settle();
    expect(q(el, 'draw-reveal')).toBeNull();
    expect(q(el, 'board')).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(el.contains(document.activeElement)).toBe(true);
  });
});
