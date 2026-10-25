// @vitest-environment jsdom
// Issue #93 (SPEC §4.3, design §8 C2, C5–C7): the counter rewind's screens,
// through a real GameScreen on a real GameStore and the wasm engine.
//
//   C2  With nothing selected, the board (the `counter-link` marker
//       included) is the same markup whether or not the viewer holds a 2.
//   C5  The winner's beat: "Not So Fast!" over their own board; in
//       pass-and-play a tap or 3 s raises the handoff, online the waiting
//       line shows after it. Never on the decider's screen, and never when
//       the decider has no 2.
//   C6  The decider at a pending win: a normal board, one `let-it-happen`,
//       the 2s playable and everything else dimmed, nothing selected and no
//       chooser. One tap of "Let it happen" ends the game for the winner;
//       a 2 dragged onto the marker counters.
//   C7  The owed discard: the picker and the 2's drag together; paying
//       plays on with no curtain, a 2 dragged onto the marker counters.
//
// Positions are written with the tutorial's `positionSnapshot`, as in
// counter-rewind-wasm.test.ts.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Move } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { NOT_SO_FAST_CUE_MS, NOT_SO_FAST_MS } from '../../src/lib/components/NotSoFast.svelte';
import { MoveKind, Phase } from '../../src/lib/enums';
import { lastMoveLine, winningMoveLine } from '../../src/lib/recap';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import type { OnlineTableInfo } from '../../src/lib/stores/tableSource';
import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { LessonPosition } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';
import { FakeTableSource } from './fake-table-source.svelte';
import { fakeStorage, passResumeGate } from './game-test-support';

const NAMES: [string, string] = ['Alice', 'Blake'];

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function tsSave(engineState: string): string {
  return JSON.stringify({
    v: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    engineState,
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 },
    viewer: 0,
    curtain: { kind: 'none' },
    names: NAMES,
    seed: '0',
    dealer: 1,
  });
}

/** A lesson-style position, Alice to move, restored and past the resume gate. */
async function startAt(pos: LessonPosition): Promise<GameStore> {
  const storage = fakeStorage();
  storage.setItem(SNAPSHOT_KEY, tsSave(positionSnapshot(pos)));
  const store = new GameStore({ storage, session });
  await store.restore();
  expect(store.error).toBeNull();
  await passResumeGate(store);
  return store;
}

function sameCard(a: Card | null, b: Card): boolean {
  return a !== null && a.Rank === b.Rank && a.Suit === b.Suit;
}

function indexOf(store: GameStore, pred: (m: Move) => boolean, what: string): number {
  const i = store.legalMoves.findIndex(pred);
  if (i < 0) throw new Error(`no legal move: ${what}`);
  return i;
}

const isOneOff = (card: Card) => (m: Move) => m.Kind === MoveKind.OneOff && sameCard(m.Card, card);

/** Walks handoff -> reveal -> the board. */
async function pass(store: GameStore): Promise<void> {
  for (let i = 0; i < 4 && (store.curtain.kind === 'handoff' || store.curtain.kind === 'reveal'); i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}

// ---------------------------------------------------------------------------
// DOM harness
// ---------------------------------------------------------------------------

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let hitElement: Element | null = null;

function render(source: GameStore | FakeTableSource): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source } });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function all(el: HTMLElement, id: string): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

async function click(el: HTMLElement, id: string): Promise<void> {
  const target = q(el, id);
  if (!target) throw new Error(`no [data-testid="${id}"] rendered`);
  target.click();
  await settle();
}

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch' }),
  );
  flushSync();
}

/** Drags hand card `handIndex` and drops it on `onto` (jsdom has no layout: elementFromPoint is stubbed). */
async function drag(el: HTMLElement, handIndex: number, onto: Element | null): Promise<void> {
  const card = q(el, `hand-card-${handIndex}`)!;
  pointer('pointerdown', card, 100, 700);
  pointer('pointermove', card, 100, 680);
  hitElement = onto;
  pointer('pointermove', card, 130, 400);
  pointer('pointerup', card, 130, 400);
  await settle();
}

