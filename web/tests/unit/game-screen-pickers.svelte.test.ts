// @vitest-environment jsdom
// P2 W15 — DiscardPicker (R15), SevenRevealPanel (R16) and ScrapBrowser (R6)
// wired into GameScreen. ONE mounted GameScreen per test, the real
// `game`/`session` singletons and StagingStore; only `lib/bridge/engine` is
// faked, so every apply and curtain step runs the store's real code.
//
// Strict tier: rules wiring (every Confirm applies the exact engine index for
// what was tapped) and privacy (the 7's revealed cards never reach the DOM
// for anyone but the acting player, at curtain `none`).
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Card, Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
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
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');
const { settings } = await import('../../src/lib/stores/settings.svelte');

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

function point(card: Card, owner: PlayerId): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const FOUR_D: Card = { Rank: 4, Suit: 1 };
const FIVE_S: Card = { Rank: 5, Suit: 3 };
const NINE_C: Card = { Rank: 9, Suit: 0 };
const KING_H: Card = { Rank: 13, Suit: 2 };
const EIGHT_D: Card = { Rank: 8, Suit: 1 };
const JACK_C: Card = { Rank: 11, Suit: 0 };
const THREE_C: Card = { Rank: 3, Suit: 0 };
const QUEEN_S: Card = { Rank: 12, Suit: 3 };

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

function resetSingletons(): void {
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
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  resetSingletons();
});

afterEach(cleanup);

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  await settle();
}

async function start(env: Envelope): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, env, { seed: '1' });
  const el = render();
  await settle();
  return el;
}

/** Rendered text with whitespace removed, so a face's rank and suit spans read as one token ("J♣"). */
function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, '');
}

/** Any element whose testid belongs to the seven-reveal panel family. */
function sevenNodes(el: HTMLElement): NodeListOf<Element> {
  return el.querySelectorAll('[data-testid^="seven-"]');
}

// ---------------------------------------------------------------------------
// DiscardPicker (R15)
// ---------------------------------------------------------------------------

function discardView(hand: Card[]): PlayerView {
  return playerView({
    viewer: 1,
    active: 1,
    phase: Phase.AwaitingDiscard,
    you: { hand, frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 4, hand: null, points: [], permanents: [] },
    pending: { playedBy: 0, card: FOUR_D, target: null, counterChain: [] },
  });
}

function pairEnvelope(): Envelope {
  return envelope({
    state: discardView([FIVE_S, NINE_C, KING_H]),
    legalMoves: [
      mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 1 }),
      mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 2 }),
      mv({ Kind: Kind.DiscardPair, DiscardA: 1, DiscardB: 2 }),
    ],
    descriptions: ['discard hand[0] and hand[1]', 'discard hand[0] and hand[2]', 'discard hand[1] and hand[2]'],
  });
}

