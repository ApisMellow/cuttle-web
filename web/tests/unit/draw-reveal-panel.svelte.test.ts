// @vitest-environment jsdom
// Issue #27 — DrawRevealPanel (SPEC §4.7): the drawer's hand with the drawn
// cards arriving face down from the deck and turning face up. It continues
// on a tap, on its Continue button, or on its own after 3 seconds, exactly
// once. Key auto-repeat never continues it (the same rule as the deck's
// issue #24 guard): a key held down from the screen before is not a press.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import DrawRevealPanel from '../../src/lib/components/DrawRevealPanel.svelte';
import { DRAW_REVEAL_MS } from '../../src/lib/drawReveal';
import { label } from './glasses-leak-scan';

const KING: Card = { Rank: 13, Suit: 0 };
const D1: Card = { Rank: 9, Suit: 3 };
const D2: Card = { Rank: 12, Suit: 1 };

interface Props {
  hand: Card[];
  drawn: number[];
  reducedMotion?: boolean;
  oncontinue: () => void;
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: Props): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(DrawRevealPanel, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function q(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no [data-testid="${id}"]`);
  return found;
}

function key(el: HTMLElement, type: 'keydown' | 'keyup', k: string, repeat: boolean): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: k, repeat, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  flushSync();
  return event;
}

describe('what the drawer sees', () => {
  it('the whole hand, with the drawn cards marked, and a count', () => {
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue: () => {} });
    const slots = el.querySelectorAll<HTMLElement>('[data-draw-slot]');
    expect(slots.length).toBe(3);
    expect([...slots].map((s) => s.dataset.drawn)).toEqual(['false', 'true', 'true']);
    const text = (slot: HTMLElement) => (slot.textContent ?? '').replace(/\s+/g, '');
    expect(text(slots[1])).toContain(label(D1));
    expect(text(slots[2])).toContain(label(D2));
    expect(text(slots[0])).toContain(label(KING));
    expect(q(el, 'draw-reveal').textContent).toContain('You drew 2 cards');
  });

  it('a drawn card starts face down: its slot holds a card back as well as the face it turns to', () => {
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue: () => {} });
    const drawn = el.querySelectorAll<HTMLElement>('[data-draw-slot][data-drawn="true"]');
    for (const slot of drawn) {
      expect(slot.querySelector('[data-draw-back]')).not.toBeNull();
      expect(slot.querySelector('[data-draw-face]')).not.toBeNull();
    }
    const kept = el.querySelector<HTMLElement>('[data-draw-slot][data-drawn="false"]')!;
    expect(kept.querySelector('[data-draw-back]')).toBeNull();
  });

  it('one card drawn reads "You drew 1 card"', () => {
    const el = render({ hand: [KING, D1], drawn: [1], oncontinue: () => {} });
    expect(q(el, 'draw-reveal').textContent).toContain('You drew 1 card');
    expect(q(el, 'draw-reveal').textContent).not.toContain('1 cards');
  });

  it('reduced motion: no travel or flip, the faces are simply there', () => {
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], reducedMotion: true, oncontinue: () => {} });
    expect(q(el, 'draw-reveal').dataset.motion).toBe('reduced');
    expect(el.querySelector('[data-draw-back]')).toBeNull();
    const full = render({ hand: [KING, D1, D2], drawn: [1, 2], reducedMotion: false, oncontinue: () => {} });
    expect(q(full, 'draw-reveal').dataset.motion).toBe('full');
  });

  it('Continue takes focus, so a keyboard user is on it', () => {
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue: () => {} });
    expect(document.activeElement).toBe(q(el, 'draw-reveal-continue'));
  });
});

describe('continuing: tap, Continue, or 3 seconds, exactly once', () => {
  it('Continue continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    q(el, 'draw-reveal-continue').click();
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('a tap anywhere on the panel continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    q(el, 'draw-reveal').click();
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('after 3 seconds it continues on its own, not before', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 1);
    expect(oncontinue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('a tap then the timer (or two taps) is still one continue', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    q(el, 'draw-reveal-continue').click();
    q(el, 'draw-reveal').click();
    vi.advanceTimersByTime(DRAW_REVEAL_MS * 2);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('unmounted before 3 seconds (Home, a new game): the timer never fires', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    cleanup();
    vi.advanceTimersByTime(DRAW_REVEAL_MS * 2);
    expect(oncontinue).not.toHaveBeenCalled();
  });
});

describe('keyboard: auto-repeat never skips the reveal', () => {
  it('held Enter (repeat keydowns) is refused and does not continue', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    const button = q(el, 'draw-reveal-continue');
    const first = key(button, 'keydown', 'Enter', true);
    const second = key(button, 'keydown', 'Enter', true);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it('held Space carried over from the last screen: its keyup click is ignored', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    const button = q(el, 'draw-reveal-continue');
    key(button, 'keydown', ' ', true);
    key(button, 'keyup', ' ', false);
    button.click(); // the click a browser fires on Space keyup
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it('a fresh press after the held key is let go continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    const button = q(el, 'draw-reveal-continue');
    key(button, 'keydown', ' ', true);
    key(button, 'keyup', ' ', false);
    button.click();
    const fresh = key(button, 'keydown', 'Enter', false);
    expect(fresh.defaultPrevented).toBe(false);
    button.click(); // the click a browser fires on Enter keydown
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });
});
