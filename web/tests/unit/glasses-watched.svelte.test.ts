// @vitest-environment jsdom
// W24 — the "being watched" marker. While the OPPONENT has a glasses 8 in
// play, the viewer's hand carries a small marker ("Blake can see your
// hand"). Public information only: it is derived from the opponent's
// permanents, which are on the table for both players (SPEC §3.2). ONE
// mounted Board driven through a `$state` props object, so the marker is
// checked coming and going on the same instance.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card, PlayerView } from '../../src/lib/bridge/schema';
import Board from '../../src/lib/components/Board.svelte';
import { playerView } from './game-test-support';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function viewWith(youPerms: Card[], oppPerms: Card[]): PlayerView {
  return playerView({
    viewer: 0,
    you: { hand: [{ Rank: 3, Suit: 1 }], frozenHandIndices: [], points: [], permanents: youPerms },
    opponent: { handCount: 2, hand: null, points: [], permanents: oppPerms },
  });
}

function marker(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>('.watched-marker');
}

describe('the watched marker appears if and only if the opponent has glasses', () => {
  it('toggles with the opponent permanents on one mounted board, names the opponent, and sits in the viewer hand slot', () => {
    const props = $state({
      view: viewWith([], []),
      names: ['Alice', 'Blake'] as [string, string],
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      dimmedHand: new Set<number>(),
      selectedHand: null,
      inert: false,
      deckEnabled: true,
      ontap: () => {},
    });
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(Board, { target: host, props });
    flushSync();

    // No permanents at all: no marker.
    expect(marker(host)).toBeNull();

    // Opponent holds a Queen and a King, no 8: still no marker.
    props.view = viewWith([], [{ Rank: 12, Suit: 0 }, { Rank: 13, Suit: 2 }]);
    flushSync();
    expect(marker(host)).toBeNull();

    // The VIEWER has glasses: they watch, they are not watched.
    props.view = viewWith([{ Rank: 8, Suit: 1 }], []);
    flushSync();
    expect(marker(host)).toBeNull();

    // Opponent plays glasses: the marker appears, in the viewer's hand slot.
    props.view = viewWith([], [{ Rank: 12, Suit: 0 }, { Rank: 8, Suit: 3 }]);
    flushSync();
    const shown = marker(host);
    expect(shown).not.toBeNull();
    expect(shown!.textContent).toContain('Blake can see your hand');
    expect(host.querySelector('[data-testid="player-zone"]')!.contains(shown)).toBe(true);
    expect(host.querySelector('[data-testid="opponent-zone"]')!.contains(shown)).toBe(false);

    // Viewer 1's board names player 0.
    props.view = { ...viewWith([], [{ Rank: 8, Suit: 0 }]), viewer: 1 };
    flushSync();
    expect(marker(host)!.textContent).toContain('Alice can see your hand');

    // The glasses leave (scrapped by a 2, say): the marker goes.
    props.view = viewWith([], [{ Rank: 12, Suit: 0 }]);
    flushSync();
    expect(marker(host)).toBeNull();
  });
});