describe('GameScreen DiscardPicker (R15)', () => {
  it('replaces the stub: the picker prompt renders and every hand card is pickable', async () => {
    const el = await start(pairEnvelope());
    expect(el.textContent).not.toContain("isn't playable yet");
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'discard-picker')?.textContent).toContain('Choose 2 cards to discard');
    expect(q(el, 'staging-bar')).toBeNull();
  });

  it('two hand taps stage the pair by name; only Confirm applies, with that pair\'s engine index', async () => {
    const el = await start(pairEnvelope());
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: playerView({ viewer: 1, active: 1, you: { hand: [NINE_C], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
          lastMove: appliedMove({ by: 1, kind: Kind.DiscardPair, seq: 1, index: 1 }),
          history: [appliedMove({ by: 1, kind: Kind.DiscardPair, seq: 1, index: 1 })],
        }),
    );
    await click(el, 'hand-card-2');
    expect(q(el, 'hand-card-2')?.dataset.staged).toBe('true');
    expect(q(el, 'discard-picker')?.textContent).toContain('1 of 2');
    expect(q(el, 'staging-bar')).toBeNull();
    await click(el, 'hand-card-0');
    expect(q(el, 'staging-bar')?.textContent).toContain('Discard 5♠ and K♥');
    expect(bridge.apply).not.toHaveBeenCalled();
    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith(1);
  });

  it('R15.2: a one-card hand arrives pre-staged; Confirm applies the {0,-1} move', async () => {
    const el = await start(
      envelope({
        state: discardView([QUEEN_S]),
        legalMoves: [mv({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: -1 })],
        descriptions: ['discard hand[0] and hand[-1]'],
      }),
    );
    expect(q(el, 'staging-bar')?.textContent).toContain('Discard Q♠');
    expect(q(el, 'hand-card-0')?.dataset.staged).toBe('true');
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: playerView({ viewer: 1, active: 1 }),
          lastMove: appliedMove({ by: 1, kind: Kind.DiscardPair, seq: 1, index: 0 }),
          history: [appliedMove({ by: 1, kind: Kind.DiscardPair, seq: 1, index: 0 })],
        }),
    );
    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledWith(0);
  });

  it('the picker does not render outside a discard position', async () => {
    const el = await start(
      envelope({
        state: playerView({ you: { hand: [FIVE_S], frozenHandIndices: [], points: [], permanents: [], watched: false } }),
        legalMoves: [mv({ Kind: Kind.Draw })],
        descriptions: ['draw a card'],
      }),
    );
    expect(q(el, 'discard-picker')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SevenRevealPanel (R16)
// ---------------------------------------------------------------------------

/** Alice (P0) played a 7; the top of the deck showed 8♦ and J♣. */
function sevenView(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.SevenChoosing,
    you: { hand: [FIVE_S], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 3, hand: null, points: [point(NINE_C, 1)], permanents: [] },
    scrap: [{ Rank: 7, Suit: 2 }],
    sevenRevealed: [EIGHT_D, JACK_C],
    pending: { playedBy: 0, card: { Rank: 7, Suit: 2 }, target: null, counterChain: [] },
    ...overrides,
  });
}

const SEVEN_MOVES: Move[] = [
  mv({ Kind: Kind.SevenPick, Card: EIGHT_D, SubMove: mv({ Kind: Kind.PlayPoint, Card: EIGHT_D }) }),
  mv({ Kind: Kind.SevenPick, Card: EIGHT_D, SubMove: mv({ Kind: Kind.PlayPermanent, Card: EIGHT_D }) }),
  mv({
    Kind: Kind.SevenPick,
    Card: JACK_C,
    SubMove: mv({ Kind: Kind.PlayPermanent, Card: JACK_C, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }),
  }),
];
const SEVEN_DESCRIPTIONS = ['7: play 8♦ as point card', '7: play 8♦ as permanent', '7: play J♣ (steal opponent point)'];

function sevenEnvelope(): Envelope {
  return envelope({ state: sevenView(), legalMoves: SEVEN_MOVES, descriptions: SEVEN_DESCRIPTIONS });
}

describe('GameScreen SevenRevealPanel (R16)', () => {
  it('replaces the stub: the acting player sees the revealed cards', async () => {
    const el = await start(sevenEnvelope());
    expect(el.textContent).not.toContain("isn't playable yet");
    expect(q(el, 'seven-reveal')).not.toBeNull();
    expect(q(el, 'seven-card-0')?.textContent).toContain('8');
    expect(q(el, 'seven-card-1')?.textContent).toContain('J');
    expect(q(el, 'seven-reveal')?.textContent).toContain('Top of the deck');
  });

  it('a revealed card replays on the real board: tap it, tap the lit zone, Confirm applies that SevenPick', async () => {
    const el = await start(sevenEnvelope());
    await click(el, 'seven-card-0');
    expect(q(el, 'zone-points')?.dataset.state).toBe('highlighted');
    expect(q(el, 'zone-permanents')?.dataset.state).toBe('highlighted');
    await click(el, 'zone-permanents');
    expect(q(el, 'staging-bar')?.textContent).toContain('Play 8♦ as glasses: you see their hand.');
    expect(q(el, 'seven-card-0')?.dataset.staged).toBe('true');
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({ state: sevenView({ phase: Phase.Normal, active: 0, sevenRevealed: null }), history: [] }),
    );
    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledWith(1);
  });

  it('the Jack revealed by the 7 targets the opponent point on the board', async () => {
    const el = await start(sevenEnvelope());
    await click(el, 'seven-card-1');
    await click(el, 'point-1-0');
    expect(q(el, 'staging-bar')?.textContent).toContain('Steal their 9♣ with J♣.');
  });

  it('a dead-end reveal is scrapped by tapping the lit scrap pile, not by opening the browser', async () => {
    const el = await start(
      envelope({
        state: sevenView(),
        legalMoves: [mv({ Kind: Kind.SevenPick, Card: EIGHT_D }), mv({ Kind: Kind.SevenPick, Card: JACK_C })],
        descriptions: ['7: no legal play — scrap 8♦', '7: no legal play — scrap J♣'],
      }),
    );
    await click(el, 'seven-card-0');
    await click(el, 'scrap-pile');
    expect(q(el, 'scrap-browser')).toBeNull();
    expect(q(el, 'staging-bar')?.textContent).toContain('Scrap 8♦: no revealed card can be played.');
  });

  it('PRIVACY: the panel is absent for a viewer who is not the actor, even at phase SevenChoosing', async () => {
    // The engine never sends sevenRevealed to the non-actor (SPEC §3.2). The
    // fixture sends it anyway, so this proves the UI's own gate, not the bridge's.
    const el = await start(
      envelope({
        state: sevenView({ viewer: 1, active: 0, sevenRevealed: [EIGHT_D, JACK_C] }),
        legalMoves: [],
        descriptions: [],
      }),
    );
    expect(q(el, 'board')).not.toBeNull();
    expect(sevenNodes(el)).toHaveLength(0);
    expect(text(el)).not.toContain('J♣');
    expect(text(el)).not.toContain('8♦');
  });

  it('PRIVACY: the panel is absent for the actor outside phase SevenChoosing, even if sevenRevealed arrives', async () => {
    // The engine sends sevenRevealed only at SevenChoosing (SPEC §3.2). The
    // fixture sends it at Normal anyway, to the actor, so this proves
    // GameScreen's phase gate on its own.
    const el = await start(
      envelope({
        state: sevenView({ phase: Phase.Normal, viewer: 0, active: 0, pending: null, sevenRevealed: [EIGHT_D, JACK_C] }),
        legalMoves: [mv({ Kind: Kind.Draw })],
        descriptions: ['draw a card'],
      }),
    );
    expect(q(el, 'board')).not.toBeNull();
    expect(sevenNodes(el)).toHaveLength(0);
    expect(text(el)).not.toContain('J♣');
    expect(text(el)).not.toContain('8♦');
  });

  it('PRIVACY: after the pick, neither revealed card survives into the handoff, reveal, recap or the opponent\'s board', async () => {
    const el = await start(sevenEnvelope());
    // Control: the unchosen J♣ is on screen for the actor while choosing.
    expect(text(el)).toContain('J♣');

    const pick = appliedMove({
      by: 0,
      kind: Kind.SevenPick,
      subKind: Kind.PlayPoint,
      seq: 1,
      card: EIGHT_D,
      description: '7: play 8♦ as point card',
    });
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: sevenView({
            phase: Phase.Normal,
            active: 1,
            sevenRevealed: null,
            pending: null,
            you: { hand: [FIVE_S], frozenHandIndices: [], points: [point(EIGHT_D, 0)], permanents: [], watched: false },
          }),
          lastMove: { ...pick, index: 0 },
          history: [{ ...pick, index: 0 }],
        }),
    );
    bridge.view.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: playerView({
            viewer: 1,
            active: 1,
            you: { hand: [KING_H], frozenHandIndices: [], points: [point(NINE_C, 1)], permanents: [], watched: false },
            opponent: { handCount: 1, hand: null, points: [point(EIGHT_D, 0)], permanents: [] },
          }),
          lastMove: pick,
          history: [pick],
          legalMoves: [mv({ Kind: Kind.Draw })],
          descriptions: ['draw a card'],
        }),
    );

    await click(el, 'seven-card-0');
    await click(el, 'zone-points');
    await click(el, 'staging-confirm');

    for (const step of ['handoff', 'reveal', 'recap', 'none'] as const) {
      expect(game.curtain.kind).toBe(step);
      expect(sevenNodes(el)).toHaveLength(0);
      expect(text(el)).not.toContain('J♣');
      if (step === 'handoff' || step === 'reveal') await click(el, 'reveal-two-step');
      if (step === 'recap') {
        expect(q(el, 'recap')?.textContent).toContain('revealed the top of the deck');
        await click(el, 'recap-dismiss');
      }
    }
    expect(game.viewer).toBe(1);
    expect(q(el, 'board')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ScrapBrowser (R6)
// ---------------------------------------------------------------------------

const SCRAP: Card[] = [FOUR_D, FIVE_S, NINE_C];

function threeEnvelope(): Envelope {
  return envelope({
    state: playerView({
      viewer: 0,
      active: 0,
      you: { hand: [KING_H, THREE_C], frozenHandIndices: [], points: [], permanents: [], watched: false },
      scrap: SCRAP,
    }),
    legalMoves: [
      mv({ Kind: Kind.Draw }),
      mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: THREE_C }),
      mv({ Kind: Kind.OneOff, HandIndex: 1, Card: THREE_C, ScrapIndex: 0 }),
      mv({ Kind: Kind.OneOff, HandIndex: 1, Card: THREE_C, ScrapIndex: 2 }),
    ],
    descriptions: ['draw a card', 'play 3♣ as point card', 'play 3♣ as one-off', 'play 3♣ as one-off'],
  });
}