/** The board's markup with the viewer's own hand taken out and generated ids normalised. */
function boardMarkupWithoutHand(el: HTMLElement): string {
  const screen = q(el, 'game-screen')!.cloneNode(true) as HTMLElement;
  for (const hand of screen.querySelectorAll('[data-testid="player-hand"]')) hand.replaceChildren();
  return screen.innerHTML.replace(/\s(id|aria-labelledby|aria-describedby|for)="[^"]*"/g, ' $1=""');
}

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  localStorage.clear();
  session.setNames('Alice', 'Blake');
  session.lastDealer = null;
  settings.revealPreference = 'two-step';
  settings.reducedMotion = false;
  settings.tableMode = false;
  hitElement = null;
  document.elementFromPoint = () => hitElement;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// C2: a 2 in hand changes nothing on the board until it is selected
// ---------------------------------------------------------------------------

/** Alice's 9♥ sends Blake's 8♥ back to his hand: Blake's next turn may counter it, if he holds a 2. */
function nineTwin(blakeFirst: Card): LessonPosition {
  return {
    aliceHand: [c(9, 'H'), c(4, 'S')],
    alicePoints: [],
    blakeHand: [blakeFirst, c(7, 'D'), c(13, 'C')],
    blakePoints: [c(8, 'H')],
    scrap: [],
    deckTop: [c(5, 'C'), c(6, 'C')],
  };
}

async function blakeAfterNine(blakeFirst: Card): Promise<GameStore> {
  const store = await startAt(nineTwin(blakeFirst));
  await store.apply(indexOf(store, isOneOff(c(9, 'H')), 'Alice 9♥'));
  await pass(store);
  expect(store.viewer).toBe(1);
  return store;
}

