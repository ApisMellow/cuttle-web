// @vitest-environment jsdom
// P2 W13 — CounterPrompt (SPEC §4.3 Presentation table, §6.3 Counter/Decline
// rows, R14). One component serves the real counter window and the
// synthetic ack; the ONLY difference is the counter buttons, which the
// acting player never sees. Everything else — heading, the one-off and
// chain lines, the "Let it resolve" control and its position — must be
// byte-identical, and nothing may auto-advance.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CounterPrompt from '../../src/lib/components/CounterPrompt.svelte';
import type { AppliedMove } from '../../src/lib/bridge/schema';
import { Kind, appliedMove } from './game-test-support';

const hosts: { host: HTMLDivElement; instance: ReturnType<typeof mount> }[] = [];

afterEach(() => {
  for (const { host, instance } of hosts.splice(0)) {
    unmount(instance);
    host.remove();
  }
});

const ENTRIES: AppliedMove[] = [
  appliedMove({
    by: 0,
    kind: Kind.OneOff,
    seq: 3,
    card: { Rank: 9, Suit: 2 },
    targetCard: { Rank: 5, Suit: 1 },
    description: 'play 9♥ as one-off',
  }),
  appliedMove({ by: 1, kind: Kind.Counter, seq: 4, card: { Rank: 2, Suit: 3 }, description: 'counter with 2♠' }),
];

interface Opts {
  options?: { index: number; description: string }[];
  onresolve?: () => void;
  oncounter?: (index: number) => void;
}

function render(opts: Opts = {}): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const instance = mount(CounterPrompt, {
    target: host,
    props: {
      entries: ENTRIES,
      viewer: 0,
      names: ['Alice', 'Blake'] as const,
      options: opts.options ?? [],
      onresolve: opts.onresolve ?? (() => {}),
      oncounter: opts.oncounter ?? (() => {}),
    },
  });
  flushSync();
  hosts.push({ host, instance });
  return host;
}

/** The DOM with the counter buttons (the one allowed difference) removed. */
function withoutCounterOptions(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('[data-testid^="counter-option-"]')) el.remove();
  return clone.innerHTML;
}

