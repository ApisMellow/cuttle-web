// Issue #37 — table mode (SPEC §5.10): the phone lies flat between the two
// players. Player 1 (seat 0) sits at the phone's bottom edge, player 2
// (seat 1) at its top edge. Every screen addressed to player 2 is turned
// 180°, so it reads the right way up from across the table; the board
// never appears to flip.
import { describe, expect, it } from 'vitest';

import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { screenAddressee, screenRotated, toViewDelta } from '../../src/lib/tableMode';

const P1 = 0 as const;
const P2 = 1 as const;

/** Every curtain kind that is addressed to one player, for either player. */
function addressed(to: 0 | 1): CurtainState[] {
  return [
    { kind: 'handoff', to, reason: 'turn' },
    { kind: 'handoff', to, reason: 'counter' },
    { kind: 'handoff', to, reason: 'discard' },
    { kind: 'handoff', to, reason: 'seven-return' },
    { kind: 'handoff', to, reason: 'resume' },
    { kind: 'reveal', to },
    { kind: 'recap', to, entries: [] },
    { kind: 'ack', to },
  ];
}

describe('screenAddressee: who the current game screen faces', () => {
  it.each(addressed(P2).map((c) => [c.kind, c] as const))('a %s addressed to player 2 faces player 2', (_kind, curtain) => {
    // The viewer is deliberately the other player: an addressed curtain's own `to` wins.
    expect(screenAddressee(curtain, P1)).toBe(P2);
    expect(screenAddressee(curtain, null)).toBe(P2);
  });

  it.each(addressed(P1).map((c) => [c.kind, c] as const))('a %s addressed to player 1 faces player 1', (_kind, curtain) => {
    expect(screenAddressee(curtain, P2)).toBe(P1);
    expect(screenAddressee(curtain, null)).toBe(P1);
  });

  it('the live board (and the draw reveal / pickers on it) faces whoever holds the view', () => {
    expect(screenAddressee({ kind: 'none' }, P2)).toBe(P2);
    expect(screenAddressee({ kind: 'none' }, P1)).toBe(P1);
  });

  it('a board with no view yet faces player 1', () => {
    expect(screenAddressee({ kind: 'none' }, null)).toBe(P1);
  });

  it('the result screen faces player 1, whoever held the last view', () => {
    expect(screenAddressee({ kind: 'result' }, P2)).toBe(P1);
    expect(screenAddressee({ kind: 'result' }, null)).toBe(P1);
  });
});

describe('screenRotated: table mode turns only player 2 screens', () => {
  const all: [string, CurtainState, 0 | 1 | null][] = [
    ...addressed(P1).map((c): [string, CurtainState, 0 | 1 | null] => [`${c.kind}→P1`, c, P2]),
    ...addressed(P2).map((c): [string, CurtainState, 0 | 1 | null] => [`${c.kind}→P2`, c, P1]),
    ['board P1', { kind: 'none' }, P1],
    ['board P2', { kind: 'none' }, P2],
    ['board no view', { kind: 'none' }, null],
    ['result', { kind: 'result' }, P2],
  ];

  it.each(all)('normal pass-and-play never rotates (%s)', (_label, curtain, viewer) => {
    expect(screenRotated(false, curtain, viewer)).toBe(false);
  });

  it.each(all)('table mode rotates exactly the player 2 screens (%s)', (_label, curtain, viewer) => {
    expect(screenRotated(true, curtain, viewer)).toBe(screenAddressee(curtain, viewer) === P2);
  });
});

describe('toViewDelta: a finger movement in the rotated frame', () => {
  it('passes screen deltas through unchanged when the view is upright', () => {
    expect(toViewDelta(15, -90, false)).toEqual({ x: 15, y: -90 });
  });

  it('negates both axes under the 180° turn, so the card still follows the finger', () => {
    expect(toViewDelta(15, -90, true)).toEqual({ x: -15, y: 90 });
  });

  it('never emits -0 (a style of "-0px" is harmless, but tests compare strings)', () => {
    expect(Object.is(toViewDelta(0, 0, true).x, 0)).toBe(true);
    expect(Object.is(toViewDelta(0, 0, true).y, 0)).toBe(true);
  });
});

describe('geometry: player 1 always at the bottom edge, player 2 at the top', () => {
  // Each player's own view draws their side (hand, points) at the bottom of
  // the view and the opponent's side at the top. A 180° turn about the
  // screen's centre maps a point at fraction f of the height to 1 - f.
  // Physical position (0 = top edge of the phone, 1 = bottom edge):
  const OWN_SIDE = 0.9; // in-view position of the viewer's own hand
  const OPP_SIDE = 0.1; // in-view position of the opponent's side
  function physical(inView: number, rotated: boolean): number {
    return rotated ? 1 - inView : inView;
  }

  it("player 1's view: their side at the bottom edge, player 2's at the top", () => {
    const rotated = screenRotated(true, { kind: 'none' }, P1);
    expect(physical(OWN_SIDE, rotated)).toBeGreaterThan(0.5); // P1's side: bottom
    expect(physical(OPP_SIDE, rotated)).toBeLessThan(0.5); // P2's side: top
  });

  it("player 2's view: their side at the top edge, player 1's at the bottom", () => {
    const rotated = screenRotated(true, { kind: 'none' }, P2);
    expect(physical(OWN_SIDE, rotated)).toBeLessThan(0.5); // P2's side: top
    expect(physical(OPP_SIDE, rotated)).toBeGreaterThan(0.5); // P1's side: bottom
  });

  it('without table mode the board flips: player 2 sees their own side at the bottom', () => {
    const rotated = screenRotated(false, { kind: 'none' }, P2);
    expect(physical(OWN_SIDE, rotated)).toBeGreaterThan(0.5);
  });
});
