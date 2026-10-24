// @vitest-environment jsdom
// T8 - lib/tutorial/motion.ts base: the reduced-motion switch, token reading
// and the ghost-demo keyframes (docs/tutorial-design.md §8.2, §8.3).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dragDemoFrames,
  dragRingFrames,
  motionOn,
  readMotionTokens,
  tapDemoFrames,
} from '../../src/lib/tutorial/motion';

const rect = (x: number, y: number, width = 60, height = 78): DOMRect =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('motionOn', () => {
  it('is false when the setting asks for reduced motion, whatever the media query says', () => {
    expect(motionOn(true, { matches: false })).toBe(false);
    expect(motionOn(true, { matches: true })).toBe(false);
  });

  it('is false when the media query asks, even with the setting off', () => {
    expect(motionOn(false, { matches: true })).toBe(false);
  });

  it('is true only when neither asks', () => {
    expect(motionOn(false, { matches: false })).toBe(true);
  });

  it('reads window.matchMedia("(prefers-reduced-motion: reduce)") when no query is passed', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    vi.stubGlobal('matchMedia', matchMedia);
    expect(motionOn(false)).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(motionOn(false)).toBe(true);
  });

  it('treats a missing or throwing matchMedia as "no preference"', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(motionOn(false)).toBe(true);
    vi.stubGlobal('matchMedia', () => {
      throw new Error('nope');
    });
    expect(motionOn(false)).toBe(true);
    expect(motionOn(true)).toBe(false);
  });
});

describe('readMotionTokens', () => {
  it('falls back to the design values when the tokens are not defined', () => {
    const el = document.createElement('div');
    document.body.append(el);
    expect(readMotionTokens(el)).toEqual({
      flight: 420,
      demoTravel: 660,
      dealStagger: 80,
      easeLand: 'cubic-bezier(0.3, 1.25, 0.5, 1)',
      fast: 120,
      med: 200,
      slow: 320,
    });
    el.remove();
  });

  it('parses ms and s values and a trimmed easing from the computed style', () => {
    const values: Record<string, string> = {
      '--cu-dur-flight': ' 500ms',
      '--cu-dur-demo-travel': '0.7s',
      '--cu-dur-deal-stagger': '90ms',
      '--cu-ease-land': ' cubic-bezier(0.1, 0.2, 0.3, 0.4) ',
      '--cu-dur-fast': '100ms',
      '--cu-dur-med': '210ms',
      '--cu-dur-slow': '330ms',
    };
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => values[name] ?? '',
    } as unknown as CSSStyleDeclaration);
    expect(readMotionTokens(document.body)).toEqual({
      flight: 500,
      demoTravel: 700,
      dealStagger: 90,
      easeLand: 'cubic-bezier(0.1, 0.2, 0.3, 0.4)',
      fast: 100,
      med: 210,
      slow: 330,
    });
  });

  it('reads a zeroed token (reduced motion) as 0, not as the fallback', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--cu-dur-flight' ? '0ms' : ''),
    } as unknown as CSSStyleDeclaration);
    expect(readMotionTokens(document.body).flight).toBe(0);
    expect(readMotionTokens(document.body).demoTravel).toBe(660);
  });
});

const ALLOWED_KEYS = new Set(['transform', 'opacity', 'offset', 'easing']);

function check(frames: Keyframe[]): void {
  expect(frames.length).toBeGreaterThan(2);
  let last = 0;
  for (const f of frames) {
    for (const key of Object.keys(f)) expect(ALLOWED_KEYS.has(key), `key ${key}`).toBe(true);
    const offset = f.offset as number;
    expect(offset).toBeGreaterThanOrEqual(last);
    expect(offset).toBeLessThanOrEqual(1);
    last = offset;
  }
  expect(frames[0].offset).toBe(0);
  expect(frames[frames.length - 1].offset).toBe(1);
}

const at = (frames: Keyframe[], ms: number, total: number): Keyframe => {
  const hit = frames.find((f) => Math.abs((f.offset as number) * total - ms) < 0.5);
  if (!hit) throw new Error(`no keyframe at ${ms} ms`);
  return hit;
};

const translate = (f: Keyframe): [number, number] => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(f.transform));
  if (!m) throw new Error(`no translate in ${String(f.transform)}`);
  return [Number(m[1]), Number(m[2])];
};

