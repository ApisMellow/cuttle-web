// @vitest-environment jsdom
// W24 (the "glasses" 8). An 8 played as a permanent is glasses (SPEC §3.2:
// Permanents holds only Queens, Kings and glasses-8s, so any 8 there is
// glasses). It lies sideways in the permanent row and draws the vector
// theme's `variant="glasses"` face: goggles on a suit-tinted stained-glass
// ground, no rank number. An 8 played for points is an ordinary card and
// keeps the ordinary face.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card, PointEntry } from '../../src/lib/bridge/schema';
import PermanentRow from '../../src/lib/components/PermanentRow.svelte';
import PointRow from '../../src/lib/components/PointRow.svelte';
import { DEFAULT_THEME_ID, getTheme, vectorTheme } from '../../src/lib/theme';
import type { CardFaceProps } from '../../src/lib/theme/types';

const theme = getTheme(DEFAULT_THEME_ID);

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function freshHost(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  return host;
}

function mountFace(props: CardFaceProps): HTMLDivElement {
  const el = freshHost();
  instance = mount(vectorTheme.Face, { target: el, props });
  flushSync();
  return el;
}

function mountPermanents(rowId: 0 | 1, cards: Card[], ontap: (key: string) => void = () => {}): HTMLDivElement {
  const el = freshHost();
  instance = mount(PermanentRow, {
    target: el,
    props: {
      rowId,
      cards,
      label: 'Permanents',
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      ontap,
      theme,
    },
  });
  flushSync();
  return el;
}

function mountPoints(entries: PointEntry[]): HTMLDivElement {
  const el = freshHost();
  instance = mount(PointRow, {
    target: el,
    props: {
      rowId: 0,
      entries,
      pointTotal: 8,
      label: 'Points',
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      ontap: () => {},
      theme,
    },
  });
  flushSync();
  return el;
}

function faceRoot(el: HTMLElement): HTMLElement {
  const root = el.querySelector<HTMLElement>('[data-state]');
  if (!root) throw new Error('no face root');
  return root;
}

describe('vector theme: the glasses face variant', () => {
  for (const suit of [0, 1, 2, 3] as const) {
    it(`suit ${suit}: draws goggles (an inline svg), marks the variant and the suit tint, and shows no rank`, () => {
      const el = mountFace({ card: { Rank: 8, Suit: suit }, size: 'field', variant: 'glasses' });
      const root = faceRoot(el);
      expect(root.getAttribute('data-variant')).toBe('glasses');
      expect(root.getAttribute('data-size')).toBe('field');
      expect(root.getAttribute('data-state')).toBe('normal');
      expect(root.getAttribute('data-tint')).toBe(['clubs', 'diamonds', 'hearts', 'spades'][suit]);
      expect(root.querySelector('svg')).not.toBeNull();
      expect(root.querySelector('.cuttle-card-face__rank')).toBeNull();
      expect(el.textContent ?? '').not.toMatch(/8/);
    });
  }

  it('honours the state it is given, like the standard face', () => {
    const el = mountFace({ card: { Rank: 8, Suit: 2 }, size: 'field', state: 'highlighted', variant: 'glasses' });
    expect(faceRoot(el).getAttribute('data-state')).toBe('highlighted');
  });

  it('with no variant, an 8 is the standard face with its rank', () => {
    const el = mountFace({ card: { Rank: 8, Suit: 2 }, size: 'field' });
    const root = faceRoot(el);
    expect(root.getAttribute('data-variant')).toBe('standard');
    expect(root.querySelector('.cuttle-card-face__rank')?.textContent).toBe('8');
  });
});

describe('PermanentRow: a glasses 8 lies sideways', () => {
  it('renders the 8 sideways with the glasses face and no rank text; a Queen beside it stays upright and standard', () => {
    const el = mountPermanents(1, [
      { Rank: 12, Suit: 3 },
      { Rank: 8, Suit: 2 },
    ]);
    const queen = el.querySelector<HTMLElement>('[data-testid="perm-1-0"]')!;
    const glasses = el.querySelector<HTMLElement>('[data-testid="perm-1-1"]')!;

    expect(glasses.getAttribute('data-orientation')).toBe('sideways');
    expect(glasses.classList.contains('permanent-row__card--sideways')).toBe(true);
    expect(faceRoot(glasses).getAttribute('data-variant')).toBe('glasses');
    // The face carries no rank (design.md: suit tint and pip only); the
    // in-play badge names the 8 (playtest 2026-09-29, "8 Sees hand").
    expect(faceRoot(glasses).textContent ?? '').not.toMatch(/8/);
    expect(glasses.querySelector('[data-card-label="badge"]')?.textContent).toBe('8 Sees hand');

    expect(queen.getAttribute('data-orientation')).toBe('upright');
    expect(queen.classList.contains('permanent-row__card--sideways')).toBe(false);
    expect(faceRoot(queen).getAttribute('data-variant')).toBe('standard');
    expect(queen.textContent).toContain('Q');
  });

  it('a tap on the sideways 8 fires its own perm:<rowId>:<index> key (e.g. as the target of a 2 or a 9)', () => {
    const seen: string[] = [];
    const el = mountPermanents(
      1,
      [
        { Rank: 13, Suit: 0 },
        { Rank: 8, Suit: 1 },
      ],
      (k) => seen.push(k),
    );
    el.querySelector<HTMLElement>('[data-testid="perm-1-1"]')!.click();
    flushSync();
    expect(seen).toEqual(['perm:1:1']);
  });
});

describe('PointRow: an 8 played for points is not glasses', () => {
  it('keeps the standard face, upright, with its rank', () => {
    const el = mountPoints([{ Card: { Rank: 8, Suit: 2 }, JackStack: [], JackOwners: [], Owner: 0, Controller: 0 }]);
    const cardEl = el.querySelector<HTMLElement>('[data-testid="point-0-0"]')!;
    const root = faceRoot(cardEl);
    expect(root.getAttribute('data-variant')).toBe('standard');
    expect(cardEl.querySelector('[data-variant="glasses"]')).toBeNull();
    expect(cardEl.getAttribute('data-orientation')).not.toBe('sideways');
    expect(root.querySelector('.cuttle-card-face__rank')?.textContent).toBe('8');
  });
});
