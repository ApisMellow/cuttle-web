// @vitest-environment jsdom
// SPEC §4, §4.5, §5.2 (W10), orchestrator ruling A1 — Curtain, the
// full-viewport host. This file tests `lib/components/Curtain.svelte`,
// distinct from `curtain.test.ts` (the pure `stores/curtain.svelte.ts`
// machine).
//
// `.svelte.test.ts`: prop-change tests drive ONE mounted instance through a
// `$state` props object (AGENTS.md "Svelte 5 conventions", OQ-13).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, PlayerId } from '../../src/lib/bridge/schema';
import { HOLD_DURATION_MS } from '../../src/lib/curtain';
import type { CurtainState, HandoffReason } from '../../src/lib/stores/curtain.svelte';
import Curtain from '../../src/lib/components/Curtain.svelte';
import { appliedMove, Kind } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Bob'];
const REASONS: HandoffReason[] = ['turn', 'counter', 'discard', 'seven-return', 'acknowledge'];

function pass(seq: number): AppliedMove {
  return appliedMove({ by: 1, kind: Kind.Pass, description: 'pass', seq });
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  curtain: CurtainState;
  names: readonly [string, string];
  revealPreference: 'hold' | 'two-step';
  recapEntries: AppliedMove[];
  viewer: PlayerId | null;
  onadvance: () => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(Curtain, { target: host, props });
  flushSync();
  return host;
}

function renderLive(initial: RenderProps): { el: HTMLDivElement; props: RenderProps } {
  cleanup();
  const props: RenderProps = $state(initial);
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(Curtain, { target: host, props });
  flushSync();
  return { el: host, props };
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

function baseProps(curtain: CurtainState): RenderProps {
  return { curtain, names: NAMES, revealPreference: 'hold', recapEntries: [], viewer: 0, onadvance: () => {} };
}

function gate(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="curtain-gate"]');
  if (!found) throw new Error('no curtain-gate rendered');
  return found;
}

function label(el: HTMLElement): string | null | undefined {
  return gate(el).querySelector('.gate__label')?.textContent;
}

function pillText(el: HTMLElement): string | undefined {
  return el.querySelector('[data-testid="reveal-two-step"]')?.textContent?.trim();
}

