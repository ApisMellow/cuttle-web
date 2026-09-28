// @vitest-environment jsdom
// SPEC §4.5 (R13.3), docs/design.md §8-9, orchestrator ruling A1 ("same
// screen, armed") — RevealGate, the two reveal controls (hold ring and
// two-step pill) shared by the `handoff` and `reveal` curtain kinds.
//
// The contract under test:
//   - `stage: 'handoff'`: the FIRST explicit action (a pill tap, or a
//     pointerdown on the ring) calls onadvance() once (handoff -> reveal).
//     A ring press keeps running as the 600 ms hold.
//   - `stage: 'reveal'`: the hold completing, or a pill tap ("Show my
//     hand"), calls onadvance() once (reveal -> next).
//   - One onadvance() per machine transition, never more: a latch keyed on
//     (stage, epoch, name) that resets when any of them changes on the SAME
//     instance (OQ-13).
//
// `lib/curtain.ts`'s pure gate is proven in `curtain-hold.test.ts` and is not
// re-tested here.
//
// jsdom has no `window.matchMedia` (calling it throws "not a function"), so
// reduced-motion tests stub it and remove the stub afterwards.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlayerId } from '../../src/lib/bridge/schema';
import { HOLD_DURATION_MS } from '../../src/lib/curtain';
import RevealGate from '../../src/lib/components/RevealGate.svelte';

type Stage = 'handoff' | 'reveal';

interface RenderProps {
  name: string;
  player: PlayerId;
  stage: Stage;
  epoch?: number;
  revealPreference: 'hold' | 'two-step';
  onadvance: () => void;
}

/** Helper input: `player` defaults to 0. */
type RenderInput = Omit<RenderProps, 'player'> & { player?: PlayerId };

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let matchMediaStubbed = false;

function render(input: RenderInput): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  const props: RenderProps = { player: 0, ...input };
  instance = mount(RevealGate, { target: host, props });
  flushSync();
  return host;
}

/** Mounts ONE instance driven by a `$state` props object (OQ-13 pattern). */
function renderLive(initial: RenderInput): { el: HTMLDivElement; props: RenderProps } {
  cleanup();
  const props: RenderProps = $state({ player: 0, ...initial });
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(RevealGate, { target: host, props });
  flushSync();
  return { el: host, props };
}

/**
 * The store's handoff -> reveal step, modelled on one instance: onadvance in
 * `handoff` moves the stage to `reveal` (with a fresh epoch, as Curtain
 * does); in `reveal` it only records the call and leaves the gate mounted,
 * which is the worst case for a double fire (a slow or stuck parent).
 */
function renderMachine(opts: { revealPreference?: 'hold' | 'two-step'; stage?: Stage } = {}): {
  el: HTMLDivElement;
  props: RenderProps;
  calls: Stage[];
} {
  const calls: Stage[] = [];
  const live = renderLive({
    name: 'Alice',
    stage: opts.stage ?? 'handoff',
    epoch: 1,
    revealPreference: opts.revealPreference ?? 'hold',
    onadvance: () => {
      calls.push(live.props.stage);
      if (live.props.stage === 'handoff') {
        live.props.stage = 'reveal';
        live.props.epoch = (live.props.epoch ?? 0) + 1;
      }
    },
  });
  return { ...live, calls };
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(() => {
  cleanup();
  if (matchMediaStubbed) {
    delete (window as { matchMedia?: unknown }).matchMedia;
    matchMediaStubbed = false;
  }
  vi.useRealTimers();
});

function stubReducedMotion(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  matchMediaStubbed = true;
}

function holdButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="reveal-hold"]');
  if (!found) throw new Error('no reveal-hold button rendered');
  return found;
}

function pill(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]');
  if (!found) throw new Error('no reveal-two-step button rendered');
  return found;
}

function primaryRoot(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-primary]');
  if (!found) throw new Error('no [data-primary] element rendered');
  return found;
}

