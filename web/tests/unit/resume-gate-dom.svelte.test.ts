// @vitest-environment jsdom
// Resume gate in the DOM (SPEC §5.7 "Resume always raises a curtain",
// ruling 2026-09-29; §4.3 R14; §4.5). Strict tier: hidden-information privacy.
//
// ONE mounted App per test, driven through the real `game` and `session`
// singletons with the bridge faked (the app.svelte.test.ts pattern). The
// saved game is resumed through HomeScreen's Resume button, exactly as a
// player does after a reload or Menu -> Home. Before the gate is passed the
// DOM holds no hand, no card, no board and no counter option, and it is the
// same markup whether the saved position is the live board, a real counter
// window or a synthetic ack.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Envelope, PlayerId } from '../../src/lib/bridge/schema';
import type { CurtainState } from '../../src/lib/stores/curtain.svelte';
import { SNAPSHOT_KEY, encodeSnapshot, type Snapshot } from '../../src/lib/stores/snapshot';
import { Kind, Phase, appliedMove, envelope, playerView } from './game-test-support';

vi.mock('../../src/lib/bridge/wasm', () => ({
  ensureEngine: vi.fn(() => Promise.resolve()),
  resetEngineForTests: vi.fn(),
}));

const bridge = vi.hoisted(() => ({
  newGame: vi.fn(),
  apply: vi.fn(),
  view: vi.fn(),
  snapshot: vi.fn(() => '"fake-engine-state"'),
  restore: vi.fn(),
  legalMoves: vi.fn(),
  describe: vi.fn(),
}));

vi.mock('../../src/lib/bridge/engine', () => bridge);

const { default: App } = await import('../../src/App.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session, TALLY_KEY } = await import('../../src/lib/stores/session.svelte');

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

async function renderApp(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(App, { target: host });
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  return host;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.snapshot.mockImplementation(() => '"fake-engine-state"');
  game.goHome();
  game.error = null;
  game.notice = null;
  session.setNames('', '');
  session.tally = { 0: 0, 1: 0 };
});

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

// Distinctive identities the gate must never render.
const HAND: Card[] = [
  { Rank: 13, Suit: 3 },
  { Rank: 2, Suit: 1 },
];
const COUNTER_MOVE = { Kind: Kind.Counter, Card: HAND[1], HandIndex: 1, Target: null, JackTarget: null, ScrapIndex: -1, DiscardA: -1, DiscardB: -1, SubMove: null };
const DECLINE_MOVE = { ...COUNTER_MOVE, Kind: Kind.Decline, Card: null, HandIndex: -1 };
const ONE_OFF = appliedMove({ by: 1, kind: Kind.OneOff, seq: 1, card: { Rank: 9, Suit: 0 }, description: 'play 9♣ as one-off' });

function saved(curtain: CurtainState, viewer: PlayerId = 0): Snapshot {
  return {
    v: 2,
    savedAt: '2026-09-29T00:00:00.000Z',
    engineState: '"fake-engine-state"',
    history: [ONE_OFF],
    lastSeenSeq: { 0: 1, 1: 1 },
    viewer,
    curtain,
    names: ['Alice', 'Blake'],
    seed: '42',
    dealer: 1,
  };
}

function viewerEnvelope(kind: 'board' | 'real' | 'synthetic', viewer: PlayerId = 0): Envelope {
  const real = kind === 'real';
  const legalMoves = real ? [DECLINE_MOVE, COUNTER_MOVE] : [];
  return envelope({
    state: playerView({
      viewer,
      active: viewer,
      phase: real ? Phase.AwaitingCounter : Phase.Normal,
      you: { hand: HAND, frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    }),
    legalMoves,
    descriptions: legalMoves.map((m) => (m.Kind === Kind.Counter ? 'counter with 2♦' : 'decline')),
    history: [ONE_OFF],
    seq: 1,
  });
}

const CASES: Array<{ name: string; curtain: CurtainState; env: 'board' | 'real' | 'synthetic' }> = [
  { name: 'live board', curtain: { kind: 'none' }, env: 'board' },
  { name: 'real counter window', curtain: { kind: 'ack', to: 0, synthetic: false }, env: 'real' },
  { name: 'synthetic ack', curtain: { kind: 'ack', to: 0, synthetic: true }, env: 'synthetic' },
];

async function resumeInto(c: (typeof CASES)[number], viewer: PlayerId = 0): Promise<HTMLDivElement> {
  localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(saved(c.curtain, viewer)));
  const env = viewerEnvelope(c.env, viewer);
  bridge.restore.mockImplementation(() => env);
  bridge.view.mockImplementation(() => env);
  const el = await renderApp();
  const resume = el.querySelector<HTMLElement>('[data-testid="resume"]');
  if (!resume) throw new Error('no Resume button');
  resume.click();
  await Promise.resolve();
  flushSync();
  return el;
}

