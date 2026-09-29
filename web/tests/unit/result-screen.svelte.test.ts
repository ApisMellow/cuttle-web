// @vitest-environment jsdom
// SPEC §5.2 ResultScreen (R2.3, R3.1, R3.2). Pure presentational component —
// no store, no engine, no WASM — so this is a straight prop-driven unit
// test with store-shaped props (this round's brief: "you can't reach a real
// game over through the UI yet, so unit-test ResultScreen with store-shaped
// props"). The e2e halves that drive a real game to game-over land after
// the round-4 board/curtain integration.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import ResultScreen from '../../src/lib/components/ResultScreen.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  state: Pick<PlayerView, 'winner' | 'stalemate'>;
  names: [string, string];
  tally: Record<PlayerId, number>;
  onRematch: () => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(ResultScreen, { target: host, props });
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
  const found = el.querySelector<HTMLElement>('[data-testid="result-screen"]');
  if (!found) throw new Error('no result-screen root rendered');
  return found;
}

function headline(el: HTMLElement): string | undefined {
  return root(el).querySelector('h1')?.textContent?.trim();
}

function rematchButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>('[data-testid="rematch"]');
  if (!found) throw new Error('no rematch button rendered');
  return found;
}

describe('ResultScreen copy (R2.3)', () => {
  it('shows the named winner, not the stalemate copy', () => {
    const el = render({
      state: { winner: 0, stalemate: false },
      names: ['Alice', 'Blake'],
      tally: { 0: 1, 1: 0 },
      onRematch: () => {},
    });
    expect(headline(el)).toBe('Alice wins!');
  });

  it('shows player 2 as winner correctly (not hardcoded to index 0)', () => {
    const el = render({
      state: { winner: 1, stalemate: false },
      names: ['Alice', 'Blake'],
      tally: { 0: 0, 1: 1 },
      onRematch: () => {},
    });
    expect(headline(el)).toBe('Blake wins!');
  });

  it('shows the stalemate copy, not a winner line, when stalemate is true', () => {
    const el = render({
      state: { winner: null, stalemate: true },
      names: ['Alice', 'Blake'],
      tally: { 0: 2, 1: 2 },
      onRematch: () => {},
    });
    expect(headline(el)).toBe('Stalemate — nobody wins this one.');
  });
});

describe('ResultScreen tally line (R3.1)', () => {
  it('renders "Name N – Name N" using the given names and tally, verbatim', () => {
    const el = render({
      state: { winner: 0, stalemate: false },
      names: ['Alice', 'Blake'],
      tally: { 0: 3, 1: 1 },
      onRematch: () => {},
    });
    const tally = el.querySelector('[data-testid="tally"]');
    expect(tally?.textContent?.trim()).toBe('Match: Alice 3 – Blake 1');
  });

  it('reflects a 0-0 tally on the very first game', () => {
    const el = render({
      state: { winner: 1, stalemate: false },
      names: ['Player 1', 'Player 2'],
      tally: { 0: 0, 1: 0 },
      onRematch: () => {},
    });
    const tally = el.querySelector('[data-testid="tally"]');
    expect(tally?.textContent?.trim()).toBe('Match: Player 1 0 – Player 2 0');
  });
});

describe('ResultScreen Rematch (R3.2, SPEC §8 OQ-12)', () => {
  it('calls onRematch exactly once per click; the dealer/nextDealer wiring is the app layer\'s job, not this component\'s', () => {
    const onRematch = vi.fn();
    const el = render({
      state: { winner: 0, stalemate: false },
      names: ['Alice', 'Blake'],
      tally: { 0: 1, 1: 0 },
      onRematch,
    });
    rematchButton(el).click();
    flushSync();
    expect(onRematch).toHaveBeenCalledTimes(1);
  });
});

// The "no card identity from a view that holds a hand" half of this
// guarantee is asserted at App level, where a real game-over view carrying
// both hands feeds this screen (app.svelte.test.ts, N3).
describe('ResultScreen renders neither hand (round-2 carry-over)', () => {
  it('never renders a hand-card element or any card-shaped testid', () => {
    const el = render({
      state: { winner: 0, stalemate: false },
      names: ['Alice', 'Blake'],
      tally: { 0: 1, 1: 0 },
      onRematch: () => {},
    });
    expect(el.querySelectorAll('[data-testid^="hand-card-"]').length).toBe(0);
    // Only the three contracted testids exist on this screen.
    const ids = [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    expect(ids.sort()).toEqual(['rematch', 'result-screen', 'tally']);
  });
});

describe('W25: Home button and final scores', () => {
  it('shows each player\'s final points, and Home calls onHome', () => {
    const onHome = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(ResultScreen, {
      target: host,
      props: {
        state: { winner: 0, stalemate: false },
        names: ['Alice', 'Blake'] as [string, string],
        tally: { 0: 1, 1: 0 },
        scores: { 0: 22, 1: 9 },
        onRematch: () => {},
        onHome,
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="final-scores"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Final score: Alice 22 – Blake 9',
    );
    host.querySelector<HTMLButtonElement>('[data-testid="result-home"]')!.click();
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