describe('CounterPrompt (SPEC §4.3)', () => {
  it('renders the one-off and every 2 in the chain as lines with mini faces', () => {
    const el = render();
    const lines = el.querySelectorAll('.counter-prompt__line');
    expect(lines).toHaveLength(2);
    // one-off line names card + target, counter line names the 2 (recapCards)
    expect(lines[0].querySelectorAll('[data-size="mini"]')).toHaveLength(2);
    expect(lines[1].querySelectorAll('[data-size="mini"]')).toHaveLength(1);
    expect(lines[0].textContent).toContain('You played');
    expect(lines[1].textContent).toContain('Blake countered');
  });

  it('always offers "Let it resolve"; one button per legal 2 only when given', () => {
    const synthetic = render();
    expect(synthetic.querySelector('[data-testid="counter-resolve"]')?.textContent?.trim()).toBe('Let it resolve');
    expect(synthetic.querySelectorAll('[data-testid^="counter-option-"]')).toHaveLength(0);

    const real = render({
      options: [
        { index: 1, description: 'counter with 2x' },
        { index: 3, description: 'counter with 2y' },
      ],
    });
    expect(real.querySelector('[data-testid="counter-resolve"]')?.textContent?.trim()).toBe('Let it resolve');
    expect([...real.querySelectorAll('[data-testid^="counter-option-"]')].map((b) => b.getAttribute('data-testid'))).toEqual([
      'counter-option-1',
      'counter-option-3',
    ]);
  });

  it('PRIVACY: real window and synthetic ack are byte-identical apart from the counter buttons', () => {
    const synthetic = render();
    const real = render({ options: [{ index: 2, description: 'counter with 2x' }] });
    expect(withoutCounterOptions(real)).toBe(withoutCounterOptions(synthetic));
  });

  it('"Let it resolve" is one tap (it IS the confirm, SPEC §6.3) and fires once', () => {
    const onresolve = vi.fn();
    const el = render({ onresolve });
    const button = el.querySelector<HTMLButtonElement>('[data-testid="counter-resolve"]')!;
    button.click();
    button.click();
    flushSync();
    expect(onresolve).toHaveBeenCalledTimes(1);
  });

  it('a counter tap stages (R12): nothing fires until Confirm; Cancel returns to the choice', () => {
    const oncounter = vi.fn();
    const onresolve = vi.fn();
    const el = render({ options: [{ index: 4, description: 'counter with 2x' }], oncounter, onresolve });

    el.querySelector<HTMLButtonElement>('[data-testid="counter-option-4"]')!.click();
    flushSync();
    expect(oncounter).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="staging-bar"]')?.textContent).toContain('Counter with 2x'); // W25: sentence-cased

    el.querySelector<HTMLButtonElement>('[data-testid="staging-cancel"]')!.click();
    flushSync();
    expect(el.querySelector('[data-testid="staging-bar"]')).toBeNull();

    el.querySelector<HTMLButtonElement>('[data-testid="counter-option-4"]')!.click();
    flushSync();
    el.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]')?.click();
    flushSync();
    expect(oncounter).toHaveBeenCalledTimes(1);
    expect(oncounter).toHaveBeenCalledWith(4);
    expect(onresolve).not.toHaveBeenCalled();
  });

  it('never auto-advances (no timer fires a callback)', () => {
    vi.useFakeTimers();
    try {
      const onresolve = vi.fn();
      const oncounter = vi.fn();
      render({ options: [{ index: 1, description: 'c' }], onresolve, oncounter });
      vi.advanceTimersByTime(60_000);
      expect(onresolve).not.toHaveBeenCalled();
      expect(oncounter).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('W25: a staged counter locks "Let it resolve"', () => {
  const OPTS = [{ index: 1, description: 'counter with 2♣' }];

  it('disables "Let it resolve" while a counter is staged, and a tap on it does nothing', () => {
    const onresolve = vi.fn();
    const el = render({ options: OPTS, onresolve });
    const resolve = el.querySelector<HTMLButtonElement>('[data-testid="counter-resolve"]')!;
    expect(resolve.disabled).toBe(false);
    el.querySelector<HTMLElement>('[data-testid="counter-option-1"]')!.click();
    flushSync();
    expect(resolve.disabled).toBe(true);
    resolve.click();
    flushSync();
    expect(onresolve).not.toHaveBeenCalled();

    el.querySelector<HTMLElement>('[data-testid="staging-cancel"]')!.click();
    flushSync();
    expect(resolve.disabled).toBe(false);
  });

  it('capitalises the staged text: "Counter with 2♣"', () => {
    const el = render({ options: OPTS });
    el.querySelector<HTMLElement>('[data-testid="counter-option-1"]')!.click();
    flushSync();
    expect(el.querySelector('[data-testid="staging-bar"]')?.textContent).toContain('Counter with 2♣');
  });

  it('PRIVACY: unstaged, the real window and the synthetic ack still match (no disabled attribute on either)', () => {
    const real = render({ options: OPTS });
    const synthetic = render({ options: [] });
    expect(withoutCounterOptions(real)).toBe(withoutCounterOptions(synthetic));
    expect(real.querySelector('[data-testid="counter-resolve"]')?.hasAttribute('disabled')).toBe(false);
  });
});

describe('CounterPrompt focus (r16, desktop keyboard)', () => {
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  };

  it('review B1: starts on the heading (not a control), on both paths', () => {
    const real = render({ options: [{ index: 7, description: 'counter with 2♥' }] });
    expect(document.activeElement).toBe(real.querySelector('.counter-prompt__heading'));
    const synthetic = render({ options: [] });
    expect(document.activeElement).toBe(synthetic.querySelector('.counter-prompt__heading'));
  });

  it('re-review B2 (R12): a fresh press stages the counter, but a repeated Enter on the staged Confirm (or Cancel) does nothing', async () => {
    const countered: number[] = [];
    const el = render({ options: [{ index: 7, description: 'counter with 2♥' }], oncounter: (i) => countered.push(i) });
    el.querySelector<HTMLButtonElement>('[data-testid="counter-option-7"]')!.click();
    flushSync();
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    el.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-testid="staging-cancel"]')!.click();
    flushSync();
    expect(countered).toEqual([]);
    expect(el.querySelector('[data-testid="staging-confirm"]')).not.toBeNull();
    // After the repeat's task, a fresh press confirms.
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: false }));
    el.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]')!.click();
    expect(countered).toEqual([7]);
  });

  it('review B1: an auto-repeated Enter cannot resolve or counter', () => {
    const calls: string[] = [];
    const el = render({
      options: [{ index: 7, description: 'counter with 2♥' }],
      onresolve: () => calls.push('resolve'),
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    el.querySelector<HTMLButtonElement>('[data-testid="counter-resolve"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-testid="counter-option-7"]')!.click();
    flushSync();
    expect(calls).toEqual([]);
    expect(el.querySelector('[data-testid="staging-confirm"]')).toBeNull();
  });

  it('staging a counter moves focus to Confirm; Cancel brings it back to the first option', async () => {
    const el = render({ options: [{ index: 7, description: 'counter with 2♥' }] });
    el.querySelector<HTMLButtonElement>('[data-testid="counter-option-7"]')!.click();
    flushSync();
    await settle();
    expect(document.activeElement).toBe(el.querySelector('[data-testid="staging-confirm"]'));
    el.querySelector<HTMLButtonElement>('[data-testid="staging-cancel"]')!.click();
    flushSync();
    await settle();
    expect(document.activeElement).toBe(el.querySelector('[data-testid="counter-option-7"]'));
  });
});
