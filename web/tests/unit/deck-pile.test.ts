// @vitest-environment jsdom
// P2 W9 — DeckPile: count only, no card identity ever (a CardBack carries
// none by construction), and still tappable regardless (only Board's
// `inert` blocks a tap; see board test).
//
// Revise 1 ruling: the disabled styling comes from `enabled` (the
// integrator passes whether Draw is legal), NOT from "is it highlighted".
// The iris ring shows only when staging highlights `deck`.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import DeckPile from '../../src/lib/components/DeckPile.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface Props {
  count: number;
  enabled: boolean;
  highlighted: boolean;
  staged: boolean;
  ontap: () => void;
}

function render(props: Props): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(DeckPile, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function pile(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="deck-pile"]');
  if (!found) throw new Error('no deck-pile rendered');
  return found;
}

const base: Props = { count: 5, enabled: true, highlighted: false, staged: false, ontap: () => {} };

describe('DeckPile (docs/design.md §6, Board brief)', () => {
  it('shows the count and nothing else — no [data-state] leaks a card identity', () => {
    const el = render({ ...base, count: 17 });
    expect(pile(el).textContent).toContain('17');
    expect(pile(el).querySelectorAll('[data-state]').length).toBe(0);
  });

  it('disabled comes from `enabled` alone: enabled + not highlighted is NOT disabled', () => {
    const el = render({ ...base, enabled: true, highlighted: false, staged: false });
    expect(pile(el).getAttribute('data-disabled')).toBe('false');
    expect(pile(el).getAttribute('aria-disabled')).toBe('false');
  });

  it('disabled comes from `enabled` alone: not enabled is disabled even when highlighted or staged', () => {
    let el = render({ ...base, enabled: false });
    expect(pile(el).getAttribute('data-disabled')).toBe('true');
    expect(pile(el).getAttribute('aria-disabled')).toBe('true');

    el = render({ ...base, enabled: false, highlighted: true });
    expect(pile(el).getAttribute('data-disabled')).toBe('true');

    el = render({ ...base, enabled: false, staged: true });
    expect(pile(el).getAttribute('data-disabled')).toBe('true');
  });

  it('enabled but idle shows no ring: data-state is "normal" until staging highlights the deck', () => {
    const el = render({ ...base, enabled: true });
    expect(pile(el).getAttribute('data-state')).toBe('normal');
  });

  it('reflects highlighted/staged in data-state, staged winning', () => {
    let el = render({ ...base, highlighted: true });
    expect(pile(el).getAttribute('data-state')).toBe('highlighted');
    el = render({ ...base, highlighted: true, staged: true });
    expect(pile(el).getAttribute('data-state')).toBe('staged');
  });

  it('still fires ontap when tapped while disabled — legality is a caller decision, not a DOM lock', () => {
    let count = 0;
    const el = render({ ...base, enabled: false, ontap: () => count++ });
    expect(pile(el).hasAttribute('disabled')).toBe(false);
    pile(el).click();
    flushSync();
    expect(count).toBe(1);
  });

  it('the testid is stable across a 0-card deck', () => {
    const el = render({ ...base, count: 0, enabled: false });
    expect(pile(el)).not.toBeNull();
  });
});
