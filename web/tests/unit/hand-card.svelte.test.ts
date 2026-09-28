// @vitest-environment jsdom
// R8.2 — HandCard's frozen state is driven SOLELY by
// `view.you.frozenHandIndices` membership, including the OQ-13
// self-freeze-then-clear-before-next-turn case, with no additional logic
// layered on top (SPEC §2.8(c), §8 OQ-13).
//
// `.svelte.test.ts` so the OQ-13 test can drive ONE mounted instance through
// a `$state` props object: a component that remembers "was frozen" (a latch)
// only shows up when the same instance sees the array change.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import HandCard from '../../src/lib/components/HandCard.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  card: Card;
  handIndex: number;
  frozenHandIndices: number[];
  selected?: boolean;
  onselect?: (handIndex: number) => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(HandCard, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(cleanup);

function button(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('button[data-testid^="hand-card-"]');
  if (!found) throw new Error('no hand-card button rendered');
  return found;
}

/** The theme Face root: the CardFaceProps contract puts `data-state` on it. */
function faceState(el: HTMLElement): string | null | undefined {
  return button(el).querySelector('[data-state]')?.getAttribute('data-state');
}

function frozenMarker(el: HTMLElement): Element | null {
  return button(el).querySelector('[data-frozen-marker]');
}

/** Every observable facet of "frozen" must agree. */
function expectFrozen(el: HTMLElement, frozen: boolean): void {
  expect(button(el).getAttribute('data-frozen')).toBe(frozen ? 'true' : 'false');
  expect(faceState(el) === 'frozen').toBe(frozen);
  expect(frozenMarker(el) !== null).toBe(frozen);
}

// Deliberately varied: a 2 (the rank the reviewer's mutation special-cased),
// an Ace, a 9 (the OQ-13 card), a Jack and a King across all four suits.
const CARDS: Card[] = [
  { Rank: 2, Suit: 0 },
  { Rank: 1, Suit: 2 },
  { Rank: 9, Suit: 1 },
  { Rank: 11, Suit: 3 },
  { Rank: 13, Suit: 2 },
];

describe('HandCard frozen state is exactly frozenHandIndices membership (R8.2)', () => {
  const frozenLists: number[][] = [[], [0], [1, 3], [0, 1, 2, 3, 4], [7]];
  for (const [cardPos, card] of CARDS.entries()) {
    for (const withCallback of [true, false]) {
      for (const selected of [false, true]) {
        it(`card ${card.Rank}/${card.Suit} at index ${cardPos}, onselect=${withCallback}, selected=${selected}`, () => {
          for (const frozenHandIndices of frozenLists) {
            const el = render({
              card,
              handIndex: cardPos,
              frozenHandIndices,
              selected,
              onselect: withCallback ? () => {} : undefined,
            });
            expectFrozen(el, frozenHandIndices.includes(cardPos));
          }
        });
      }
    }
  }

  it('selected renders highlighted (not frozen) when the index is not frozen', () => {
    const el = render({ card: CARDS[2], handIndex: 4, frozenHandIndices: [], selected: true });
    expect(faceState(el)).toBe('highlighted');
    expectFrozen(el, false);
  });

  it('unselected, unfrozen renders normal', () => {
    const el = render({ card: CARDS[2], handIndex: 4, frozenHandIndices: [1], selected: false });
    expect(faceState(el)).toBe('normal');
  });
});

describe('OQ-13 on a single mounted instance (SPEC §8 OQ-13)', () => {
  it('a self-freeze appears and then clears on the SAME instance when the array clears', () => {
    // From the owner's seat: they play a 9 on their own Jack-stolen point;
    // the point card returns to THEIR hand at index 3 with a freeze
    // (engine sets it on pe.Owner). Across the opponent's turn the owner's
    // view shows it frozen; engine endTurn has cleared FrozenIDs by the
    // time the owner's next turn arrives. Each step hands HandCard a fresh
    // view object, as a re-fetched PlayerView would.
    const props: RenderProps = $state({
      card: { Rank: 9, Suit: 1 },
      handIndex: 3,
      frozenHandIndices: [],
      onselect: () => {},
    });
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(HandCard, { target: host, props });
    flushSync();

    const sameButton = button(host);

    // 1. Owner's turn, before the 9 resolves: nothing frozen.
    expectFrozen(host, false);

    // 2. The 9 resolves; opponent's turn from the owner's view: frozen.
    props.card = { Rank: 9, Suit: 1 };
    props.frozenHandIndices = [3];
    flushSync();
    expectFrozen(host, true);
    expect(button(host)).toBe(sameButton);

    // 3. Owner's next turn: the engine cleared it. No memory of step 2.
    props.card = { Rank: 9, Suit: 1 };
    props.frozenHandIndices = [];
    flushSync();
    expectFrozen(host, false);
    expect(faceState(host)).toBe('normal');
    expect(button(host)).toBe(sameButton);
  });

  it('tracks membership on every change, not just the first: [] → [3] → [0] → [3] → []', () => {
    const props: RenderProps = $state({ card: { Rank: 2, Suit: 0 }, handIndex: 3, frozenHandIndices: [] });
    host = document.createElement('div');
    instance = mount(HandCard, { target: host, props });
    flushSync();
    for (const next of [[3], [0], [3], [], [3, 0], []]) {
      props.frozenHandIndices = next;
      flushSync();
      expectFrozen(host, next.includes(3));
    }
  });
});

describe('HandCard interaction and testids (SPEC §5.1, §5.9)', () => {
  it('calls onselect with its own handIndex on click', () => {
    const seen: number[] = [];
    const el = render({
      card: CARDS[0],
      handIndex: 6,
      frozenHandIndices: [],
      onselect: (handIndex) => seen.push(handIndex),
    });
    button(el).click();
    flushSync();
    expect(seen).toEqual([6]);
  });

  it('carries a stable hand-card-N testid on the button', () => {
    const el = render({ card: CARDS[0], handIndex: 5, frozenHandIndices: [] });
    expect(button(el).getAttribute('data-testid')).toBe('hand-card-5');
  });

  it('the button is the ONLY [data-testid] element, frozen or not (44px sweep, §5.9/§7.4)', () => {
    for (const frozenHandIndices of [[], [5]]) {
      const el = render({ card: CARDS[1], handIndex: 5, frozenHandIndices });
      const ids = [...el.querySelectorAll('[data-testid]')];
      expect(ids.length).toBe(1);
      expect(ids[0].tagName).toBe('BUTTON');
    }
  });

  it('the frozen marker is visible content for the owner, not an aria-hidden-only artefact', () => {
    const el = render({ card: CARDS[1], handIndex: 2, frozenHandIndices: [2] });
    const marker = frozenMarker(el);
    expect(marker?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
