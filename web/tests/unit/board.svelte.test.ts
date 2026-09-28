// @vitest-environment jsdom
// P2 W9 — Board is presentational: `view` in, `ontap(key)` out, no store or
// bridge import (grepped below), no legal-move derivation. This file covers
// the Board brief's acceptance list end to end: every target key maps to
// the right element and fires the exact key; highlighted/staged/dimmedHand
// each render the documented state; `inert` blocks every tap; testids never
// vary with legality.
//
// `.svelte.test.ts` so the legality-toggle tests can drive ONE mounted
// instance through a `$state` props object (Svelte 5 conventions,
// docs/vendor/svelte-5-llms.txt "Component testing"; playbook "Prop-change
// tests use ONE mounted instance").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlayerView } from '../../src/lib/bridge/schema';
import Board from '../../src/lib/components/Board.svelte';
import { playerView } from './game-test-support';

const BOARD_SRC = join(__dirname, '..', '..', 'src', 'lib', 'components', 'Board.svelte');

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  view: PlayerView;
  names: [string, string];
  highlighted: ReadonlySet<string>;
  staged: ReadonlySet<string>;
  dimmedHand: ReadonlySet<number>;
  selectedHand: number | null;
  inert: boolean;
  deckEnabled: boolean;
  ontap: (key: string) => void;
  lastMoveText?: string;
}

