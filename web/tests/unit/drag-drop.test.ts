// @vitest-environment jsdom
// Issue #26 — drag a hand card onto a target. The pure half: the pointer
// gesture (an 8 px threshold separates a tap from a drag), the testid <->
// target-key mapping the drop hit-test reads, and the drop decision. The
// wiring into GameScreen and the staging store is covered by
// game-screen-drag.svelte.test.ts; the real touch path by drag-drop.spec.ts.
import { describe, expect, it } from 'vitest';

import {
  DRAG_THRESHOLD_PX,
  DragGesture,
  dropKeyAt,
  dropTarget,
  targetKeyFromTestId,
  testIdForKey,
} from '../../src/lib/dragDrop';
import type { TargetKey } from '../../src/lib/targetKey';

describe('DragGesture', () => {
  it('uses an 8 px threshold', () => {
    expect(DRAG_THRESHOLD_PX).toBe(8);
  });

  it('a move under the threshold stays a tap', () => {
    const g = new DragGesture();
    g.down(1, 2, 100, 100);
    expect(g.phase).toBe('pending');
    expect(g.move(1, 104, 105)).toBeNull(); // ~6.4 px
    expect(g.phase).toBe('pending');
    expect(g.up(1)).toBe('tap');
    expect(g.phase).toBe('idle');
  });

  it('crossing the threshold starts the drag exactly once, then reports moves', () => {
    const g = new DragGesture();
    g.down(1, 2, 100, 100);
    expect(g.move(1, 100, 92)).toBe('start'); // 8 px straight up
    expect(g.phase).toBe('dragging');
    expect(g.handIndex).toBe(2);
    expect(g.dx).toBe(0);
    expect(g.dy).toBe(-8);
    expect(g.move(1, 130, 40)).toBe('move');
    expect(g.dx).toBe(30);
    expect(g.dy).toBe(-60);
    expect(g.up(1)).toBe('drop');
    expect(g.phase).toBe('idle');
    expect(g.handIndex).toBeNull();
  });

  it('measures the threshold as a distance, not per axis', () => {
    const g = new DragGesture();
    g.down(1, 0, 0, 0);
    expect(g.move(1, 5, 5)).toBeNull(); // 7.07 px
    expect(g.move(1, 6, 6)).toBe('start'); // 8.49 px
  });

  it('ignores another pointer (a second finger)', () => {
    const g = new DragGesture();
    g.down(1, 0, 0, 0);
    expect(g.move(2, 50, 50)).toBeNull();
    expect(g.phase).toBe('pending');
    expect(g.up(2)).toBeNull();
    expect(g.phase).toBe('pending');
  });

  it('a second down while one is in flight is ignored', () => {
    const g = new DragGesture();
    g.down(1, 0, 0, 0);
    g.down(2, 3, 50, 50);
    expect(g.handIndex).toBe(0);
    expect(g.move(1, 20, 0)).toBe('start');
  });

  it('cancel() returns to idle from any phase and later events do nothing', () => {
    const g = new DragGesture();
    g.down(1, 0, 0, 0);
    g.move(1, 20, 0);
    g.cancel();
    expect(g.phase).toBe('idle');
    expect(g.move(1, 40, 0)).toBeNull();
    expect(g.up(1)).toBeNull();
  });

  it('move and up with nothing pending do nothing', () => {
    const g = new DragGesture();
    expect(g.move(1, 40, 0)).toBeNull();
    expect(g.up(1)).toBeNull();
  });
});

describe('testid <-> target key', () => {
  const keys: TargetKey[] = [
    'hand:0',
    'hand:7',
    'deck',
    'scrap',
    'zone:points',
    'zone:permanents',
    'zone:oneoff',
    'point:0:2',
    'point:1:0',
    'perm:0:1',
    'perm:1:3',
    'seven:1',
  ];

  it.each(keys)('%s round-trips through its testid', (key) => {
    expect(targetKeyFromTestId(testIdForKey(key))).toBe(key);
  });

  it('maps the testids the board renders', () => {
    expect(testIdForKey('deck')).toBe('deck-pile');
    expect(testIdForKey('scrap')).toBe('scrap-pile');
    expect(testIdForKey('hand:3')).toBe('hand-card-3');
    expect(testIdForKey('seven:0')).toBe('seven-card-0');
    expect(testIdForKey('zone:points')).toBe('zone-points');
    expect(testIdForKey('point:1:0')).toBe('point-1-0');
    expect(testIdForKey('perm:0:2')).toBe('perm-0-2');
  });

  it.each(['board', 'player-zone', 'center-zone', 'opp-hand', 'staging-confirm', 'hand-card-', 'point-2-0', ''])(
    '%j is not a target',
    (id) => {
      expect(targetKeyFromTestId(id)).toBeNull();
    },
  );
});

describe('dropKeyAt', () => {
  function tree(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  }

  it('reads the nearest testid above the hit element', () => {
    const host = tree('<div data-testid="board"><button data-testid="point-0-1"><span id="face"></span></button></div>');
    expect(dropKeyAt(host.querySelector('#face'))).toBe('point:0:1');
  });

  it('a zone hit button is its zone', () => {
    const host = tree('<div data-testid="board"><button data-testid="zone-oneoff"></button></div>');
    expect(dropKeyAt(host.querySelector('button'))).toBe('zone:oneoff');
  });

  it('empty board space is no target', () => {
    const host = tree('<div data-testid="board"><div id="gap"></div></div>');
    expect(dropKeyAt(host.querySelector('#gap'))).toBeNull();
  });

  it('nothing under the pointer is no target', () => {
    expect(dropKeyAt(null)).toBeNull();
  });
});

describe('dropTarget (what a drop does)', () => {
  const lit = new Set<string>(['zone:points', 'zone:oneoff', 'point:1:0']);

  it('a lit target is tapped', () => {
    expect(dropTarget('zone:points', lit, 0)).toBe('zone:points');
    expect(dropTarget('point:1:0', lit, 0)).toBe('point:1:0');
  });

  it('a card in your own lit points row counts as the points zone, as a tap does', () => {
    expect(dropTarget('point:0:3', lit, 0)).toBe('zone:points');
  });

  it('an unlit target, empty space, the deck or a hand card snaps back', () => {
    expect(dropTarget('zone:permanents', lit, 0)).toBeNull();
    expect(dropTarget('point:1:1', lit, 0)).toBeNull();
    expect(dropTarget('deck', lit, 0)).toBeNull();
    expect(dropTarget(null, lit, 0)).toBeNull();
  });

  it('a hand key is never a drop target, even when lit', () => {
    expect(dropTarget('hand:1', new Set(['hand:1']), 0)).toBeNull();
  });
});