function expectGateOnly(el: HTMLElement, name: string): void {
  expect(el.querySelector('[data-testid="curtain-gate"]'), name).not.toBeNull();
  for (const id of ['board', 'counter-prompt', 'counter-resolve', 'player-hand', 'pass', 'score-bar', 'recap']) {
    expect(el.querySelector(`[data-testid="${id}"]`), `${name}: ${id}`).toBeNull();
  }
  expect(el.querySelectorAll('[data-testid^="hand-card-"], [data-testid^="counter-option-"]').length, name).toBe(0);
  // No card art: the only graphic is the menu button's own icon.
  const graphics = [...el.querySelectorAll('svg, img, canvas')].filter((g) => !g.closest('[data-testid="menu-button"]'));
  expect(graphics.length, name).toBe(0);
  // No card identity in any text: no rank-suit pair, no suit glyph at all.
  expect(el.textContent, name).not.toMatch(/[♣♦♥♠]/);
  expect(el.innerHTML, name).not.toMatch(/let it resolve|counter/i);
}

describe('Resume shows only the gate until the viewer passes it', () => {
  for (const c of CASES) {
    it(`${c.name}: the DOM before the gate holds no hand, card, board or counter option`, async () => {
      const el = await resumeInto(c);
      expect(game.curtain).toEqual({ kind: 'handoff', to: 0, reason: 'resume' });
      expectGateOnly(el, c.name);
      expect(el.textContent).toContain('Alice');
      expect(bridge.view).not.toHaveBeenCalled();

      // "I'm Alice" arms the screen; still nothing behind it.
      el.querySelector<HTMLElement>('[data-testid="reveal-two-step"]')!.click();
      flushSync();
      await Promise.resolve();
      flushSync();
      expectGateOnly(el, `${c.name} (armed)`);

      // "Show my hand" passes the gate: now the resting screen appears.
      el.querySelector<HTMLElement>('[data-testid="reveal-two-step"]')!.click();
      flushSync();
      await Promise.resolve();
      flushSync();
      expect(el.querySelector('[data-testid="curtain-gate"]')).toBeNull();
      if (c.env === 'board') expect(el.querySelector('[data-testid="board"]')).not.toBeNull();
      else expect(el.querySelector('[data-testid="counter-prompt"]')).not.toBeNull();
      if (c.env === 'real') expect(el.querySelectorAll('[data-testid^="counter-option-"]').length).toBe(1);
    });
  }

  it('the gate markup is identical for the board, a real window and a synthetic ack (R14)', async () => {
    const html: string[] = [];
    for (const c of CASES) {
      const el = await resumeInto(c);
      html.push(el.innerHTML);
      if (instance) unmount(instance);
      host?.remove();
      instance = undefined;
      game.goHome();
    }
    expect(html[1]).toBe(html[0]);
    expect(html[2]).toBe(html[0]);
  });

  it('the other viewer: the gate names Blake and the same holds', async () => {
    const el = await resumeInto(CASES[0], 1);
    expect(game.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'resume' });
    expectGateOnly(el, 'Blake');
    expect(el.textContent).toContain('Blake');
  });
});

// R3 (ruling 2026-09-29, SPEC §5.3): the tally survives a reload. The app's
// session singleton keeps it in sessionStorage for the name pair, and the
// saved game's names bring it back.
describe('the tally survives a reload (R3.3 amended)', () => {
  it('a 0–2 tally for Alice and Blake reads 0–2 on the result screen after a reload and Resume', async () => {
    sessionStorage.setItem(TALLY_KEY, JSON.stringify({ names: ['Alice', 'Blake'], tally: { 0: 0, 1: 2 } }));
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(saved({ kind: 'result' })));
    const over = envelope({ state: playerView({ viewer: 0, active: 1, phase: Phase.GameOver, winner: 1 }), history: [ONE_OFF] });
    bridge.restore.mockImplementation(() => over);
    const el = await renderApp();
    el.querySelector<HTMLElement>('[data-testid="resume"]')!.click();
    await Promise.resolve();
    flushSync();
    expect(el.querySelector('[data-testid="result-screen"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="tally"]')?.textContent?.trim()).toBe('Match: Alice 0 – Blake 2');
  });

  it('a tally saved for other names is not shown: 0–0', async () => {
    sessionStorage.setItem(TALLY_KEY, JSON.stringify({ names: ['Alice', 'Casey'], tally: { 0: 3, 1: 0 } }));
    localStorage.setItem(SNAPSHOT_KEY, encodeSnapshot(saved({ kind: 'result' })));
    bridge.restore.mockImplementation(() => envelope({ state: playerView({ viewer: 0, active: 1, phase: Phase.GameOver, winner: 1 }), history: [ONE_OFF] }));
    const el = await renderApp();
    el.querySelector<HTMLElement>('[data-testid="resume"]')!.click();
    await Promise.resolve();
    flushSync();
    expect(el.querySelector('[data-testid="tally"]')?.textContent?.trim()).toBe('Match: Alice 0 – Blake 0');
  });
});
