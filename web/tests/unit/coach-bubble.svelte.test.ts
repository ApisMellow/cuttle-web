// @vitest-environment jsdom
// T4 — CoachBubble render tests (docs/tutorial-design.md §7.3, §8.2, §9) and
// the coach motion tokens (plan T4, design §8.2). One mounted instance is
// driven through a $state props object where a prop changes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CoachBubble from '../../src/lib/components/CoachBubble.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import type { BubblePlacement } from '../../src/lib/tutorial/placement';

type Tone = 'main' | 'nudge' | 'success' | 'blake' | 'error';

interface Props {
  text: string;
  tone: Tone;
  stepId: string;
  stage: string;
  showNext: boolean;
  onnext?: () => void;
  onshowme?: () => void;
  onleave?: () => void;
  lessonNumber: number;
  placement: BubblePlacement;
  shake: number;
  headline?: string;
  error?: { onrestart?: () => void };
}

const placement: BubblePlacement = { x: 36, y: 478, notch: 'up', notchX: 196 };

function baseProps(over: Partial<Props> = {}): Props {
  return {
    text: 'Your 9 gets you to 21. Drag it onto your Points row.',
    tone: 'main',
    stepId: '1.5',
    stage: 'idle',
    showNext: false,
    lessonNumber: 2,
    placement,
    shake: 0,
    ...over,
  };
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: Props): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(CoachBubble, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubReducedMotion(false);
  settings.reducedMotion = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  settings.reducedMotion = false;
  delete (Element.prototype as { animate?: unknown }).animate;
});

