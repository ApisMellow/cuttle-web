// @vitest-environment jsdom
// P2 W13 — GameScreen integration (SPEC §4, §5.2, §6). ONE mounted
// GameScreen per test, driven through the real `game`/`session` singletons
// and a real StagingStore; only the `lib/bridge/engine` calls are faked, so
// every transition here runs the store's real apply/advanceCurtain code.
//
// Strict layer (testing policy 2026-09-28): move wiring (R9/R10/R11/R12),
// the curtain gate (R13.2: the board is unmounted, not hidden) and the R14
// privacy rule (real counter window and synthetic ack identical).
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import { stagingAffordances } from '../../src/lib/affordances';
import type { Component } from 'svelte';
import { ensureThemeLoaded, getTheme, resetThemeCatalogForTests } from '../../src/lib/theme';
import type { CardFaceProps } from '../../src/lib/theme/types';
import { Kind, Phase, appliedMove, envelope, playerView, startGameMocked } from './game-test-support';
import { THEMES_URL, fakeFetch, mythicRoutes } from './theme-fixture';

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
// Fixtures
// ---------------------------------------------------------------------------

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

function point(card: { Rank: PointEntry['Card']['Rank']; Suit: PointEntry['Card']['Suit'] }, owner: PlayerId): PointEntry {
  return { Card: card, Owner: owner, JackStack: [], JackOwners: [], Controller: owner };
}

const ACE = { Rank: 1, Suit: 3 } as const;
const NINE = { Rank: 9, Suit: 2 } as const;
const KING = { Rank: 13, Suit: 0 } as const;

/** P0 to act. hand [A, 9, K]; own points [3]; opponent points [7]. K has no legal move. */
const P0_MOVES: Move[] = [
  mv({ Kind: Kind.Draw }), // 0
  mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: ACE }), // 1
  mv({ Kind: Kind.OneOff, HandIndex: 0, Card: ACE }), // 2
  mv({ Kind: Kind.PlayPoint, HandIndex: 1, Card: NINE }), // 3
  mv({ Kind: Kind.Scuttle, HandIndex: 1, Card: NINE, Target: { Owner: 1, Zone: 0, Index: 0 } }), // 4
  mv({ Kind: Kind.OneOff, HandIndex: 1, Card: NINE, Target: { Owner: 1, Zone: 0, Index: 0 } }), // 5
];
const P0_DESCRIPTIONS = [
  'draw a card',
  'play ace as point card',
  'play ace as one-off',
  'play nine as point card',
  'scuttle seven with nine',
  'play nine as one-off on seven',
];

function p0View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: { hand: [ACE, NINE, KING], frozenHandIndices: [], points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [], watched: false },
    opponent: { handCount: 4, hand: null, points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [] },
    ...overrides,
  });
}

function p0Opening(moves: Move[] = P0_MOVES, descriptions: string[] = P0_DESCRIPTIONS): Envelope {
  return envelope({ state: p0View(), legalMoves: moves, descriptions });
}

/** Distinctive P1 hand so a leak across the curtain would be visible. */
const P1_HAND = [
  { Rank: 12, Suit: 2 },
  { Rank: 2, Suit: 1 },
] as const;

function p1View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 1,
    active: 1,
    phase: Phase.Normal,
    you: { hand: [...P1_HAND], frozenHandIndices: [], points: [point({ Rank: 7, Suit: 1 }, 1)], permanents: [], watched: false },
    opponent: { handCount: 3, hand: null, points: [point({ Rank: 3, Suit: 0 }, 0)], permanents: [] },
    ...overrides,
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

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function start(env: Envelope = p0Opening()): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, env, { seed: '1' });
  return render();
}

// ---------------------------------------------------------------------------
// Board at curtain `none`
// ---------------------------------------------------------------------------

