// @vitest-environment jsdom
// W24, strict tier (hidden information, R7 / SPEC §3.2). Both directions of
// the glasses-8 reveal, through the REAL wasm bridge, the real game store and
// the real GameScreen:
//
//   1. The glasses owner's opponent (no glasses of their own) is at the
//      board. The glasses owner's hand is known to the test; not one of
//      those cards may appear anywhere: not in any face in the DOM, not in
//      the serialized DOM, not in the test hook, not in the store's view.
//      That board DOES show the watched marker (public: the 8 is on the
//      table).
//   2. The glasses owner is at the board. The opponent's hand renders face
//      up, card for card, in the opponent-hand slot.
//
// Red evidence (docs/loop-workflow.md §4.5): direction 1 was shown red with
// a hand-applied mutant that dropped the viewerHasGlasses gate in the
// bridge's view builder (every opponent hand visible), direction 2 with a
// mutant that always rendered backs in OpponentHand. Both reverted.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Card, PlayerId } from '../../src/lib/bridge/schema';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind } from './game-test-support';

const { default: GameScreen } = await import('../../src/lib/components/GameScreen.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');

const NAMES: [string, string] = ['Alice', 'Blake'];
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const GLYPHS = [0x2663, 0x2666, 0x2665, 0x2660].map((cp) => String.fromCodePoint(cp));

/** "8" + heart glyph, etc. — how the vector face and the engine's descriptions name a card. */
function label(c: Card): string {
  return `${RANKS[c.Rank]}${GLYPHS[c.Suit]}`;
}

function id(c: Card): string {
  return `${c.Rank}/${c.Suit}`;
}

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function mountScreen(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

async function toBoard(): Promise<void> {
  for (let i = 0; i < 8 && game.curtain.kind !== 'none'; i++) await game.advanceCurtain();
  expect(game.curtain.kind).toBe('none');
}

/** Every standard face in the DOM, as a rank/suit identity. */
function faceIdentities(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const face of root.querySelectorAll<HTMLElement>('[data-state]')) {
    const rank = face.querySelector('.cuttle-card-face__rank')?.textContent ?? '';
    const suit = face.querySelector('.cuttle-card-face__suit')?.textContent ?? '';
    const r = RANKS.indexOf(rank);
    const s = GLYPHS.indexOf(suit);
    if (r > 0 && s >= 0) out.push(`${r}/${s}`);
  }
  return out;
}

interface GlassesPosition {
  owner: PlayerId;
  /** The glasses owner's hand after playing the 8: the cards that must stay hidden. */
  ownerHand: Card[];
}

/** Deals seeds until the first player can play an 8 as glasses, plays it, and hands the phone over. */
async function playGlassesFromADeal(): Promise<GlassesPosition> {
  for (let seed = 1; seed <= 300; seed++) {
    await game.newGame({ seed: String(seed), dealer: 0 });
    await toBoard();
    const env = game.envelope!;
    const index = env.legalMoves.findIndex((m) => m.Kind === Kind.PlayPermanent && m.Card?.Rank === 8);
    if (index < 0) continue;
    const owner = env.state.viewer;
    const eight = env.legalMoves[index].Card!;
    const ownerHand = env.state.you.hand.filter((c) => id(c) !== id(eight));
    expect(ownerHand.length).toBeGreaterThan(0);
    await game.apply(index);
    await toBoard();
    expect(game.viewer).toBe(1 - owner);
    return { owner, ownerHand };
  }
  throw new Error('no seed in 1..300 lets the first player play glasses');
}

beforeAll(async () => {
  await createWasmEngine();
  session.setNames(...NAMES);
});

describe('R7: the glasses-8 reveal, both directions, through the real bridge', () => {
  it('without glasses, the viewer sees none of the opponent hand anywhere; with glasses, it is face up card for card', async () => {
    const { owner, ownerHand } = await playGlassesFromADeal();
    const watcher = (1 - owner) as PlayerId;

    // ── Direction 1: the watcher (no glasses) is at the board. ──────────
    let el = mountScreen();
    const view = game.view!;
    expect(view.viewer).toBe(watcher);
    expect(view.you.permanents.some((c) => c.Rank === 8)).toBe(false);
    expect(view.opponent.permanents.some((c) => c.Rank === 8)).toBe(true);
    expect(view.opponent.hand).toBeNull();
    expect(view.opponent.handCount).toBe(ownerHand.length);

    const oppHand = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
    expect(oppHand.getAttribute('data-revealed')).toBe('false');
    expect(oppHand.querySelectorAll('[data-state]').length).toBe(0);
    expect(oppHand.querySelectorAll('.opponent-hand__card').length).toBe(ownerHand.length);

    const hidden = new Set(ownerHand.map(id));
    const shown = faceIdentities(document.body);
    expect(shown.length).toBeGreaterThan(0); // the watcher's own hand, at least
    expect(shown.filter((s) => hidden.has(s))).toEqual([]);

    const html = document.body.innerHTML;
    const text = document.body.textContent ?? '';
    for (const c of ownerHand) {
      expect(html).not.toContain(label(c));
      expect(text).not.toContain(label(c));
    }

    const hook = window.__cuttleTestHook!;
    expect(hook).toBeDefined();
    const hookDump = JSON.stringify({ moves: hook.moves(), affordances: hook.affordances() });
    for (const c of ownerHand) expect(hookDump).not.toContain(label(c));

    const viewDump = JSON.stringify(game.envelope);
    for (const c of ownerHand) expect(viewDump).not.toContain(`{"Rank":${c.Rank},"Suit":${c.Suit}}`);

    // Public: the watcher is told they are watched.
    expect(el.querySelector('.watched-marker')?.textContent).toContain(`${NAMES[owner]} can see your hand`);

    // The watcher draws and hands the phone back.
    const watcherHandBefore = view.you.hand.map(id);
    const draw = game.envelope!.legalMoves.findIndex((m) => m.Kind === Kind.Draw);
    expect(draw).toBeGreaterThanOrEqual(0);
    unmount(instance!);
    host!.remove();
    instance = undefined;
    await game.apply(draw);
    await toBoard();
    expect(game.viewer).toBe(owner);

    // ── Direction 2: the glasses owner is at the board. ─────────────────
    el = mountScreen();
    const ownerView = game.view!;
    expect(ownerView.opponent.hand).not.toBeNull();
    const revealed = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
    expect(revealed.getAttribute('data-revealed')).toBe('true');
    const faceUp = faceIdentities(revealed);
    expect(faceUp).toEqual(ownerView.opponent.hand!.map(id));
    expect(faceUp.length).toBe(ownerView.opponent.handCount);
    for (const c of watcherHandBefore) expect(faceUp).toContain(c);
    // The owner is not watched (the watcher has no glasses).
    expect(el.querySelector('.watched-marker')).toBeNull();
  }, 30_000);
});
