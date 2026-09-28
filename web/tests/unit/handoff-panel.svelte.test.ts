// @vitest-environment jsdom
// SPEC §4.5 (amended 2026-09-27), docs/design.md §8, orchestrator ruling A1
// ("same screen, armed") — HandoffPanel is the ONE screen shown for both
// the `handoff` and `reveal` curtain kinds: "Pass the phone to NAME", the
// neutral label, the hold ring and the two-step pill.
//
// HandoffPanel takes the already-neutral label string, never a
// HandoffReason: Curtain computes it with `handoffLabel(reason)`. The raw
// reason's absence from the DOM is asserted at the Curtain level
// (`curtain-panel.svelte.test.ts`), which is where the reason exists.
// Control behaviour (arming, latch, hold) is covered in
// `reveal-gate.svelte.test.ts`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import HandoffPanel from '../../src/lib/components/HandoffPanel.svelte';

interface RenderProps {
  name: string;
  player: 0 | 1;
  label: string;
  stage: 'handoff' | 'reveal';
  epoch?: number;
  revealPreference: 'hold' | 'two-step';
  onadvance: () => void;
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(HandoffPanel, { target: host, props });
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

function base(overrides: Partial<RenderProps> = {}): RenderProps {
  return { name: 'Alice', player: 0, label: 'Your turn', stage: 'handoff', revealPreference: 'hold', onadvance: () => {}, ...overrides };
}

function root(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="curtain-gate"]');
  if (!found) throw new Error('no curtain-gate root rendered');
  return found;
}

describe('HandoffPanel content (SPEC §4.5, design.md §8)', () => {
  it('renders "Pass the phone to", the name, the label, the ring and the pill', () => {
    const el = render(base());
    const r = root(el);
    expect(r.textContent).toContain('Pass the phone to');
    expect(r.querySelector('.gate__name')?.textContent).toBe('Alice');
    expect(r.querySelector('.gate__label')?.textContent).toBe('Your turn');
    expect(r.querySelector('[data-testid="reveal-hold"]')).toBeTruthy();
    expect(r.querySelector('[data-testid="reveal-two-step"]')?.textContent?.trim()).toBe("I'm Alice");
  });

  it('the label slot is always present, even when empty (fixed-height slot)', () => {
    const el = render(base({ label: '' }));
    const slot = root(el).querySelector('.gate__label');
    expect(slot).toBeTruthy();
    expect(slot?.textContent).toBe('');
  });

  it('the handoff and reveal stages share one layout: only the pill text and the armed class differ', () => {
    const strip = (html: string): string =>
      html.replace("I'm Alice", '<<PILL>>').replace('Show my hand', '<<PILL>>').replace(/ reveal--armed/g, '');
    const handoff = root(render(base({ stage: 'handoff' }))).outerHTML;
    const reveal = root(render(base({ stage: 'reveal' }))).outerHTML;
    expect(handoff).not.toBe(reveal);
    expect(strip(reveal)).toBe(strip(handoff));
  });

  it('the label slot has a fixed height of 1.5em in the stylesheet (design.md §8)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'HandoffPanel.svelte'), 'utf8');
    const style = source.slice(source.indexOf('<style>'));
    const rules = [...style.matchAll(/\.gate__label\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBe(1);
    const decls = rules[0]
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    expect(decls).toContain('height: 1.5em');
    // Nothing else may let the box grow or shrink with its text.
    expect(decls.some((d) => /^(min-|max-)?height\s*:/.test(d) && d !== 'height: 1.5em')).toBe(false);
  });

  it('renders zero game state: no digits anywhere in the text', () => {
    for (const stage of ['handoff', 'reveal'] as const) {
      expect(root(render(base({ stage }))).textContent ?? '').not.toMatch(/\d/);
    }
  });

  it('the old separate "Continue" control is gone', () => {
    const el = render(base());
    expect(el.querySelector('[data-testid="handoff-continue"]')).toBeNull();
    expect(el.textContent).not.toContain('Continue');
  });

  it('forwards onadvance to the controls: the pill arms from handoff', () => {
    const seen: number[] = [];
    const el = render(base({ onadvance: () => seen.push(1) }));
    el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]')?.click();
    flushSync();
    expect(seen).toEqual([1]);
  });

  it('never auto-advances', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    render(base({ onadvance: () => seen.push(1) }));
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([]);
  });
});

describe('HandoffPanel prop changes on one mounted instance (OQ-13 pattern)', () => {
  it('keeps its root across handoff -> reveal and a name change, never mixing stale content', () => {
    const props: RenderProps = $state(base());
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(HandoffPanel, { target: host, props });
    flushSync();
    const sameRoot = root(host);

    props.stage = 'reveal';
    flushSync();
    expect(root(host)).toBe(sameRoot);
    expect(sameRoot.querySelector('[data-testid="reveal-two-step"]')?.textContent?.trim()).toBe('Show my hand');
    expect(sameRoot.querySelector('.gate__label')?.textContent).toBe('Your turn');

    props.name = 'Blake';
    props.label = 'Your response';
    props.stage = 'handoff';
    flushSync();
    expect(root(host)).toBe(sameRoot);
    expect(sameRoot.textContent).toContain('Blake');
    expect(sameRoot.textContent).not.toContain('Alice');
    expect(sameRoot.querySelector('.gate__label')?.textContent).toBe('Your response');
  });
});