describe('GameScreen at curtain none (the live board)', () => {
  it('mounts the board and keeps the session names in the DOM (screen-reader heading)', async () => {
    const el = await start();
    expect(q(el, 'game-screen')).not.toBeNull();
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'curtain')).toBeNull();
    expect(el.textContent).toContain('Alice vs Blake');
  });

  it('R9.3: a hand card with no legal move renders dimmed; playable ones do not', async () => {
    const el = await start();
    expect(q(el, 'hand-card-0')?.dataset.dimmed).toBe('false');
    expect(q(el, 'hand-card-1')?.dataset.dimmed).toBe('false');
    expect(q(el, 'hand-card-2')?.dataset.dimmed).toBe('true');
  });

  it('R10.1: the deck is enabled exactly when Draw is legal', async () => {
    const el = await start();
    expect(q(el, 'deck-pile')?.dataset.disabled).toBe('false');
    cleanup();
    resetSingletons();
    const noDraw = P0_MOVES.slice(1);
    const el2 = await start(p0Opening(noDraw, P0_DESCRIPTIONS.slice(1)));
    expect(q(el2, 'deck-pile')?.dataset.disabled).toBe('true');
    // and a tap on the disabled deck stages nothing
    await click(el2, 'deck-pile');
    expect(q(el2, 'staging-bar')).toBeNull();
  });

  it('R9.2/R12.1: hand → zone stages the engine description; only Confirm applies, exactly once', async () => {
    const el = await start();
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: p0View({ active: 0 }),
          lastMove: appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 1, card: ACE }),
          history: [appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 1, card: ACE })],
          legalMoves: P0_MOVES,
          descriptions: P0_DESCRIPTIONS,
        }),
    );

    await click(el, 'hand-card-0');
    expect(q(el, 'staging-bar')).toBeNull();
    await click(el, 'zone-points');
    expect(q(el, 'staging-bar')?.textContent).toContain('play ace as point card');
    expect(bridge.apply).not.toHaveBeenCalled();

    const confirm = q(el, 'staging-confirm')!;
    confirm.click();
    confirm.click();
    flushSync();
    await tick();
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith(1);
  });

  it('Deck tap stages Draw; Cancel clears it', async () => {
    const el = await start();
    await click(el, 'deck-pile');
    expect(q(el, 'staging-bar')?.textContent).toContain('draw a card');
    await click(el, 'staging-cancel');
    expect(q(el, 'staging-bar')).toBeNull();
  });

  it('a tap on your own point card while zone:points is lit stages the points move', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    await click(el, 'point-0-0');
    expect(q(el, 'staging-bar')?.textContent).toContain('play ace as point card');
  });

  it('R9.4: a tap on an unlit card clears the selection and stages nothing', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    await click(el, 'point-1-0'); // opponent point: not a target for the Ace
    expect(q(el, 'staging-bar')).toBeNull();
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('R11 backstop: two moves on one target open the AmbiguityChooser; a choice stages', async () => {
    const el = await start();
    await click(el, 'hand-card-1');
    await click(el, 'point-1-0');
    expect(q(el, 'ambiguity-chooser')).not.toBeNull();
    expect(q(el, 'ambiguity-chooser-option-4')).not.toBeNull();
    expect(q(el, 'ambiguity-chooser-option-5')).not.toBeNull();
    await click(el, 'ambiguity-chooser-option-5');
    expect(q(el, 'ambiguity-chooser')).toBeNull();
    expect(q(el, 'staging-bar')?.textContent).toContain('play nine as one-off on seven');
  });

  it('R10.2: the Pass pill renders only when Pass is the sole legal move, and stages Pass', async () => {
    const el = await start();
    expect(q(el, 'pass')).toBeNull();
    cleanup();
    resetSingletons();
    const el2 = await start(p0Opening([mv({ Kind: Kind.Pass })], ['pass']));
    expect(q(el2, 'pass')).not.toBeNull();
    await click(el2, 'pass');
    expect(q(el2, 'staging-bar')?.textContent).toContain('pass');
  });

  it('SPEC §6.5: window.__cuttleTestHook.affordances() matches the derived map; removed on unmount', async () => {
    await start();
    const hook = (window as unknown as { __cuttleTestHook?: { affordances(): Record<string, number[]> } })
      .__cuttleTestHook;
    expect(hook).toBeDefined();
    expect(hook!.affordances()).toEqual(stagingAffordances(P0_MOVES));
    cleanup();
    expect((window as unknown as { __cuttleTestHook?: unknown }).__cuttleTestHook).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Curtain
// ---------------------------------------------------------------------------

/** P0 plays the Ace for points; the turn passes to P1. */
function applyToHandoff(): void {
  const played = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 1, card: ACE, description: 'play A♠ as point card' });
  bridge.apply.mockImplementation(
    (): BridgeResult =>
      envelope({
        state: p0View({ active: 1 }),
        lastMove: played,
        history: [played],
      }),
  );
  bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => {
    const entry = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, card: ACE, description: 'play A♠ as point card' });
    return viewer === 1
      ? envelope({
          state: p1View(),
          lastMove: entry,
          history: [entry],
          legalMoves: [mv({ Kind: Kind.Draw })],
          descriptions: ['draw a card'],
        })
      : envelope({ state: p0View({ active: 1 }), lastMove: entry, history: [entry] });
  });
}

