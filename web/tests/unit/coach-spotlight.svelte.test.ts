// @vitest-environment jsdom
// T4 — CoachSpotlight render tests (docs/tutorial-design.md §7.1 layers 1-2).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import CoachSpotlight from '../../src/lib/components/CoachSpotlight.svelte';
import type { Box } from '../../src/lib/tutorial/placement';

interface Props {
  holes: Box[];
  ring: 'iris' | 'ochre';
  visible: boolean;
}

const hand: Box = { x: 40, y: 700, width: 56, height: 78 };
const deck: Box = { x: 170, y: 420, width: 56, height: 78 };

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: Props): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(CoachSpotlight, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(cleanup);

function root(el: HTMLElement): HTMLElement {
  const found = el.firstElementChild as HTMLElement | null;
  if (!found) throw new Error('nothing rendered');
  return found;
}

describe('CoachSpotlight', () => {
  it('renders one window and one ring per hole', () => {
    const el = render({ holes: [hand, deck], ring: 'iris', visible: true });
    expect(el.querySelectorAll('mask rect.coach-spotlight__window')).toHaveLength(2);
    expect(el.querySelectorAll('[data-coach-hole]')).toHaveLength(2);
    expect(el.querySelectorAll('svg')).toHaveLength(1);
  });

  it('renders none for no holes, still with the scrim', () => {
    const el = render({ holes: [], ring: 'iris', visible: true });
    expect(el.querySelectorAll('[data-coach-hole]')).toHaveLength(0);
    expect(el.querySelectorAll('mask rect.coach-spotlight__window')).toHaveLength(0);
    expect(el.querySelector('rect.coach-spotlight__shade')).not.toBeNull();
  });

  it('pads each hole by 6 px with a 10 px radius, in both the window and the ring', () => {
    const el = render({ holes: [hand], ring: 'iris', visible: true });
    const win = el.querySelector('mask rect.coach-spotlight__window');
    expect(win?.getAttribute('x')).toBe('34');
    expect(win?.getAttribute('y')).toBe('694');
    expect(win?.getAttribute('width')).toBe('68');
    expect(win?.getAttribute('height')).toBe('90');
    expect(win?.getAttribute('rx')).toBe('10');
    const ring = el.querySelector<HTMLElement>('[data-coach-hole]');
    expect(ring?.style.left).toBe('34px');
    expect(ring?.style.top).toBe('694px');
    expect(ring?.style.width).toBe('68px');
    expect(ring?.style.height).toBe('90px');
  });

  it('masks the shade, so the windows are cut out of the ink', () => {
    const el = render({ holes: [hand], ring: 'iris', visible: true });
    const mask = el.querySelector('mask');
    const shade = el.querySelector('rect.coach-spotlight__shade');
    expect(mask?.id).toBeTruthy();
    expect(shade?.getAttribute('mask')).toBe(`url(#${mask?.id})`);
    expect(mask?.querySelector('rect[fill="white"]')).not.toBeNull();
  });

  it('is aria-hidden and takes no pointer events', () => {
    const el = render({ holes: [hand, deck], ring: 'iris', visible: true });
    const layer = root(el);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.style.pointerEvents).toBe('none');
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('button, a, input, [tabindex], [data-testid]')).toBeNull();
  });

  it('gives two instances different mask ids', () => {
    const a = render({ holes: [hand], ring: 'iris', visible: true });
    const idA = a.querySelector('mask')?.id;
    const second = document.createElement('div');
    document.body.append(second);
    const other = mount(CoachSpotlight, { target: second, props: { holes: [hand], ring: 'iris', visible: true } });
    flushSync();
    expect(second.querySelector('mask')?.id).not.toBe(idA);
    unmount(other);
    second.remove();
  });

  it('follows ring and visible, and re-aims on one instance when the holes change', () => {
    cleanup();
    const props = $state<Props>({ holes: [hand], ring: 'iris', visible: false });
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(CoachSpotlight, { target: host, props });
    flushSync();
    const layer = root(host);
    expect(layer.getAttribute('data-visible')).toBe('false');
    expect(layer.getAttribute('data-ring')).toBe('iris');

    props.visible = true;
    props.ring = 'ochre';
    props.holes = [hand, deck];
    flushSync();

    expect(root(host)).toBe(layer);
    expect(layer.getAttribute('data-visible')).toBe('true');
    expect(layer.getAttribute('data-ring')).toBe('ochre');
    expect(host.querySelectorAll('mask rect.coach-spotlight__window')).toHaveLength(2);
  });
});
