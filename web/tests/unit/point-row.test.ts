// @vitest-environment jsdom
// P2 W9 (SPEC §5.2, Board props contract) — PointRow: shared between
// OpponentZone and PlayerZone, `point:<rowId>:<index>` keys, the JackStack
// fan, the Controller-vs-Owner ownership marker, the verbatim `pointTotal`
// tally, and the viewer-only drop zone.
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

  it('shows the JackStack fanned above the point card, one mini Face per Jack', () => {
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
    expect(slot.querySelectorAll('.point-row__jack').length).toBe(2);
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

  it('each Jack\'s mini face renders its JackStack card, not the point card (M41)', () => {
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
    const jackFaces = [...card.querySelectorAll('.point-row__jack [data-size="mini"]')] as HTMLElement[];
    expect(jackFaces.length).toBe(2);
    // Rank label of each Jack face is "J"; the point card's is "6".
    expect(jackFaces.map((f) => f.firstElementChild?.textContent)).toEqual(['J', 'J']);
    expect(pointFace.firstElementChild?.textContent).toBe('6');
    // The two Jacks differ by suit, so each face is its own JackStack entry.
    expect(jackFaces[0].textContent).not.toBe(jackFaces[1].textContent);
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