async function playAceForPoints(el: HTMLElement): Promise<void> {
  await click(el, 'hand-card-0');
  await click(el, 'zone-points');
  await click(el, 'staging-confirm');
}

describe('GameScreen curtain gate (R13.2, SPEC §4.5)', () => {
  it('the board is NOT in the DOM at handoff, reveal and recap; it returns for the new viewer', async () => {
    const el = await start();
    applyToHandoff();
    await playAceForPoints(el);

    expect(game.curtain.kind).toBe('handoff');
    expect(q(el, 'curtain')).not.toBeNull();
    expect(q(el, 'board')).toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();

    await click(el, 'reveal-two-step'); // handoff -> reveal
    expect(game.curtain.kind).toBe('reveal');
    expect(q(el, 'board')).toBeNull();

    await click(el, 'reveal-two-step'); // reveal -> recap
    expect(game.curtain.kind).toBe('recap');
    expect(q(el, 'board')).toBeNull();
    expect(q(el, 'recap')?.textContent).toContain('Alice played');

    await click(el, 'recap-dismiss'); // recap -> none, fetch P1's view
    expect(game.curtain.kind).toBe('none');
    expect(bridge.view).toHaveBeenCalledWith(1);
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'curtain')).toBeNull();
    // P1's own hand is what renders now (two cards)
    expect(el.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(2);
  });

  it('staging state never survives a curtain (selection cleared for the next viewer)', async () => {
    const el = await start();
    applyToHandoff();
    await playAceForPoints(el);
    await click(el, 'reveal-two-step');
    await click(el, 'reveal-two-step');
    await click(el, 'recap-dismiss');
    expect(q(el, 'staging-bar')).toBeNull();
    for (const card of el.querySelectorAll('[data-testid^="hand-card-"]')) {
      expect(card.getAttribute('aria-pressed')).toBe('false');
      expect((card as HTMLElement).dataset.staged).toBe('false');
    }
  });
});

