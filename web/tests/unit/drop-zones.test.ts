// @vitest-environment jsdom
// P2 W9 — DropZones (docs/design.md §7, Board brief): "visible as targets
// only when highlighted", testid stable regardless, and a click on a NESTED
// interactive child must never also fire the zone-level tap.
//
// Revise 1 a11y ruling: the zone is a non-interactive well plus a separate
// sibling hit <button> that carries the `zone-*` testid. Children render
// beside the hit button, never inside it, so no button ever wraps a button.
// The hit button is keyboard-focusable only while the zone is highlighted or
// staged; keyboard activation is the native <button> path (Enter/Space ->
// click), checked in a real browser in the hand-back.
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import DropZones from '../../src/lib/components/DropZones.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface Props {
  targetKey: string;
  label: string;
  highlighted: boolean;
  staged: boolean;
  ontap: () => void;
}

function render(props: Props, withChild = false): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  const children = withChild
    ? createRawSnippet(() => ({ render: () => '<button type="button" data-child>card</button>' }))
    : undefined;
  instance = mount(DropZones, { target: host, props: { ...props, children } });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function zone(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid]');
  if (!found) throw new Error('no drop zone rendered');
  return found;
}

const base: Props = { targetKey: 'zone:points', label: 'Play for points', highlighted: false, staged: false, ontap: () => {} };

describe('DropZones (docs/design.md §7)', () => {
  it('derives the testid from the target key, on a native type=button hit target', () => {
    const el = render(base);
    const hit = zone(el);
    expect(hit.getAttribute('data-testid')).toBe('zone-points');
    expect(hit.tagName).toBe('BUTTON');
    expect(hit.getAttribute('type')).toBe('button');
  });

  it('the well around the hit button is not interactive (no role, no tabindex)', () => {
    const el = render(base);
    const well = zone(el).parentElement as HTMLElement;
    expect(well.classList.contains('drop-zone')).toBe(true);
    expect(well.hasAttribute('role')).toBe(false);
    expect(well.hasAttribute('tabindex')).toBe(false);
    expect(el.querySelector('[role="button"]')).toBeNull();
  });

  it('is present in the DOM whether or not it is highlighted (testid never varies with legality)', () => {
    let el = render({ ...base, targetKey: 'zone:oneoff' });
    expect(zone(el).getAttribute('data-testid')).toBe('zone-oneoff');
    el = render({ ...base, targetKey: 'zone:oneoff', highlighted: true });
    expect(zone(el).getAttribute('data-testid')).toBe('zone-oneoff');
  });

  it('shows no ring/label when neither highlighted nor staged', () => {
    const el = render(base);
    expect(zone(el).getAttribute('data-state')).toBe('normal');
    expect(zone(el).parentElement?.getAttribute('data-state')).toBe('normal');
    expect(zone(el).querySelector('[data-drop-label]')).toBeNull();
  });

  it('shows the iris ring and label when highlighted', () => {
    const el = render({ ...base, highlighted: true });
    expect(zone(el).getAttribute('data-state')).toBe('highlighted');
    expect(zone(el).parentElement?.getAttribute('data-state')).toBe('highlighted');
    expect(zone(el).querySelector('[data-drop-label]')?.textContent).toBe('Play for points');
  });

  it('shows the ochre "staged" state and label when staged, even without highlighted', () => {
    const el = render({ ...base, targetKey: 'zone:permanents', label: 'Play as a permanent', staged: true });
    expect(zone(el).getAttribute('data-state')).toBe('staged');
    expect(zone(el).querySelector('[data-drop-label]')).not.toBeNull();
  });

  it('staged wins over highlighted when both are true (M6)', () => {
    const el = render({ ...base, highlighted: true, staged: true });
    expect(zone(el).getAttribute('data-state')).toBe('staged');
    expect(zone(el).parentElement?.getAttribute('data-state')).toBe('staged');
  });

  it('clicking the hit target fires ontap', () => {
    let count = 0;
    const el = render({ ...base, highlighted: true, ontap: () => count++ });
    zone(el).click();
    flushSync();
    expect(count).toBe(1);
  });

  it('keyboard: focusable only while highlighted or staged (M29)', () => {
    let el = render(base);
    expect(zone(el).tabIndex).toBe(-1);

    el = render({ ...base, highlighted: true });
    expect(zone(el).tabIndex).toBe(0);
    zone(el).focus();
    expect(document.activeElement).toBe(zone(el));

    el = render({ ...base, staged: true });
    expect(zone(el).tabIndex).toBe(0);
  });

  it('has an accessible name even when the visible label is hidden', () => {
    const el = render(base);
    expect(zone(el).getAttribute('aria-label')).toBe('Play for points');
  });

  it('children render beside the hit button, and clicking one does NOT fire the zone-level tap', () => {
    let count = 0;
    const el = render({ ...base, highlighted: true, ontap: () => count++ }, true);
    const child = el.querySelector<HTMLButtonElement>('[data-child]')!;
    expect(child).not.toBeNull();
    expect(zone(el).contains(child)).toBe(false);
    child.click();
    flushSync();
    expect(count).toBe(0);
  });
});
