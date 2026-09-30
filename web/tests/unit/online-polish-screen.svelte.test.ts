// @vitest-environment jsdom
// Two-phone W13b: ONE mounted GameScreen driven by a real OnlineGameStore over
// the W11 connection and a FakeSocket; the test plays the server. Covers the
// styled status and notice lines, the "responding" and "waiting" panels, the
// waiting line, the missed-moves recap (and its privacy), and the stuck screen.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedMove, Card, Envelope, Move, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import ResultScreen from '../../src/lib/components/ResultScreen.svelte';
import { createConnection } from '../../src/lib/online/connection';
import { SEAT_STORAGE_KEY, loadSeat, type SeatRecord } from '../../src/lib/online/seat';
import { OnlineGameStore } from '../../src/lib/stores/onlineGame.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { Kind, Phase, appliedMove, envelope, fakeStorage, playerView } from './game-test-support';
import { CODE, FakeEnvironment, ORIGIN, TOKEN, socketFactory } from './online-fakes';

const c = (Rank: number, Suit: number) => ({ Rank, Suit }) as Card;
// Suits: 0 ♣, 1 ♦, 2 ♥, 3 ♠ (SPEC §2.5).
const ACE_S = c(1, 3);
const FIVE_D = c(5, 1);
const FIVE_H = c(5, 2);
const SEVEN_H = c(7, 2);
const THREE_D = c(3, 1);
const NINE_S = c(9, 3);
const QUEEN_H = c(12, 2);
const TEN_H = c(10, 2);
const KING_S = c(13, 3);

function mv(overrides: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...overrides };
}

function draws(n: number): AppliedMove[] {
  return Array.from({ length: n }, (_, i) => appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'draw a card', seq: i + 1, ...(i % 2 === 0 ? { index: 0 } : {}) }));
}

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerView({
    viewer: 0,
    active: 0,
    you: { hand: [ACE_S, FIVE_D], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 5, hand: null, points: [], permanents: [] },
    ...overrides,
  });
}

/** Alice (seat 0) to act: Draw, or the A♠ as a one-off. */
function aliceToAct(history = draws(2), overrides: Partial<PlayerView> = {}): Envelope {
  return envelope({
    state: view(overrides),
    history,
    legalMoves: [mv({ Kind: Kind.Draw }), mv({ Kind: Kind.OneOff, HandIndex: 0, Card: ACE_S })],
    descriptions: ['draw a card', 'play A♠ as one-off'],
  });
}

function stateFrame(env: Envelope, game = 1) {
  return { t: 'state', game, envelope: env, opponentOnline: true, tally: [0, 0] };
}

const WELCOME = { t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' };

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;
let store: OnlineGameStore | undefined;

function setup() {
  cleanup();
  const sockets = socketFactory();
  const env = new FakeEnvironment();
  const storage = fakeStorage();
  const left: (string | null)[] = [];
  store = new OnlineGameStore({
    connect: (o) => createConnection({ ...o, socketFactory: sockets.factory, environment: env, random: () => 0.5 }),
    seatStorage: storage,
    onLeave: (notice) => left.push(notice),
  });
  const record: SeatRecord = { v: 1, server: ORIGIN, code: CODE, seat: 0, token: TOKEN, names: ['Alice', 'Blake'] };
  storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
  store.attach(record);
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host, props: { source: store } });
  flushSync();
  const send = async (frame: unknown) => {
    sockets.last.serverSend(frame);
    await settle();
  };
  return { store, sockets, env, storage, left, send };
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
  store?.detach();
  store = undefined;
}

