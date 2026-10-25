// @vitest-environment jsdom
// Issue #106: the suit-order reference strip (icons only) and its host.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import ScoreBar from '../../src/lib/components/ScoreBar.svelte';
import { SuitOrder } from '../../src/lib/theme';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function render(component: typeof SuitOrder | typeof ScoreBar, props: object): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(component as typeof SuitOrder, { target: host, props: props as never });
  flushSync();
  return host;
}

const SPADE = String.fromCodePoint(0x2660);
const HEART = String.fromCodePoint(0x2665);
const DIAMOND = String.fromCodePoint(0x2666);
const CLUB = String.fromCodePoint(0x2663);

describe('SuitOrder (#106)', () => {
  it('shows spades, hearts, diamonds, clubs in that order, labelled for screen readers', () => {
    const el = render(SuitOrder, {});
    const strip = el.querySelector<HTMLElement>('[data-suit-order]');
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute('role')).toBe('img');
    expect(strip?.getAttribute('aria-label')).toBe('Suit order: spades, hearts, diamonds, clubs');
    const suits = [...(strip?.children ?? [])] as HTMLElement[];
    expect(suits.map((s) => s.textContent)).toEqual([SPADE, HEART, DIAMOND, CLUB]);
    expect(suits.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(strip?.textContent).toBe(`${SPADE}${HEART}${DIAMOND}${CLUB}`);
  });

  it('colours hearts and diamonds red and spades and clubs not', () => {
    const el = render(SuitOrder, {});
    const suits = [...el.querySelectorAll<HTMLElement>('.suit-order__suit')];
    expect(suits.map((s) => s.classList.contains('suit-order__suit--red'))).toEqual([false, true, true, false]);
  });

  it('renders no testid (it is not a tap target)', () => {
    const el = render(SuitOrder, {});
    expect(el.querySelectorAll('[data-testid]').length).toBe(0);
  });
});

describe('ScoreBar hosts the strip (#106)', () => {
  it('has [data-suit-order] inside the score bar during play', () => {
    const el = render(ScoreBar, {
      scoreboard: {
        you: { points: 0, threshold: 21, kings: 0, hasWon: false },
        opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
      },
      opponentName: 'Blake',
    });
    expect(el.querySelectorAll('[data-testid="score-bar"] [data-suit-order]').length).toBe(1);
  });
});
