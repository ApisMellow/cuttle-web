// @vitest-environment jsdom
// r16 (2026-09-29 playtest, "Desktop and accessibility") — every card button
// has an accessible name in words ("King of Hearts"), whatever the theme
// (Mythic's images are alt=""), and the deck and scrap are named with their
// counts. STRICT for the privacy half: a card the viewer can't see is never
// named — the opponent's hidden hand and the deck are backs, and a back has
// no name.
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Card, PlayerView } from '../../src/lib/bridge/schema';
import Board from '../../src/lib/components/Board.svelte';
import ScrapBrowser from '../../src/lib/components/ScrapBrowser.svelte';
import SevenRevealPanel from '../../src/lib/components/SevenRevealPanel.svelte';
import { cardSpokenName, ensureThemeLoaded, getTheme, resetThemeCatalogForTests, vectorTheme } from '../../src/lib/theme';
import type { CardTheme } from '../../src/lib/theme/types';
import { playerView } from './game-test-support';
import { THEMES_URL, fakeFetch, mythicRoutes } from './theme-fixture';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(cleanup);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Svelte's own mount() constraint
function mountInto<P extends Record<string, any>>(component: Component<P>, props: P): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(component, { target: host, props });
  flushSync();
  return host;
}

let mythic: CardTheme;

beforeAll(async () => {
  resetThemeCatalogForTests();
  await ensureThemeLoaded('mythic', { fetch: fakeFetch(mythicRoutes({ back: true })), themesUrl: THEMES_URL });
  mythic = getTheme('mythic');
  expect(mythic.id).toBe('mythic');
});

// The opponent's real hand: known to this test only, never in the view.
const HIDDEN_HAND: Card[] = [
  { Rank: 13, Suit: 2 },
  { Rank: 12, Suit: 0 },
  { Rank: 3, Suit: 1 },
];

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    you: {
      hand: [
        { Rank: 1, Suit: 0 },
        { Rank: 9, Suit: 3 },
      ],
      frozenHandIndices: [1],
      points: [
        { Card: { Rank: 10, Suit: 2 }, Owner: 1, JackStack: [{ Rank: 11, Suit: 3 }], JackOwners: [0], Controller: 0 },
      ],
      permanents: [{ Rank: 13, Suit: 1 }],
      watched: false,
    },
    opponent: {
      handCount: HIDDEN_HAND.length,
      hand: null,
      points: [{ Card: { Rank: 7, Suit: 0 }, Owner: 1, JackStack: [], JackOwners: [], Controller: 1 }],
      permanents: [{ Rank: 8, Suit: 2 }],
    },
    deckCount: 41,
    scrap: [
      { Rank: 2, Suit: 0 },
      { Rank: 6, Suit: 3 },
    ],
    ...overrides,
  });
}

function board(theme: CardTheme, v: PlayerView = view()): HTMLDivElement {
  return mountInto(Board, {
    view: v,
    names: ['Alice', 'Blake'],
    highlighted: new Set<string>(),
    staged: new Set<string>(),
    dimmedHand: new Set<number>(),
    selectedHand: null,
    inert: false,
    deckEnabled: true,
    ontap: () => {},
    theme,
  });
}

function label(el: HTMLElement, id: string): string | null {
  return el.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-label') ?? null;
}

/** Every card name ("… of Hearts") the DOM exposes, in any attribute or text. */
function namedCards(el: HTMLElement): string[] {
  const found = new Set<string>();
  const re = /(Ace|King|Queen|Jack|10|[2-9]) of (Clubs|Diamonds|Hearts|Spades)/g;
  const scan = (s: string | null) => {
    for (const m of (s ?? '').matchAll(re)) found.add(m[0]);
  };
  for (const node of el.querySelectorAll('*')) {
    for (const attr of node.attributes) scan(attr.value);
  }
  scan(el.textContent);
  return [...found];
}