const scale = (f: Keyframe): number => Number(/scale\((-?[\d.]+)\)/.exec(String(f.transform))?.[1]);
const rotate = (f: Keyframe): number => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(f.transform))?.[1]);

describe('dragDemoFrames (design §8.3 drag timeline)', () => {
  const from = rect(40, 700);
  const to = rect(200, 400, 80, 100);
  const dx = 200 + 40 - (40 + 30);
  const dy = 400 + 50 - (700 + 39);

  it('runs about 1.5 s and uses only transform and opacity keys', () => {
    const frames = dragDemoFrames(from, to);
    expect(frames.durationMs).toBe(1500);
    check(frames.dot);
    check(frames.card);
  });

  it('fades the dot in over the card centre: opacity 0 to 1, scale 1.25 to 1 by 200 ms', () => {
    const { dot, durationMs } = dragDemoFrames(from, to);
    expect(dot[0].opacity).toBe(0);
    expect(scale(dot[0])).toBe(1.25);
    expect(translate(dot[0])).toEqual([0, 0]);
    const k = at(dot, 200, durationMs);
    expect(k.opacity).toBe(1);
    expect(scale(k)).toBe(1);
  });

  it('presses to 0.85 by 320 ms, and the ghost card appears at 72% opacity lifted 12 px', () => {
    const { dot, card, durationMs } = dragDemoFrames(from, to);
    expect(scale(at(dot, 320, durationMs))).toBe(0.85);
    expect(card[0].opacity).toBe(0);
    expect(at(card, 200, durationMs).opacity).toBe(0);
    const lifted = at(card, 320, durationMs);
    expect(lifted.opacity).toBe(0.72);
    expect(translate(lifted)).toEqual([0, -12]);
    expect(rotate(lifted)).toBe(-4);
  });

  it('never lets the ghost card exceed 72% opacity', () => {
    for (const f of dragDemoFrames(from, to).card) expect(Number(f.opacity)).toBeLessThanOrEqual(0.72);
  });

  it('travels to the target centre by 980 ms, rotating -4 to 0 degrees', () => {
    const { dot, card, durationMs } = dragDemoFrames(from, to);
    const dotEnd = at(dot, 980, durationMs);
    expect(translate(dotEnd)[0]).toBeCloseTo(dx, 1);
    expect(translate(dotEnd)[1]).toBeCloseTo(dy, 1);
    const cardEnd = at(card, 980, durationMs);
    expect(translate(cardEnd)[0]).toBeCloseTo(dx, 1);
    expect(translate(cardEnd)[1]).toBeCloseTo(dy - 12, 1);
    expect(rotate(cardEnd)).toBeCloseTo(0, 5);
  });

  it('arcs: at the midpoint of the travel the dot is 24 px above the straight line', () => {
    const { dot, durationMs } = dragDemoFrames(from, to);
    const mid = dot.find((f) => Math.abs((f.offset as number) * durationMs - 650) < 0.5);
    expect(mid).toBeDefined();
    // The ease-in-out is symmetric enough that progress at the midpoint is
    // within a hair of 0.5; the arc peak is 24 px above the chord.
    const [x, y] = translate(mid!);
    const chordY = (y + 24) / dy;
    expect(x / dx).toBeCloseTo(chordY, 1);
    expect(y).toBeCloseTo(dy * (x / dx) - 24, 0);
  });

  it('eases rather than moving at constant speed', () => {
    const { dot, durationMs } = dragDemoFrames(from, to);
    const travel = dot.filter((f) => {
      const t = (f.offset as number) * durationMs;
      return t >= 320 && t <= 980;
    });
    const xs = travel.map((f) => translate(f)[0]);
    const first = xs[1] - xs[0];
    const middle = xs[Math.floor(xs.length / 2)] - xs[Math.floor(xs.length / 2) - 1];
    expect(Math.abs(first)).toBeLessThan(Math.abs(middle));
  });

  it('releases by 1180 ms (dot back to scale 1, card set down) and fades out by 1500 ms', () => {
    const { dot, card, durationMs } = dragDemoFrames(from, to);
    const dotRelease = at(dot, 1180, durationMs);
    expect(scale(dotRelease)).toBe(1);
    expect(dotRelease.opacity).toBe(1);
    const cardRelease = at(card, 1180, durationMs);
    expect(translate(cardRelease)[1]).toBeCloseTo(dy, 1);
    expect(cardRelease.opacity).toBe(0.72);
    expect(dot[dot.length - 1].opacity).toBe(0);
    expect(card[card.length - 1].opacity).toBe(0);
  });

  it('takes the travel time from the token when given, keeping the other phases', () => {
    const frames = dragDemoFrames(from, to, { travelMs: 800 });
    expect(frames.durationMs).toBe(1640);
    expect(at(frames.dot, 1120, frames.durationMs).opacity).toBe(1);
    check(frames.dot);
  });

  it('handles a target straight above, straight below and on the source without NaN', () => {
    for (const target of [rect(40, 100), rect(40, 900), rect(40, 700)]) {
      const frames = dragDemoFrames(from, target);
      for (const f of [...frames.dot, ...frames.card]) expect(String(f.transform)).not.toContain('NaN');
    }
  });

  it('is pure: the same input gives equal output', () => {
    expect(dragDemoFrames(from, to)).toEqual(dragDemoFrames(from, to));
  });
});