function q(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function click(id: string): Promise<void> {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  el.click();
  await settle();
}

/**
 * Every card token ("7♥", "10♠") a piece of text names, sentences and card
 * faces alike (a face renders its rank and suit as separate spans, so the
 * whitespace between them is dropped first).
 */
function tokens(text: string | null | undefined): string[] {
  return (text ?? '').replace(/\s+(?=[♣♦♥♠])/g, '').match(/(?:10|[2-9AJQK])[♣♦♥♠]/g) ?? [];
}

beforeEach(() => {
  vi.useFakeTimers();
  session.setNames('Player 1', 'Player 2');
  settings.setTableMode(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('W13b: the responding and waiting panels', () => {
  it('the waiting panel stands in until the first state', async () => {
    const { sockets } = setup();
    expect(q('online-waiting')?.textContent).toContain('Waiting for the game');
    sockets.last.serverOpen();
    await settle();
    expect(q('board')).toBeNull();
  });

  it('the hold shows "Blake is responding…" with the card Alice played, and no board', async () => {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(aliceToAct()));
    await store?.apply(1); // the A♠ as a one-off, as Confirm would send it
    await settle();
    await send({ t: 'responding', by: 1 });
    const panel = q('online-responding');
    expect(panel?.textContent).toContain('Blake is responding…');
    expect(new Set(tokens(panel?.textContent))).toEqual(new Set(['A♠']));
    expect(q('board')).toBeNull();
    await send(stateFrame(envelope({ state: view({ active: 1 }), history: draws(3) })));
    expect(q('online-responding')).toBeNull();
  });
});

describe('W13b: status, notice and waiting lines', () => {
  it('the status line carries its tone: warn for this phone, info for the opponent', async () => {
    const { sockets, env, send } = setup();
    expect(q('online-status')?.getAttribute('data-tone')).toBe('warn');
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(aliceToAct()));
    expect(q('online-status')).toBeNull();
    await send({ t: 'presence', opponentOnline: false });
    expect(q('online-status')?.textContent).toContain('Blake is offline.');
    expect(q('online-status')?.getAttribute('data-tone')).toBe('info');
    env.goOffline();
    await settle();
    expect(q('online-status')?.textContent).toContain('You’re offline. Online games need a connection.');
    expect(q('online-status')?.getAttribute('data-tone')).toBe('warn');
  });

  it('a notice has its own line', async () => {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(aliceToAct()));
    await send({ t: 'error', code: 'RATE_LIMITED', message: 'x' });
    expect(q('online-notice')?.textContent).toContain('Too many tries');
    expect(q('online-notice')?.getAttribute('data-tone')).toBe('notice');
  });

  it('the action bar says what Blake is doing while Alice waits on a discard or a 7', async () => {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(envelope({ state: view({ active: 1, phase: Phase.AwaitingDiscard }), history: draws(3) })));
    expect(q('online-waiting-on')?.textContent).toBe('Blake is choosing what to discard.');
    await send(stateFrame(envelope({ state: view({ active: 1, phase: Phase.Normal }), history: draws(4) })));
    expect(q('online-waiting-on')).toBeNull();
    await send(stateFrame(envelope({ state: view({ active: 1, phase: Phase.SevenChoosing }), history: draws(5) })));
    expect(q('online-waiting-on')?.textContent).toBe('Blake is choosing from the 7.');
  });
});

/** The previous state at seq 2, then a reconnect's state: Alice's in-flight draw (3), then `blake` (4…). */
async function jump(blake: AppliedMove[], after: Partial<PlayerView> = {}, before: Partial<PlayerView> = {}) {
  const s = setup();
  s.sockets.last.serverOpen();
  await s.send(WELCOME);
  await s.send(stateFrame(aliceToAct(draws(2), before)));
  const history = [...draws(2), appliedMove({ by: 0, kind: Kind.Draw, description: 'draw a card', seq: 3, index: 0 }), ...blake];
  await s.send(stateFrame(aliceToAct(history, after)));
  return s;
}

