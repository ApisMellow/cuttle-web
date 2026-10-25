// @vitest-environment jsdom
// T8 - GhostDemo (docs/tutorial-design.md §8.3, §9). jsdom has no
// Element.animate, so each test installs a recording stub; one test removes
// it to prove the component guards for its absence.
//
// `.svelte.test.ts` so the replay tests drive ONE mounted instance through a
// `$state` props object.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import GhostDemo from '../../src/lib/components/GhostDemo.svelte';
import { vectorTheme } from '../../src/lib/theme';
import type { CardTheme } from '../../src/lib/theme';
import type { Box } from '../../src/lib/tutorial/placement';

type Demo =
  | { kind: 'drag'; from: Box; to: Box; card: Card }
  | { kind: 'tap'; at: Box[] }
  | null;

interface Props {
  demo: Demo;
  playKey: number;
  motion: boolean;
  confirmBox?: Box;
  theme: CardTheme;
}

interface Call {
  el: HTMLElement;
  part: string;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { cancel: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
}

const hand: Box = { x: 40, y: 700, width: 60, height: 78 };
const zone: Box = { x: 150, y: 420, width: 90, height: 100 };
const deck: Box = { x: 170, y: 300, width: 56, height: 72 };
const confirm: Box = { x: 280, y: 790, width: 90, height: 44 };
const fiveOfHearts: Card = { Rank: 5, Suit: 2 };

const dragDemo = (): Demo => ({ kind: 'drag', from: hand, to: zone, card: fiveOfHearts });

let calls: Call[] = [];
let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
const proto = Element.prototype as unknown as { animate?: unknown };
let originalAnimate: unknown;

function installAnimateStub(): void {
  proto.animate = function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { cancel: vi.fn(), finish: vi.fn() };
    calls.push({ el: this, part: this.getAttribute('data-part') ?? '', frames, options, animation });
    return animation;
  };
}

beforeEach(() => {
  calls = [];
  originalAnimate = proto.animate;
  installAnimateStub();
});

afterEach(() => {
  cleanup();
  if (originalAnimate === undefined) delete proto.animate;
  else proto.animate = originalAnimate;
});

function render(props: Props): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GhostDemo, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

const base = (over: Partial<Props>): Props => ({
  demo: dragDemo(),
  playKey: 1,
  motion: true,
  theme: vectorTheme,
  ...over,
});

const part = (name: string) => calls.filter((c) => c.part === name);

