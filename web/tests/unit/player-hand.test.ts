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

  it('renders every card through the theme <Face> — one Face root (data-state) per hand card', () => {
    const el = renderPlayerHand({ cards: HAND, frozenHandIndices: [], selectedHandIndex: null, onselect: () => {} });
    const buttons = [...el.querySelectorAll('[data-testid^="hand-card-"]')];
    expect(buttons.map((b) => b.querySelectorAll('[data-state]').length)).toEqual([1, 1, 1]);
  });
});
