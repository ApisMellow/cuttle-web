// @vitest-environment jsdom
// SPEC §4.6 (R20), docs/design.md §8 — RecapPanel, and the formatter-owned
// `recapCards` helper that decides which cards a recap line shows as
// `mini` faces.
//
// Fixtures are wire-true (engine v0.2.0, SPEC §2.7) and built through the
// shared `appliedMove()` factory:
//   - `card` is null for Draw, Pass, Decline and DiscardPair;
//   - `card` is the played card for OneOff, PlayPermanent, PlayPoint,
//     Scuttle and Counter;
//   - for SevenPick, `card` is the chosen revealed card, or the scrapped
//     card on a dead end (the unchosen card never enters an AppliedMove);
//   - `targetCard` is the target, or null.
//   - `index` only on the viewer's own entries.
//
// `entries` is treated as already filtered (unseen + isRecapVisible) by the
// caller; this component never filters.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, PlayerId } from '../../src/lib/bridge/schema';
import { formatRecapLine, recapCards } from '../../src/lib/recap';
import { DEFAULT_THEME_ID, getTheme } from '../../src/lib/theme';
import RecapPanel from '../../src/lib/components/RecapPanel.svelte';
import { appliedMove, Kind } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Blake'];

// Suits: 0 ♣, 1 ♦, 2 ♥, 3 ♠ (SPEC §2.5).
const C = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });
const SEVEN_H = C(7, 2);
const NINE_S = C(9, 3);
const TEN_H = C(10, 2);
const JACK_C = C(11, 0);
const QUEEN_D = C(12, 1);
const NINE_H = C(9, 2);
const FIVE_C = C(5, 0);
const THREE_C = C(3, 0);
const TWO_S = C(2, 3);
const FIVE_H = C(5, 2);
const EIGHT_D = C(8, 1);

/** One wire-true entry per recap-visible shape, all by the opponent (player 1). */
const WIRE = {
  draw: appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 1 }),
  pass: appliedMove({ by: 1, kind: Kind.Pass, description: 'pass', seq: 2 }),
  playPoint: appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 3 }),
  permanent: appliedMove({ by: 1, kind: Kind.PlayPermanent, card: QUEEN_D, description: 'play Q♦ as permanent', seq: 4 }),
  jackSteal: appliedMove({
    by: 1,
    kind: Kind.PlayPermanent,
    card: JACK_C,
    targetCard: TEN_H,
    description: 'play J♣ (steal opponent point)',
    seq: 5,
  }),
  scuttle: appliedMove({
    by: 1,
    kind: Kind.Scuttle,
    card: NINE_S,
    targetCard: SEVEN_H,
    description: "scuttle opponent's 7♥ with 9♠",
    seq: 6,
  }),
  oneOff: appliedMove({ by: 1, kind: Kind.OneOff, card: THREE_C, description: 'play 3♣ as one-off', seq: 7 }),
  oneOffTargeted: appliedMove({
    by: 1,
    kind: Kind.OneOff,
    card: NINE_H,
    targetCard: FIVE_C,
    description: 'play 9♥ as one-off',
    seq: 8,
  }),
  counter: appliedMove({ by: 1, kind: Kind.Counter, card: TWO_S, description: 'counter with 2♠', seq: 9 }),
  sevenPick: appliedMove({
    by: 1,
    kind: Kind.SevenPick,
    subKind: Kind.PlayPoint,
    card: FIVE_H,
    description: '7: play 5♥ as point card',
    seq: 10,
  }),
  sevenPickScuttle: appliedMove({
    by: 1,
    kind: Kind.SevenPick,
    subKind: Kind.Scuttle,
    card: NINE_S,
    targetCard: SEVEN_H,
    description: "7: scuttle opponent's 7♥ with 9♠",
    seq: 11,
  }),
  sevenPickDeadEnd: appliedMove({
    by: 1,
    kind: Kind.SevenPick,
    subKind: null,
    card: EIGHT_D,
    description: '7: no legal play — scrap 8♦',
    seq: 12,
  }),
  discardPair: appliedMove({ by: 1, kind: Kind.DiscardPair, description: 'discard hand[0] and hand[3]', seq: 13 }),
} satisfies Record<string, AppliedMove>;

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
const extraHosts: { host: HTMLDivElement; instance: ReturnType<typeof mount> }[] = [];