describe('GhostDemo, motion on', () => {
  it('a drag demo animates the dot, the ghost card and the target ring with the design 1.5 s timeline', () => {
    render(base({}));
    expect(calls).toHaveLength(3);
    expect(part('dot')).toHaveLength(1);
    expect(part('ghost')).toHaveLength(1);
    expect(part('target-ring')).toHaveLength(1);
    for (const c of calls) expect(c.options.duration).toBe(1500);
  });

  it('animates only transform and opacity', () => {
    render(base({}));
    const allowed = new Set(['transform', 'opacity', 'offset', 'easing']);
    for (const c of calls) for (const f of c.frames) for (const k of Object.keys(f)) expect(allowed.has(k)).toBe(true);
  });

  it('puts the ghost card at 72% opacity at most, and the dot starts over the source centre', () => {
    render(base({}));
    const ghost = part('ghost')[0];
    expect(Math.max(...ghost.frames.map((f) => Number(f.opacity)))).toBe(0.72);
    const dot = part('dot')[0].el;
    expect(dot.style.left).toBe('70px');
    expect(dot.style.top).toBe('739px');
    expect(part('ghost')[0].el.style.left).toBe('70px');
    expect(part('ghost')[0].el.style.top).toBe('739px');
  });

  it('draws the ghost card with the theme Face at hand size inside a box that owns the geometry', () => {
    const el = render(base({}));
    const box = el.querySelector<HTMLElement>('[data-part="ghost-card"]');
    expect(box).not.toBeNull();
    const face = box!.firstElementChild as HTMLElement;
    expect(face.getAttribute('data-size')).toBe('hand');
    expect(face.getAttribute('data-state')).toBe('normal');
    // SPEC §5.6 rule 2: the container is sized by the app tokens; the face is not.
    expect(box!.className).toContain('ghost-demo__card');
    expect(face.style.width).toBe('');
  });

  it('draws the Face the given theme supplies', () => {
    const seen: Card[] = [];
    const theme: CardTheme = {
      ...vectorTheme,
      id: 'probe',
      Face: ((_anchor: unknown, props: { card: Card }) => {
        seen.push(props.card);
      }) as unknown as CardTheme['Face'],
    };
    render(base({ theme }));
    expect(seen).toEqual([fiveOfHearts]);
  });

  it('has an aria-hidden, pointer-transparent root and no testid or interactive element', () => {
    const el = render(base({}));
    const root = el.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.style.pointerEvents).toBe('none');
    expect(el.querySelector('[data-testid]')).toBeNull();
    expect(el.querySelector('button, a, input, [tabindex]')).toBeNull();
  });

  it('puts the target ring on the drop zone', () => {
    const el = render(base({}));
    const ring = el.querySelector<HTMLElement>('[data-part="target-ring"]')!;
    expect(ring.style.left).toBe('144px');
    expect(ring.style.top).toBe('414px');
    expect(ring.style.width).toBe('102px');
    expect(ring.style.height).toBe('112px');
  });

  it('replays when playKey changes, on the same instance, and not when only the boxes move', () => {
    const props = $state<Props>(base({}));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(GhostDemo, { target: host, props });
    flushSync();
    expect(calls).toHaveLength(3);
    const firstRoot = host.firstElementChild;

    // The controller re-measures every frame: a new box object must not replay.
    props.demo = { kind: 'drag', from: { ...hand, y: 701 }, to: { ...zone }, card: fiveOfHearts };
    flushSync();
    expect(calls).toHaveLength(3);

    props.playKey = 2;
    flushSync();
    expect(calls).toHaveLength(6);
    expect(host.firstElementChild).toBe(firstRoot);
    // The earlier run was cancelled before the new one started.
    for (const c of calls.slice(0, 3)) expect(c.animation.cancel).toHaveBeenCalled();
    for (const c of calls.slice(3)) expect(c.animation.cancel).not.toHaveBeenCalled();
  });

  it('switching to a tap demo plays the tap timeline and cancels the drag', () => {
    const props = $state<Props>(base({}));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(GhostDemo, { target: host, props });
    flushSync();
    props.demo = { kind: 'tap', at: [deck] };
    props.playKey = 2;
    flushSync();
    for (const c of calls.slice(0, 3)) expect(c.animation.cancel).toHaveBeenCalled();
    expect(part('tap-dot')).toHaveLength(1);
    expect(part('tap-ripple')).toHaveLength(1);
  });

  it('a null demo plays nothing and shows nothing; going back to a demo plays it', () => {
    const props = $state<Props>(base({ demo: null }));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(GhostDemo, { target: host, props });
    flushSync();
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[data-part]')).toBeNull();
    props.demo = dragDemo();
    flushSync();
    expect(calls).toHaveLength(3);
    props.demo = null;
    flushSync();
    for (const c of calls) expect(c.animation.cancel).toHaveBeenCalled();
    expect(host.querySelector('[data-part]')).toBeNull();
  });

  it('a pointerdown on window cancels the running demo, via a passive listener', () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(base({}));
    const reg = add.mock.calls.find((c) => c[0] === 'pointerdown');
    expect(reg).toBeDefined();
    expect(reg![2]).toMatchObject({ passive: true });
    for (const c of calls) expect(c.animation.cancel).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    for (const c of calls) expect(c.animation.cancel).toHaveBeenCalledTimes(1);
  });

  it('removes its pointerdown listener on unmount, and a later press cancels nothing', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    render(base({}));
    cleanup();
    expect(remove.mock.calls.some((c) => c[0] === 'pointerdown')).toBe(true);
    const before = calls.map((c) => c.animation.cancel.mock.calls.length);
    window.dispatchEvent(new Event('pointerdown'));
    expect(calls.map((c) => c.animation.cancel.mock.calls.length)).toEqual(before);
  });

  it('a press after a cancel does not stop the next replay', () => {
    const props = $state<Props>(base({}));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(GhostDemo, { target: host, props });
    flushSync();
    window.dispatchEvent(new Event('pointerdown'));
    props.playKey = 2;
    flushSync();
    expect(calls).toHaveLength(6);
    window.dispatchEvent(new Event('pointerdown'));
    for (const c of calls.slice(3)) expect(c.animation.cancel).toHaveBeenCalled();
  });

  it('a tap at one spot taps once (900 ms); the same spot twice taps twice (1200 ms)', () => {
    render(base({ demo: { kind: 'tap', at: [deck] } }));
    expect(calls.map((c) => c.options.duration)).toEqual([900, 900]);
    expect(part('tap-dot')[0].el.style.left).toBe('198px');
    expect(part('tap-dot')[0].el.style.top).toBe('336px');

    render(base({ demo: { kind: 'tap', at: [deck, deck] } }));
    const second = calls.slice(2);
    expect(second.map((c) => c.options.duration)).toEqual([1200, 1200]);
    expect(second.filter((c) => c.part === 'tap-dot')).toHaveLength(1);
  });

  it('T14: on a wide labelled button (4.2\u2019s counter option) the tap lands near its right end, off the label', () => {
    // "Counter with 2 of hearts: stop their card." is centred in a 358 x 44 pill.
    const option: Box = { x: 16, y: 500, width: 358, height: 44 };
    render(base({ demo: { kind: 'tap', at: [option] } }));
    const dot = part('tap-dot')[0].el;
    const ripple = part('tap-ripple')[0].el;
    expect(dot.style.left).toBe(`${16 + 358 - 28}px`);
    expect(dot.style.top).toBe('522px');
    expect(ripple.style.left).toBe(dot.style.left);
    // A card-shaped target (the deck) is still tapped in its centre.
    render(base({ demo: { kind: 'tap', at: [deck] } }));
    expect(part('tap-dot').at(-1)!.el.style.left).toBe('198px');
  });

  it('taps in two different places play one after the other', () => {
    render(base({ demo: { kind: 'tap', at: [deck, confirm] } }));
    expect(part('tap-dot')).toHaveLength(2);
    expect(part('tap-dot')[0].options.delay ?? 0).toBe(0);
    expect(part('tap-dot')[1].options.delay).toBe(900);
    expect(part('tap-ripple')[1].options.delay).toBe(900);
  });

  it('the tap dot is a plain circle with no ghost card; the tap demo has no markers', () => {
    const el = render(base({ demo: { kind: 'tap', at: [deck] } }));
    expect(el.querySelector('[data-part="ghost-card"]')).toBeNull();
    expect(el.querySelector('[data-part="marker"]')).toBeNull();
  });

  it('reads the travel time from the --cu-dur-demo-travel token', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--cu-dur-demo-travel' ? '800ms' : ''),
    } as unknown as CSSStyleDeclaration);
    render(base({}));
    for (const c of calls) expect(c.options.duration).toBe(1640);
  });

  it('plays the default timeline when the token is zero', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--cu-dur-demo-travel' ? '0ms' : ''),
    } as unknown as CSSStyleDeclaration);
    render(base({}));
    for (const c of calls) expect(c.options.duration).toBe(1500);
  });

  it('does not throw and plays nothing when Element.animate does not exist', () => {
    delete proto.animate;
    const el = render(base({}));
    expect(calls).toHaveLength(0);
    expect(el.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('GhostDemo, motion off (reduced-motion markers)', () => {
  it('calls no animate and shows numbered markers 1 and 2 with a dashed line between them', () => {
    const el = render(base({ motion: false }));
    expect(calls).toHaveLength(0);
    const markers = [...el.querySelectorAll<HTMLElement>('[data-part="marker"]')];
    expect(markers.map((m) => m.textContent?.trim())).toEqual(['1', '2']);
    // 1 on the card centre, 2 on the target centre.
    expect(markers[0].style.left).toBe('70px');
    expect(markers[0].style.top).toBe('739px');
    expect(markers[1].style.left).toBe('195px');
    expect(markers[1].style.top).toBe('470px');
    const line = el.querySelector<HTMLElement>('[data-part="line"]');
    expect(line).not.toBeNull();
    const dist = Math.hypot(195 - 70, 470 - 739);
    expect(parseFloat(line!.style.width)).toBeCloseTo(dist, 1);
    expect(line!.style.transform).toMatch(/^rotate\(-?[\d.]+deg\)$/);
    expect(line!.style.left).toBe('70px');
  });

  it('adds a 3 on the Confirm box when one is given, and only then', () => {
    let el = render(base({ motion: false }));
    expect(el.querySelectorAll('[data-part="marker"]')).toHaveLength(2);
    el = render(base({ motion: false, confirmBox: confirm }));
    const markers = [...el.querySelectorAll<HTMLElement>('[data-part="marker"]')];
    expect(markers.map((m) => m.textContent?.trim())).toEqual(['1', '2', '3']);
    // Above the Confirm box's top-right corner, inside its right edge, so the
    // "3" (28 px round) never reaches its label (T14: it covered the "m").
    expect(markers[2].style.left).toBe('356px');
    expect(markers[2].style.top).toBe('780px');
    const bottom = 780 + 14;
    expect(bottom, 'the marker ends above the label line').toBeLessThanOrEqual(confirm.y + 4);
  });

  it('T14: with motion off the tap marker on a wide button sits near its right end too', () => {
    const option: Box = { x: 16, y: 500, width: 358, height: 44 };
    const el = render(base({ motion: false, demo: { kind: 'tap', at: [option] } }));
    const marker = el.querySelector<HTMLElement>('[data-part="marker"]')!;
    expect(marker.style.left).toBe(`${16 + 358 - 28}px`);
    expect(marker.style.top).toBe('522px');
  });

  it('numbers tap markers in order, and keeps two taps at one spot apart', () => {
    const el = render(base({ motion: false, demo: { kind: 'tap', at: [deck, deck] } }));
    const markers = [...el.querySelectorAll<HTMLElement>('[data-part="marker"]')];
    expect(markers.map((m) => m.textContent?.trim())).toEqual(['1', '2']);
    expect(markers[0].style.left).not.toBe(markers[1].style.left);
    expect(el.querySelector('[data-part="line"]')).toBeNull();
  });

  it('keeps the root aria-hidden with no testid and no pointer events, and never shows the animated parts', () => {
    const el = render(base({ motion: false, confirmBox: confirm }));
    const root = el.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.style.pointerEvents).toBe('none');
    expect(el.querySelector('[data-testid]')).toBeNull();
    expect(el.querySelector('[data-part="dot"], [data-part="ghost"], [data-part="target-ring"]')).toBeNull();
  });

  it('a pointerdown does not remove the markers (they are not an animation)', () => {
    const el = render(base({ motion: false }));
    window.dispatchEvent(new Event('pointerdown'));
    expect(el.querySelectorAll('[data-part="marker"]')).toHaveLength(2);
  });

  it('switches between markers and animation on one instance when motion flips', () => {
    const props = $state<Props>(base({ motion: false }));
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(GhostDemo, { target: host, props });
    flushSync();
    expect(calls).toHaveLength(0);
    props.motion = true;
    flushSync();
    expect(calls).toHaveLength(3);
    expect(host.querySelector('[data-part="marker"]')).toBeNull();
    props.motion = false;
    flushSync();
    for (const c of calls) expect(c.animation.cancel).toHaveBeenCalled();
    expect(host.querySelectorAll('[data-part="marker"]')).toHaveLength(2);
  });
});