describe('GameScreen ScrapBrowser (R6)', () => {
  it('R6.1: tapping the scrap pile opens a browse list of every scrap card; Close dismisses it', async () => {
    const el = await start(threeEnvelope());
    expect(q(el, 'scrap-browser')).toBeNull();
    await click(el, 'scrap-pile');
    const browser = q(el, 'scrap-browser');
    expect(browser?.dataset.mode).toBe('browse');
    expect(browser?.querySelectorAll('.cuttle-card-face')).toHaveLength(SCRAP.length);
    for (const glyph of ['4♦', '5♠', '9♣']) expect(text(browser)).toContain(glyph);
    expect(q(el, 'staging-bar')).toBeNull();
    expect(bridge.apply).not.toHaveBeenCalled();
    await click(el, 'scrap-browser-close');
    expect(q(el, 'scrap-browser')).toBeNull();
  });

  it('R6.1: browsing an empty scrap says so', async () => {
    const el = await start(
      envelope({ state: playerView(), legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    await click(el, 'scrap-pile');
    expect(q(el, 'scrap-browser')?.textContent).toContain('empty');
  });

  it('pick mode for the 3 lists exactly the offered scrap cards; a pick stages it by name; Confirm applies it', async () => {
    const el = await start(threeEnvelope());
    await click(el, 'hand-card-1');
    await click(el, 'zone-oneoff');
    const browser = q(el, 'scrap-browser');
    expect(browser?.dataset.mode).toBe('pick');
    expect(el.querySelectorAll('[data-testid^="scrap-pick-"]')).toHaveLength(2);
    expect(q(el, 'scrap-pick-0')).not.toBeNull();
    expect(q(el, 'scrap-pick-2')).not.toBeNull();
    expect(q(el, 'scrap-pick-1')).toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();

    await click(el, 'scrap-pick-2');
    expect(q(el, 'scrap-browser')).toBeNull();
    expect(q(el, 'staging-bar')?.textContent).toContain('Play 3♣ as a one-off: take 9♣ from the scrap.');
    expect(bridge.apply).not.toHaveBeenCalled();
    bridge.apply.mockImplementation(
      (): BridgeResult => envelope({ state: playerView({ viewer: 0, active: 0 }), history: [] }),
    );
    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledWith(3);
  });

  it('pick mode Cancel closes the browser and stages nothing', async () => {
    const el = await start(threeEnvelope());
    await click(el, 'hand-card-1');
    await click(el, 'zone-oneoff');
    await click(el, 'scrap-browser-cancel');
    expect(q(el, 'scrap-browser')).toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();
  });

  it('while a card is selected, a tap on an unlit scrap pile clears the selection and opens nothing (R9.4)', async () => {
    const el = await start(threeEnvelope());
    await click(el, 'hand-card-1');
    await click(el, 'scrap-pile');
    expect(q(el, 'scrap-browser')).toBeNull();
    expect(q(el, 'hand-card-1')?.getAttribute('aria-pressed')).toBe('false');
  });
});
