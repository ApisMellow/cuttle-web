// @vitest-environment jsdom
// P2 W9 (SPEC §3.2, §5.6, Board brief) — OpponentHand redaction: `null` is
// hidden (CardBacks, which carry no card identity), `[]` is visible-but-
// empty, and a non-empty array is visible face-up. `handCount` is always
// the numeral shown, independent of which branch renders.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import OpponentHand from '../../src/lib/components/OpponentHand.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: { handCount: number; hand: Card[] | null }): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(OpponentHand, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function hand(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="opp-hand"]');
  if (!found) throw new Error('no opp-hand rendered');
  return found;
}

describe('OpponentHand redaction (SPEC §3.2)', () => {
  it('null (hidden): renders handCount CardBacks, none carrying a card identity', () => {
    const el = render({ handCount: 4, hand: null });
    const root = hand(el);
    expect(root.getAttribute('data-revealed')).toBe('false');
    expect(root.querySelectorAll('.opponent-hand__card').length).toBe(4);
    // A CardBack root has no [data-state] (only CardFaceProps carries state).
    expect(root.querySelectorAll('[data-state]').length).toBe(0);
    expect(root.textContent).toContain('4 cards');
  });

  it('[] (visible, empty): renders zero faces, not zero backs, count still 0', () => {
    const el = render({ handCount: 0, hand: [] });
    const root = hand(el);
    expect(root.getAttribute('data-revealed')).toBe('true');
    expect(root.querySelectorAll('.opponent-hand__card').length).toBe(0);
    expect(root.textContent).toContain('0 cards');
  });

  it('non-empty array (visible, glasses-8): renders those cards face up through the theme', () => {
    const cardsUp: Card[] = [
      { Rank: 1, Suit: 0 },
      { Rank: 13, Suit: 3 },
    ];
    const el = render({ handCount: 2, hand: cardsUp });
    const root = hand(el);
    expect(root.getAttribute('data-revealed')).toBe('true');
    const faces = [...root.querySelectorAll('[data-state]')];
    expect(faces.length).toBe(2);
    expect(faces.every((f) => f.getAttribute('data-state') === 'normal')).toBe(true);
    expect(root.textContent).toContain('2 cards');
  });

  it('handCount is the numeral shown even when it does not match hand.length (defensive: this component trusts its own prop, not a derived length)', () => {
    const el = render({ handCount: 6, hand: [{ Rank: 4, Suit: 1 }] });
    expect(hand(el).textContent).toContain('6 cards');
  });
});

describe('#94: inspect exposed cards', () => {
  const cardsUp: Card[] = [
    { Rank: 1, Suit: 0 },
    { Rank: 13, Suit: 3 },
  ];
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const open = () => {
    q('opp-hand-inspect')!.click();
    flushSync();
  };

  it('hidden and empty hands have no tap target and no sheet', () => {
    render({ handCount: 3, hand: null });
    expect(q('opp-hand-inspect')).toBeNull();
    expect(q('opp-hand-sheet')).toBeNull();
    cleanupOnly();
    render({ handCount: 0, hand: [] });
    expect(q('opp-hand-inspect')).toBeNull();
  });

  it('revealed: tap lists name and effect per card in hand order', () => {
    render({ handCount: 2, hand: cardsUp });
    expect(q('opp-hand-sheet')).toBeNull();
    open();
    const sheet = q('opp-hand-sheet')!;
    expect([...sheet.querySelectorAll('[data-opp-sheet="name"]')].map((n) => n.textContent)).toEqual(['Board Wipe', 'Shortcut']);
    expect([...sheet.querySelectorAll('[data-opp-sheet="effect"]')].map((n) => n.textContent)).toEqual([
      'One-off: scrap every point card.',
      'Permanent: you need fewer points to win.',
    ]);
  });

  it('closes with the button, Escape and the scrim', () => {
    render({ handCount: 2, hand: cardsUp });
    open();
    q('opp-hand-sheet-close')!.click();
    flushSync();
    expect(q('opp-hand-sheet')).toBeNull();
    open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(q('opp-hand-sheet')).toBeNull();
    open();
    q('opp-hand-sheet-scrim')!.click();
    flushSync();
    expect(q('opp-hand-sheet')).toBeNull();
  });
});

function cleanupOnly(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

describe('W25: count noun agrees with the number', () => {
  it('"1 card", never "1 cards"', () => {
    const el = render({ handCount: 1, hand: null });
    expect(hand(el).textContent).toContain('1 card');
    expect(hand(el).textContent).not.toContain('1 cards');
  });
});