describe('W13b: the missed-moves recap', () => {
  it('shows Blake’s missed moves beside the board, never over it, and closes on Got it', async () => {
    await jump([appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 4 })]);
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('While you were away');
    expect(recap?.textContent).toContain('Blake played 7♥ for points.');
    // Alice's own draw is not recapped.
    expect(recap?.textContent).not.toContain('You drew');
    // Non-blocking: the board is live under it.
    expect(q('board')).not.toBeNull();
    expect(q('board')?.getAttribute('data-inert')).toBe('false');
    await click('online-recap-dismiss');
    expect(q('online-recap')).toBeNull();
  });

  it('shows the last 6, with "+N earlier" for the rest', async () => {
    const blake = Array.from({ length: 8 }, (_, i) => appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 4 + i }));
    await jump(blake);
    // Closed: the heading with the count, and only the latest line.
    expect(q('online-recap')?.textContent).toContain('8 moves');
    expect(q('online-recap')?.querySelectorAll('li')).toHaveLength(0);
    expect(q('online-recap')?.textContent?.match(/Blake drew a card\./g)).toHaveLength(1);
    await click('online-recap-toggle');
    expect(q('online-recap')?.querySelectorAll('li')).toHaveLength(6);
    expect(q('online-recap-expand')?.textContent).toContain('+2 earlier');
    await click('online-recap-expand');
    expect(q('online-recap')?.querySelectorAll('li')).toHaveLength(8);
  });

  it('an entry the formatter can’t read is skipped on its own; the others still show', async () => {
    await jump([
      appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 4 }),
      appliedMove({ by: 1, kind: Kind.PlayPoint, description: 'something the engine never says', seq: 5 }),
      appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 6 }),
    ]);
    await click('online-recap-toggle');
    const items = [...(q('online-recap')?.querySelectorAll('li') ?? [])].map((li) => li.textContent?.trim() ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Blake played 7♥ for points.');
    expect(items[1]).toContain('Blake drew a card.');
    expect(q('online-recap')?.textContent).not.toContain('something the engine never says');
  });

  it('a one-step state shows no recap', async () => {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(aliceToAct()));
    await send(stateFrame(aliceToAct([...draws(2), appliedMove({ by: 1, kind: Kind.PlayPoint, card: SEVEN_H, description: 'play 7♥ as point card', seq: 3 })])));
    expect(q('online-recap')).toBeNull();
  });
});