describe('C2: the board is the same markup with or without a 2 (issue #93, SPEC §4.3)', () => {
  it('twins that differ only by a 2 in Blake\'s hand render the same board, counter-link included', async () => {
    const withTwo = await blakeAfterNine(c(2, 'C'));
    expect(withTwo.legalMoves.some((m) => m.Kind === MoveKind.Counter)).toBe(true);
    let el = render(withTwo);
    await settle();
    expect(q(el, 'counter-link')?.dataset.state).toBe('normal');
    const markupWith = boardMarkupWithoutHand(el);
    cleanup();

    const withoutTwo = await blakeAfterNine(c(3, 'D'));
    expect(withoutTwo.legalMoves.some((m) => m.Kind === MoveKind.Counter)).toBe(false);
    el = render(withoutTwo);
    await settle();
    expect(q(el, 'counter-link')?.dataset.state).toBe('normal');
    expect(boardMarkupWithoutHand(el)).toBe(markupWith);
    expect(all(el, 'counter-link')).toHaveLength(1);
  }, 20_000);

  it('selecting the 2 lights the marker; a tap stages the Counter line; Confirm counters with no curtain', async () => {
    const store = await blakeAfterNine(c(2, 'C'));
    const el = render(store);
    await settle();
    const two = store.view!.you.hand.findIndex((h) => sameCard(h, c(2, 'C')));
    await click(el, `hand-card-${two}`);
    expect(q(el, 'counter-link')?.dataset.state).toBe('highlighted');
    expect(q(el, 'counter-link')?.getAttribute('aria-label')).toBe('Last turn');
    await click(el, 'counter-link');
    expect(q(el, 'staging-bar')?.textContent).toContain("Counter with 2♣: undo Alice's last turn.");
    await click(el, 'staging-confirm');
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    expect(lastMoveLine(store.history, 1, NAMES)).toBe("You countered with 2♣ and undid Alice's last turn.");
    expect(q(el, 'board')).not.toBeNull();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// C5 / C6: a pending win
// ---------------------------------------------------------------------------

function pendingWin(blakeHand: Card[]): LessonPosition {
  return {
    aliceHand: [c(7, 'C'), c(9, 'H')],
    alicePoints: [c(10, 'S'), c(3, 'S')],
    blakeHand,
    blakePoints: [],
    scrap: [],
    deckTop: [c(10, 'H'), c(4, 'D'), c(6, 'C')],
  };
}

/** Alice's 7 reveals 10♥ and she plays it for points: 23 of 21 on a counterable turn. */
async function winThroughSeven(store: GameStore): Promise<void> {
  await store.apply(indexOf(store, isOneOff(c(7, 'C')), 'Alice 7♣'));
  const pick = indexOf(
    store,
    (m) => m.Kind === MoveKind.SevenPick && m.SubMove !== null && m.SubMove.Kind === MoveKind.PlayPoint && sameCard(m.Card, c(10, 'H')),
    '7 pick 10♥ for points',
  );
  await store.apply(pick);
}

/** Blake at his pending-win board, the beat dismissed and the handoff passed. */
async function blakeDeciding(): Promise<GameStore> {
  const store = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
  await winThroughSeven(store);
  store.dismissNotSoFast();
  await pass(store);
  expect(store.view?.phase).toBe(Phase.PendingWin);
  return store;
}

describe('C5: the winner\'s beat, pass-and-play (issue #93, SPEC §4.3)', () => {
  it('the win headline, then "Not So Fast!" over Alice\'s own board; 3 s raise the handoff to Blake', async () => {
    const store = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
    const el = render(store);
    await settle();
    vi.useFakeTimers();
    await winThroughSeven(store);
    await settle();

    const beat = q(el, 'not-so-fast')!;
    expect(beat).not.toBeNull();
    expect(beat.getAttribute('role')).toBe('status');
    expect(beat.querySelector('button')).toBeNull();
    expect(beat.dataset.stage).toBe('cue');
    expect(beat.textContent).toBe('You win!');
    expect(q(el, 'board')).not.toBeNull(); // the winner's own board stays up
    expect(q(el, 'let-it-happen')).toBeNull();

    vi.advanceTimersByTime(NOT_SO_FAST_CUE_MS);
    flushSync();
    expect(q(el, 'not-so-fast')?.dataset.stage).toBe('cut');
    expect(q(el, 'not-so-fast')?.textContent).toBe('Not So Fast!');
    expect(store.curtain).toEqual({ kind: 'none' });

    vi.advanceTimersByTime(NOT_SO_FAST_MS - NOT_SO_FAST_CUE_MS - 1);
    flushSync();
    expect(store.notSoFast).toEqual({ to: 0 });
    vi.advanceTimersByTime(1);
    await settle();
    expect(store.notSoFast).toBeNull();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(q(el, 'not-so-fast')).toBeNull();
    expect(q(el, 'board')).toBeNull();
  }, 20_000);

  it('a tap raises the handoff at once; reduced motion keeps the same beat', async () => {
    settings.reducedMotion = true;
    const store = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
    const el = render(store);
    await settle();
    vi.useFakeTimers();
    await winThroughSeven(store);
    await settle();
    const beat = q(el, 'not-so-fast')!;
    expect(beat.dataset.motion).toBe('reduced');
    pointer('pointerdown', beat, 200, 400);
    beat.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await settle();
    expect(store.curtain).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(q(el, 'not-so-fast')).toBeNull();
  }, 20_000);

  it('Blake holds no 2: the game is simply over, with no beat', async () => {
    const store = await startAt(pendingWin([c(6, 'D'), c(5, 'D')]));
    const el = render(store);
    await settle();
    await winThroughSeven(store);
    await settle();
    expect(store.curtain).toEqual({ kind: 'result' });
    expect(q(el, 'not-so-fast')).toBeNull();
  }, 20_000);
});

describe('C5: the winner\'s beat, online', () => {
  function onlineInfo(waitingText: string | null): OnlineTableInfo {
    return {
      names: NAMES,
      statusText: null,
      statusAction: null,
      respondingName: null,
      notice: null,
      runStatusAction() {},
      statusTone: null,
      respondingCard: null,
      waitingText,
      missed: [],
      dismissMissed() {},
      stuck: null,
      leaveGame() {},
    };
  }

  it('3 s clear the beat; the board stays up with "Blake is deciding…"', async () => {
    const store = await startAt(pendingWin([c(2, 'C'), c(5, 'D')]));
    await winThroughSeven(store);
    const winner = store.envelope!;
    const source = new FakeTableSource();
    source.online = onlineInfo('Blake is deciding…');
    source.push(winner);
    source.notSoFast = { to: 0 };
    vi.useFakeTimers();
    const el2 = render(source);
    await settle();
    expect(q(el2, 'not-so-fast')).not.toBeNull();
    vi.advanceTimersByTime(NOT_SO_FAST_MS);
    await settle();
    expect(source.notSoFastDismissals).toBe(1);
    expect(q(el2, 'not-so-fast')).toBeNull();
    expect(q(el2, 'board')).not.toBeNull();
    expect(q(el2, 'online-waiting-on')?.textContent).toBe('Blake is deciding…');
  }, 20_000);

  it('never on the decider\'s screen: Blake\'s board has "Let it happen" and no beat', async () => {
    const store = await blakeDeciding();
    const source = new FakeTableSource();
    source.online = onlineInfo(null);
    source.push(store.envelope!);
    const el = render(source);
    await settle();
    expect(q(el, 'not-so-fast')).toBeNull();
    expect(all(el, 'let-it-happen')).toHaveLength(1);
  }, 20_000);
});

describe('C6: the decider at a pending win (issue #93, SPEC §4.3)', () => {
  it('a normal board, one "Let it happen", the 2 playable and the rest dimmed, nothing selected, no chooser', async () => {
    const store = await blakeDeciding();
    const el = render(store);
    await settle();
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'not-so-fast')).toBeNull();
    expect(all(el, 'let-it-happen')).toHaveLength(1);
    expect(q(el, 'hand-card-0')?.dataset.dimmed).toBe('false'); // 2♣
    expect(q(el, 'hand-card-1')?.dataset.dimmed).toBe('true'); // 5♦
    expect(el.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(q(el, 'counter-link')?.dataset.state).toBe('normal');
    expect(q(el, 'staging-bar')).toBeNull();
    expect(el.querySelector('[data-testid^="ambiguity-chooser"]')).toBeNull();
  }, 20_000);

  it('one tap of "Let it happen" ends the game: Alice wins with the 10♥', async () => {
    const store = await blakeDeciding();
    const el = render(store);
    await settle();
    await click(el, 'let-it-happen');
    expect(store.curtain).toEqual({ kind: 'result' });
    expect(store.view?.winner).toBe(0);
    expect(winningMoveLine(store.history, 0, NAMES, 23)).toBe('Alice won by reaching 23 with the 10♥, from the top of the deck.');
  }, 20_000);

  it('dragging the 2 onto the marker counters at once: Blake plays on, no curtain', async () => {
    const store = await blakeDeciding();
    const el = render(store);
    await settle();
    await drag(el, 0, q(el, 'counter-link'));
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    expect(store.view?.winner).toBeNull();
    expect(lastMoveLine(store.history, 1, NAMES)).toBe("You countered with 2♣ and undid Alice's last turn.");
    expect(q(el, 'let-it-happen')).toBeNull();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// C7: the owed discard
// ---------------------------------------------------------------------------

function owed(): LessonPosition {
  return {
    aliceHand: [c(4, 'S'), c(9, 'H')],
    alicePoints: [],
    blakeHand: [c(2, 'C'), c(7, 'D'), c(13, 'C')],
    blakePoints: [],
    scrap: [],
    deckTop: [c(5, 'C'), c(6, 'C')],
  };
}

async function blakeOwing(): Promise<GameStore> {
  const store = await startAt(owed());
  await store.apply(indexOf(store, isOneOff(c(4, 'S')), 'Alice 4♠'));
  await pass(store);
  expect(store.view?.phase).toBe(Phase.AwaitingDiscard);
  return store;
}

describe('C7: the owed discard (issue #93, SPEC §4.3)', () => {
  it('the picker shows; paying two plays on in the same turn with no curtain', async () => {
    const store = await blakeOwing();
    const el = render(store);
    await settle();
    expect(q(el, 'discard-picker')).not.toBeNull();
    expect(q(el, 'counter-link')?.dataset.state).toBe('normal');
    await click(el, 'hand-card-1');
    await click(el, 'hand-card-2');
    await click(el, 'staging-confirm');
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    expect(q(el, 'board')).not.toBeNull();
    expect(q(el, 'discard-picker')).toBeNull();
  }, 20_000);

  it('picking the 2 lights the marker beside the picker', async () => {
    const store = await blakeOwing();
    const el = render(store);
    await settle();
    await click(el, 'hand-card-0');
    expect(q(el, 'discard-picker')).not.toBeNull();
    expect(q(el, 'counter-link')?.dataset.state).toBe('highlighted');
  }, 20_000);

  it('dragging the 2 onto the marker counters the 4: no debt, no curtain, Blake plays on', async () => {
    const store = await blakeOwing();
    const el = render(store);
    await settle();
    await drag(el, 0, q(el, 'counter-link'));
    expect(store.curtain).toEqual({ kind: 'none' });
    expect(store.view?.active).toBe(1);
    expect(store.view?.phase).toBe(Phase.Normal);
    expect(store.view?.owedDiscards).toEqual({ you: 0, opponent: 0 });
    expect(q(el, 'discard-picker')).toBeNull();
  }, 20_000);

  it('a card without a Counter still can\'t be dragged at the discard', async () => {
    const store = await blakeOwing();
    const el = render(store);
    await settle();
    const seq = store.seq;
    await drag(el, 1, q(el, 'counter-link'));
    expect(store.seq).toBe(seq);
    expect(store.view?.phase).toBe(Phase.AwaitingDiscard);
  }, 20_000);
});