function press(el: HTMLElement): void {
  holdButton(el).dispatchEvent(new Event('pointerdown', { bubbles: true }));
  flushSync();
}

function release(el: HTMLElement, type = 'pointerup'): void {
  holdButton(el).dispatchEvent(new Event(type, { bubbles: true }));
  flushSync();
}

function tap(el: HTMLElement): void {
  pill(el).click();
  flushSync();
}

function ring(el: HTMLElement): string {
  return holdButton(el).style.getPropertyValue('--cu-hold-progress');
}

function tick(ms: number): void {
  vi.advanceTimersByTime(ms);
  flushSync();
}

describe('RevealGate controls and content (SPEC §4.5, design.md §8)', () => {
  it('both controls are always in the DOM, in both stages', () => {
    for (const stage of ['handoff', 'reveal'] as const) {
      const el = render({ name: 'Alice', stage, revealPreference: 'hold', onadvance: () => {} });
      expect(holdButton(el).tagName).toBe('BUTTON');
      expect(pill(el).tagName).toBe('BUTTON');
    }
  });

  it('the pill reads "I\'m NAME" in handoff and "Show my hand" in reveal', () => {
    expect(pill(render({ name: 'Alice', stage: 'handoff', revealPreference: 'hold', onadvance: () => {} })).textContent?.trim()).toBe(
      "I'm Alice",
    );
    expect(pill(render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => {} })).textContent?.trim()).toBe(
      'Show my hand',
    );
  });

  it('--cu-dur-hold is exactly HOLD_DURATION_MS (design.md §10 rule 10)', () => {
    const el = render({ name: 'Alice', stage: 'handoff', revealPreference: 'hold', onadvance: () => {} });
    expect(primaryRoot(el).style.getPropertyValue('--cu-dur-hold')).toBe(`${HOLD_DURATION_MS}ms`);
    expect(HOLD_DURATION_MS).toBe(600);
  });
});