for (const which of ['Classic', 'Mythic'] as const) {
  describe(`card names in words, ${which}`, () => {
    const theme = () => (which === 'Classic' ? vectorTheme : mythic);

    it('names every card button, the deck and the scrap', () => {
      const el = board(theme());
      expect(label(el, 'hand-card-0')).toBe('Ace of Clubs');
      expect(label(el, 'hand-card-1')).toBe('9 of Spades, frozen');
      expect(label(el, 'point-0-0')).toBe('10 of Hearts, stolen from Blake, Jack of Spades on it');
      expect(label(el, 'perm-0-0')).toMatch(/^King of Diamonds, Goal /);
      expect(label(el, 'point-1-0')).toBe('7 of Clubs');
      expect(label(el, 'perm-1-0')).toMatch(/^8 of Hearts, glasses/);
      expect(label(el, 'deck-pile')).toBe('Deck, 41 cards');
      expect(label(el, 'scrap-pile')).toBe('Scrap, 2 cards, 6 of Spades on top');
    });

    it('never names a hidden card: the opponent’s backs and the deck carry no card name', () => {
      const el = board(theme());
      const opp = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
      // Backs have no accessible name at all (no label, no role=img).
      for (const slot of opp.querySelectorAll('.opponent-hand__card')) {
        expect(slot.hasAttribute('aria-label')).toBe(false);
        expect(slot.getAttribute('role')).toBeNull();
      }
      expect(namedCards(opp)).toEqual([]);
      // Nothing anywhere names a card of the hidden hand.
      const named = namedCards(el);
      for (const card of HIDDEN_HAND) expect(named).not.toContain(cardSpokenName(card));
      // Every name on the page is a card the view shows face up.
      const v = view();
      const visible = new Set(
        [
          ...v.you.hand,
          ...v.you.points.flatMap((p) => [p.Card, ...p.JackStack]),
          ...v.you.permanents,
          ...v.opponent.points.flatMap((p) => [p.Card, ...p.JackStack]),
          ...v.opponent.permanents,
          ...v.scrap,
        ].map(cardSpokenName),
      );
      for (const name of named) expect(visible.has(name), name).toBe(true);
    });

    it('under glasses the opponent’s face-up hand is named (it is visible to this viewer)', () => {
      const el = board(theme(), view({ opponent: { ...view().opponent, hand: HIDDEN_HAND } }));
      const opp = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
      expect([...opp.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))).toEqual(
        HIDDEN_HAND.map(cardSpokenName),
      );
    });

    it('names the 7’s revealed cards and the scrap picks', () => {
      let el = mountInto(SevenRevealPanel, {
        cards: [
          { Rank: 3, Suit: 2 },
          { Rank: 7, Suit: 1 },
        ],
        hand: [{ Rank: 5, Suit: 0 }],
        selected: null,
        staged: new Set<string>(),
        ontap: () => {},
        theme: theme(),
      });
      expect(label(el, 'seven-card-0')).toBe('3 of Hearts');
      expect(label(el, 'seven-card-1')).toBe('7 of Diamonds');
      expect(el.querySelector('[data-seven-hand] [aria-label]')?.getAttribute('aria-label')).toBe('5 of Clubs');

      el = mountInto(ScrapBrowser, {
        mode: 'pick',
        cards: [
          { Rank: 2, Suit: 0 },
          { Rank: 6, Suit: 3 },
        ],
        picks: [
          { index: 4, scrapIndex: 0 },
          { index: 5, scrapIndex: 1 },
        ],
        onclose: () => {},
        theme: theme(),
      });
      expect(label(el, 'scrap-pick-0')).toBe('2 of Clubs');
      expect(label(el, 'scrap-pick-1')).toBe('6 of Spades');

      // Browse mode (review N2): each card is an image with a name, never a
      // bare <li> carrying aria-label. Top of the pile first.
      el = mountInto(ScrapBrowser, {
        mode: 'browse',
        cards: [
          { Rank: 2, Suit: 0 },
          { Rank: 6, Suit: 3 },
        ],
        onclose: () => {},
        theme: theme(),
      });
      expect(el.querySelectorAll('li[aria-label]')).toHaveLength(0);
      expect([...el.querySelectorAll('li [role="img"]')].map((e) => e.getAttribute('aria-label'))).toEqual([
        '6 of Spades',
        '2 of Clubs',
      ]);
    });
  });
}

describe('Mythic hand cards: the name comes from the button, not the image', () => {
  it('the face image stays alt="" (decorative) and the button is named', () => {
    const el = board(mythic);
    const button = el.querySelector('[data-testid="hand-card-0"]')!;
    const img = button.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Ace of Clubs');
  });
});
