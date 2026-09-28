// @vitest-environment jsdom
// PlayerHand is presentational: cards + frozenHandIndices + a selected
// index + an onselect callback in; no store, no bridge, no legal-move
// awareness (SPEC §5.2, §5.3). Redaction (carry-over 8): it renders only
// the hand it is given and has no code path for an opponent's cards.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import PlayerHand from '../../src/lib/components/PlayerHand.svelte';

const HAND: Card[] = [
  { Rank: 1, Suit: 0 }, // A clubs
  { Rank: 7, Suit: 2 }, // 7 hearts
  { Rank: 13, Suit: 3 }, // K spades
];

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function renderPlayerHand(props: {
  cards: Card[];
  frozenHandIndices: number[];
  selectedHandIndex: number | null;
  onselect: (handIndex: number) => void;
  highlighted?: ReadonlySet<string>;
  staged?: ReadonlySet<string>;
  dimmedHandIndices?: ReadonlySet<number>;
}): HTMLDivElement {
  host = document.createElement('div');
  instance = mount(PlayerHand, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  instance = undefined;
  host = undefined;
});

describe('PlayerHand (presentational, SPEC §5.2/§5.3)', () => {
  it('renders exactly one HandCard per card it is given, in order', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    const cards = el.querySelectorAll('[data-testid^="hand-card-"]');
    expect(cards.length).toBe(HAND.length);
    expect(cards[0].getAttribute('data-testid')).toBe('hand-card-0');
    expect(cards[1].getAttribute('data-testid')).toBe('hand-card-1');
    expect(cards[2].getAttribute('data-testid')).toBe('hand-card-2');
  });

  it('redaction: renders no more and no fewer cards than the `cards` prop — an empty hand renders nothing', () => {
    const el = renderPlayerHand({ cards: [], frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    expect(el.querySelectorAll('[data-testid^="hand-card-"]').length).toBe(0);
  });

  it('forwards frozenHandIndices membership to the matching HandCard only', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [1], selectedHandIndex: null, onselect: () => {} });
    expect(el.querySelector('[data-testid="hand-card-0"]')?.getAttribute('data-frozen')).toBe('false');
    expect(el.querySelector('[data-testid="hand-card-1"]')?.getAttribute('data-frozen')).toBe('true');
    expect(el.querySelector('[data-testid="hand-card-2"]')?.getAttribute('data-frozen')).toBe('false');
  });

  it('a frozen card is counted once: every hand-card-* testid is a button, one per card (§5.9 sweep)', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [0, 2], selectedHandIndex: null, onselect: () => {} });
    const cards = [...el.querySelectorAll('[data-testid^="hand-card-"]')];
    expect(cards.length).toBe(HAND.length);
    expect(cards.every((c) => c.tagName === 'BUTTON')).toBe(true);
    const allIds = [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    expect(allIds).toEqual(['player-hand', 'hand-card-0', 'hand-card-1', 'hand-card-2']);
  });

  it('marks only the selectedHandIndex as selected (aria-pressed)', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: 1, onselect: () => {} });
    expect(el.querySelector('[data-testid="hand-card-0"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-testid="hand-card-1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-testid="hand-card-2"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('null selectedHandIndex selects nothing', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    for (const card of el.querySelectorAll('[data-testid^="hand-card-"]')) {
      expect(card.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('invokes onselect with the tapped card\'s handIndex', () => {
    const seen: number[] = [];
    const el = renderPlayerHand({
      cards: HAND,
      frozenHandIndices: [],
      selectedHandIndex: null,
      onselect: (handIndex) => seen.push(handIndex),
    });
    el.querySelector<HTMLButtonElement>('[data-testid="hand-card-2"]')?.click();
    flushSync();
    expect(seen).toEqual([2]);
  });

  it('exposes the card count to its fan CSS as --hand-count (design §6: fan with equal overlap)', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ Rank: i + 1, Suit: 0 })) as Card[];
    const el = renderPlayerHand({ cards: eight, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    const hand = el.querySelector<HTMLElement>('[data-testid="player-hand"]')!;
    expect(hand.style.getPropertyValue('--hand-count')).toBe('8');
    expect(el.querySelectorAll('[data-testid^="hand-card-"]').length).toBe(8);
  });

  it('renders every card through the theme <Face> — one Face root (data-state) per hand card', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    const buttons = [...el.querySelectorAll('[data-testid^="hand-card-"]')];
    expect(buttons.map((b) => b.querySelectorAll('[data-state]').length)).toEqual([1, 1, 1]);
  });
});

// P2 W9 (Board props contract) — highlighted/staged use the `hand:<index>`
// key format; dimmedHandIndices is index-based, matching Board's
// `dimmedHand: ReadonlySet<number>` directly.
describe('PlayerHand forwards highlighted/staged/dimmed to the matching HandCard only (docs/design.md §7)', () => {
  function faceState(card: Element | null): string | null | undefined {
    return card?.querySelector('[data-state]')?.getAttribute('data-state');
  }

  it('highlighted checks the hand:<index> key and touches only that card', () => {
    const el = renderPlayerHand({
      cards: HAND,
      frozenHandIndices: [],
      selectedHandIndex: null,
      onselect: () => {},
      highlighted: new Set(['hand:1']),
    });
    expect(faceState(el.querySelector('[data-testid="hand-card-0"]'))).toBe('normal');
    expect(faceState(el.querySelector('[data-testid="hand-card-1"]'))).toBe('highlighted');
    expect(faceState(el.querySelector('[data-testid="hand-card-2"]'))).toBe('normal');
  });

  it('staged checks the hand:<index> key and touches only that card', () => {
    const el = renderPlayerHand({
      cards: HAND,
      frozenHandIndices: [],
      selectedHandIndex: null,
      onselect: () => {},
      staged: new Set(['hand:2']),
    });
    expect(faceState(el.querySelector('[data-testid="hand-card-2"]'))).toBe('staged');
    expect(el.querySelector('[data-testid="hand-card-2"]')?.getAttribute('data-staged')).toBe('true');
    expect(el.querySelector('[data-testid="hand-card-0"]')?.getAttribute('data-staged')).toBe('false');
  });

  it('dimmedHandIndices touches only the matching index and the card stays tappable', () => {
    const seen: number[] = [];
    const el = renderPlayerHand({
      cards: HAND,
      frozenHandIndices: [],
      selectedHandIndex: null,
      onselect: (i) => seen.push(i),
      dimmedHandIndices: new Set([0]),
    });
    expect(faceState(el.querySelector('[data-testid="hand-card-0"]'))).toBe('dimmed');
    expect(faceState(el.querySelector('[data-testid="hand-card-1"]'))).toBe('normal');
    el.querySelector<HTMLButtonElement>('[data-testid="hand-card-0"]')?.click();
    flushSync();
    expect(seen).toEqual([0]);
  });

  it('omitting highlighted/staged/dimmedHandIndices entirely behaves exactly as before this round', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    for (const card of el.querySelectorAll('[data-testid^="hand-card-"]')) {
      expect(faceState(card)).toBe('normal');
    }
  });
});