interface RenderProps {
  entries: AppliedMove[];
  viewer: PlayerId | null;
  names: readonly [string, string];
  onadvance: () => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(RecapPanel, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  for (const extra of extraHosts.splice(0)) {
    unmount(extra.instance);
    extra.host.remove();
  }
}

afterEach(cleanup);

/** The default theme's mini face for `card`, rendered on its own, for comparison. */
function faceHtml(card: Card): string {
  const faceHost = document.createElement('div');
  document.body.append(faceHost);
  const face = mount(getTheme(DEFAULT_THEME_ID).Face, { target: faceHost, props: { card, size: 'mini' } });
  flushSync();
  extraHosts.push({ host: faceHost, instance: face });
  return withoutAnchors(faceHost.innerHTML);
}

function root(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="recap"]');
  if (!found) throw new Error('no recap root rendered');
  return found;
}

function lines(el: HTMLElement): HTMLElement[] {
  return [...root(el).querySelectorAll<HTMLElement>('.recap__line')];
}

function lineText(line: HTMLElement): string | null | undefined {
  return line.querySelector('.recap__text')?.textContent;
}

/** Svelte's comment anchors (`<!---->`) are placement markers, not markup. */
function withoutAnchors(html: string): string {
  return html.replace(/<!--[^]*?-->/g, '');
}

function facesIn(line: HTMLElement): string[] {
  return [...line.querySelectorAll<HTMLElement>('.recap__face')].map((f) => withoutAnchors(f.innerHTML));
}

function dismissButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="recap-dismiss"]');
  if (!found) throw new Error('no recap-dismiss button rendered');
  return found;
}

function expandButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>('[data-testid="recap-expand"]');
}

function base(entries: AppliedMove[], overrides: Partial<RenderProps> = {}): RenderProps {
  return { entries, viewer: 0, names: NAMES, onadvance: () => {}, ...overrides };
}

describe('B4: recapCards(entry) — which cards a line shows, in sentence order', () => {
  const cases: [string, AppliedMove, Card[]][] = [
    ['Draw: none', WIRE.draw, []],
    ['Pass: none', WIRE.pass, []],
    ['DiscardPair: none', WIRE.discardPair, []],
    ['PlayPoint: the played card', WIRE.playPoint, [SEVEN_H]],
    ['PlayPermanent: the played card', WIRE.permanent, [QUEEN_D]],
    ['Jack steal: the stolen card, then the Jack ("stole your 10♥ with J♣")', WIRE.jackSteal, [TEN_H, JACK_C]],
    ['Scuttle: the target, then the scuttler ("scuttled your 7♥ with 9♠")', WIRE.scuttle, [SEVEN_H, NINE_S]],
    ['untargeted OneOff: the played card', WIRE.oneOff, [THREE_C]],
    ['targeted OneOff: the played card, then the target ("9♥ ... targeting 5♣")', WIRE.oneOffTargeted, [NINE_H, FIVE_C]],
    ['Counter: the 2', WIRE.counter, [TWO_S]],
    ['SevenPick: only the chosen card', WIRE.sevenPick, [FIVE_H]],
    ['SevenPick with a scuttle: target, then the chosen card', WIRE.sevenPickScuttle, [SEVEN_H, NINE_S]],
    ['dead-end SevenPick: only the scrapped card', WIRE.sevenPickDeadEnd, [EIGHT_D]],
  ];

  for (const [label, entry, expected] of cases) {
    it(label, () => {
      expect(recapCards(entry)).toEqual(expected);
    });
  }

  it('Decline: none (never recapped anyway)', () => {
    expect(recapCards(appliedMove({ by: 1, kind: Kind.Decline, description: 'decline to counter' }))).toEqual([]);
  });

  it('DiscardPair never yields a card, even if a card were present on the entry', () => {
    expect(recapCards({ ...WIRE.discardPair, card: SEVEN_H })).toEqual([]);
  });

  it('reads nothing but card and targetCard: the description and index do not change the result', () => {
    const own = { ...WIRE.scuttle, by: 0 as PlayerId, index: 4, description: "scuttle opponent's 7♥ with 9♠" };
    expect(recapCards(own)).toEqual([SEVEN_H, NINE_S]);
  });

  it('returns copies, not the entry\'s own card objects', () => {
    const cards = recapCards(WIRE.jackSteal);
    expect(cards[0]).not.toBe(WIRE.jackSteal.targetCard);
    expect(cards[1]).not.toBe(WIRE.jackSteal.card);
  });
});