describe('dragRingFrames (the target ring flash)', () => {
  it('stays dark until release at 980 ms, flashes to full by 1060 ms and fades out by the end', () => {
    const frames = dragRingFrames();
    check(frames);
    const total = 1500;
    expect(frames[0].opacity).toBe(0);
    expect(at(frames, 980, total).opacity).toBe(0);
    expect(at(frames, 1060, total).opacity).toBe(1);
    expect(frames[frames.length - 1].opacity).toBe(0);
  });

  it('follows a changed travel time', () => {
    const frames = dragRingFrames({ travelMs: 800 });
    expect(at(frames, 1120, 1640).opacity).toBe(0);
  });
});

describe('tapDemoFrames (design §8.3 tap timeline)', () => {
  it('one tap runs about 900 ms with a dot and a ripple, transform and opacity only', () => {
    const { dot, ripple, durationMs } = tapDemoFrames(1);
    expect(durationMs).toBe(900);
    check(dot);
    check(ripple);
  });

  it('fades in over 200 ms, presses to 0.82 over 90 ms, then releases', () => {
    const { dot, durationMs } = tapDemoFrames(1);
    expect(dot[0].opacity).toBe(0);
    const open = at(dot, 200, durationMs);
    expect(open.opacity).toBe(1);
    expect(scale(open)).toBe(1);
    expect(scale(at(dot, 290, durationMs))).toBe(0.82);
    const back = dot.find((f) => (f.offset as number) * durationMs > 290 && scale(f) === 1);
    expect(back).toBeDefined();
    expect(dot[dot.length - 1].opacity).toBe(0);
  });

  it('expands a ripple 1 to 2.2 while its opacity falls 0.6 to 0 over 360 ms', () => {
    const { ripple, durationMs } = tapDemoFrames(1);
    const start = at(ripple, 290, durationMs);
    expect(start.opacity).toBe(0.6);
    expect(scale(start)).toBe(1);
    const end = at(ripple, 650, durationMs);
    expect(end.opacity).toBe(0);
    expect(scale(end)).toBe(2.2);
    expect(ripple[0].opacity).toBe(0);
  });

  it('tapping twice repeats the press and ripple 300 ms apart', () => {
    const one = tapDemoFrames(1);
    const two = tapDemoFrames(2);
    expect(two.durationMs).toBe(one.durationMs + 300);
    check(two.dot);
    check(two.ripple);
    expect(scale(at(two.dot, 290, two.durationMs))).toBe(0.82);
    expect(scale(at(two.dot, 590, two.durationMs))).toBe(0.82);
    expect(at(two.ripple, 290, two.durationMs).opacity).toBe(0.6);
    expect(at(two.ripple, 590, two.durationMs).opacity).toBe(0.6);
    expect(two.dot[two.dot.length - 1].opacity).toBe(0);
  });

  it('the dot stays down in place: no translate', () => {
    for (const f of tapDemoFrames(2).dot) expect(String(f.transform)).not.toMatch(/translate\(\s*[1-9]/);
  });
});