describe('Arming from handoff (ruling A1)', () => {
  it('pill path: "I\'m NAME" advances handoff -> reveal once, then "Show my hand" completes it', () => {
    const { el, calls } = renderMachine();
    tap(el);
    expect(calls).toEqual(['handoff']);
    expect(pill(el).textContent?.trim()).toBe('Show my hand');
    tap(el);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('ring path: pointerdown advances handoff -> reveal at once, and the SAME press completes the hold at 600 ms', () => {
    vi.useFakeTimers();
    const { el, calls } = renderMachine();
    press(el);
    expect(calls).toEqual(['handoff']);
    tick(HOLD_DURATION_MS - 1);
    expect(calls).toEqual(['handoff']);
    tick(1);
    expect(calls).toEqual(['handoff', 'reveal']);
    tick(HOLD_DURATION_MS * 5);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('ring path: releasing early aborts the hold, resets the ring, and leaves the screen armed', () => {
    vi.useFakeTimers();
    const { el, props, calls } = renderMachine();
    press(el);
    tick(300);
    expect(Number(ring(el))).toBeGreaterThan(0);
    release(el);
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 3);
    expect(calls).toEqual(['handoff']);
    expect(props.stage).toBe('reveal');
    expect(pill(el).textContent?.trim()).toBe('Show my hand');

    // Armed: a fresh full hold completes it...
    press(el);
    tick(HOLD_DURATION_MS);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('ring path: after an early release the armed pill completes it too', () => {
    vi.useFakeTimers();
    const { el, calls } = renderMachine();
    press(el);
    tick(100);
    release(el, 'pointerleave');
    tap(el);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('pointercancel and pointerleave abort a hold exactly like pointerup', () => {
    vi.useFakeTimers();
    for (const type of ['pointercancel', 'pointerleave']) {
      const { el, calls } = renderMachine({ stage: 'reveal' });
      press(el);
      tick(100);
      release(el, type);
      tick(HOLD_DURATION_MS);
      expect(calls).toEqual([]);
      expect(ring(el)).toBe('0');
    }
  });
});

describe('B1: once-only latch per machine state', () => {
  it('triple tap on the two-step path: exactly one call per transition (handoff, reveal), never a third', () => {
    const { el, calls } = renderMachine();
    tap(el);
    tap(el);
    tap(el);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('triple tap with a parent that never leaves handoff: exactly one call', () => {
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'handoff', revealPreference: 'hold', onadvance: () => seen.push(1) });
    tap(el);
    tap(el);
    tap(el);
    expect(seen).toEqual([1]);
  });

  it('triple tap from a restored reveal: exactly one call', () => {
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => seen.push(1) });
    tap(el);
    tap(el);
    tap(el);
    expect(seen).toEqual([1]);
  });

  it('hold then tap on the armed control: exactly one call per transition', () => {
    vi.useFakeTimers();
    const { el, calls } = renderMachine();
    press(el);
    tick(HOLD_DURATION_MS);
    release(el);
    tap(el);
    tap(el);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('tap during a running hold, then the hold completing: exactly one call per transition', () => {
    vi.useFakeTimers();
    const { el, calls } = renderMachine();
    press(el);
    tick(200);
    tap(el);
    expect(calls).toEqual(['handoff', 'reveal']);
    tick(HOLD_DURATION_MS * 2);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('a pill tap during a running hold stops the ring: it resets and never fills afterwards', () => {
    vi.useFakeTimers();
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => {} });
    press(el);
    tick(200);
    expect(Number(ring(el))).toBeGreaterThan(0);
    tap(el);
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 2);
    expect(ring(el)).toBe('0');
  });

  it('a second hold after completion does not fire again for the same state', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(HOLD_DURATION_MS);
    release(el);
    press(el);
    tick(HOLD_DURATION_MS);
    expect(seen).toEqual([1]);
  });

  it('a pointerdown on the ring in handoff with a parent that never leaves handoff: one call, and the completed hold adds none', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'handoff', revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(HOLD_DURATION_MS * 2);
    expect(seen).toEqual([1]);
  });
});

describe('B1: the latch resets on the SAME instance (OQ-13)', () => {
  it('a new name re-opens the latch, and the pill text follows the name', () => {
    const seen: number[] = [];
    const { el, props } = renderLive({ name: 'Alice', stage: 'handoff', epoch: 1, revealPreference: 'hold', onadvance: () => seen.push(1) });
    tap(el);
    tap(el);
    expect(seen).toEqual([1]);

    props.name = 'Blake';
    flushSync();
    expect(pill(el).textContent?.trim()).toBe("I'm Blake");
    tap(el);
    expect(seen).toEqual([1, 1]);
    tap(el);
    expect(seen).toEqual([1, 1]);
  });

  it('a new curtain state (epoch) re-opens the latch, same stage and name', () => {
    const seen: number[] = [];
    const { el, props } = renderLive({ name: 'Alice', stage: 'reveal', epoch: 1, revealPreference: 'hold', onadvance: () => seen.push(1) });
    tap(el);
    tap(el);
    expect(seen).toEqual([1]);
    props.epoch = 2;
    flushSync();
    tap(el);
    expect(seen).toEqual([1, 1]);
  });

  it('a new stage re-opens the latch (reveal -> handoff, same name and epoch)', () => {
    const seen: number[] = [];
    const { el, props } = renderLive({ name: 'Alice', stage: 'reveal', epoch: 1, revealPreference: 'hold', onadvance: () => seen.push(1) });
    tap(el);
    props.stage = 'handoff';
    flushSync();
    expect(pill(el).textContent?.trim()).toBe("I'm Alice");
    tap(el);
    expect(seen).toEqual([1, 1]);
  });

  it('a name change aborts a running hold: it never fires for the new name', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const { el, props } = renderLive({ name: 'Alice', stage: 'reveal', epoch: 1, revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(300);
    props.name = 'Blake';
    flushSync();
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 2);
    expect(seen).toEqual([]);
  });

  it('CA1: handoff(A) -> reveal(B) aborts a running hold: the ring resets and B is never revealed by A\'s press', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { el, props } = renderLive({ name: 'Alice', player: 0, stage: 'handoff', epoch: 1, revealPreference: 'hold', onadvance: () => calls.push(props.name) });
    press(el);
    expect(calls).toEqual(['Alice']);
    tick(300);
    expect(Number(ring(el))).toBeGreaterThan(0);

    props.stage = 'reveal';
    props.name = 'Blake';
    props.player = 1;
    props.epoch = 2;
    flushSync();
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 2);
    expect(calls).toEqual(['Alice']);
    expect(ring(el)).toBe('0');
  });

  it('CA2: reveal -> handoff for the same player aborts a running hold', () => {
    vi.useFakeTimers();
    const calls: Stage[] = [];
    const { el, props } = renderLive({ name: 'Alice', player: 0, stage: 'reveal', epoch: 1, revealPreference: 'hold', onadvance: () => calls.push(props.stage) });
    press(el);
    tick(300);
    expect(Number(ring(el))).toBeGreaterThan(0);

    props.stage = 'handoff';
    props.epoch = 2;
    flushSync();
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 2);
    expect(calls).toEqual([]);
    expect(ring(el)).toBe('0');
  });

  it('carry-over is keyed on the player id: handoff(0) -> reveal(1) with the SAME name aborts the hold', () => {
    vi.useFakeTimers();
    const calls: Stage[] = [];
    const { el, props } = renderLive({ name: 'Sam', player: 0, stage: 'handoff', epoch: 1, revealPreference: 'hold', onadvance: () => calls.push(props.stage) });
    press(el);
    expect(calls).toEqual(['handoff']);
    tick(300);

    props.stage = 'reveal';
    props.player = 1;
    props.epoch = 2;
    flushSync();
    expect(ring(el)).toBe('0');
    tick(HOLD_DURATION_MS * 2);
    expect(calls).toEqual(['handoff']);
  });

  it('carry-over still works for the same player id: handoff(0) -> reveal(0) completes on the same press', () => {
    vi.useFakeTimers();
    const calls: Stage[] = [];
    const { el, props } = renderLive({ name: 'Sam', player: 0, stage: 'handoff', epoch: 1, revealPreference: 'hold', onadvance: () => calls.push(props.stage) });
    press(el);
    props.stage = 'reveal';
    props.epoch = 2;
    flushSync();
    tick(HOLD_DURATION_MS);
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('only handoff -> reveal for the same name carries a press over; reveal -> reveal (new epoch) aborts it', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const { el, props } = renderLive({ name: 'Alice', stage: 'reveal', epoch: 1, revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(300);
    props.epoch = 2;
    flushSync();
    tick(HOLD_DURATION_MS * 2);
    expect(seen).toEqual([]);
  });
});

describe('B3: the hold works in every mode (M18)', () => {
  const modes: { label: string; reduced: boolean; pref: 'hold' | 'two-step' }[] = [
    { label: 'hold preferred', reduced: false, pref: 'hold' },
    { label: 'two-step preferred', reduced: false, pref: 'two-step' },
    { label: 'reduced motion, hold preferred', reduced: true, pref: 'hold' },
    { label: 'reduced motion, two-step preferred', reduced: true, pref: 'two-step' },
  ];

  for (const mode of modes) {
    it(`${mode.label}: ring press arms from handoff and completes at exactly 600 ms`, () => {
      vi.useFakeTimers();
      if (mode.reduced) stubReducedMotion(true);
      const { el, calls } = renderMachine({ revealPreference: mode.pref });
      press(el);
      expect(calls).toEqual(['handoff']);
      tick(HOLD_DURATION_MS - 1);
      expect(calls).toEqual(['handoff']);
      tick(1);
      expect(calls).toEqual(['handoff', 'reveal']);
    });
  }
});

describe('B3: reduced motion fills the ring in three discrete steps (M16, design.md §9)', () => {
  /** Samples the ring every `step` ms from press to completion, collapsing repeats. */
  function sampleRing(el: HTMLElement, step: number): string[] {
    const seen: string[] = [];
    const record = (): void => {
      const value = ring(el);
      if (seen[seen.length - 1] !== value) seen.push(value);
    };
    record();
    press(el);
    record();
    for (let elapsed = 0; elapsed < HOLD_DURATION_MS + 2 * step; elapsed += step) {
      tick(step);
      record();
    }
    return seen;
  }

  it('under reduced motion the ring steps 0 -> 1/3 -> 2/3 -> 1 and nothing else, and the transition fires', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => seen.push(1) });
    expect(sampleRing(el, 10)).toEqual(['0', String(1 / 3), String(2 / 3), '1']);
    expect(seen).toEqual([1]);
  });

  it('each step lands on a completed third: 1/3 at 200 ms, 2/3 at 400 ms, 1 only at 600 ms with the transition', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(150);
    expect(ring(el)).toBe('0');
    tick(60); // 210 ms
    expect(ring(el)).toBe(String(1 / 3));
    tick(200); // 410 ms
    expect(ring(el)).toBe(String(2 / 3));
    tick(HOLD_DURATION_MS - 410 - 1); // 599 ms
    expect(ring(el)).toBe(String(2 / 3));
    expect(seen).toEqual([]);
    tick(1); // 600 ms
    expect(ring(el)).toBe('1');
    expect(seen).toEqual([1]);
  });

  it('without reduced motion the ring fills continuously (more than three intermediate values)', () => {
    vi.useFakeTimers();
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => {} });
    const values = sampleRing(el, 20);
    expect(values.length).toBeGreaterThan(6);
    expect(values[values.length - 1]).toBe('1');
  });
});