// Strict tier: the recap names only what Alice's own frames showed her, as
// SPEC §3.2 and §4.6 allow. Each case plants a card Alice may not see where a
// careless recap could pick it up, and checks every card token the panel
// shows against the cards the entries name in public.
describe('W13b privacy: the recap never names a hidden card', () => {
  it('Blake’s draw: a count, never the card, even if an entry carried one', async () => {
    // The wire's Draw entry has card: null; K♠ here is a card Alice can't see.
    await jump([appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 4, card: KING_S })]);
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake drew a card.');
    expect(tokens(recap?.textContent)).toEqual([]);
  });

  it('Blake’s 5: says what a 5 does, never `drawn` and never the cards', async () => {
    // drawn: 1 (a nearly empty deck), so a line that read `drawn` would say so.
    await jump(
      [appliedMove({ by: 1, kind: Kind.OneOff, card: FIVE_H, description: 'play 5♥ as one-off', seq: 4, drawn: 1 })],
      { opponent: { handCount: 7, hand: null, points: [], permanents: [] } },
    );
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake played 5♥ as a one-off to draw 2 cards.');
    expect(recap?.textContent).not.toMatch(/\b1 card|drew 1/);
    expect(new Set(tokens(recap?.textContent))).toEqual(new Set(['5♥']));
  });

  // Glasses (SPEC §3.2): with an 8 in her permanents Alice sees Blake's hand,
  // on the board. The recap still names only what the entries name in public.
  const EIGHT_D = c(8, 1);
  const NINE_C = c(9, 0);
  const BLAKE_HAND = [c(13, 0), c(12, 3), c(4, 2)];

  it('a jump that takes Alice’s glasses away names only the 9 and the 8, never Blake’s hand she saw', async () => {
    await jump(
      [appliedMove({ by: 1, kind: Kind.OneOff, card: NINE_C, description: 'play 9♣ as one-off', seq: 4, targetCard: EIGHT_D })],
      {
        you: { hand: [ACE_S, FIVE_D, EIGHT_D], frozenHandIndices: [2], points: [], permanents: [], watched: false },
        opponent: { handCount: 2, hand: null, points: [], permanents: [] },
      },
      {
        you: { hand: [ACE_S, FIVE_D], frozenHandIndices: [], points: [], permanents: [EIGHT_D], watched: false },
        opponent: { handCount: 3, hand: BLAKE_HAND, points: [], permanents: [] },
      },
    );
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake played 9♣ as a one-off, targeting 8♦.');
    expect(new Set(tokens(recap?.textContent))).toEqual(new Set(['9♣', '8♦']));
  });

  it('a jump into glasses (Alice’s own 8 landed) recaps Blake’s draw as a count, though his hand is now in view', async () => {
    const drawn = c(6, 3);
    await jump(
      [appliedMove({ by: 1, kind: Kind.Draw, description: 'draw a card', seq: 4 })],
      {
        you: { hand: [ACE_S, FIVE_D], frozenHandIndices: [], points: [], permanents: [EIGHT_D], watched: false },
        opponent: { handCount: 4, hand: [...BLAKE_HAND, drawn], points: [], permanents: [] },
      },
    );
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake drew a card.');
    expect(tokens(recap?.textContent)).toEqual([]);
  });

  it('Blake’s 3: never names the card it took from the scrap', async () => {
    // Before: 7♥ sat in the scrap (public). After: it is in Blake's hidden hand.
    // A stray mover-only index on Blake's entry is planted too; it must not help.
    await jump(
      [appliedMove({ by: 1, kind: Kind.OneOff, card: THREE_D, description: 'play 3♦ as one-off', seq: 4, index: 0 })],
      { scrap: [THREE_D], opponent: { handCount: 5, hand: null, points: [], permanents: [] } },
      { scrap: [SEVEN_H] },
    );
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake played 3♦ as a one-off to take a card from the scrap.');
    expect(new Set(tokens(recap?.textContent))).toEqual(new Set(['3♦']));
    expect(recap?.innerHTML).not.toContain('7♥');
  });

  it('Blake’s 9: names the 9 and the board card it sent back, nothing from a hand', async () => {
    await jump(
      [appliedMove({ by: 1, kind: Kind.OneOff, card: NINE_S, description: 'play 9♠ as one-off', seq: 4, targetCard: QUEEN_H })],
      { you: { hand: [ACE_S, FIVE_D, QUEEN_H], frozenHandIndices: [2], points: [], permanents: [], watched: false } },
      { you: { hand: [ACE_S, FIVE_D], frozenHandIndices: [], points: [], permanents: [QUEEN_H], watched: false } },
    );
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake played 9♠ as a one-off, targeting Q♥.');
    expect(new Set(tokens(recap?.textContent))).toEqual(new Set(['9♠', 'Q♥']));
    // Nothing of Alice's hand beyond the returned card, which was on the board.
    expect(recap?.textContent).not.toContain('A♠');
    expect(recap?.textContent).not.toContain('5♦');
  });

  it('Blake’s 7: names the played card only, never the one that went back', async () => {
    await jump([appliedMove({ by: 1, kind: Kind.SevenPick, subKind: Kind.PlayPoint, card: TEN_H, description: '7: play 10♥ as point card', seq: 4 })]);
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake revealed the top of the deck and played 10♥ for points.');
    expect(new Set(tokens(recap?.textContent))).toEqual(new Set(['10♥']));
  });

  it('Blake’s discard: a count, no hand positions', async () => {
    await jump([appliedMove({ by: 1, kind: Kind.DiscardPair, description: 'discard hand[0] and hand[3]', seq: 4 })]);
    const recap = q('online-recap');
    expect(recap?.textContent).toContain('Blake discarded 2 cards.');
    expect(recap?.textContent).not.toContain('[');
    expect(tokens(recap?.textContent)).toEqual([]);
  });

  it('a Decline is never shown', async () => {
    await jump([
      appliedMove({ by: 1, kind: Kind.OneOff, card: FIVE_H, description: 'play 5♥ as one-off', seq: 4 }),
      appliedMove({ by: 0, kind: Kind.Decline, description: 'decline to counter', seq: 5, index: 0, drawn: 2 }),
    ]);
    expect(q('online-recap')?.textContent).not.toMatch(/resolve|decline/i);
  });
});

// SPEC §2.12.5: after Alice's one-off, Blake may hold a 2 and decline, or
// hold none (no window). The screen after the hold must be the same.
describe('W13b privacy: no hold tell after the hold', () => {
  async function afterHold(declined: boolean): Promise<string> {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(aliceToAct()));
    await store?.apply(1);
    await send({ t: 'responding', by: 1 });
    const mine = appliedMove({ by: 0, kind: Kind.OneOff, card: ACE_S, description: 'play A♠ as one-off', seq: 3, index: 1 });
    const history = declined
      ? [...draws(2), mine, appliedMove({ by: 1, kind: Kind.Decline, description: 'decline to counter', seq: 4 })]
      : [...draws(2), mine];
    await send(stateFrame(envelope({ state: view({ active: 1, you: { hand: [FIVE_D], frozenHandIndices: [], points: [], permanents: [], watched: false } }), history })));
    expect(q('online-recap')).toBeNull();
    expect(q('online-responding')).toBeNull();
    return q('game-screen')?.innerHTML ?? '';
  }

  it('the declined path and the no-window path render the same screen', async () => {
    const noWindow = await afterHold(false);
    const declined = await afterHold(true);
    expect(noWindow).not.toBe('');
    expect(declined).toBe(noWindow);
  });
});