describe('Curtain renders exactly one child per curtain.kind (Contract)', () => {
  it('kind "none": renders nothing at all', () => {
    const el = render(baseProps({ kind: 'none' }));
    expect(el.querySelectorAll('*').length).toBe(0);
    expect(el.textContent).toBe('');
  });

  it('kind "ack" and "result": render nothing', () => {
    expect(render(baseProps({ kind: 'ack', to: 0, synthetic: true })).querySelector('[data-testid="curtain"]')).toBeNull();
    expect(render(baseProps({ kind: 'result' })).querySelector('[data-testid="curtain"]')).toBeNull();
  });

  it('kinds "handoff" and "reveal": the curtain root with the gate screen only', () => {
    for (const curtain of [{ kind: 'handoff', to: 1, reason: 'turn' }, { kind: 'reveal', to: 1 }] as CurtainState[]) {
      const el = render(baseProps(curtain));
      expect(el.querySelector('[data-testid="curtain"]')).toBeTruthy();
      expect(gate(el).textContent).toContain('Bob');
      expect(el.querySelector('[data-testid="recap"]')).toBeNull();
    }
  });

  it('kind "recap": the curtain root with the recap only', () => {
    const props = baseProps({ kind: 'recap', to: 0, entries: [pass(1)] });
    props.recapEntries = [pass(1), pass(2)];
    const el = render(props);
    expect(el.querySelector('[data-testid="recap"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="curtain-gate"]')).toBeNull();
  });

  it('the removed separate screens leave no testid behind', () => {
    const el = render(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    for (const gone of ['handoff', 'handoff-continue', 'reveal-gate']) {
      expect(el.querySelector(`[data-testid="${gone}"]`)).toBeNull();
    }
  });
});

describe('B2: the handoff DOM is invariant across HandoffReason at the Curtain level (M7)', () => {
  function handoffHtml(reason: HandoffReason): string {
    return render(baseProps({ kind: 'handoff', to: 1, reason })).innerHTML;
  }

  it('with the label replaced by a placeholder, innerHTML is byte-identical for all 5 reasons', () => {
    const normalized = REASONS.map((reason) =>
      handoffHtml(reason).replace('Your turn', '<<LABEL>>').replace('Your response', '<<LABEL>>'),
    );
    for (const html of normalized) expect(html).toBe(normalized[0]);
  });

  it('turn ≡ seven-return, and counter ≡ acknowledge ≡ discard, byte for byte', () => {
    expect(handoffHtml('seven-return')).toBe(handoffHtml('turn'));
    expect(handoffHtml('acknowledge')).toBe(handoffHtml('counter'));
    expect(handoffHtml('discard')).toBe(handoffHtml('counter'));
    expect(handoffHtml('turn')).not.toBe(handoffHtml('counter'));
  });

  it('no raw reason token appears in any attribute name or value, for any reason', () => {
    for (const reason of REASONS) {
      const el = render(baseProps({ kind: 'handoff', to: 1, reason }));
      for (const node of el.querySelectorAll('*')) {
        for (const attr of Array.from(node.attributes)) {
          for (const token of REASONS) {
            expect(attr.name.toLowerCase()).not.toContain(token);
            expect(attr.value.toLowerCase()).not.toContain(token);
          }
        }
      }
    }
  });

  it('no raw reason token appears in the text, except "turn" inside the allowed "Your turn" label', () => {
    for (const reason of REASONS) {
      const el = render(baseProps({ kind: 'handoff', to: 1, reason }));
      const text = (el.textContent ?? '').replace('Your turn', '');
      for (const token of REASONS) expect(text.toLowerCase()).not.toContain(token);
    }
  });

  it('shows the neutral label for each reason', () => {
    for (const reason of REASONS) {
      const el = render(baseProps({ kind: 'handoff', to: 1, reason }));
      const expected = reason === 'turn' || reason === 'seven-return' ? 'Your turn' : 'Your response';
      expect(label(el)).toBe(expected);
    }
  });

  it('renders zero game state behind a handoff: no digits', () => {
    for (const reason of REASONS) {
      expect(render(baseProps({ kind: 'handoff', to: 1, reason })).textContent ?? '').not.toMatch(/\d/);
    }
  });
});

describe('M7e: the reveal stage is invariant across the HandoffReason that preceded it (design.md §10 rule 4)', () => {
  /** handoff(reason) -> reveal on ONE instance; returns the reveal-stage DOM. */
  function revealAfter(reason: HandoffReason): HTMLDivElement {
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason }));
    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    return el;
  }

  it('with the label replaced by a placeholder, the reveal innerHTML is byte-identical for all 5 reasons', () => {
    const normalized = REASONS.map((reason) =>
      revealAfter(reason).innerHTML.replace('Your turn', '<<LABEL>>').replace('Your response', '<<LABEL>>'),
    );
    expect(normalized[0]).toContain('<<LABEL>>');
    for (const html of normalized) expect(html).toBe(normalized[0]);
  });

  it('no attribute name or value in the reveal stage contains a reason token, for any reason', () => {
    for (const reason of REASONS) {
      const el = revealAfter(reason);
      expect(el.querySelector('[data-testid="reveal-two-step"]')?.textContent?.trim()).toBe('Show my hand');
      for (const node of el.querySelectorAll('*')) {
        for (const attr of Array.from(node.attributes)) {
          for (const token of REASONS) {
            expect(attr.name.toLowerCase()).not.toContain(token);
            expect(attr.value.toLowerCase()).not.toContain(token);
          }
        }
      }
    }
  });
});