describe('B3: data-primary selects the emphasised control, visibly (SPEC §4.5)', () => {
  it('is "two-step" under reduced motion even when revealPreference is "hold"', () => {
    stubReducedMotion(true);
    const el = render({ name: 'Alice', stage: 'handoff', revealPreference: 'hold', onadvance: () => {} });
    expect(primaryRoot(el).getAttribute('data-primary')).toBe('two-step');
  });

  it('follows revealPreference without reduced motion', () => {
    for (const pref of ['hold', 'two-step'] as const) {
      const el = render({ name: 'Alice', stage: 'handoff', revealPreference: pref, onadvance: () => {} });
      expect(primaryRoot(el).getAttribute('data-primary')).toBe(pref);
    }
  });

  it('the stylesheet styles each primary value differently (not a dead attribute)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'RevealGate.svelte'), 'utf8');
    const style = source.slice(source.indexOf('<style>'));
    const rulesFor = (value: string): string[] =>
      [...style.matchAll(new RegExp(`\\[data-primary='${value}'\\][^{]*\\{([^}]*)\\}`, 'g'))].map((m) => m[1].trim());
    const hold = rulesFor('hold');
    const twoStep = rulesFor('two-step');
    expect(hold.length).toBeGreaterThan(0);
    expect(twoStep.length).toBeGreaterThan(0);
    expect(hold.join('|')).not.toBe(twoStep.join('|'));
  });
});

describe('RevealGate never auto-advances', () => {
  it('mounting either stage and running timers never calls onadvance', () => {
    vi.useFakeTimers();
    for (const stage of ['handoff', 'reveal'] as const) {
      const seen: number[] = [];
      render({ name: 'Alice', stage, revealPreference: 'hold', onadvance: () => seen.push(1) });
      tick(60_000);
      expect(seen).toEqual([]);
    }
  });

  it('unmounting mid-hold disposes cleanly: no error, no late onadvance', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const el = render({ name: 'Alice', stage: 'reveal', revealPreference: 'hold', onadvance: () => seen.push(1) });
    press(el);
    tick(200);
    expect(() => cleanup()).not.toThrow();
    tick(HOLD_DURATION_MS);
    expect(seen).toEqual([]);
  });
});