describe('GameScreen clears bitmap image failures at each handoff (A-6)', () => {
  it('an image that failed during Alice’s view is retried for Blake, not inherited', async () => {
    resetThemeCatalogForTests();
    await ensureThemeLoaded('mythic', { fetch: fakeFetch(mythicRoutes()), themesUrl: THEMES_URL });
    const Face = getTheme('mythic').Face as Component<CardFaceProps & Record<string, unknown>>;
    const faceHost = document.createElement('div');
    document.body.append(faceHost);
    const face = mount(Face, { target: faceHost, props: { card: ACE, size: 'field' } });
    try {
      flushSync();
      const el = await start();
      for (let i = 0; i < 2; i++) {
        faceHost.querySelector('img')!.dispatchEvent(new Event('error'));
        flushSync();
      }
      expect(faceHost.querySelector('img')).toBeNull();

      applyToHandoff();
      await playAceForPoints(el);
      expect(game.curtain.kind).toBe('handoff');
      flushSync();
      expect(faceHost.querySelector('img')).not.toBeNull();
    } finally {
      unmount(face);
      faceHost.remove();
      resetThemeCatalogForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// CounterPrompt: real window vs synthetic ack (R14)
// ---------------------------------------------------------------------------

const TWO = { Rank: 2, Suit: 1 } as const;

/**
 * P0 plays the 9 as a one-off at P1's 7. `real` decides whether the engine
 * opened a counter window (P1 holds a 2) or auto-resolved it (synthetic ack).
 * Either way P1 walks handoff → reveal → recap → ack.
 */
async function toAck(real: boolean): Promise<HTMLDivElement> {
  const el = await start();
  const oneOff = appliedMove({
    by: 0,
    kind: Kind.OneOff,
    seq: 1,
    card: NINE,
    targetCard: { Rank: 7, Suit: 1 },
    description: 'play 9♥ as one-off',
  });
  bridge.apply.mockImplementation(
    (): BridgeResult =>
      envelope({
        state: p0View({ active: 1, phase: real ? Phase.AwaitingCounter : Phase.Normal }),
        lastMove: { ...oneOff, index: 5 },
        history: [{ ...oneOff, index: 5 }],
      }),
  );
  bridge.view.mockImplementation(
    (): BridgeResult =>
      envelope({
        state: real
          ? p1View({
              phase: Phase.AwaitingCounter,
              pending: { playedBy: 0, card: NINE, target: { Owner: 1, Zone: 0, Index: 0 }, counterChain: [] },
            })
          : // synthetic: the 9 already resolved — P1's 7 went back to hand, scores changed
            p1View({ you: { hand: [...P1_HAND, { Rank: 7, Suit: 1 }], frozenHandIndices: [2], points: [], permanents: [], watched: false } }),
        lastMove: oneOff,
        history: [oneOff],
        legalMoves: real
          ? [mv({ Kind: Kind.Decline }), mv({ Kind: Kind.Counter, HandIndex: 1, Card: TWO })]
          : [mv({ Kind: Kind.Draw })],
        descriptions: real ? ['decline', 'counter with two'] : ['draw a card'],
      }),
  );

  await click(el, 'hand-card-1');
  await click(el, 'point-1-0');
  await click(el, 'ambiguity-chooser-option-5');
  await click(el, 'staging-confirm');
  await click(el, 'reveal-two-step');
  await click(el, 'reveal-two-step');
  await click(el, 'recap-dismiss');
  expect(game.curtain).toEqual({ kind: 'ack', to: 1, synthetic: !real });
  return el;
}

function withoutCounterOptions(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll('[data-testid^="counter-option-"]')) node.remove();
  return clone.innerHTML;
}

describe('GameScreen CounterPrompt (R14, SPEC §4.3)', () => {
  it('PRIVACY: the real counter window and the synthetic ack render identically apart from the 2-buttons', async () => {
    const synthetic = withoutCounterOptions(await toAck(false));
    cleanup();
    resetSingletons();
    const realEl = await toAck(true);
    expect(realEl.querySelectorAll('[data-testid^="counter-option-"]')).toHaveLength(1);
    expect(withoutCounterOptions(realEl)).toBe(synthetic);
  });

  it('neither ack path mounts the board (a peek would show post-resolution state on one path only)', async () => {
    const synthetic = await toAck(false);
    expect(q(synthetic, 'counter-prompt')).not.toBeNull();
    expect(q(synthetic, 'board')).toBeNull();
    cleanup();
    resetSingletons();
    const real = await toAck(true);
    expect(q(real, 'counter-prompt')).not.toBeNull();
    expect(q(real, 'board')).toBeNull();
  });

  it('synthetic ack: "Let it resolve" advances the local curtain with no bridge apply', async () => {
    const el = await toAck(false);
    bridge.apply.mockClear();
    await click(el, 'counter-resolve');
    expect(bridge.apply).not.toHaveBeenCalled();
    expect(game.curtain.kind).toBe('none');
    expect(q(el, 'board')).not.toBeNull();
  });

  it('real window: "Let it resolve" applies the engine Decline index', async () => {
    const el = await toAck(true);
    bridge.apply.mockReset();
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: p1View({ active: 1 }),
          lastMove: appliedMove({ by: 1, kind: Kind.Decline, seq: 2, index: 0 }),
          history: [],
        }),
    );
    await click(el, 'counter-resolve');
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith(0);
  });

  it('real window: a counter needs Confirm, then applies that Counter index', async () => {
    const el = await toAck(true);
    bridge.apply.mockReset();
    bridge.apply.mockImplementation(
      (): BridgeResult =>
        envelope({
          state: p1View({ active: 0, phase: Phase.AwaitingCounter }),
          lastMove: appliedMove({ by: 1, kind: Kind.Counter, seq: 2, index: 1, card: TWO }),
          history: [],
        }),
    );
    await click(el, 'counter-option-1');
    expect(bridge.apply).not.toHaveBeenCalled();
    await click(el, 'staging-confirm');
    expect(bridge.apply).toHaveBeenCalledWith(1);
  });

  it('SPEC §6.5: at a real window the hook exposes the counter and decline slots', async () => {
    await toAck(true);
    const hook = (window as unknown as { __cuttleTestHook: { affordances(): Record<string, number[]> } })
      .__cuttleTestHook;
    expect(hook.affordances()).toEqual({ decline: [0], 'counter:1': [1] });
  });

  it('SPEC §6.5: at a synthetic ack the hook exposes nothing (the held envelope is post-resolution)', async () => {
    await toAck(false);
    // The store does hold the acknowledger's envelope here, with a live Draw.
    expect(game.envelope?.legalMoves).toHaveLength(1);
    const hook = (
      window as unknown as { __cuttleTestHook: { affordances(): Record<string, number[]>; moves(): unknown[] } }
    ).__cuttleTestHook;
    expect(hook.affordances()).toEqual({});
    expect(hook.moves()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Last-move line (R20.1) must not reveal whether the opponent held a 2 (R14)
// ---------------------------------------------------------------------------

const SEVEN = { Rank: 7, Suit: 2 } as const;

/** Mounts GameScreen at curtain `none` straight onto `env` (the acting player's returned board). */
async function boardAt(env: Envelope): Promise<string> {
  const el = await start(env);
  expect(game.curtain.kind).toBe('none');
  expect(q(el, 'board')).not.toBeNull();
  return el.innerHTML;
}

describe('GameScreen last-move line (R14 privacy, SPEC §4.3)', () => {
  it('PRIVACY: a 7 one-off back at SevenChoosing renders the same board whether or not the opponent declined', async () => {
    // A (P0) played the 7 as a one-off. Synthetic path: O had no 2, the
    // engine resolved it at once. Real path: O held a 2 and declined.
    const sevenOneOff = appliedMove({
      by: 0,
      kind: Kind.OneOff,
      seq: 1,
      index: 0,
      card: SEVEN,
      description: 'play 7♥ as one-off',
    });
    const decline = appliedMove({ by: 1, kind: Kind.Decline, seq: 2, description: 'decline' });
    const state = p0View({ phase: Phase.SevenChoosing, active: 0 });

    const synthetic = await boardAt(envelope({ state, lastMove: sevenOneOff, history: [sevenOneOff] }));
    cleanup();
    resetSingletons();
    const real = await boardAt(envelope({ state, lastMove: decline, history: [sevenOneOff, decline] }));

    expect(real).toBe(synthetic);
  });

  it('PRIVACY: an odd-chain counter cancel renders the same board to the counterer on both paths', async () => {
    // A (P0) played a one-off, O (P1) countered. Synthetic: A had no 2, the
    // counter resolved (cancelled) at once. Real: A held a 2 and declined.
    const oneOff = appliedMove({
      by: 0,
      kind: Kind.OneOff,
      seq: 1,
      card: NINE,
      targetCard: { Rank: 7, Suit: 1 },
      description: 'play 9♥ as one-off',
    });
    const counter = appliedMove({
      by: 1,
      kind: Kind.Counter,
      seq: 2,
      index: 1,
      card: TWO,
      description: 'counter with 2♦',
    });
    const decline = appliedMove({ by: 0, kind: Kind.Decline, seq: 3, description: 'decline' });
    const state = p1View({ phase: Phase.Normal, active: 1 });
    const moves = [mv({ Kind: Kind.Draw })];
    const descriptions = ['draw a card'];

    const synthetic = await boardAt(
      envelope({ state, lastMove: counter, history: [oneOff, counter], legalMoves: moves, descriptions }),
    );
    cleanup();
    resetSingletons();
    const real = await boardAt(
      envelope({ state, lastMove: decline, history: [oneOff, counter, decline], legalMoves: moves, descriptions }),
    );

    expect(real).toBe(synthetic);
  });
});

// ---------------------------------------------------------------------------
// Last-move line TEXT (R20.1, SPEC §4.6) — the reviewer found only real-vs-
// synthetic equality was tested, never the rendered text itself. History has
// four entries so the last visible one (the 4 one-off) differs from every
// earlier one, catching a formatter that picks the wrong entry.
// ---------------------------------------------------------------------------

describe('GameScreen last-move line text (R20.1, SPEC §4.6)', () => {
  const QUEEN = { Rank: 12, Suit: 1 } as const; // Q♦
  const JACK = { Rank: 11, Suit: 0 } as const; // J♣
  const FOUR = { Rank: 4, Suit: 0 } as const; // 4♣
  const STOLEN = { Rank: 3, Suit: 2 } as const; // 3♥ — the Jack steal's target card

  /**
   * Queen played, then a Jack steal, then the 4 one-off (untargeted — ranks
   * 2/9 are the only targeted one-offs), then a Decline. `oneOffBy` is the
   * mover of the 4 one-off (the last VISIBLE entry — Decline is filtered by
   * isRecapVisible); `otherBy` moves the rest, so the earlier entries always
   * differ from the actor of the last one.
   */
  function fourEntryHistory(oneOffBy: PlayerId, otherBy: PlayerId) {
    return [
      appliedMove({ by: otherBy, kind: Kind.PlayPermanent, seq: 1, card: QUEEN, description: 'play Q♦ as permanent' }),
      appliedMove({
        by: otherBy,
        kind: Kind.PlayPermanent,
        seq: 2,
        card: JACK,
        targetCard: STOLEN,
        description: 'play J♣ (steal opponent point)',
      }),
      appliedMove({ by: oneOffBy, kind: Kind.OneOff, seq: 3, card: FOUR, description: 'play 4♣ as one-off' }),
      appliedMove({ by: otherBy, kind: Kind.Decline, seq: 4, description: 'decline' }),
    ];
  }

  function lastMoveLine(el: HTMLElement): string | null {
    return el.querySelector('.center-zone__last-move')?.textContent ?? null;
  }

  it('R20.1: the viewer’s own last visible move renders verbatim, not through the §4.6 formatter', async () => {
    // Reversed from the file default (Alice, Blake) so this deliberately exercises a
    // different name pair than resetSingletons(), not a coincidental match.
    session.setNames('Blake', 'Alice');
    const history = fourEntryHistory(0, 1); // the 4 one-off is the viewer's (Blake's) own move
    const state = playerView({ viewer: 0, active: 0, phase: Phase.Normal });
    const el = await start(
      envelope({ state, history, legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    expect(lastMoveLine(el)).toBe('play 4♣ as one-off');
  });

  it('SPEC §4.6: the opponent’s last visible move renders as the per-viewer recap line', async () => {
    // Reversed from the file default (Alice, Blake) so this deliberately exercises a
    // different name pair than resetSingletons(), not a coincidental match.
    session.setNames('Blake', 'Alice');
    const history = fourEntryHistory(1, 0); // the 4 one-off is the opponent's (Alice's) move
    const state = playerView({ viewer: 0, active: 0, phase: Phase.Normal });
    const el = await start(
      envelope({ state, history, legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] }),
    );
    expect(lastMoveLine(el)).toBe('Alice played 4♣ as a one-off.');
  });
});

describe('W25 deck tap and blank-space deselect', () => {
  it('with a hand card selected, one deck tap stages Draw (Confirm still required)', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
    await click(el, 'deck-pile');
    expect(q(el, 'staging-bar')?.textContent).toContain('draw a card');
    expect(bridge.apply).not.toHaveBeenCalled();
  });

  it('a tap on the score bar or empty board space clears the selection', async () => {
    const el = await start();
    await click(el, 'hand-card-0');
    await click(el, 'score-bar');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');

    await click(el, 'hand-card-0');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('true');
    await click(el, 'board');
    expect(q(el, 'hand-card-0')?.getAttribute('aria-pressed')).toBe('false');
    expect(q(el, 'staging-bar')).toBeNull();
  });
});
