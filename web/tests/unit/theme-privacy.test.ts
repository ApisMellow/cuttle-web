// @vitest-environment jsdom
// PRD §10 A-6 + SPEC §3 / §4 — STRICT tier (hidden-information privacy).
// A bitmap theme is a skin, never a window: with Mythic active, the DOM
// carries a face image only for a card the viewer may see. The opponent's
// hidden hand and the deck stay backs (and a back image names no card);
// behind a curtain no face image exists at all.
//
// Same harness as game-screen.svelte.test.ts: the real game/session/settings
// singletons, with only `lib/bridge/engine` faked.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Envelope, Move, PlayerId, PlayerView, PointEntry } from '../../src/lib/bridge/schema';
import { ensureThemeLoaded, getTheme, resetThemeCatalogForTests } from '../../src/lib/theme';
import { Kind, Phase, envelope, playerView, startGameMocked } from './game-test-support';
import { THEMES_URL, fakeFetch, faceKeyOfSrc, mythicRoutes } from './theme-fixture';

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

const LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const key = (c: Card): string => `${LABELS[c.Rank]}-${SUITS[c.Suit]}`;

// Viewer 0 sees: own hand, both point rows, the scrap top.
const HAND: Card[] = [
  { Rank: 1, Suit: 3 },
  { Rank: 9, Suit: 2 },
  { Rank: 13, Suit: 0 },
];
const OWN_POINT: Card = { Rank: 3, Suit: 0 };
const OPP_POINT: Card = { Rank: 7, Suit: 1 };
const SCRAP_TOP: Card = { Rank: 5, Suit: 1 };

function view(): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    phase: Phase.Normal,
    scrap: [{ Rank: 6, Suit: 3 }, SCRAP_TOP],
    you: { hand: HAND, frozenHandIndices: [], points: [point(OWN_POINT, 0)], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [point(OPP_POINT, 1)], permanents: [] },
  });
}

function opening(): Envelope {
  return envelope({
    state: view(),
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.PlayPoint, HandIndex: 0, Card: HAND[0] })],
    descriptions: ['draw a card', 'play ace as point card'],
  });
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

async function start(): Promise<HTMLDivElement> {
  await startGameMocked(game, bridge, opening(), { seed: '1' });
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  await tick();
  flushSync();
  return host;
}

function imgSrcs(el: Element): string[] {
  return [...el.querySelectorAll('img')].map((img) => img.src);
}

function faceKeys(el: Element): string[] {
  return imgSrcs(el)
    .map(faceKeyOfSrc)
    .filter((k): k is string => k !== null)
    .sort();
}

beforeEach(async () => {
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

  resetThemeCatalogForTests();
  await ensureThemeLoaded('mythic', { fetch: fakeFetch(mythicRoutes({ back: true, table: true })), themesUrl: THEMES_URL });
  expect(getTheme('mythic').id).toBe('mythic');
  settings.setThemeId('mythic');
});

afterEach(() => {
  cleanup();
  settings.setThemeId('vector');
});

describe('Mythic active: face images only for cards the viewer may see', () => {
  it('the board renders Mythic faces, and exactly the visible cards get one', async () => {
    const el = await start();
    const expected = [...HAND, OWN_POINT, OPP_POINT, SCRAP_TOP].map(key).sort();
    expect(faceKeys(el)).toEqual(expected);
  });

  it("the opponent's hidden hand renders only back images, one per card, naming no card", async () => {
    const el = await start();
    const opp = el.querySelector('[data-testid="opp-hand"]');
    expect(opp).not.toBeNull();
    const srcs = imgSrcs(opp!);
    expect(srcs).toHaveLength(5);
    for (const src of srcs) {
      expect(src).toBe(`${THEMES_URL}mythic/back.webp`);
      expect(faceKeyOfSrc(src)).toBeNull();
    }
    expect(opp!.querySelector('.bitmap-card-face, .cuttle-card-face')).toBeNull();
  });

  it('the deck renders the back image, never a face', async () => {
    const el = await start();
    const deck = el.querySelector('[data-testid="deck-pile"]')!;
    expect(faceKeys(deck)).toEqual([]);
    expect(imgSrcs(deck)).toEqual([`${THEMES_URL}mythic/back.webp`]);
  });

  for (const curtain of [
    { kind: 'handoff', to: 1, reason: 'turn' },
    { kind: 'reveal', to: 1 },
    { kind: 'ack', to: 1 },
  ] as const) {
    it(`behind the curtain (${curtain.kind}) no face image and no playmat is in the DOM`, async () => {
      const el = await start();
      // the board showed faces and the playmat a moment ago
      expect(faceKeys(el).length).toBeGreaterThan(0);
      expect(imgSrcs(el).filter((s) => s.endsWith('/table.webp'))).toHaveLength(1);
      game.curtain = curtain;
      flushSync();
      await tick();
      flushSync();
      expect(faceKeys(el)).toEqual([]);
      expect(el.querySelector('.bitmap-card-face')).toBeNull();
      expect(imgSrcs(el).filter((s) => s.endsWith('/table.webp'))).toEqual([]);
    });
  }
});
