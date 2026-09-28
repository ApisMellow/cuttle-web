// @vitest-environment jsdom
// P2 W9 (SPEC §5.2, Board props contract) — PermanentRow: shared between
// OpponentZone and PlayerZone, `perm:<rowId>:<index>` keys, the viewer-only
// drop zone.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import PermanentRow from '../../src/lib/components/PermanentRow.svelte';
import { getTheme, DEFAULT_THEME_ID } from '../../src/lib/theme';

const theme = getTheme(DEFAULT_THEME_ID);

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  rowId: 0 | 1;
  cards: Card[];
  label: string;
  dropZoneKey?: 'zone:permanents';
  dropZoneLabel?: string;
  highlighted?: ReadonlySet<string>;
  staged?: ReadonlySet<string>;
  ontap: (key: string) => void;
}

function render(props: RenderProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(PermanentRow, {
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

describe('PermanentRow (SPEC §5.2)', () => {
  it('renders perm-<rowId>-<index> for every card and fires the same key on tap', () => {
    const seen: string[] = [];
    const el = render({
      rowId: 1,
      cards: [
        { Rank: 8, Suit: 0 },
        { Rank: 3, Suit: 2 },
      ],
      label: 'Permanents',
      ontap: (k) => seen.push(k),
    });
    el.querySelector<HTMLElement>('[data-testid="perm-1-0"]')?.click();
    el.querySelector<HTMLElement>('[data-testid="perm-1-1"]')?.click();
    flushSync();
    expect(seen).toEqual(['perm:1:0', 'perm:1:1']);
  });

  it('shows the row\'s name when empty and no card testids otherwise', () => {
    const el = render({ rowId: 0, cards: [], label: 'Permanents', ontap: () => {} });
    expect(el.textContent).toContain('Permanents');
    expect(el.querySelectorAll('[data-testid^="perm-"]').length).toBe(0);
  });

  it('applies highlighted/staged per-card state via the perm:<rowId>:<index> key', () => {
    const el = render({
      rowId: 0,
      cards: [{ Rank: 8, Suit: 0 }],
      label: 'Permanents',
      staged: new Set(['perm:0:0']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="perm-0-0"]')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe(
      'staged',
    );
  });

  it('staged wins over highlighted when the key is in both sets (M5)', () => {
    const el = render({
      rowId: 1,
      cards: [{ Rank: 8, Suit: 0 }],
      label: 'Permanents',
      highlighted: new Set(['perm:1:0']),
      staged: new Set(['perm:1:0']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="perm-1-0"]')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe(
      'staged',
    );
  });

  it('highlighted alone renders "highlighted"', () => {
    const el = render({
      rowId: 1,
      cards: [{ Rank: 8, Suit: 0 }],
      label: 'Permanents',
      highlighted: new Set(['perm:1:0']),
      ontap: () => {},
    });
    expect(el.querySelector('[data-testid="perm-1-0"]')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe(
      'highlighted',
    );
  });

  it('with no dropZoneKey, renders a plain row; with one, wraps in DropZones with that testid and forwards its tap', () => {
    let el = render({ rowId: 1, cards: [], label: 'Permanents', ontap: () => {} });
    expect(el.querySelector('[data-testid^="zone-"]')).toBeNull();

    const seen: string[] = [];
    el = render({ rowId: 0, cards: [], label: 'Permanents', dropZoneKey: 'zone:permanents', ontap: (k) => seen.push(k) });
    const zone = el.querySelector<HTMLElement>('[data-testid="zone-permanents"]');
    expect(zone).not.toBeNull();
    zone?.click();
    flushSync();
    expect(seen).toEqual(['zone:permanents']);
  });

  it('testids are stable regardless of highlighted/staged', () => {
    const cards: Card[] = [{ Rank: 5, Suit: 1 }];
    const bare = render({ rowId: 0, cards, label: 'Permanents', ontap: () => {} });
    const bareIds = [...bare.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));

    const lit = render({ rowId: 0, cards, label: 'Permanents', highlighted: new Set(['perm:0:0']), ontap: () => {} });
    const litIds = [...lit.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    expect(litIds).toEqual(bareIds);
  });
});