describe('LA3: Curtain bumps the epoch for every new curtain state', () => {
  it('a new reveal state for the same player re-opens the latch on the same instance', () => {
    const calls: string[] = [];
    const { el, props } = renderLive(baseProps({ kind: 'reveal', to: 1 }));
    props.onadvance = () => calls.push(props.curtain.kind);
    flushSync();
    const pill = el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]')!;
    pill.click();
    flushSync();
    pill.click();
    flushSync();
    expect(calls).toEqual(['reveal']);

    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    pill.click();
    flushSync();
    expect(calls).toEqual(['reveal', 'reveal']);
  });

  it('a new handoff state for the same player re-opens the latch on the same instance', () => {
    let seen = 0;
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    props.onadvance = () => (seen += 1);
    flushSync();
    const pill = el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]')!;
    pill.click();
    flushSync();
    expect(seen).toBe(1);

    props.curtain = { kind: 'handoff', to: 1, reason: 'turn' };
    flushSync();
    pill.click();
    flushSync();
    expect(seen).toBe(2);
  });
});

describe('R2: the remembered label is cleared once the gate screen goes away', () => {
  it('handoff -> reveal -> none -> reveal on one instance: the second reveal has an empty label', () => {
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    expect(label(el)).toBe('Your turn');

    props.curtain = { kind: 'none' };
    flushSync();
    expect(el.querySelector('[data-testid="curtain"]')).toBeNull();

    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    expect(label(el)).toBe('');
  });
});

describe('Hold carry-over is keyed on the player id, not the display name', () => {
  it('two players with the same name: a press from handoff(0) never completes a reveal for player 1', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 0, reason: 'turn' }));
    props.names = ['Sam', 'Sam'];
    props.onadvance = () => {
      calls.push(props.curtain.kind);
      // A (misbehaving) parent that moves the reveal to the OTHER player.
      if (props.curtain.kind === 'handoff') props.curtain = { kind: 'reveal', to: 1 };
    };
    flushSync();

    el.querySelector('[data-testid="reveal-hold"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSync();
    expect(calls).toEqual(['handoff']);
    vi.advanceTimersByTime(HOLD_DURATION_MS * 2);
    flushSync();
    expect(calls).toEqual(['handoff']);
  });
});

describe('Ruling A1: one persistent screen across handoff -> reveal', () => {
  it('the same gate element stays mounted, keeps the handoff label, and the pill turns into "Show my hand"', () => {
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'counter' }));
    const screen = gate(el);
    expect(label(el)).toBe('Your response');
    expect(pillText(el)).toBe("I'm Bob");

    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    expect(gate(el)).toBe(screen);
    expect(label(el)).toBe('Your response');
    expect(pillText(el)).toBe('Show my hand');
  });

  it('a reveal with no preceding handoff (restored) shows an empty label slot, not a guessed label', () => {
    const el = render(baseProps({ kind: 'reveal', to: 1 }));
    expect(label(el)).toBe('');
  });

  it('a remembered label never carries to a reveal for the other player', () => {
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    props.curtain = { kind: 'reveal', to: 0 };
    flushSync();
    expect(label(el)).toBe('');
  });

  it('ring press carry-over: pointerdown advances handoff -> reveal, the same press completes the hold at 600 ms', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    props.onadvance = () => {
      calls.push(props.curtain.kind);
      if (props.curtain.kind === 'handoff') props.curtain = { kind: 'reveal', to: 1 };
      else if (props.curtain.kind === 'reveal') props.curtain = { kind: 'recap', to: 1, entries: [pass(1)] };
    };
    props.recapEntries = [pass(1)];
    flushSync();

    const ring = el.querySelector('[data-testid="reveal-hold"]')!;
    ring.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSync();
    expect(calls).toEqual(['handoff']);
    expect(el.querySelector('[data-testid="reveal-hold"]')).toBe(ring);

    vi.advanceTimersByTime(HOLD_DURATION_MS - 1);
    flushSync();
    expect(calls).toEqual(['handoff']);
    vi.advanceTimersByTime(1);
    flushSync();
    expect(calls).toEqual(['handoff', 'reveal']);
    expect(el.querySelector('[data-testid="recap"]')).toBeTruthy();
  });

  it('pill path through the Curtain: triple tap gives exactly one call per transition', () => {
    const calls: string[] = [];
    const { el, props } = renderLive(baseProps({ kind: 'handoff', to: 1, reason: 'turn' }));
    props.onadvance = () => {
      calls.push(props.curtain.kind);
      if (props.curtain.kind === 'handoff') props.curtain = { kind: 'reveal', to: 1 };
    };
    flushSync();
    const pill = el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]')!;
    pill.click();
    flushSync();
    pill.click();
    flushSync();
    pill.click();
    flushSync();
    expect(calls).toEqual(['handoff', 'reveal']);
  });

  it('a new curtain state for the same player re-opens the latch on the same instance', () => {
    const calls: string[] = [];
    const { el, props } = renderLive(baseProps({ kind: 'reveal', to: 1 }));
    props.onadvance = () => calls.push(props.curtain.kind);
    flushSync();
    const pill = el.querySelector<HTMLButtonElement>('[data-testid="reveal-two-step"]')!;
    pill.click();
    flushSync();
    pill.click();
    flushSync();
    expect(calls).toEqual(['reveal']);

    props.curtain = { kind: 'handoff', to: 1, reason: 'turn' };
    flushSync();
    pill.click();
    flushSync();
    expect(calls).toEqual(['reveal', 'handoff']);
  });
});

