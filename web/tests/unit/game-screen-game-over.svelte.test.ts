// @vitest-environment jsdom
// Tutorial spike T1 (docs/tutorial-plan.md §6, builder's call B6): does the
// board survive `PhaseGameOver` at curtain `none`?
//
// The tutorial's lesson 1 ends on a winning move, and the tutorial table
// shows `view(0)` straight afterwards at curtain `none`, with no result
// screen. This test builds lesson 1's position as a literal snapshot
// (tutorial-design §5.2, §6.1), restores it through the REAL wasm bridge,
// plays the winning PlayPoint of the 9 of diamonds, and mounts the real
// GameScreen on that game-over envelope. Light tier: render and inertness
// only. No production change.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, restore, view } from '../../src/lib/bridge/engine';
import type { Card, Envelope } from '../../src/lib/bridge/schema';
import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { session } from '../../src/lib/stores/session.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';
import { createWasmEngine } from '../scenario/wasm-engine';
import { FakeTableSource } from './fake-table-source.svelte';
import { Kind, Phase } from './game-test-support';

// Suits: 0 clubs, 1 diamonds, 2 hearts, 3 spades. Ranks: 1 ace .. 13 king.
const C = 0;
const D = 1;
const H = 2;
const S = 3;
const card = (Rank: number, Suit: number): Card => ({ Rank, Suit }) as Card;

const ALICE_HAND = [card(9, D), card(4, S), card(2, C)];
const BLAKE_HAND = [card(3, D), card(6, S), card(11, C), card(12, D), card(8, H)];
const ALICE_POINTS = [card(7, H), card(5, C)];
const BLAKE_POINTS = [card(10, S)];
const SCRAP = [card(13, C), card(4, H)];

/** The 39 cards nobody holds, in a fixed order. */
function restOfDeck(): Card[] {
  const used = new Set([...ALICE_HAND, ...BLAKE_HAND, ...ALICE_POINTS, ...BLAKE_POINTS, ...SCRAP].map((c) => `${c.Rank}:${c.Suit}`));
  const deck: Card[] = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 1; rank <= 13; rank++) {
      if (!used.has(`${rank}:${suit}`)) deck.push(card(rank, suit));
    }
  }
  return deck;
}

function pointEntry(c: Card, owner: 0 | 1) {
  return { Card: c, Owner: owner, JackStack: null, JackOwners: null };
}

/** Lesson 1's position as the bridge's own snapshot string (tutorial-design §6.1). */
function lessonOneSnapshot(): string {
  const deck = restOfDeck();
  expect(deck).toHaveLength(39);
  const all = [...ALICE_HAND, ...BLAKE_HAND, ...ALICE_POINTS, ...BLAKE_POINTS, ...SCRAP, ...deck];
  expect(new Set(all.map((c) => `${c.Rank}:${c.Suit}`)).size).toBe(52);
  return JSON.stringify({
    ok: true,
    v: 2,
    state: {
      Players: [
        { Hand: ALICE_HAND, Points: ALICE_POINTS.map((c) => pointEntry(c, 0)), Permanents: null, FrozenIDs: null },
        { Hand: BLAKE_HAND, Points: BLAKE_POINTS.map((c) => pointEntry(c, 1)), Permanents: null, FrozenIDs: null },
      ],
      Deck: deck,
      Scrap: SCRAP,
      Active: 0,
      Phase: 0,
      Pending: null,
      PassesInARow: 0,
      Winner: null,
    },
    history: [],
    seed: '0',
    dealer: 1,
  });
}

function must(result: ReturnType<typeof view>): Envelope {
  if (!result.ok) throw new Error(`bridge error: ${JSON.stringify(result)}`);
  return result;
}

/** Alice's post-win envelope, built through the real bridge. */
function gameOverEnvelope(): Envelope {
  const before = must(restore(lessonOneSnapshot(), 0));
  expect(before.state.phase).toBe(Phase.Normal);
  const index = before.legalMoves.findIndex((m) => m.Kind === Kind.PlayPoint && m.Card?.Rank === 9 && m.Card.Suit === D);
  expect(index).toBeGreaterThanOrEqual(0);
  must(apply(index));
  const after = must(view(0));
  expect(after.state.phase).toBe(Phase.GameOver);
  expect(after.state.winner).toBe(0);
  return after;
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(source: FakeTableSource): HTMLDivElement {
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

async function click(el: HTMLElement): Promise<void> {
  el.click();
  await settle();
}

/** A source at curtain `none` showing the post-win envelope. `goHome` is counted. */
class HomeCountingSource extends FakeTableSource {
  homeCalls = 0;
  override goHome(): void {
    this.homeCalls++;
  }
}

let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await createWasmEngine();
});

beforeEach(() => {
  session.setNames('Alice', 'Blake');
  settings.revealPreference = 'two-step';
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errors.mockRestore();
  warns.mockRestore();
});

describe('T1 / B6: the board at PhaseGameOver under curtain none', () => {
  it('mounts cleanly and renders the finished position', async () => {
    const env = gameOverEnvelope();
    const source = new HomeCountingSource();
    source.push(env);
    render(source);
    await settle();

    // The board is in the DOM and shows both sides.
    expect(q('board')).not.toBeNull();
    expect(q('player-hand')).not.toBeNull();
    expect(q('opp-hand')).not.toBeNull();
    expect(q('deck-pile')).not.toBeNull();
    expect(q('menu-button')).not.toBeNull();
    expect(host?.querySelectorAll('[data-testid^="hand-card-"]').length).toBe(env.state.you.hand.length);

    // Nothing logged an error while mounting or flushing.
    expect(errors).not.toHaveBeenCalled();
  });

  it('is inert: no Pass, no staging bar, deck not lit, and no hand card stages a move', async () => {
    const env = gameOverEnvelope();
    expect(env.legalMoves).toEqual([]);
    const source = new HomeCountingSource();
    source.push(env);
    render(source);
    await settle();

    expect(q('pass')).toBeNull();
    expect(q('staging-bar')).toBeNull();
    expect(q('staging-confirm')).toBeNull();
    expect(q('deck-pile')?.getAttribute('data-state')).not.toBe('highlighted');
    expect(q('deck-pile')?.getAttribute('data-disabled')).toBe('true');

    const cards = [...host!.querySelectorAll<HTMLElement>('[data-testid^="hand-card-"]')];
    expect(cards.length).toBeGreaterThan(0);
    for (const el of cards) {
      await click(el);
      expect(q('staging-confirm')).toBeNull();
      expect(q('staging-bar')).toBeNull();
    }

    // The deck and the scrap take a tap without staging or throwing.
    await click(q('deck-pile')!);
    expect(q('staging-confirm')).toBeNull();

    expect(source.applied).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps the menu working: it opens, and Home calls goHome', async () => {
    const source = new HomeCountingSource();
    source.push(gameOverEnvelope());
    render(source);
    await settle();

    await click(q('menu-button')!);
    expect(q('menu-home')).not.toBeNull();
    expect(q('menu-button')?.getAttribute('aria-expanded')).toBe('true');

    await click(q('menu-home')!);
    expect(source.homeCalls).toBe(1);
    expect(source.applied).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});