describe('W13b: the stuck screen (SPEC §2.10)', () => {
  it('replaces the board after ILLEGAL_MOVE: plain words, game and move, the moves so far, one way on', async () => {
    const { sockets, send, storage, left } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    const history = [
      ...draws(2),
      appliedMove({ by: 1, kind: Kind.OneOff, card: FIVE_H, description: 'play 5♥ as one-off', seq: 3 }),
      appliedMove({ by: 0, kind: Kind.Decline, description: 'decline to counter', seq: 4, index: 0, drawn: 2 }),
    ];
    await send(stateFrame(aliceToAct(history), 2));
    await click('deck-pile');
    await click('staging-confirm');
    await send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'illegal move: play K♠' });
    const stuck = q('online-stuck');
    expect(stuck).not.toBeNull();
    expect(q('board')).toBeNull();
    expect(stuck?.textContent).toContain('This game can’t go on');
    expect(stuck?.textContent).toContain('Game 2');
    expect(stuck?.textContent).toContain('move 4');
    expect(stuck?.textContent).toContain('ILLEGAL_MOVE');
    expect(stuck?.textContent).toContain('Blake played 5♥ as a one-off to draw 2 cards.');
    // Never the server's message, never a Decline (the hold's tell), never a seed.
    expect(stuck?.textContent).not.toContain('K♠');
    expect(stuck?.textContent).not.toMatch(/resolve|decline|seed/i);
    // No retry: nothing more is sent.
    expect(sockets.sockets.flatMap((s) => s.frames()).filter((f) => f.t === 'move')).toHaveLength(1);
    await click('online-leave-game');
    expect(loadSeat(storage)).toBeNull();
    expect(left).toEqual([null]);
  });

  it('a counter window that offers nothing is stuck too, and the prompt does not mount', async () => {
    const { sockets, send } = setup();
    sockets.last.serverOpen();
    await send(WELCOME);
    await send(stateFrame(envelope({ state: view({ phase: Phase.AwaitingCounter }), history: draws(3) })));
    expect(q('online-stuck')?.textContent).toContain('NO_LEGAL_MOVES');
    expect(q('counter-prompt')).toBeNull();
  });
});

describe('W13b: the online result’s rematch line', () => {
  let rhost: HTMLDivElement | undefined;
  let rinstance: ReturnType<typeof mount> | undefined;

  afterEach(() => {
    if (rinstance) unmount(rinstance);
    rhost?.remove();
    rinstance = undefined;
    rhost = undefined;
  });

  function renderResult(props: Record<string, unknown>) {
    rhost = document.createElement('div');
    document.body.append(rhost);
    const onRematch = vi.fn();
    rinstance = mount(ResultScreen, {
      target: rhost,
      props: { state: { winner: 0, stalemate: false }, names: ['Alice', 'Blake'], tally: { 0: 1, 1: 0 }, onRematch, ...props },
    });
    flushSync();
    return { onRematch, get: (id: string) => rhost?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null };
  }

  it('waiting for Blake: the line says so and Rematch is spent', () => {
    const r = renderResult({ rematchStatus: 'Waiting for Blake…', rematchWaiting: true });
    expect(r.get('online-rematch-status')?.textContent).toContain('Waiting for Blake…');
    expect((r.get('rematch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Blake asked: the line says so and Rematch accepts', () => {
    const r = renderResult({ rematchStatus: 'Blake wants a rematch.' });
    expect(r.get('online-rematch-status')?.textContent).toContain('Blake wants a rematch.');
    r.get('rematch')?.click();
    expect(r.onRematch).toHaveBeenCalledTimes(1);
  });

  it('pass-and-play has no rematch line', () => {
    const r = renderResult({});
    expect(r.get('online-rematch-status')).toBeNull();
    expect((r.get('rematch') as HTMLButtonElement).disabled).toBe(false);
  });
});
