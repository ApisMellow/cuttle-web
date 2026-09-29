// @vitest-environment jsdom
// Issue #27 — DrawRevealPanel (SPEC §4.7): the drawer's hand with the drawn
// cards arriving face down from the deck and turning face up. It continues
// on a tap, on its Continue button, or on its own after 3 seconds, exactly
// once.
//
// Input rules:
//   - A tap counts only if its press (pointerdown) landed on the panel after
//     it mounted. A finger still down from the screen before (the 600 ms
//     ring hold) lifts onto the panel without continuing it.
//   - Key auto-repeat never continues it, and a key held from the screen
//     before is not a press (lib/keyGuard.ts, the same guard as the curtain
//     screens). Letting go of a held key leaves nothing behind: the next tap
//     still counts.
//   - While the game menu is open (`paused`) the 3 s wait stops and taps
//     are ignored; it resumes with the time it had left.
//
// `.svelte.test.ts` so the pause tests drive ONE mounted instance through a
// `$state` props object.
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
  paused?: boolean;
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

/** A finger (or mouse button) going down on `el`. */
function press(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  flushSync();
}

/** The click a pointer produces on lift (`detail` 1, unlike a key's 0). */
function lift(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  flushSync();
}

/** A whole tap: press and lift on the same element. */
function tap(el: HTMLElement): void {
  press(el);
  lift(el);
}

/** An Enter keydown on a focused button, and the click a browser fires for it unless prevented. */
function enterDown(button: HTMLElement, repeat: boolean): void {
  const event = key(button, 'keydown', 'Enter', repeat);
  if (!event.defaultPrevented) button.click();
}

/** Lets the key guard's end-of-task reset run, as between two real events. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  it('Continue continues (a key press or a programmatic click: no pointer involved)', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    q(el, 'draw-reveal-continue').click();
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('a tap on Continue continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    tap(q(el, 'draw-reveal-continue'));
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('a tap anywhere on the panel continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    tap(q(el, 'draw-reveal'));
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('a tap on a card in the panel continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    tap(el.querySelector<HTMLElement>('[data-draw-slot]')!);
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
    tap(q(el, 'draw-reveal'));
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

describe('a finger still down from the screen before never skips the reveal (iOS)', () => {
  it('a lift onto the panel whose press came before it mounted does not continue', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    lift(q(el, 'draw-reveal'));
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it('nor a lift onto Continue', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    lift(q(el, 'draw-reveal-continue'));
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it('a press outside the panel that lifts on it does not continue', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    press(document.body);
    lift(q(el, 'draw-reveal'));
    lift(q(el, 'draw-reveal-continue'));
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it('after the stray lift, a real tap continues', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    lift(q(el, 'draw-reveal'));
    expect(oncontinue).not.toHaveBeenCalled();
    tap(q(el, 'draw-reveal'));
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });
});

describe('keyboard: auto-repeat never skips the reveal', () => {
  it('held Enter (repeat keydowns, each clicking the focused button) does not continue', () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    const button = q(el, 'draw-reveal-continue');
    enterDown(button, true);
    enterDown(button, true);
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
    enterDown(button, false);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('held Enter, let go (its keyup clicks nothing), then a tap on Continue: the tap continues', async () => {
    const oncontinue = vi.fn();
    const el = render({ hand: [KING, D1, D2], drawn: [1, 2], oncontinue });
    const button = q(el, 'draw-reveal-continue');
    enterDown(button, true);
    enterDown(button, true);
    key(button, 'keyup', 'Enter', false);
    expect(oncontinue).not.toHaveBeenCalled();
    await nextTask();
    tap(button);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });
});

describe('the game menu pauses the 3 s wait', () => {
  it('open: the timer stops and a tap does nothing; closed: it resumes with the time it had left', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    const props = $state<Props>({ hand: [KING, D1, D2], drawn: [1, 2], paused: false, oncontinue });
    const el = render(props);
    vi.advanceTimersByTime(1000);

    props.paused = true;
    flushSync();
    expect(q(el, 'draw-reveal').dataset.paused).toBe('true');
    vi.advanceTimersByTime(DRAW_REVEAL_MS * 5);
    tap(q(el, 'draw-reveal'));
    q(el, 'draw-reveal-continue').click();
    expect(oncontinue).not.toHaveBeenCalled();

    props.paused = false;
    flushSync();
    expect(q(el, 'draw-reveal').dataset.paused).toBe('false');
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 1000 - 1);
    expect(oncontinue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('mounted while the menu is open: no wait runs until it closes, then the full 3 s', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    const props = $state<Props>({ hand: [KING, D1, D2], drawn: [1, 2], paused: true, oncontinue });
    render(props);
    vi.advanceTimersByTime(DRAW_REVEAL_MS * 5);
    expect(oncontinue).not.toHaveBeenCalled();
    props.paused = false;
    flushSync();
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 1);
    expect(oncontinue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });

  it('opening and closing the menu twice still adds up to 3 s of showing', () => {
    vi.useFakeTimers();
    const oncontinue = vi.fn();
    const props = $state<Props>({ hand: [KING, D1, D2], drawn: [1, 2], paused: false, oncontinue });
    render(props);
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(1000);
      props.paused = true;
      flushSync();
      vi.advanceTimersByTime(20_000);
      props.paused = false;
      flushSync();
    }
    vi.advanceTimersByTime(DRAW_REVEAL_MS - 2000 - 1);
    expect(oncontinue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(oncontinue).toHaveBeenCalledTimes(1);
  });
});
