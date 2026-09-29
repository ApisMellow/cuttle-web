// @vitest-environment jsdom
// ROADMAP "Card labels", strict tier (hidden information, R7 / SPEC §3.2,
// §4.5). A card's name, effect line or in-play badge appears only on a
// face-up card the viewer can see: a permanent or stolen-point Jack on the
// table, the viewer's own selected or staged card, and the popover for the
// viewer's own dimmed card. Never on a back (the opponent's hidden hand, the
// deck), never on the opponent's hand even when glasses turn it face up
// (labels are for the table and your own choices), and never behind the
// curtain: at handoff, reveal, recap and both kinds of ack there is no
// label, and nothing the previous player selected or staged carries over.
//
// ONE mounted GameScreen per test, driven through the real game/session
// singletons and a real StagingStore; only lib/bridge/engine is faked.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeResult, Card, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
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

// ---------------------------------------------------------------------------
// Fixtures: Alice (P0) to act. Her table: King, Queen, glasses 8, and a
// point card she stole with a Jack. Blake's table: Queen and glasses 8.
// ---------------------------------------------------------------------------

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

const c = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });
const ACE = c(1, 3);
const NINE = c(9, 2);
const KING_IN_HAND = c(13, 0);
const TWO = c(2, 1);

const STOLEN: PointEntry = { Card: c(3, 0), Owner: 1, JackStack: [c(11, 3)], JackOwners: [0], Controller: 0 };

/** Blake's hand: a 5 and a 6. Distinct names (Draw Two, Royal Wipe) so a leak would show. */
const BLAKE_HAND: Card[] = [c(5, 2), c(6, 1)];

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
  'play A♠ as point card',
  'play A♠ as one-off',
  'play 9♥ as point card',
  "scuttle opponent's 7♦ with 9♥",
  'play 9♥ as one-off',
];

function p0View(overrides: Partial<PlayerView> = {}, blakeHand: Card[] | null = null): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    you: {
      hand: [ACE, NINE, KING_IN_HAND],
      frozenHandIndices: [],
      points: [STOLEN],
      permanents: [c(13, 2), c(12, 3), c(8, 2)],
      watched: false,
    },
    opponent: {
      handCount: BLAKE_HAND.length,
      hand: blakeHand,
      points: [{ Card: c(7, 1), Owner: 1, JackStack: [], JackOwners: [], Controller: 1 }],
      permanents: [c(12, 2), c(8, 0)],
    },
    scoreboard: {
      you: { points: 3, threshold: 14, kings: 1, hasWon: false },
      opponent: { points: 7, threshold: 21, kings: 0, hasWon: false },
    },
    ...overrides,
  });
}

function p1View(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 1,
    active: 1,
    phase: Phase.Normal,
    you: { hand: [...BLAKE_HAND], frozenHandIndices: [], points: [], permanents: [c(12, 2), c(8, 0)], watched: true },
    opponent: { handCount: 3, hand: [ACE, NINE, KING_IN_HAND], points: [STOLEN], permanents: [c(13, 2), c(12, 3), c(8, 2)] },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

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

async function start(state: PlayerView = p0View(), moves: Move[] = P0_MOVES, descriptions: string[] = P0_DESCRIPTIONS): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, envelope({ state, legalMoves: moves, descriptions }), { seed: '1' });
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

const LABELS = '[data-card-label], [data-card-hint]';

/** Words only a card label writes. None may appear behind the curtain. */
const LABEL_WORDS = ['Goal ', 'Protects', 'Stole', 'Sees hand', 'One-off:', 'Permanent:', 'Glasses:', 'Points only', 'Send Back', 'Board Wipe', 'Shortcut', 'Draw Two', 'Royal Wipe'];

function expectNoLabels(el: HTMLElement, where: string): void {
  expect(el.querySelectorAll(LABELS), where).toHaveLength(0);
  const text = el.textContent ?? '';
  for (const word of LABEL_WORDS) expect(text, `${where}: "${word}"`).not.toContain(word);
}

/** Every label element sits on a table card, or on the viewer's own selection, staging line or popover. */
function expectLabelsOnlyWhereAllowed(el: HTMLElement): void {
  for (const label of el.querySelectorAll(LABELS)) {
    const home = label.closest(
      '[data-testid^="perm-"], [data-testid^="point-"], [data-testid="staging-bar"], [data-testid="card-detail-popover"], .game-screen__action-bar',
    );
    expect(home, label.outerHTML).not.toBeNull();
  }
  for (const zone of ['opp-hand', 'deck-pile', 'scrap-pile']) {
    expect(q(el, zone)?.querySelectorAll(LABELS) ?? [], zone).toHaveLength(0);
  }
  expect(el.querySelectorAll('[data-testid^="hand-card-"] [data-card-label]')).toHaveLength(0);
}

