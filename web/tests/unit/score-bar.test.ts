// @vitest-environment jsdom
// P2 W9 (SPEC §3.3 rule 2, docs/design.md §6) — ScoreBar renders
// `view.scoreboard` verbatim: points, threshold, and one King pip per King,
// with no recomputation from points/permanents arrays (it never sees them).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlayerView } from '../../src/lib/bridge/schema';
import ScoreBar from '../../src/lib/components/ScoreBar.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(props: { scoreboard: PlayerView['scoreboard']; opponentName: string }): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(ScoreBar, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

function bar(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="score-bar"]');
  if (!found) throw new Error('no score-bar rendered');
  return found;
}

describe('ScoreBar (SPEC §3.3 rule 2)', () => {
  it('shows both sides\' points and thresholds verbatim, and the viewer as literal "You"', () => {
    const el = render({
      scoreboard: {
        you: { points: 11, threshold: 21, kings: 0, hasWon: false },
        opponent: { points: 3, threshold: 14, kings: 0, hasWon: false },
      },
      opponentName: 'Priya',
    });
    const text = bar(el).textContent ?? '';
    expect(text).toContain('You');
    expect(text).toContain('11');
    expect(text).toContain('of 21');
    expect(text).toContain('Priya');
    expect(text).toContain('3');
    expect(text).toContain('of 14');
  });

  it('a King lowers the threshold and shows one pip per King — the numbers move together, unmodified', () => {
    const el = render({
      scoreboard: {
        you: { points: 8, threshold: 14, kings: 2, hasWon: false },
        opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
      },
      opponentName: 'Priya',
    });
    const youKings = bar(el).querySelector('[data-kings]');
    expect(youKings?.getAttribute('data-kings')).toBe('2');
    expect(bar(el).textContent).toContain('of 14');
  });

  it('zero Kings on a side renders no king-pip element for that side', () => {
    const el = render({
      scoreboard: {
        you: { points: 0, threshold: 21, kings: 0, hasWon: false },
        opponent: { points: 0, threshold: 21, kings: 3, hasWon: false },
      },
      opponentName: 'Priya',
    });
    const pips = [...bar(el).querySelectorAll('[data-kings]')];
    expect(pips.length).toBe(1);
    expect(pips[0].getAttribute('data-kings')).toBe('3');
  });

  it('a hasWon flag is not read for rendering (out of this round\'s scope) but does not crash either value', () => {
    expect(() =>
      render({
        scoreboard: {
          you: { points: 21, threshold: 21, kings: 0, hasWon: true },
          opponent: { points: 5, threshold: 21, kings: 0, hasWon: false },
        },
        opponentName: 'Priya',
      }),
    ).not.toThrow();
  });

  it('renders no [data-testid] other than score-bar itself (no accidental 44px-rule violations from sub-elements)', () => {
    const el = render({
      scoreboard: {
        you: { points: 1, threshold: 21, kings: 1, hasWon: false },
        opponent: { points: 2, threshold: 21, kings: 0, hasWon: false },
      },
      opponentName: 'Priya',
    });
    expect([...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))).toEqual(['score-bar']);
  });
});

describe('W25 turn header (public: names and view.active)', () => {
  const scoreboard: PlayerView['scoreboard'] = {
    you: { points: 0, threshold: 21, kings: 0, hasWon: false },
    opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
  };

  it('names the viewer and marks their turn: "Alice, your turn"', () => {
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(ScoreBar, { target: host, props: { scoreboard, opponentName: 'Blake', youName: 'Alice', active: 'you' } });
    flushSync();
    const text = bar(host).textContent ?? '';
    expect(text).toContain('Alice, your turn');
    expect(text).toContain('Blake');
    expect(text).not.toContain('You');
  });

  it('marks the opponent side when it is their turn', () => {
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(ScoreBar, { target: host, props: { scoreboard, opponentName: 'Blake', youName: 'Alice', active: 'opponent' } });
    flushSync();
    const text = bar(host).textContent ?? '';
    expect(text).toContain('Blake’s turn');
    expect(text).not.toContain('your turn');
  });
});