function baseProps(overrides: Partial<RenderProps> = {}): RenderProps {
  return {
    view: playerView(),
    names: ['Ada', 'Bel'],
    highlighted: new Set<string>(),
    staged: new Set<string>(),
    dimmedHand: new Set<number>(),
    selectedHand: null,
    inert: false,
    deckEnabled: true,
    ontap: () => {},
    ...overrides,
  };
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(Board, { target: host, props });
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

function testid(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no [data-testid="${id}"] found`);
  return found;
}

/** A rich view: both sides hold hand cards, points (one Jack-stacked and
 * stolen), permanents, a non-empty scrap, and a positive deck count — every
 * key family in the Board contract's table has something to click. */
function richView(): PlayerView {
  return playerView({
    viewer: 0,
    you: {
      hand: [
        { Rank: 1, Suit: 0 },
        { Rank: 5, Suit: 1 },
        { Rank: 9, Suit: 2 },
        { Rank: 11, Suit: 3 },
      ],
      frozenHandIndices: [],
      points: [
        { Card: { Rank: 4, Suit: 0 }, Owner: 0, JackStack: [], JackOwners: [], Controller: 0 },
        {
          Card: { Rank: 6, Suit: 1 },
          Owner: 1,
          JackStack: [{ Rank: 11, Suit: 2 }],
          JackOwners: [0],
          Controller: 0,
        },
      ],
      permanents: [{ Rank: 8, Suit: 3 }],
    },
    opponent: {
      handCount: 3,
      hand: null,
      points: [
        { Card: { Rank: 7, Suit: 0 }, Owner: 1, JackStack: [], JackOwners: [], Controller: 1 },
        // Player 0's point stolen by 1: the first thief is Owner's opponent.
        { Card: { Rank: 2, Suit: 3 }, Owner: 0, JackStack: [{ Rank: 11, Suit: 1 }], JackOwners: [1], Controller: 1 },
      ],
      permanents: [{ Rank: 3, Suit: 2 }],
    },
    deckCount: 20,
    scrap: [
      { Rank: 2, Suit: 0 },
      { Rank: 10, Suit: 3 },
    ],
    scoreboard: {
      you: { points: 4, threshold: 21, kings: 0, hasWon: false },
      opponent: { points: 7, threshold: 21, kings: 1, hasWon: false },
    },
  });
}

describe('Board never imports a store or the bridge (presentational only)', () => {
  it('has no store or bridge import in source', () => {
    const src = readFileSync(BOARD_SRC, 'utf8');
    expect(src).not.toMatch(/from ['"].*stores\//);
    expect(src).not.toMatch(/from ['"].*bridge\/(engine|wasm)['"]/);
  });
});

describe('Board target keys — every key maps to the right element, ontap fires the exact key', () => {
  it('hand card taps report hand:<index>', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), ontap: (k) => seen.push(k) }));
    testid(el, 'hand-card-2').click();
    flushSync();
    expect(seen).toEqual(['hand:2']);
  });

  it('the deck taps report deck', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), ontap: (k) => seen.push(k) }));
    testid(el, 'deck-pile').click();
    flushSync();
    expect(seen).toEqual(['deck']);
  });

  it('the scrap pile taps report scrap', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), ontap: (k) => seen.push(k) }));
    testid(el, 'scrap-pile').click();
    flushSync();
    expect(seen).toEqual(['scrap']);
  });

  it('the viewer\'s own drop zones report zone:points / zone:permanents / zone:oneoff', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), ontap: (k) => seen.push(k) }));
    testid(el, 'zone-points').click();
    testid(el, 'zone-permanents').click();
    testid(el, 'zone-oneoff').click();
    flushSync();
    expect(seen).toEqual(['zone:points', 'zone:permanents', 'zone:oneoff']);
  });

  it('a point card reports point:<rowId>:<index> for both the viewer\'s and the opponent\'s row', () => {
    const seen: string[] = [];
    const view = richView();
    const el = render(baseProps({ view, ontap: (k) => seen.push(k) }));
    testid(el, `point-${view.viewer}-0`).click();
    testid(el, `point-${1 - view.viewer}-0`).click();
    flushSync();
    expect(seen).toEqual([`point:${view.viewer}:0`, `point:${1 - view.viewer}:0`]);
  });

  it('a permanent reports perm:<rowId>:<index> for both the viewer\'s and the opponent\'s row', () => {
    const seen: string[] = [];
    const view = richView();
    const el = render(baseProps({ view, ontap: (k) => seen.push(k) }));
    testid(el, `perm-${view.viewer}-0`).click();
    testid(el, `perm-${1 - view.viewer}-0`).click();
    flushSync();
    expect(seen).toEqual([`perm:${view.viewer}:0`, `perm:${1 - view.viewer}:0`]);
  });

  it('clicking a card INSIDE the viewer\'s points zone does not also fire the zone-level tap', () => {
    const seen: string[] = [];
    const view = richView();
    const el = render(baseProps({ view, ontap: (k) => seen.push(k) }));
    testid(el, `point-${view.viewer}-0`).click();
    flushSync();
    expect(seen).toEqual([`point:${view.viewer}:0`]);
  });

  it('a stolen point (Owner !== row) reports point:<rowId>:<index> on both sides, never point:<Owner>:<index> (B2)', () => {
    const seen: string[] = [];
    const view = richView();
    // you.points[1]: Owner 1, Controller 0. opponent.points[1]: Owner 0, Controller 1.
    expect(view.you.points[1].Owner).not.toBe(view.viewer);
    expect(view.opponent.points[1].Owner).toBe(view.viewer);
    const el = render(baseProps({ view, ontap: (k) => seen.push(k) }));
    testid(el, `point-${view.viewer}-1`).click();
    testid(el, `point-${1 - view.viewer}-1`).click();
    flushSync();
    expect(seen).toEqual([`point:${view.viewer}:1`, `point:${1 - view.viewer}:1`]);
  });

  it('a stolen point highlights and stages by its row key (B2)', () => {
    const view = richView();
    const opp = 1 - view.viewer;
    const el = render(
      baseProps({
        view,
        highlighted: new Set([`point:${view.viewer}:1`]),
        staged: new Set([`point:${opp}:1`]),
      }),
    );
    const faceState = (id: string) => testid(el, id).querySelector('[data-state]')?.getAttribute('data-state');
    expect(faceState(`point-${view.viewer}-1`)).toBe('highlighted');
    expect(faceState(`point-${opp}-1`)).toBe('staged');
    // The Owner-keyed spellings light nothing else.
    expect(faceState(`point-${view.viewer}-0`)).toBe('normal');
    expect(faceState(`point-${opp}-0`)).toBe('normal');
  });
});

describe('Board visual states — highlighted / staged / dimmedHand', () => {
  function faceState(container: HTMLElement): string | null {
    return container.querySelector('[data-state]')?.getAttribute('data-state') ?? null;
  }

  it('highlighted hand card renders theme state "highlighted"', () => {
    const el = render(baseProps({ view: richView(), highlighted: new Set(['hand:1']) }));
    expect(faceState(testid(el, 'hand-card-1'))).toBe('highlighted');
    expect(faceState(testid(el, 'hand-card-0'))).toBe('normal');
  });

  it('staged hand card renders theme state "staged" and the ✓ tab, not highlighted', () => {
    const el = render(baseProps({ view: richView(), highlighted: new Set(['hand:1']), staged: new Set(['hand:1']) }));
    const card = testid(el, 'hand-card-1');
    expect(faceState(card)).toBe('staged');
    expect(card.querySelector('[data-staged-tab]')).not.toBeNull();
  });

  it('dimmedHand renders theme state "dimmed" and stays tappable', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), dimmedHand: new Set([3]), ontap: (k) => seen.push(k) }));
    const card = testid(el, 'hand-card-3');
    expect(faceState(card)).toBe('dimmed');
    card.click();
    flushSync();
    expect(seen).toEqual(['hand:3']);
  });

  it('a point card in the highlighted/staged sets renders the matching theme state', () => {
    const view = richView();
    const key = `point:${view.viewer}:0`;
    const el = render(baseProps({ view, highlighted: new Set([key]) }));
    expect(faceState(testid(el, `point-${view.viewer}-0`))).toBe('highlighted');
    expect(faceState(testid(el, `point-${view.viewer}-1`))).toBe('normal');
  });

  it('a permanent in the staged set renders theme state "staged"', () => {
    const view = richView();
    const key = `perm:${view.viewer}:0`;
    const el = render(baseProps({ view, staged: new Set([key]) }));
    expect(faceState(testid(el, `perm-${view.viewer}-0`))).toBe('staged');
  });

  it('deck highlighted/staged/neither renders the matching data-state; the ring needs the deck key', () => {
    const view = richView();
    let el = render(baseProps({ view, highlighted: new Set(['deck']) }));
    expect(testid(el, 'deck-pile').getAttribute('data-state')).toBe('highlighted');

    el = render(baseProps({ view, staged: new Set(['deck']) }));
    expect(testid(el, 'deck-pile').getAttribute('data-state')).toBe('staged');

    el = render(baseProps({ view }));
    expect(testid(el, 'deck-pile').getAttribute('data-state')).toBe('normal');
  });

  it('deck disabled styling follows deckEnabled, not highlighting', () => {
    const view = richView();
    let el = render(baseProps({ view, deckEnabled: true }));
    expect(testid(el, 'deck-pile').getAttribute('data-disabled')).toBe('false');
    expect(testid(el, 'deck-pile').getAttribute('data-state')).toBe('normal');

    el = render(baseProps({ view, deckEnabled: false, highlighted: new Set(['deck']) }));
    expect(testid(el, 'deck-pile').getAttribute('data-disabled')).toBe('true');
  });

  it('a disabled deck is still tappable (only inert blocks)', () => {
    const seen: string[] = [];
    const el = render(baseProps({ view: richView(), deckEnabled: false, ontap: (k) => seen.push(k) }));
    testid(el, 'deck-pile').click();
    flushSync();
    expect(seen).toEqual(['deck']);
  });

  it('scrap staged renders "staged" on the scrap face', () => {
    const view = richView();
    const el = render(baseProps({ view, staged: new Set(['scrap']) }));
    expect(faceState(testid(el, 'scrap-pile'))).toBe('staged');
  });

  it('scrap highlighted renders "highlighted" on the scrap face (M38)', () => {
    const view = richView();
    const el = render(baseProps({ view, highlighted: new Set(['scrap']) }));
    expect(faceState(testid(el, 'scrap-pile'))).toBe('highlighted');
  });

  it('zone:oneoff highlighted lights only the one-off zone (M39)', () => {
    const el = render(baseProps({ view: richView(), highlighted: new Set(['zone:oneoff']) }));
    expect(testid(el, 'zone-oneoff').getAttribute('data-state')).toBe('highlighted');
    expect(testid(el, 'zone-points').getAttribute('data-state')).toBe('normal');
  });

  it('zone:points highlighted does not light the one-off zone (M39)', () => {
    const el = render(baseProps({ view: richView(), highlighted: new Set(['zone:points']) }));
    expect(testid(el, 'zone-oneoff').getAttribute('data-state')).toBe('normal');
  });

  it('zone:oneoff staged renders "staged" on the one-off zone (M35)', () => {
    const el = render(baseProps({ view: richView(), staged: new Set(['zone:oneoff']) }));
    expect(testid(el, 'zone-oneoff').getAttribute('data-state')).toBe('staged');
  });

  it('zone:oneoff in both sets renders "staged"', () => {
    const el = render(
      baseProps({ view: richView(), highlighted: new Set(['zone:oneoff']), staged: new Set(['zone:oneoff']) }),
    );
    expect(testid(el, 'zone-oneoff').getAttribute('data-state')).toBe('staged');
  });

  it('the viewer\'s drop zones show a ring (data-state) and label only when highlighted or staged', () => {
    const view = richView();
    let el = render(baseProps({ view }));
    expect(testid(el, 'zone-points').getAttribute('data-state')).toBe('normal');
    expect(testid(el, 'zone-points').querySelector('[data-drop-label]')).toBeNull();

    el = render(baseProps({ view, highlighted: new Set(['zone:points']) }));
    expect(testid(el, 'zone-points').getAttribute('data-state')).toBe('highlighted');
    expect(testid(el, 'zone-points').querySelector('[data-drop-label]')).not.toBeNull();

    el = render(baseProps({ view, staged: new Set(['zone:permanents']) }));
    expect(testid(el, 'zone-permanents').getAttribute('data-state')).toBe('staged');
  });

  it('precedence on one instance: normal -> highlighted -> staged -> frozen wins over everything for the same hand card', () => {
    const view = richView();
    const props = $state(
      baseProps({ view, dimmedHand: new Set([0]), highlighted: new Set(), staged: new Set() }),
    );
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(Board, { target: host, props });
    flushSync();
    expect(faceState(testid(host, 'hand-card-0'))).toBe('dimmed');

    props.highlighted = new Set(['hand:0']);
    flushSync();
    expect(faceState(testid(host, 'hand-card-0'))).toBe('highlighted');

    props.staged = new Set(['hand:0']);
    flushSync();
    expect(faceState(testid(host, 'hand-card-0'))).toBe('staged');

    props.view = { ...view, you: { ...view.you, frozenHandIndices: [0] } };
    flushSync();
    expect(faceState(testid(host, 'hand-card-0'))).toBe('frozen');
  });
});

describe('Board inert — every tap is a no-op', () => {
  it('blocks hand, deck, scrap, every zone and both sides\' point/permanent taps alike (M11)', () => {
    const seen: string[] = [];
    const view = richView();
    const opp = 1 - view.viewer;
    const el = render(
      baseProps({
        view,
        inert: true,
        // Everything lit, so no element could plausibly be skipped for being inactive.
        highlighted: new Set(['zone:oneoff', 'zone:points', 'zone:permanents', 'deck', 'scrap']),
        ontap: (k) => seen.push(k),
      }),
    );
    testid(el, 'hand-card-0').click();
    testid(el, 'deck-pile').click();
    testid(el, 'scrap-pile').click();
    testid(el, 'zone-points').click();
    testid(el, 'zone-permanents').click();
    testid(el, 'zone-oneoff').click();
    testid(el, `point-${view.viewer}-0`).click();
    testid(el, `perm-${view.viewer}-0`).click();
    testid(el, `point-${opp}-0`).click();
    testid(el, `perm-${opp}-0`).click();
    flushSync();
    expect(seen).toEqual([]);
  });

  it('keyboard on the one-off zone is inert too (native button: Enter/Space activate as click)', () => {
    const seen: string[] = [];
    const el = render(
      baseProps({ view: richView(), inert: true, highlighted: new Set(['zone:oneoff']), ontap: (k) => seen.push(k) }),
    );
    const zone = testid(el, 'zone-oneoff');
    expect(zone.tagName).toBe('BUTTON');
    expect(zone.tabIndex).toBe(0);
    zone.focus();
    for (const key of ['Enter', ' ']) {
      zone.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      zone.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }
    // A browser turns Enter/Space on a focused <button> into a click.
    zone.click();
    flushSync();
    expect(seen).toEqual([]);
  });

  it('the same taps all reach ontap when not inert (the guard, not the elements, blocks)', () => {
    const seen: string[] = [];
    const view = richView();
    const opp = 1 - view.viewer;
    const el = render(baseProps({ view, ontap: (k) => seen.push(k) }));
    testid(el, 'zone-oneoff').click();
    testid(el, `point-${opp}-0`).click();
    testid(el, `perm-${opp}-0`).click();
    flushSync();
    expect(seen).toEqual(['zone:oneoff', `point:${opp}:0`, `perm:${opp}:0`]);
  });

  it('exposes data-inert on the board root', () => {
    const el = render(baseProps({ view: richView(), inert: true }));
    expect(testid(el, 'board').getAttribute('data-inert')).toBe('true');
  });
});

describe('Board testids are stable across legality changes (playbook "Testids and tap targets")', () => {
  it('the full testid set is unchanged whether or not anything is highlighted/staged/dimmed', () => {
    const view = richView();
    const idsOf = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')).sort();

    const bare = render(baseProps({ view }));
    const bareIds = idsOf(bare);

    const lit = render(
      baseProps({
        view,
        highlighted: new Set(['hand:0', 'deck', 'scrap', 'zone:points', `point:${view.viewer}:0`]),
        staged: new Set([`perm:${view.viewer}:0`]),
        dimmedHand: new Set([1, 2]),
      }),
    );
    expect(idsOf(lit)).toEqual(bareIds);
    expect(bareIds.length).toBeGreaterThan(0);
  });
});

describe('JackStack and the ownership marker (SPEC §5.2)', () => {
  it('renders a mini Face per JackStack card and a marker only when Controller differs from Owner', () => {
    const view = richView();
    const el = render(baseProps({ view }));
    // view.you.points[1] is Jack-stacked and stolen (Owner 1, Controller 0).
    const stolenCard = testid(el, `point-${view.viewer}-1`);
    const stolenSlot = stolenCard.closest('.point-row__slot')!;
    expect(stolenSlot.querySelectorAll('.point-row__jack').length).toBe(1);
    expect(stolenSlot.querySelector('[data-owner-marker]')).not.toBeNull();
    expect(stolenSlot.querySelector('[data-owner-marker]')?.getAttribute('data-owner')).toBe('1');

    // view.you.points[0] is a plain, un-stolen point: no jacks, no marker.
    const ownCard = testid(el, `point-${view.viewer}-0`);
    const ownSlot = ownCard.closest('.point-row__slot')!;
    expect(ownSlot.querySelectorAll('.point-row__jack').length).toBe(0);
    expect(ownSlot.querySelector('[data-owner-marker]')).toBeNull();
  });

  it('each Jack\'s mini face shows the JackStack card on both sides, not the point card (M41)', () => {
    const view = richView();
    const el = render(baseProps({ view }));
    for (const id of [`point-${view.viewer}-1`, `point-${1 - view.viewer}-1`]) {
      const card = testid(el, id);
      const jackRanks = [...card.querySelectorAll('.point-row__jack [data-size="mini"]')].map(
        (f) => f.firstElementChild?.textContent,
      );
      expect(jackRanks).toEqual(['J']);
      expect(card.querySelector('.point-row__face [data-state]')?.firstElementChild?.textContent).not.toBe('J');
    }
  });
});

describe('Last-move line (design §6: centre strip middle slot, one line, no testid)', () => {
  function line(el: HTMLElement): HTMLElement {
    const found = el.querySelector<HTMLElement>('.center-zone__last-move');
    if (!found) throw new Error('no last-move line');
    return found;
  }

  it('renders lastMoveText in the one-off slot, not in the scrap pile', () => {
    const el = render(baseProps({ view: richView(), lastMoveText: 'Bel scuttled your 4.' }));
    const l = line(el);
    expect(l.textContent).toBe('Bel scuttled your 4.');
    expect(testid(el, 'zone-oneoff').parentElement?.contains(l)).toBe(true);
    expect(testid(el, 'scrap-pile').parentElement?.contains(l)).toBe(false);
  });

  it('carries no testid and is not interactive', () => {
    const el = render(baseProps({ view: richView(), lastMoveText: 'Bel drew a card.' }));
    const l = line(el);
    expect(l.hasAttribute('data-testid')).toBe(false);
    expect(l.closest('button')).toBeNull();
    expect(l.hasAttribute('tabindex')).toBe(false);
    expect(el.querySelector('[data-testid="last-move-text"]')).toBeNull();
  });

  it('the line slot stays in the DOM (fixed height) with or without text', () => {
    const el = render(baseProps({ view: richView() }));
    expect(line(el).textContent).toBe('');
  });

  it('gives way to the drop-zone label while the one-off zone is highlighted or staged', () => {
    const view = richView();
    let el = render(baseProps({ view, lastMoveText: 'Bel drew a card.', highlighted: new Set(['zone:oneoff']) }));
    expect(line(el).textContent).toBe('');
    expect(testid(el, 'zone-oneoff').querySelector('[data-drop-label]')).not.toBeNull();

    el = render(baseProps({ view, lastMoveText: 'Bel drew a card.', staged: new Set(['zone:oneoff']) }));
    expect(line(el).textContent).toBe('');
  });

  it('adding lastMoveText adds no testid (testid set unchanged)', () => {
    const view = richView();
    const idsOf = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')).sort();
    const without = idsOf(render(baseProps({ view })));
    const withText = idsOf(render(baseProps({ view, lastMoveText: 'x'.repeat(300) })));
    expect(withText).toEqual(without);
  });
});

describe('ScoreBar shows the view\'s numbers verbatim (SPEC §3.3 rule 2)', () => {
  it('renders points/threshold for both sides and a King pip per King, with no recomputation', () => {
    const view = richView();
    const el = render(baseProps({ view, names: ['Ada', 'Bel'] }));
    const bar = testid(el, 'score-bar');
    expect(bar.textContent).toContain('4');
    expect(bar.textContent).toContain('of 21');
    expect(bar.textContent).toContain('Bel');
    expect(bar.textContent).toContain('7');
    expect(bar.querySelector('[data-kings]')?.getAttribute('data-kings')).toBe('1');
  });
});

describe('OpponentHand redaction — null, [] and face-up all render correctly', () => {
  it('null hand renders handCount backs; visible [] renders zero faces; visible non-empty renders faces', () => {
    const hiddenView = richView();
    let el = render(baseProps({ view: hiddenView }));
    let hand = testid(el, 'opp-hand');
    expect(hand.getAttribute('data-revealed')).toBe('false');
    expect(hand.querySelectorAll('[data-state]').length).toBe(0); // backs carry no state
    expect(hand.textContent).toContain('3 cards');

    const emptyVisible = playerView({ ...hiddenView, opponent: { ...hiddenView.opponent, hand: [], handCount: 0 } });
    el = render(baseProps({ view: emptyVisible }));
    hand = testid(el, 'opp-hand');
    expect(hand.getAttribute('data-revealed')).toBe('true');
    expect(hand.querySelectorAll('[data-state]').length).toBe(0);
    expect(hand.textContent).toContain('0 cards');

    const faceUp = playerView({
      ...hiddenView,
      opponent: { ...hiddenView.opponent, hand: [{ Rank: 5, Suit: 2 }], handCount: 1 },
    });
    el = render(baseProps({ view: faceUp }));
    hand = testid(el, 'opp-hand');
    expect(hand.getAttribute('data-revealed')).toBe('true');
    expect(hand.querySelectorAll('[data-state]').length).toBe(1);
    expect(hand.textContent).toContain('1 cards');
  });
});
