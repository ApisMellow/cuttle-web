// @vitest-environment jsdom
// P2 W9 — ScrapPile: top card is the LAST element of `cards` (SPEC §2.7:
// "scrap: Card[]; index 0 = bottom"), plus a count. The last-move line lives
// in CenterZone's middle slot (docs/design.md §6; revise 1 ruling).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import ScrapPile from '../../src/lib/components/ScrapPile.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: {
  cards: Card[];
  highlighted: boolean;
  staged: boolean;
  ontap: () => void;
}): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(ScrapPile, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function well(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="scrap-pile"]');
  if (!found) throw new Error('no scrap-pile rendered');
  return found;
}

describe('ScrapPile (docs/SPEC.md §2.7, Board brief)', () => {
  it('renders the LAST card in `cards` as the top, face up through the theme', () => {
    const cards: Card[] = [
      { Rank: 2, Suit: 0 },
      { Rank: 9, Suit: 3 },
    ];
    const el = render({ cards, highlighted: false, staged: false, ontap: () => {} });
    const face = well(el).querySelector('[data-state]');
    expect(face).not.toBeNull();
    expect(el.textContent).toContain('9'); // the top card (last element), not the bottom
  });

  it('shows the count, including zero for an empty scrap with no top face', () => {
    const el = render({ cards: [], highlighted: false, staged: false, ontap: () => {} });
    expect(el.textContent).toContain('0');
    expect(well(el).querySelector('[data-state]')).toBeNull();
  });

  it('reflects highlighted/staged on the top face', () => {
    const cards: Card[] = [{ Rank: 5, Suit: 1 }];
    let el = render({ cards, highlighted: true, staged: false, ontap: () => {} });
    expect(well(el).querySelector('[data-state]')?.getAttribute('data-state')).toBe('highlighted');
    el = render({ cards, highlighted: true, staged: true, ontap: () => {} });
    expect(well(el).querySelector('[data-state]')?.getAttribute('data-state')).toBe('staged');
  });

  it('taps report through ontap', () => {
    let count = 0;
    const el = render({ cards: [], highlighted: false, staged: false, ontap: () => count++ });
    well(el).click();
    flushSync();
    expect(count).toBe(1);
  });

  it('holds no last-move line (revise 1: it moved to the centre strip\'s middle slot)', () => {
    const el = render({ cards: [{ Rank: 5, Suit: 1 }], highlighted: false, staged: false, ontap: () => {} });
    expect(el.querySelector('p')).toBeNull();
    expect(el.querySelector('[data-testid="last-move-text"]')).toBeNull();
    expect([...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))).toEqual(['scrap-pile']);
  });
});
