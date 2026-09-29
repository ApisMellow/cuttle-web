// @vitest-environment jsdom
// ROADMAP "Card labels", strict tier: a King in play wears the points its
// owner now needs to win. That number is the engine's, never the UI's:
// github.com/ApisMellow/cuttle@v0.2.0 engine/win.go
//
//   func Threshold(kings int) int {
//     case kings <= 0: 21; kings == 1: 14; kings == 2: 10; kings == 3: 7; default: 5
//   }
//
// Through the REAL wasm bridge: a fresh deal is snapshotted, all four Kings
// are moved into the two players' permanents (k for Alice, 4 - k for Blake,
// k = 0..4), the state is restored, and each viewer's envelope is rendered
// by the real Board. Every King badge must read "Goal N" where N is both the
// bridge's `scoreboard.*.threshold` for that King's side and win.go's table
// for that many Kings; a side with no King shows no goal badge at all.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { restore, snapshot, view } from '../../src/lib/bridge/engine';
import type { Envelope, PlayerId } from '../../src/lib/bridge/schema';
import Board from '../../src/lib/components/Board.svelte';
import { getTheme } from '../../src/lib/theme';
import { createWasmEngine } from '../scenario/wasm-engine';

/** engine/win.go Threshold, v0.2.0, indexed by King count. */
const ENGINE_THRESHOLD = [21, 14, 10, 7, 5] as const;

interface WireCard {
  Rank: number;
  Suit: number;
}

interface WireState {
  Players: Array<{ Hand: WireCard[] | null; Permanents: WireCard[] | null }>;
  Deck: WireCard[] | null;
  Scrap: WireCard[] | null;
}

let engine: Awaited<ReturnType<typeof createWasmEngine>>;

beforeAll(async () => {
  engine = await createWasmEngine();
});

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

const isKing = (c: WireCard): boolean => c.Rank === 13;

/** A real deal with every King moved into play: `aliceKings` for Alice, the rest for Blake. */
function dealWithKings(aliceKings: number): void {
  engine.newGame({ seed: '7', dealer: 1, names: ['Alice', 'Blake'] });
  const snap = JSON.parse(snapshot()) as { state: WireState };
  const st = snap.state;
  const kings: WireCard[] = [];
  const pull = (cards: WireCard[] | null): WireCard[] => {
    const list = cards ?? [];
    kings.push(...list.filter(isKing));
    return list.filter((c) => !isKing(c));
  };
  st.Deck = pull(st.Deck);
  st.Scrap = pull(st.Scrap);
  for (const p of st.Players) {
    p.Hand = pull(p.Hand);
    p.Permanents = pull(p.Permanents);
  }
  expect(kings).toHaveLength(4);
  st.Players[0].Permanents = [...(st.Players[0].Permanents ?? []), ...kings.slice(0, aliceKings)];
  st.Players[1].Permanents = [...(st.Players[1].Permanents ?? []), ...kings.slice(aliceKings)];
  const restored = restore(JSON.stringify(snap), 0);
  if (!restored.ok) throw new Error(`restore failed: ${restored.code}: ${restored.message}`);
}

function viewFor(viewer: PlayerId): Envelope {
  const env = view(viewer);
  if (!env.ok) throw new Error(`view failed: ${env.code}`);
  return env;
}

function renderBoard(env: Envelope): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(Board, {
    target: host,
    props: {
      view: env.state,
      names: ['Alice', 'Blake'],
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      dimmedHand: new Set<number>(),
      selectedHand: null,
      inert: false,
      deckEnabled: true,
      ontap: () => {},
      theme: getTheme('vector'),
    },
  });
  flushSync();
  return host;
}

/** The badge text of every King in `rowId`'s permanents row. */
function kingBadges(el: HTMLElement, env: Envelope, rowId: PlayerId): string[] {
  const cards = rowId === env.state.viewer ? env.state.you.permanents : env.state.opponent.permanents;
  const out: string[] = [];
  cards.forEach((c, i) => {
    if (c.Rank !== 13) return;
    const button = el.querySelector(`[data-testid="perm-${rowId}-${i}"]`);
    out.push(button?.querySelector('[data-card-label="badge"]')?.textContent ?? '(no badge)');
  });
  return out;
}

describe('Card labels: a King shows its owner’s goal, exactly as the engine computes it (0–4 Kings)', () => {
  for (let aliceKings = 0; aliceKings <= 4; aliceKings++) {
    const blakeKings = 4 - aliceKings;
    it(`Alice ${aliceKings} King(s) -> goal ${ENGINE_THRESHOLD[aliceKings]}, Blake ${blakeKings} -> goal ${ENGINE_THRESHOLD[blakeKings]}, from both seats`, () => {
      dealWithKings(aliceKings);
      for (const viewer of [0, 1] as const) {
        const env = viewFor(viewer);
        const other = (1 - viewer) as PlayerId;
        const counts: Record<PlayerId, number> = { 0: aliceKings, 1: blakeKings };
        // The bridge agrees with win.go for both sides.
        expect(env.state.scoreboard.you.kings).toBe(counts[viewer]);
        expect(env.state.scoreboard.you.threshold).toBe(ENGINE_THRESHOLD[counts[viewer]]);
        expect(env.state.scoreboard.opponent.threshold).toBe(ENGINE_THRESHOLD[counts[other]]);

        const el = renderBoard(env);
        for (const side of [viewer, other]) {
          const badges = kingBadges(el, env, side);
          expect(badges).toHaveLength(counts[side]);
          for (const badge of badges) expect(badge).toBe(`Goal ${ENGINE_THRESHOLD[counts[side]]}`);
        }
        // Zero Kings: no goal badge anywhere on that side (21 is the default, shown by the score bar).
        const goals = [...el.querySelectorAll('[data-card-label="badge"]')].filter((b) => b.textContent?.startsWith('Goal'));
        expect(goals).toHaveLength(4);
        if (instance) unmount(instance);
        host?.remove();
        instance = undefined;
        host = undefined;
      }
    });
  }
});
