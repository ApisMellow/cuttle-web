// @vitest-environment jsdom
// Playtest friction round (2026-09-28): the component halves.
//   - CounterPrompt (strict, R14): a 5 whose `drawn` is already set (the
//     synthetic path) renders byte-identically to one still waiting (the
//     real counter window). Plain option text.
//   - ResultScreen: the winning-move line.
//   - Rules: the home screen's Rules button opens a cheat-sheet with one
//     line per one-off rank, and Close shuts it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove } from '../../src/lib/bridge/schema';
import CounterPrompt from '../../src/lib/components/CounterPrompt.svelte';
import ResultScreen from '../../src/lib/components/ResultScreen.svelte';
import RulesButton from '../../src/lib/components/RulesButton.svelte';
import { Kind, appliedMove } from './game-test-support';

const hosts: { host: HTMLDivElement; instance: ReturnType<typeof mount> }[] = [];

afterEach(() => {
  for (const { host, instance } of hosts.splice(0)) {
    unmount(instance);
    host.remove();
  }
});

function render<P extends Record<string, unknown>>(component: Component<P>, props: P): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const instance = mount(component, { target: host, props });
  flushSync();
  hosts.push({ host, instance });
  return host;
}

function fiveEntry(drawn: number | null): AppliedMove {
  return appliedMove({ by: 1, kind: Kind.OneOff, seq: 5, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off', drawn });
}

describe('CounterPrompt and the 5 (R14, strict)', () => {
  const props = (entries: AppliedMove[]) => ({
    entries,
    viewer: 0 as const,
    names: ['Alice', 'Blake'] as const,
    options: [],
    onresolve: () => {},
    oncounter: () => {},
  });

  it('a resolved 5 (synthetic ack) and a waiting 5 (real window) render identical DOM', () => {
    const synthetic = render(CounterPrompt, props([fiveEntry(2)]));
    const real = render(CounterPrompt, props([fiveEntry(null)]));
    expect(synthetic.innerHTML).toBe(real.innerHTML);
    expect(real.textContent).toContain('Blake played 5♥ as a one-off to draw 2 cards.');
    expect(synthetic.textContent).not.toMatch(/drew/);
  });

  it('counter buttons and the staged counter use plain wording', () => {
    const el = render(CounterPrompt, { ...props([fiveEntry(null)]), options: [{ index: 2, description: 'counter with 2♣' }] });
    const button = el.querySelector<HTMLButtonElement>('[data-testid="counter-option-2"]')!;
    expect(button.textContent?.trim()).toBe('Counter with 2♣: stop their card.');
    button.click();
    flushSync();
    expect(el.querySelector('[data-testid="staging-bar"]')?.textContent).toContain('Counter with 2♣: stop their card.');
  });
});

describe('ResultScreen winning move (R2, amended 2026-09-28)', () => {
  const base = {
    state: { winner: 0 as const, stalemate: false },
    names: ['Alice', 'Blake'] as [string, string],
    tally: { 0: 1, 1: 0 },
    scores: { 0: 21, 1: 9 },
    onRematch: () => {},
    onHome: () => {},
  };

  it('shows the line it is given, under the headline', () => {
    const el = render(ResultScreen, { ...base, winningMove: 'Alice won by reaching 21 with the 10♥.' });
    const headline = el.querySelector('.result-screen__headline');
    const move = el.querySelector('.result-screen__move');
    expect(move?.textContent).toBe('Alice won by reaching 21 with the 10♥.');
    expect(headline?.nextElementSibling).toBe(move);
  });

  it('renders no line for a stalemate (empty string)', () => {
    const el = render(ResultScreen, { ...base, state: { winner: null, stalemate: true }, winningMove: '' });
    expect(el.querySelector('.result-screen__move')).toBeNull();
  });
});

describe('Rules cheat-sheet (SPEC §5.5, amended 2026-09-28)', () => {
  it('the Rules button is enabled and opens the sheet; Close shuts it', () => {
    const el = render(RulesButton, {});
    const button = el.querySelector<HTMLButtonElement>('[data-testid="home-rules"]')!;
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-testid="rules-sheet"]')).toBeNull();
    button.click();
    flushSync();
    const sheet = el.querySelector('[data-testid="rules-sheet"]');
    expect(sheet).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="rules-close"]')!.click();
    flushSync();
    expect(el.querySelector('[data-testid="rules-sheet"]')).toBeNull();
  });

  it('Escape closes it', () => {
    const el = render(RulesButton, {});
    el.querySelector<HTMLButtonElement>('[data-testid="home-rules"]')!.click();
    flushSync();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(el.querySelector('[data-testid="rules-sheet"]')).toBeNull();
  });

  it('one line per one-off rank (A, 2, 3, 4, 5, 6, 7, 9), plus how to win and points/permanents', () => {
    const el = render(RulesButton, {});
    el.querySelector<HTMLButtonElement>('[data-testid="home-rules"]')!.click();
    flushSync();
    const sheet = el.querySelector('[data-testid="rules-sheet"]')!;
    const text = sheet.textContent ?? '';
    for (const heading of ['Win', 'Points', 'Permanents', 'One-offs']) expect(text).toContain(heading);
    const oneOffs = [...sheet.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === 'One-offs')!;
    const ranks = [...oneOffs.querySelectorAll('li b')].map((b) => b.textContent);
    // Card labels: each rank now carries its Classic name.
    expect(ranks).toEqual([
      'Ace, Board Wipe:',
      '2, Counter:',
      '3, Recycle:',
      '4, Forced Discard:',
      '5, Draw Two:',
      '6, Royal Wipe:',
      '7, Top Deck:',
      '9, Send Back:',
    ]);
    // Review N2: the win is checked as soon as a play resolves, not at the end of a turn.
    expect(text).toContain('You win as soon as you have 21 or more points on your side (fewer with Kings in play).');
    expect(text).not.toContain('end of your turn');
    // Engine v0.2.1: points that reach you during their turn win at the start of yours.
    expect(text).toContain('Points that reach your side during their turn win at the start of your next turn instead.');
    expect(text).toContain('A 2 scrapping a Jack takes only the top one, and the card goes to whoever controls the next Jack, or back to its owner.');
    expect(text).toContain('1 King 14, 2 Kings 10, 3 Kings 7, 4 Kings 5');
    expect(text).not.toMatch(/[♣♦♥♠]/);
  });

  it('review B2/N3: the 9 line is true for a stolen card; the Jack and 7 lines cover the 9 and the dead end', () => {
    const el = render(RulesButton, {});
    el.querySelector<HTMLButtonElement>('[data-testid="home-rules"]')!.click();
    flushSync();
    const items = [...el.querySelectorAll('[data-testid="rules-sheet"] li')].map((li) => li.textContent ?? '');
    const line = (start: string): string => items.find((t) => t.startsWith(start)) ?? '';
    expect(line('9,')).toBe(
      '9, Send Back: Send a card back to its owner’s hand. If it’s theirs, they can’t play it on their next turn. If it’s a card they stole from you, it comes back to your hand.',
    );
    expect(line('Jack,')).toContain('or a 9 sends that card home');
    expect(line('7,')).toContain('If none can be played, scrap one instead.');
  });

  it('review N3: focus moves into the sheet on open and back to the Rules button on close', () => {
    const el = render(RulesButton, {});
    const button = el.querySelector<HTMLButtonElement>('[data-testid="home-rules"]')!;
    button.focus();
    button.click();
    flushSync();
    expect(document.activeElement).toBe(el.querySelector('[data-testid="rules-sheet"]'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(el.querySelector('[data-testid="rules-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('HomeScreen mounts the Rules button (no disabled Rules button remains)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'components', 'HomeScreen.svelte'), 'utf8');
    expect(src).toContain('<RulesButton />');
    expect(src).not.toMatch(/disabled>Rules</);
    vi.restoreAllMocks();
  });
});