// ---------------------------------------------------------------------------

describe('Card labels privacy: only face-up cards the viewer can see', () => {
  it('on the live board: badges on the table only, none on backs, the deck or the scrap', async () => {
    const el = await start();
    expectLabelsOnlyWhereAllowed(el);
    const badges = [...el.querySelectorAll('[data-card-label="badge"]')].map((b) => b.textContent);
    // Alice: King (goal 14), Queen, glasses, stolen Jack. Blake: Queen, glasses.
    expect(badges.sort()).toEqual(['Goal 14', 'Protects', 'Protects', 'Sees hand', 'Sees hand', 'Stole'].sort());
    expect(q(el, 'perm-0-0')?.querySelector('[data-card-label="badge"]')?.textContent).toBe('Goal 14');
    expect(q(el, 'point-0-0')?.querySelector('[data-card-label="badge"]')?.textContent).toBe('Stole');
  });

  it('with glasses showing Blake’s hand face up, that hand still carries no label', async () => {
    const el = await start(p0View({}, [...BLAKE_HAND]));
    expect(q(el, 'opp-hand')?.getAttribute('data-revealed')).toBe('true');
    expectLabelsOnlyWhereAllowed(el);
    expect(el.textContent).not.toContain('Draw Two');
    expect(el.textContent).not.toContain('Royal Wipe');
  });

  for (const faceUp of [false, true]) {
    it(`a selected hand card names itself and says what it does, only that card (Blake's hand ${faceUp ? 'face up under glasses' : 'hidden'})`, async () => {
      // Review B1: with Blake's hand face up, index 1 is his 6 (Royal Wipe),
      // not Alice's 9 (Send Back), so reading the wrong hand would show.
      const el = await start(p0View({}, faceUp ? [...BLAKE_HAND] : null));
      expect(el.querySelector('[data-card-hint]')).toBeNull();
      await click(el, 'hand-card-1');
      const hint = el.querySelector('[data-card-hint]');
      expect(hint?.querySelector('[data-card-label="name"]')?.textContent).toBe('Send Back');
      expect(hint?.querySelector('[data-card-label="effect"]')?.textContent).toBe('One-off: send a card back to its owner’s hand.');
      expect(el.textContent).not.toContain('Royal Wipe');
      expectLabelsOnlyWhereAllowed(el);

      // Review S2: played for points, the 9 uses no ability, so no name.
      await click(el, 'zone-points');
      expect(el.querySelector('[data-card-hint]')).toBeNull();
      expect(q(el, 'staging-bar')).not.toBeNull();
      expect(q(el, 'staging-bar')?.querySelector('[data-card-label="name"]')).toBeNull();
      await click(el, 'staging-cancel');

      // Scuttling with it: no name either.
      await click(el, 'hand-card-1');
      await click(el, 'point-1-0');
      await click(el, 'ambiguity-chooser-option-4');
      expect(q(el, 'staging-bar')?.querySelector('[data-card-label="name"]')).toBeNull();
      await click(el, 'staging-cancel');

      // As a one-off it uses its ability: the staging line names it.
      await click(el, 'hand-card-1');
      await click(el, 'point-1-0');
      await click(el, 'ambiguity-chooser-option-5');
      expect(q(el, 'staging-bar')?.querySelector('[data-card-label="name"]')?.textContent?.trim()).toBe('Send Back');
      await click(el, 'staging-cancel');
      expect(el.querySelectorAll(LABELS).length).toBe(6); // only the six table badges remain
    });
  }

  it('review S5: a card the 7 revealed names itself for the actor, not the hand card at that index', async () => {
    const EIGHT_D = c(8, 1);
    const JACK_C = c(11, 0);
    const state = p0View({
      phase: Phase.SevenChoosing,
      sevenRevealed: [EIGHT_D, JACK_C],
      pending: { playedBy: 0, card: c(7, 2), target: null, counterChain: [] },
    });
    const moves = [
      mv({ Kind: Kind.SevenPick, Card: EIGHT_D, SubMove: mv({ Kind: Kind.PlayPoint, Card: EIGHT_D }) }),
      mv({ Kind: Kind.SevenPick, Card: EIGHT_D, SubMove: mv({ Kind: Kind.PlayPermanent, Card: EIGHT_D }) }),
      mv({ Kind: Kind.SevenPick, Card: JACK_C, SubMove: mv({ Kind: Kind.PlayPermanent, Card: JACK_C, JackTarget: { Owner: 1, Zone: 0, Index: 0 } }) }),
    ];
    const el = await start(state, moves, ['7: play 8♦ as point card', '7: play 8♦ as permanent', '7: play J♣ (steal opponent point)']);
    await click(el, 'seven-card-0');
    let hint = el.querySelector('[data-card-hint]');
    expect(hint?.querySelector('[data-card-label="name"]')?.textContent).toBe('Glasses');
    expect(hint?.querySelector('[data-card-label="effect"]')?.textContent).toBe('Glasses: you see their hand.');
    await click(el, 'seven-card-1');
    hint = el.querySelector('[data-card-hint]');
    expect(hint?.querySelector('[data-card-label="name"]')?.textContent).toBe('Thief');
    expect(el.textContent).not.toContain('Board Wipe'); // hand[0] is the Ace
    await click(el, 'seven-card-0');
    await click(el, 'zone-permanents');
    expect(q(el, 'staging-bar')?.querySelector('[data-card-label="name"]')?.textContent?.trim()).toBe('Glasses');
  });

  it('the popover for a dimmed card names that card only', async () => {
    const el = await start();
    await click(el, 'hand-card-2');
    const popover = q(el, 'card-detail-popover')!;
    expect(popover.querySelector('[data-card-label="name"]')?.textContent).toBe('Shortcut');
    expect(popover.querySelector('[data-card-label="effect"]')?.textContent).toBe('Permanent: you need fewer points to win.');
    expectLabelsOnlyWhereAllowed(el);
  });

  it('nothing is labelled at handoff, reveal or recap, and nothing Alice selected or staged reaches Blake', async () => {
    const el = await start();
    const played = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, index: 3, card: NINE, description: 'play 9♥ as point card' });
    bridge.apply.mockImplementation((): BridgeResult => envelope({ state: p0View({ active: 1 }), lastMove: played, history: [played] }));
    bridge.view.mockImplementation((viewer: PlayerId): BridgeResult => {
      const entry = appliedMove({ by: 0, kind: Kind.PlayPoint, seq: 1, card: NINE, description: 'play 9♥ as point card' });
      return viewer === 1
        ? envelope({ state: p1View(), lastMove: entry, history: [entry], legalMoves: [mv({ Kind: Kind.Draw })], descriptions: ['draw a card'] })
        : envelope({ state: p0View({ active: 1 }), lastMove: played, history: [played] });
    });

    await click(el, 'hand-card-1');
    expect(el.querySelector('[data-card-hint]')).not.toBeNull();
    await click(el, 'zone-points');
    await click(el, 'staging-confirm');

    expect(game.curtain.kind).toBe('handoff');
    expectNoLabels(el, 'handoff');
    await click(el, 'reveal-two-step');
    expect(game.curtain.kind).toBe('reveal');
    expectNoLabels(el, 'reveal');
    await click(el, 'reveal-two-step');
    expect(game.curtain.kind).toBe('recap');
    expectNoLabels(el, 'recap');
    await click(el, 'recap-dismiss');

    // Blake's board: table badges only; Alice's selection and staging are gone.
    expect(game.curtain.kind).toBe('none');
    expect(el.querySelector('[data-card-hint]')).toBeNull();
    expect(q(el, 'staging-bar')).toBeNull();
    expectLabelsOnlyWhereAllowed(el);
    expect(el.textContent).not.toContain('Send Back');
    // Blake sees Alice's hand (his glasses) but it carries no label either.
    expect(q(el, 'opp-hand')?.getAttribute('data-revealed')).toBe('true');
  });

  for (const real of [true, false]) {
    it(`nothing is labelled at a ${real ? 'real counter window' : 'synthetic ack'}`, async () => {
      const el = await start();
      const oneOff = appliedMove({ by: 0, kind: Kind.OneOff, seq: 1, card: NINE, targetCard: c(7, 1), description: 'play 9♥ as one-off' });
      bridge.apply.mockImplementation(
        (): BridgeResult =>
          envelope({ state: p0View({ active: 1, phase: real ? Phase.AwaitingCounter : Phase.Normal }), lastMove: { ...oneOff, index: 5 }, history: [{ ...oneOff, index: 5 }] }),
      );
      bridge.view.mockImplementation(
        (): BridgeResult =>
          envelope({
            state: real
              ? p1View({ phase: Phase.AwaitingCounter, pending: { playedBy: 0, card: NINE, target: { Owner: 1, Zone: 0, Index: 0 }, counterChain: [] } })
              : p1View(),
            lastMove: oneOff,
            history: [oneOff],
            legalMoves: real ? [mv({ Kind: Kind.Decline }), mv({ Kind: Kind.Counter, HandIndex: 1, Card: TWO })] : [mv({ Kind: Kind.Draw })],
            descriptions: real ? ['decline to counter', 'counter with 2♦'] : ['draw a card'],
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
      expectNoLabels(el, real ? 'real ack' : 'synthetic ack');
    });
  }
});