describe('B4: RecapPanel renders a mini face for every card recapCards returns', () => {
  for (const [key, entry] of Object.entries(WIRE)) {
    it(`${key}: faces match recapCards in order, and the text is formatRecapLine`, () => {
      const el = render(base([entry]));
      const [line] = lines(el);
      expect(facesIn(line)).toEqual(recapCards(entry).map(faceHtml));
      expect(lineText(line)).toBe(formatRecapLine(entry, 0, NAMES));
    });
  }

  it('a Jack steal shows both J♣ and 10♥', () => {
    const [line] = lines(render(base([WIRE.jackSteal])));
    expect(facesIn(line)).toEqual([faceHtml(TEN_H), faceHtml(JACK_C)]);
  });

  it('Draw, Pass and DiscardPair show no face', () => {
    for (const line of lines(render(base([WIRE.draw, WIRE.pass, WIRE.discardPair])))) {
      expect(line.querySelectorAll('.recap__face').length).toBe(0);
    }
  });

  it('a DiscardPair line names no identity and no index', () => {
    const [line] = lines(render(base([WIRE.discardPair])));
    expect(line.querySelectorAll('.recap__face').length).toBe(0);
    expect(line.textContent).not.toMatch(/[♣♦♥♠]/);
    expect(line.textContent).not.toMatch(/hand\[|\b[03]\b/);
    expect(lineText(line)).toBe('Blake discarded 2 cards.');
  });

  it('a normal SevenPick shows only the chosen card', () => {
    const [line] = lines(render(base([WIRE.sevenPick])));
    expect(facesIn(line)).toEqual([faceHtml(FIVE_H)]);
  });

  it('a dead-end SevenPick shows only the scrapped card', () => {
    const [line] = lines(render(base([WIRE.sevenPickDeadEnd])));
    expect(facesIn(line)).toEqual([faceHtml(EIGHT_D)]);
  });
});

describe('N2: face containers own the card box (SPEC §5.6 rule 2)', () => {
  it('each face sits in its own .recap__face container, with no testid on the face or container', () => {
    const [line] = lines(render(base([WIRE.jackSteal])));
    const containers = [...line.querySelectorAll<HTMLElement>('.recap__face')];
    expect(containers.length).toBe(2);
    for (const container of containers) {
      expect(container.children.length).toBe(1);
      expect(container.hasAttribute('data-testid')).toBe(false);
      expect(container.querySelector('[data-testid]')).toBeNull();
      expect(container.firstElementChild?.getAttribute('data-size')).toBe('mini');
    }
  });
});

describe('RecapPanel content and dismissal (SPEC §4.6)', () => {
  it('renders one line per entry, oldest first, using formatRecapLine', () => {
    const entries = [WIRE.draw, WIRE.playPoint, WIRE.pass];
    const el = render(base(entries));
    expect(lines(el).map(lineText)).toEqual(entries.map((e) => formatRecapLine(e, 0, NAMES)));
  });

  it('the viewer\'s own entries read in the second person', () => {
    const own = appliedMove({ by: 0, kind: Kind.PlayPoint, card: SEVEN_H, index: 2, description: 'play 7♥ as point card', seq: 1 });
    expect(lineText(lines(render(base([own])))[0])).toBe('You played 7♥ for points.');
  });

  it('one tap on dismiss calls onadvance exactly once', () => {
    const seen: number[] = [];
    const el = render(base([WIRE.draw], { onadvance: () => seen.push(1) }));
    dismissButton(el).click();
    flushSync();
    expect(seen).toEqual([1]);
  });
});

describe('B5 + C2: the last 6, and "+N earlier" below the list (SPEC §4.6, R13.4)', () => {
  const nine = [
    WIRE.draw,
    WIRE.pass,
    WIRE.playPoint,
    WIRE.permanent,
    WIRE.jackSteal,
    WIRE.scuttle,
    WIRE.oneOff,
    WIRE.oneOffTargeted,
    WIRE.counter,
  ].map((e, i) => ({ ...e, seq: i + 1 }));

  it('with 9 distinct entries the visible lines are exactly seq 4-9, oldest first', () => {
    const el = render(base(nine));
    const expected = nine.filter((e) => e.seq >= 4).map((e) => formatRecapLine(e, 0, NAMES));
    expect(lines(el).map(lineText)).toEqual(expected);
    expect(new Set(expected).size).toBe(6);
  });

  it('shows "+3 earlier", and expanding reveals all 9 in order', () => {
    const el = render(base(nine));
    expect(expandButton(el)?.textContent?.trim()).toBe('+3 earlier');
    expandButton(el)?.click();
    flushSync();
    expect(lines(el).map(lineText)).toEqual(nine.map((e) => formatRecapLine(e, 0, NAMES)));
    expect(expandButton(el)).toBeNull();
  });

  it('with 6 or fewer entries there is no expander and every line shows', () => {
    const el = render(base(nine.slice(0, 6)));
    expect(expandButton(el)).toBeNull();
    expect(lines(el).length).toBe(6);
  });

  it('C2: the expander sits after the list and before the dismiss pill in the document', () => {
    const el = render(base(nine));
    const list = root(el).querySelector('.recap__list')!;
    const expand = expandButton(el)!;
    const dismiss = dismissButton(el);
    expect(list.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(expand.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.contains(expand)).toBe(false);
  });

  it('C2: the expander shares the bottom-anchored footer with the dismiss pill', () => {
    const el = render(base(nine));
    const footer = root(el).querySelector('.recap__footer');
    expect(footer).toBeTruthy();
    expect(footer?.contains(expandButton(el))).toBe(true);
    expect(footer?.contains(dismissButton(el))).toBe(true);
  });
});

describe('N3: a null viewer renders a defensive empty state', () => {
  it('no line, no face, no expander; the dismiss pill stays so the screen is never a trap', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...WIRE.jackSteal, seq: i + 1 }));
    const el = render(base(many, { viewer: null }));
    expect(lines(el).length).toBe(0);
    expect(root(el).querySelectorAll('.recap__face').length).toBe(0);
    expect(root(el).textContent).not.toMatch(/[♣♦♥♠]/);
    expect(expandButton(el)).toBeNull();
    expect(root(el).querySelector('.recap__empty')).toBeTruthy();
    expect(dismissButton(el)).toBeTruthy();
  });
});

describe('RecapPanel never auto-advances', () => {
  it('mounting and letting timers run does not call onadvance', () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      render(base([WIRE.draw], { onadvance: () => seen.push(1) }));
      vi.advanceTimersByTime(60_000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RecapPanel prop changes on one mounted instance (OQ-13 pattern)', () => {
  it('re-renders lines and faces on the same instance, and clears when entries clear', () => {
    const props: RenderProps = $state(base([WIRE.draw]));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(RecapPanel, { target: host, props });
    flushSync();
    const sameRoot = root(host);
    expect(lines(host).length).toBe(1);

    props.entries = [WIRE.draw, WIRE.jackSteal];
    flushSync();
    expect(root(host)).toBe(sameRoot);
    expect(facesIn(lines(host)[1])).toEqual([faceHtml(TEN_H), faceHtml(JACK_C)]);

    props.viewer = null;
    flushSync();
    expect(lines(host).length).toBe(0);
    expect(sameRoot.querySelectorAll('.recap__face').length).toBe(0);

    props.viewer = 0;
    props.entries = [];
    flushSync();
    expect(lines(host).length).toBe(0);
  });
});