function byId(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('CoachBubble', () => {
  it('renders the copy, the landmark and the data attributes', () => {
    const el = render(baseProps({ tone: 'nudge', stage: 'staged-wrong', stepId: '3.1' }));
    const bubble = byId(el, 'coach-bubble');
    expect(bubble).not.toBeNull();
    expect(bubble?.tagName).toBe('SECTION');
    expect(bubble?.getAttribute('aria-label')).toBe('Coach');
    expect(bubble?.getAttribute('data-step')).toBe('3.1');
    expect(bubble?.getAttribute('data-stage')).toBe('staged-wrong');
    expect(bubble?.getAttribute('data-tone')).toBe('nudge');
    expect(el.textContent).toContain('Your 9 gets you to 21. Drag it onto your Points row.');
  });

  it('puts the copy in a polite live region that can take programmatic focus', () => {
    const el = render(baseProps());
    const live = el.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute('aria-live')).toBe('polite');
    expect(live[0].getAttribute('tabindex')).toBe('-1');
    expect(live[0].textContent?.trim()).toBe('Your 9 gets you to 21. Drag it onto your Points row.');
    expect(live[0].querySelector('.coach__copy')?.textContent).toBe('Your 9 gets you to 21. Drag it onto your Points row.');
  });

  it('announces the headline with the copy: both sit in the one live region, the headline first (T12b)', () => {
    const el = render(baseProps({ tone: 'success', headline: 'You win!', text: '21.' }));
    const live = el.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    const headline = el.querySelector('.coach__headline');
    expect(headline).not.toBeNull();
    expect(live[0].contains(headline)).toBe(true);
    expect(live[0].textContent?.trim()).toMatch(/^You win!\s*21\.$/);
    // The headline appears in the bubble exactly once.
    expect(el.textContent?.match(/You win!/g)).toHaveLength(1);
  });

  it('positions itself from the placement and aims the notch', () => {
    const el = render(baseProps());
    const bubble = byId(el, 'coach-bubble');
    expect(bubble?.style.left).toBe('36px');
    expect(bubble?.style.top).toBe('478px');
    expect(bubble?.getAttribute('data-notch')).toBe('up');
    const notch = el.querySelector<HTMLElement>('.coach__notch');
    expect(notch?.getAttribute('aria-hidden')).toBe('true');
    expect(notch?.style.left).toBe('160px');
  });

  it('draws no notch when the placement has none', () => {
    const el = render(baseProps({ placement: { x: 16, y: 52, notch: null, notchX: 176 } }));
    expect(el.querySelector('.coach__notch')).toBeNull();
    expect(byId(el, 'coach-bubble')?.getAttribute('data-notch')).toBe('none');
  });

  it('shows Next only when showNext is set, and forwards the tap', () => {
    const onnext = vi.fn();
    const without = render(baseProps({ onnext }));
    expect(byId(without, 'coach-next')).toBeNull();

    const el = render(baseProps({ showNext: true, onnext }));
    const next = byId(el, 'coach-next');
    expect(next?.textContent?.trim()).toBe('Next');
    next?.click();
    expect(onnext).toHaveBeenCalledTimes(1);
  });

  it('shows Show me, Leave and "N of 5", and forwards the taps', () => {
    const onshowme = vi.fn();
    const onleave = vi.fn();
    const el = render(baseProps({ onshowme, onleave, lessonNumber: 4 }));
    byId(el, 'coach-show-me')?.click();
    byId(el, 'coach-leave')?.click();
    expect(onshowme).toHaveBeenCalledTimes(1);
    expect(onleave).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('4 of 5');
    expect(byId(el, 'coach-restart')).toBeNull();
  });

  it('shows Restart lesson and Leave only when error is set', () => {
    const onrestart = vi.fn();
    const onleave = vi.fn();
    const el = render(baseProps({ tone: 'error', stage: 'error', text: 'This lesson hit a snag.', error: { onrestart }, onleave, showNext: true }));
    const restart = byId(el, 'coach-restart');
    expect(restart?.textContent?.trim()).toBe('Restart lesson');
    restart?.click();
    expect(onrestart).toHaveBeenCalledTimes(1);
    byId(el, 'coach-leave')?.click();
    expect(onleave).toHaveBeenCalledTimes(1);
    expect(byId(el, 'coach-show-me')).toBeNull();
    expect(byId(el, 'coach-next')).toBeNull();
  });

  it('marks a success line with a decorative check and renders a headline', () => {
    const el = render(baseProps({ tone: 'success', headline: 'You win!', text: 'That is 21 points.' }));
    expect(el.querySelector('.coach__chip')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.coach__headline')?.textContent).toBe('You win!');
    const plain = render(baseProps());
    expect(plain.querySelector('.coach__chip')).toBeNull();
    expect(plain.querySelector('.coach__headline')).toBeNull();
  });

  it('updates in place on one instance when the line changes', () => {
    cleanup();
    const props = $state<Props>(baseProps());
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(CoachBubble, { target: host, props });
    flushSync();
    const bubble = byId(host, 'coach-bubble');

    props.text = 'Not quite. Tap Cancel to try again.';
    props.tone = 'nudge';
    props.stage = 'staged-wrong';
    flushSync();

    expect(byId(host, 'coach-bubble')).toBe(bubble);
    expect(bubble?.getAttribute('data-tone')).toBe('nudge');
    expect(bubble?.getAttribute('data-stage')).toBe('staged-wrong');
    expect(host.querySelector('[aria-live] .coach__copy')?.textContent).toBe('Not quite. Tap Cancel to try again.');
  });

  describe('shake', () => {
    function mountWithShake(): { props: Props } {
      cleanup();
      const props = $state<Props>(baseProps());
      host = document.createElement('div');
      document.body.append(host);
      instance = mount(CoachBubble, { target: host, props });
      flushSync();
      return { props };
    }

    it('runs one translateX animation when shake changes', () => {
      const animate = vi.fn(() => ({}) as Animation);
      Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
      const { props } = mountWithShake();
      expect(animate).not.toHaveBeenCalled();

      props.shake = 1;
      flushSync();
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
      expect(frames.map((f) => f.transform)).toEqual([
        'translateX(0)',
        'translateX(-6px)',
        'translateX(6px)',
        'translateX(-4px)',
        'translateX(4px)',
        'translateX(0)',
      ]);
      expect(options.duration).toBe(280);
    });

    it('runs no animation under the OS reduced-motion preference', () => {
      stubReducedMotion(true);
      const animate = vi.fn(() => ({}) as Animation);
      Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
      const { props } = mountWithShake();
      props.shake = 1;
      flushSync();
      props.shake = 2;
      flushSync();
      expect(animate).not.toHaveBeenCalled();
      expect(byId(host as HTMLElement, 'coach-bubble')?.getAttribute('data-reduced')).toBe('true');
    });

    it('runs no animation under the in-app reduced-motion setting', () => {
      settings.reducedMotion = true;
      const animate = vi.fn(() => ({}) as Animation);
      Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
      const { props } = mountWithShake();
      props.shake = 1;
      flushSync();
      expect(animate).not.toHaveBeenCalled();
    });

    it('does not throw where the Web Animations API is missing', () => {
      const { props } = mountWithShake();
      props.shake = 1;
      expect(() => flushSync()).not.toThrow();
    });
  });
});

describe('coach motion tokens', () => {
  const tokensCss = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'styles', 'tokens.css'), 'utf8');
  const rootBlock = tokensCss.slice(0, tokensCss.indexOf('@media'));
  const reducedBlock = tokensCss.slice(tokensCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  it.each([
    ['--cu-dur-flight', '420ms'],
    ['--cu-dur-demo-travel', '660ms'],
    ['--cu-dur-deal-stagger', '80ms'],
    ['--cu-ease-land', 'cubic-bezier(0.3, 1.25, 0.5, 1)'],
  ])('defines %s', (name, value) => {
    expect(rootBlock).toContain(`${name}: ${value};`);
  });

  it.each(['--cu-dur-flight', '--cu-dur-demo-travel', '--cu-dur-deal-stagger'])('zeroes %s under reduced motion', (name) => {
    expect(reducedBlock).toContain(`${name}: 0ms;`);
  });

  it('removes the overshoot from --cu-ease-land under reduced motion', () => {
    expect(reducedBlock).toMatch(/--cu-ease-land:\s*var\(--cu-ease-out\);/);
  });
});