describe('Curtain never filters recapEntries (Contract)', () => {
  it('every entry passed in recapEntries renders as a line, regardless of curtain.entries', () => {
    const props = baseProps({ kind: 'recap', to: 0, entries: [] });
    props.recapEntries = [pass(1), pass(2), pass(3)];
    expect(render(props).querySelectorAll('.recap__line').length).toBe(3);
  });

  it('recap dismiss calls the SAME onadvance passed to Curtain', () => {
    const seen: number[] = [];
    const props = baseProps({ kind: 'recap', to: 0, entries: [] });
    props.recapEntries = [pass(1)];
    props.onadvance = () => seen.push(1);
    const el = render(props);
    el.querySelector<HTMLButtonElement>('[data-testid="recap-dismiss"]')?.click();
    flushSync();
    expect(seen).toEqual([1]);
  });
});

describe('Curtain never auto-advances', () => {
  it('mounting any withheld kind and letting timers run never calls onadvance', () => {
    vi.useFakeTimers();
    for (const curtain of [
      { kind: 'handoff', to: 1, reason: 'turn' },
      { kind: 'reveal', to: 1 },
      { kind: 'recap', to: 0, entries: [] },
    ] as CurtainState[]) {
      const seen: number[] = [];
      const props = baseProps(curtain);
      props.onadvance = () => seen.push(1);
      render(props);
      vi.advanceTimersByTime(60_000);
      expect(seen).toEqual([]);
    }
  });
});

describe('Curtain prop changes on one mounted instance (OQ-13 pattern)', () => {
  it('walks none -> handoff -> reveal -> recap -> none on the same instance', () => {
    const { el, props } = renderLive(baseProps({ kind: 'none' }));
    expect(el.querySelector('[data-testid="curtain"]')).toBeNull();

    props.curtain = { kind: 'handoff', to: 1, reason: 'turn' };
    flushSync();
    const screen = gate(el);

    props.curtain = { kind: 'reveal', to: 1 };
    flushSync();
    expect(gate(el)).toBe(screen);

    props.curtain = { kind: 'recap', to: 1, entries: [] };
    props.recapEntries = [pass(1)];
    flushSync();
    expect(el.querySelector('[data-testid="recap"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="curtain-gate"]')).toBeNull();

    props.curtain = { kind: 'none' };
    flushSync();
    expect(el.querySelector('[data-testid="curtain"]')).toBeNull();
  });
});

describe('Curtain default theme (SPEC §5.6 rule 5)', () => {
  it('falls back to the app default theme when the theme prop is omitted', () => {
    const props = baseProps({ kind: 'recap', to: 0, entries: [] });
    props.recapEntries = [
      appliedMove({
        by: 1,
        kind: Kind.PlayPermanent,
        card: { Rank: 11, Suit: 0 },
        description: 'play J♣ (steal opponent point)',
        seq: 1,
        targetCard: { Rank: 10, Suit: 2 },
      }),
    ];
    expect(render(props).querySelectorAll('.recap__face [data-state]').length).toBe(2);
  });
});
