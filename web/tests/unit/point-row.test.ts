// @vitest-environment jsdom
// P2 W9 (SPEC §5.2, Board props contract) — PointRow: shared between
// OpponentZone and PlayerZone, `point:<rowId>:<index>` keys, the shown
// (top-only, W18) Jack and its "deck thickness" edge, the Controller-vs-
// Owner ownership marker, the verbatim `pointTotal` tally, and the
// viewer-only drop zone.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { PointEntry } from '../../src/lib/bridge/schema';
import PointRow from '../../src/lib/components/PointRow.svelte';
import { getTheme, DEFAULT_THEME_ID } from '../../src/lib/theme';

const theme = getTheme(DEFAULT_THEME_ID);

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  rowId: 0 | 1;
  entries: PointEntry[];
  pointTotal: number;
  label: string;
  dropZoneKey?: 'zone:points';
  dropZoneLabel?: string;
  highlighted?: ReadonlySet<string>;
  staged?: ReadonlySet<string>;
  ontap: (key: string) => void;
}

function render(props: RenderProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(PointRow, {
    target: host,
    props: { highlighted: new Set<string>(), staged: new Set<string>(), theme, ...props },
  });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function entry(overrides: Partial<PointEntry> & { Owner: 0 | 1; Controller: 0 | 1 }): PointEntry {
  return { Card: { Rank: 4, Suit: 0 }, JackStack: [], JackOwners: [], ...overrides };
}

describe('PointRow (SPEC §5.2)', () => {
  it('renders point-<rowId>-<index> for every entry and fires the same key on tap', () => {
    const seen: string[] = [];
    const el = render({
      rowId: 1,
      entries: [entry({ Owner: 1, Controller: 1 }), entry({ Owner: 1, Controller: 1, Card: { Rank: 7, Suit: 2 } })],
      pointTotal: 11,
      label: 'Points',
      ontap: (k) => seen.push(k),
    });
    el.querySelector<HTMLElement>('[data-testid="point-1-0"]')?.click();
    el.querySelector<HTMLElement>('[data-testid="point-1-1"]')?.click();
    flushSync();
    expect(seen).toEqual(['point:1:0', 'point:1:1']);
  });

  it('shows only the top (newest) Jack on the point card, full field size, with the count on the stack (W18)', () => {
    const el = render({
      rowId: 0,
      entries: [
        entry({
          Owner: 1,
          Controller: 0,
          JackStack: [
            { Rank: 11, Suit: 0 },
            { Rank: 11, Suit: 2 },
          ],
          JackOwners: [0, 0],
        }),
      ],
      pointTotal: 4,
      label: 'Points',
      ontap: () => {},
    });
    const slot = el.querySelector('[data-testid="point-0-0"]')?.closest('.point-row__slot') as HTMLElement;
    // W18 (product-owner revision, superseding the W17 cascade this test
    // used to cover): only the top Jack ever renders as a card.
    expect(slot.querySelectorAll('.point-row__jack').length).toBe(1);
    expect(slot.querySelector('[data-jack-count]')?.getAttribute('data-jack-count')).toBe('2');
  });

  it('shows the ownership marker only when Controller differs from Owner (a stolen point)', () => {
    const el = render({
      rowId: 0,
      entries: [
        entry({ Owner: 0, Controller: 0 }), // plain, own point: no marker
        entry({ Owner: 1, Controller: 0, Card: { Rank: 6, Suit: 1 } }), // stolen: marker, owner=1
      ],
      pointTotal: 10,
      label: 'Points',
      ontap: () => {},
    });
    const plainSlot = el.querySelector('[data-testid="point-0-0"]')!.closest('.point-row__slot') as HTMLElement;
    const stolenSlot = el.querySelector('[data-testid="point-0-1"]')!.closest('.point-row__slot') as HTMLElement;
    expect(plainSlot.querySelector('[data-owner-marker]')).toBeNull();
    expect(stolenSlot.querySelector('[data-owner-marker]')?.getAttribute('data-owner')).toBe('1');
  });

  it('shows the row\'s name when empty, and the verbatim pointTotal tally when not', () => {
    let el = render({ rowId: 0, entries: [], pointTotal: 0, label: 'Points', ontap: () => {} });
    expect(el.textContent).toContain('Points');
    expect(el.querySelector('.point-row__tally')).toBeNull();

    el = render({ rowId: 0, entries: [entry({ Owner: 0, Controller: 0 })], pointTotal: 99, label: 'Points', ontap: () => {} });
    expect(el.querySelector('.point-row__tally')?.textContent).toBe('99');
  });

  it('applies highlighted/staged per-card state via the point:<rowId>:<index> key', () => {
    const el = render({
      rowId: 0,
      entries: [entry({ Owner: 0, Controller: 0 }), entry({ Owner: 0, Controller: 0, Card: { Rank: 8, Suit: 1 } })],
      pointTotal: 0,
      label: 'Points',
      highlighted: new Set(['point:0:1']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="point-0-0"]')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe('normal');
    expect(el.querySelector('[data-testid="point-0-1"]')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe('highlighted');
  });

  it('the shown Jack renders at the SAME size as the point card it sits on, not the point card (W17/W18)', () => {
    const el = render({
      rowId: 0,
      entries: [
        entry({
          Card: { Rank: 6, Suit: 1 },
          Owner: 0,
          Controller: 0,
          // Engine-true re-steal: 1 stole it, 0 stole it back (engine/apply.go:222 appends the actor).
          JackStack: [
            { Rank: 11, Suit: 0 },
            { Rank: 11, Suit: 2 },
          ],
          JackOwners: [1, 0],
        }),
      ],
      pointTotal: 6,
      label: 'Points',
      ontap: () => {},
    });
    const card = el.querySelector('[data-testid="point-0-0"]') as HTMLElement;
    const pointFace = card.querySelector('.point-row__face [data-state]') as HTMLElement;
    // W17 (docs owner direction, 2026-09-28): a Jack is the same size as the
    // card it sits on — no narrowing to `mini`. Both the point card's Face
    // and the shown Jack's Face render at `size="field"`, so the `data-size`
    // theme contracts (rule 2) match card-for-card.
    expect(pointFace.getAttribute('data-size')).toBe('field');
    const jackFaces = [...card.querySelectorAll('.point-row__jack [data-size="field"]')] as HTMLElement[];
    // W18: only the TOP (last, newest) JackStack entry ever renders as a
    // card — here Suit 2 (hearts), not Suit 0.
    expect(jackFaces.length).toBe(1);
    // No mini-sized Jack face survives.
    expect(card.querySelectorAll('.point-row__jack [data-size="mini"]').length).toBe(0);
    expect(jackFaces[0].firstElementChild?.textContent).toBe('J');
    expect(pointFace.firstElementChild?.textContent).toBe('6');
    expect(jackFaces[0].querySelector('.cuttle-card-face__suit')?.textContent).toBe(String.fromCodePoint(0x2665));
  });

  it('the Jack stack lives inside the point card\'s tap target, drawn after the face', () => {
    const seen: string[] = [];
    const el = render({
      rowId: 1,
      entries: [entry({ Owner: 0, Controller: 1, JackStack: [{ Rank: 11, Suit: 3 }], JackOwners: [1] })],
      pointTotal: 4,
      label: 'Points',
      ontap: (k) => seen.push(k),
    });
    const card = el.querySelector('[data-testid="point-1-0"]') as HTMLElement;
    const jack = card.querySelector('.point-row__jack') as HTMLElement;
    expect(jack).not.toBeNull();
    // Face first in DOM order so the Jacks paint over it.
    const face = card.querySelector('.point-row__face') as HTMLElement;
    expect(face.compareDocumentPosition(jack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    jack.click();
    flushSync();
    expect(seen).toEqual(['point:1:0']);
  });

  it('a stolen entry (Owner !== rowId) taps and highlights as point:<rowId>:<i>, never point:<Owner>:<i> (B2)', () => {
    // Row 0 holds its own point at 0 and, at 1, player 1's point stolen by 0:
    // Owner 1, JackOwners [0] (the first thief is Owner's opponent), Controller 0.
    const stolen = entry({
      Card: { Rank: 9, Suit: 1 },
      Owner: 1,
      Controller: 0,
      JackStack: [{ Rank: 11, Suit: 2 }],
      JackOwners: [0],
    });
    const seen: string[] = [];
    const el = render({
      rowId: 0,
      entries: [entry({ Owner: 0, Controller: 0 }), stolen],
      pointTotal: 13,
      label: 'Points',
      highlighted: new Set(['point:0:1']),
      ontap: (k) => seen.push(k),
    });
    const card = el.querySelector<HTMLElement>('[data-testid="point-0-1"]')!;
    expect(card.querySelector('.point-row__face [data-state]')?.getAttribute('data-state')).toBe('highlighted');
    card.click();
    flushSync();
    expect(seen).toEqual(['point:0:1']);
  });

  it('a stolen entry is NOT highlighted by the Owner-keyed point:<Owner>:<i> (B2)', () => {
    const el = render({
      rowId: 0,
      entries: [
        entry({ Owner: 0, Controller: 0 }),
        entry({ Owner: 1, Controller: 0, JackStack: [{ Rank: 11, Suit: 0 }], JackOwners: [0] }),
      ],
      pointTotal: 8,
      label: 'Points',
      highlighted: new Set(['point:1:1']),
      staged: new Set(['point:1:1']),
      ontap: () => {},
    });
    expect(
      el.querySelector('[data-testid="point-0-1"] .point-row__face [data-state]')?.getAttribute('data-state'),
    ).toBe('normal');
  });

  it('staged wins over highlighted when the key is in both sets (M4)', () => {
    const el = render({
      rowId: 0,
      entries: [entry({ Owner: 0, Controller: 0 })],
      pointTotal: 4,
      label: 'Points',
      highlighted: new Set(['point:0:0']),
      staged: new Set(['point:0:0']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="point-0-0"] .point-row__face [data-state]')?.getAttribute('data-state')).toBe(
      'staged',
    );
  });

  it('staged alone renders "staged" (M43)', () => {
    const el = render({
      rowId: 1,
      entries: [entry({ Owner: 1, Controller: 1 })],
      pointTotal: 4,
      label: 'Points',
      staged: new Set(['point:1:0']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="point-1-0"] .point-row__face [data-state]')?.getAttribute('data-state')).toBe(
      'staged',
    );
  });

  it('the ownership marker is an ink badge carrying the original Owner, inside the tap target', () => {
    const el = render({
      rowId: 0,
      entries: [entry({ Owner: 1, Controller: 0, JackStack: [{ Rank: 11, Suit: 0 }], JackOwners: [0] })],
      pointTotal: 4,
      label: 'Points',
      ontap: () => {},
    });
    const marker = el.querySelector('[data-testid="point-0-0"] [data-owner-marker]');
    expect(marker?.getAttribute('data-owner')).toBe('1');
    expect(marker?.hasAttribute('data-testid')).toBe(false);
  });

  it('shows the newest (last) JackStack entry, never an earlier one, for a 3-Jack stack (W18, replaces the W17 cascade)', () => {
    const el = render({
      rowId: 0,
      entries: [
        entry({
          Owner: 0,
          Controller: 0,
          JackStack: [
            { Rank: 11, Suit: 0 },
            { Rank: 11, Suit: 2 },
            { Rank: 11, Suit: 3 },
          ],
          JackOwners: [0, 0, 0],
        }),
      ],
      pointTotal: 4,
      label: 'Points',
      ontap: () => {},
    });
    const slot = el.querySelector('[data-testid="point-0-0"]')?.closest('.point-row__slot') as HTMLElement;
    const jacks = [...slot.querySelectorAll<HTMLElement>('.point-row__jack')];
    // W18: only ONE Jack card ever renders — the last (newest) entry in
    // JackStack, Suit 3 (spades) here, not Suit 0 or Suit 2.
    expect(jacks.length).toBe(1);
    expect(jacks[0].querySelector('.cuttle-card-face__suit')?.textContent).toBe(String.fromCodePoint(0x2660));
    expect(slot.querySelector('[data-jack-count]')?.getAttribute('data-jack-count')).toBe('3');
  });

  it('adds no "deck thickness" edge for a single Jack, and the same edge at 2, 3 or 4 Jacks (W18)', () => {
    const stackOf = (count: number) =>
      render({
        rowId: 0,
        entries: [
          entry({
            Owner: 0,
            Controller: 0,
            JackStack: Array.from({ length: count }, (_, i) => ({ Rank: 11 as const, Suit: (i % 4) as 0 | 1 | 2 | 3 })),
            JackOwners: Array.from({ length: count }, () => 0 as const),
          }),
        ],
        pointTotal: 4,
        label: 'Points',
        ontap: () => {},
      });

    const one = stackOf(1).querySelector('[data-testid="point-0-0"]') as HTMLElement;
    expect(one.querySelectorAll('.point-row__jack-edge').length).toBe(0);

    for (const count of [2, 3, 4]) {
      const card = stackOf(count).querySelector('[data-testid="point-0-0"]') as HTMLElement;
      const edges = [...card.querySelectorAll('.point-row__jack-edge')];
      // Same look at every count ≥ 2 — no count-dependent variation, no digits.
      expect(edges.length).toBe(2);
      expect(edges.every((e) => e.textContent === '')).toBe(true);
      expect(edges.every((e) => e.getAttribute('aria-hidden') === 'true')).toBe(true);
    }
  });

  it('carries the Jack count only as the stack\'s aria-label ("stolen, N Jacks") — none for a single Jack (W18)', () => {
    const single = render({
      rowId: 0,
      entries: [entry({ Owner: 0, Controller: 0, JackStack: [{ Rank: 11, Suit: 0 }], JackOwners: [0] })],
      pointTotal: 4,
      label: 'Points',
      ontap: () => {},
    });
    expect(
      single.querySelector('[data-testid="point-0-0"] .point-row__jack-stack')?.getAttribute('aria-label'),
    ).toBeNull();

    const triple = render({
      rowId: 0,
      entries: [
        entry({
          Owner: 0,
          Controller: 0,
          JackStack: [
            { Rank: 11, Suit: 0 },
            { Rank: 11, Suit: 2 },
            { Rank: 11, Suit: 3 },
          ],
          JackOwners: [0, 0, 0],
        }),
      ],
      pointTotal: 4,
      label: 'Points',
      ontap: () => {},
    });
    expect(
      triple.querySelector('[data-testid="point-0-0"] .point-row__jack-stack')?.getAttribute('aria-label'),
    ).toBe('stolen, 3 Jacks');
  });

  it('with no dropZoneKey, renders a plain row and no zone testid; with one, wraps in a DropZones with that testid', () => {
    let el = render({ rowId: 1, entries: [], pointTotal: 0, label: 'Points', ontap: () => {} });
    expect(el.querySelector('[data-testid^="zone-"]')).toBeNull();

    const seen: string[] = [];
    el = render({
      rowId: 0,
      entries: [],
      pointTotal: 0,
      label: 'Points',
      dropZoneKey: 'zone:points',
      ontap: (k) => seen.push(k),
    });
    const zone = el.querySelector<HTMLElement>('[data-testid="zone-points"]');
    expect(zone).not.toBeNull();
    zone?.click();
    flushSync();
    expect(seen).toEqual(['zone:points']);
  });
});
