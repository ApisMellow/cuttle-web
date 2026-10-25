// @vitest-environment jsdom
// T4 — LessonDoneSheet render tests (docs/tutorial-design.md §4.4, §9).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LessonDoneSheet from '../../src/lib/components/LessonDoneSheet.svelte';

interface Props {
  lesson: number;
  doneLine: string;
  done: readonly number[];
  final: boolean;
  onnext?: () => void;
  onlessons?: () => void;
  onplay?: () => void;
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: Props): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(LessonDoneSheet, { target: host, props });
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

function byId(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

const line = 'You can score with a number card and draw.';

describe('LessonDoneSheet', () => {
  it('is a non-modal dialog named by its heading', () => {
    const el = render({ lesson: 2, doneLine: line, done: [1, 2], final: false });
    const sheet = byId(el, 'coach-lesson-done');
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.getAttribute('aria-modal')).toBe('false');
    const heading = el.querySelector('h2');
    expect(heading?.textContent).toBe('Lesson 2 done');
    expect(sheet?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(el.textContent).toContain(line);
  });

  it('focuses its heading on arrival', () => {
    const el = render({ lesson: 2, doneLine: line, done: [1, 2], final: false });
    expect(document.activeElement).toBe(el.querySelector('h2'));
  });

  it('offers Next lesson and Lessons, and forwards the taps', () => {
    const onnext = vi.fn();
    const onlessons = vi.fn();
    const onplay = vi.fn();
    const el = render({ lesson: 3, doneLine: line, done: [1, 2, 3], final: false, onnext, onlessons, onplay });
    expect(byId(el, 'coach-next-lesson')?.textContent?.trim()).toBe('Next lesson');
    expect(byId(el, 'coach-lessons')?.textContent?.trim()).toBe('Lessons');
    expect(byId(el, 'coach-play')).toBeNull();
    byId(el, 'coach-next-lesson')?.click();
    byId(el, 'coach-lessons')?.click();
    expect(onnext).toHaveBeenCalledTimes(1);
    expect(onlessons).toHaveBeenCalledTimes(1);
    expect(onplay).not.toHaveBeenCalled();
  });

  it('says "You\'ve learned Cuttle" and offers Play a game when final', () => {
    const onplay = vi.fn();
    const el = render({ lesson: 5, doneLine: line, done: [1, 2, 3, 4, 5], final: true, onplay });
    expect(el.querySelector('h2')?.textContent).toBe("You've learned Cuttle");
    expect(byId(el, 'coach-next-lesson')).toBeNull();
    expect(byId(el, 'coach-play')?.textContent?.trim()).toBe('Play a game');
    expect(byId(el, 'coach-lessons')).not.toBeNull();
    byId(el, 'coach-play')?.click();
    expect(onplay).toHaveBeenCalledTimes(1);
  });

  it('sends Escape to onlessons', () => {
    const onlessons = vi.fn();
    const el = render({ lesson: 2, doneLine: line, done: [1, 2], final: false, onlessons });
    const heading = el.querySelector('h2') as HTMLElement;
    heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onlessons).toHaveBeenCalledTimes(1);
    heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onlessons).toHaveBeenCalledTimes(1);
  });

  it('draws five pips, marks the finished ones, and tells screen readers the count', () => {
    const el = render({ lesson: 2, doneLine: line, done: [1, 2], final: false });
    const pips = el.querySelectorAll('.done__pip');
    expect(pips).toHaveLength(5);
    expect(el.querySelectorAll('.done__pip--done')).toHaveLength(2);
    expect(el.querySelector('.done__pips')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.done__sr')?.textContent).toBe('2 of 5 lessons done');
  });

  it('counts only lessons 1-5 and each once', () => {
    const el = render({ lesson: 4, doneLine: line, done: [1, 4, 4, 9], final: false });
    expect(el.querySelector('.done__sr')?.textContent).toBe('2 of 5 lessons done');
  });
});

// T14 judge nice-to-have 1: the finale fills the five pips in sequence.
describe('LessonDoneSheet: the finale pips', () => {
  it('on the final sheet the pips carry the finale and their order (--i 0..4); other sheets do not', () => {
    const el = render({ lesson: 5, doneLine: line, done: [1, 2, 3, 4, 5], final: true });
    const pips = el.querySelector<HTMLElement>('.done__pips')!;
    expect(pips.getAttribute('data-finale')).toBe('true');
    const order = [...el.querySelectorAll<HTMLElement>('.done__pip')].map((p) => p.style.getPropertyValue('--i'));
    expect(order).toEqual(['0', '1', '2', '3', '4']);
    const plain = render({ lesson: 2, doneLine: line, done: [1, 2], final: false });
    expect(plain.querySelector('.done__pips')?.hasAttribute('data-finale')).toBe(false);
  });

  it('animates transform and opacity only, staggered 90 ms, and stops under reduced motion', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'LessonDoneSheet.svelte'), 'utf8');
    const frames = /@keyframes done-pip-fill\s*\{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? '';
    expect(frames).not.toBe('');
    const props = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(props)).toEqual(new Set(['opacity', 'transform']));
    expect(src).toContain('var(--i) * 90ms');
    expect(src).toMatch(/\.done\[data-reduced='true'\] \.done__pips\[data-finale='true'\] \.done__pip::after\s*\{\s*animation: none;/);
  });
});
