// @vitest-environment jsdom
// R10, strict tier (hidden information, R7 / SPEC §3.2; save/resume, §5.7).
// Through the REAL wasm bridge, the real game store and the real GameScreen:
//
//   (a) Glasses leave play through the UI, by a 2 (scrapped), a 6 (every
//       permanent wiped) and a 9 (bounced to the owner's hand). Afterwards
//       the owner's opp-hand is back to data-revealed="false" with backs
//       only, and the watcher's being-watched marker is gone.
//   (b) Restore from a save with glasses in play (a simulated reload: the
//       bridge is clobbered by another deal, then the saved snapshot is put
//       back and restored). The watcher's restored view has opponent.hand
//       null, no leak of the owner's hand in the DOM, and the marker shown;
//       the owner's restored view has the watcher's hand face up.
//
// Positions are reached by playing real deals with a fixed policy (seeded,
// deterministic): play glasses when nobody has them, then play the wanted
// one-off at them; otherwise draw. Every counter window declines.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Card, Envelope, PlayerId, PlayerView } from '../../src/lib/bridge/schema';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, passResumeGate } from './game-test-support';
import { expectNoLeak, id } from './glasses-leak-scan';

const { default: GameScreen } = await import('../../src/lib/components/GameScreen.svelte');
const { game } = await import('../../src/lib/stores/game.svelte');
const { session } = await import('../../src/lib/stores/session.svelte');

const NAMES: [string, string] = ['Alice', 'Blake'];
const PERMANENTS_ZONE = 1;

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function mountScreen(): HTMLDivElement {
  unmountScreen();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

function unmountScreen(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(unmountScreen);

beforeAll(async () => {
  await createWasmEngine();
  session.setNames(...NAMES);
});

/** Runs the curtain to a resting state, declining at every counter window. */
async function settle(): Promise<'board' | 'result'> {
  for (let i = 0; i < 24; i++) {
    const c = game.curtain;
    if (c.kind === 'none') return 'board';
    if (c.kind === 'result') return 'result';
    if (c.kind === 'ack') {
      const decline = game.envelope!.legalMoves.findIndex((m) => m.Kind === Kind.Decline);
      await game.apply(decline >= 0 ? decline : 0);
      continue;
    }
    await game.advanceCurtain();
  }
  throw new Error(`curtain did not settle (${game.curtain.kind})`);
}

function eights(cards: Card[]): number {
  return cards.filter((c) => c.Rank === 8).length;
}

/** Who holds glasses, from public permanents, when exactly one player does; else null. */
function soleOwner(v: PlayerView): PlayerId | null {
  const mine = eights(v.you.permanents);
  const theirs = eights(v.opponent.permanents);
  if (mine + theirs !== 1) return null;
  return mine === 1 ? v.viewer : ((1 - v.viewer) as PlayerId);
}

function permanentsOf(v: PlayerView, owner: PlayerId): Card[] {
  return owner === v.viewer ? v.you.permanents : v.opponent.permanents;
}

type Leaver = 2 | 6 | 9;

/** The legal move that takes the glasses out of play with a one-off of this rank, or -1. */
function leaverMove(env: Envelope, rank: Leaver): number {
  return env.legalMoves.findIndex((m) => {
    if (m.Kind !== Kind.OneOff || m.Card?.Rank !== rank) return false;
    if (rank === 6) return true;
    const t = m.Target;
    return t !== null && t.Zone === PERMANENTS_ZONE && permanentsOf(env.state, t.Owner)[t.Index]?.Rank === 8;
  });
}

/** A quiet move: draw if possible, else the first move that doesn't put glasses down. */
function quietMove(env: Envelope): number {
  const draw = env.legalMoves.findIndex((m) => m.Kind === Kind.Draw);
  if (draw >= 0) return draw;
  const other = env.legalMoves.findIndex((m) => !(m.Kind === Kind.PlayPermanent && m.Card?.Rank === 8));
  return other >= 0 ? other : 0;
}

interface Left {
  owner: PlayerId;
  /** Who played the one-off. */
  leaver: PlayerId;
}

/**
 * Plays seeded deals until glasses are in play for exactly one player and a
 * one-off of `rank` can take them out; checks the pre-state board of the
 * player about to play it, plays it, declines any counter, and settles.
 */
async function playGlassesThenLeaver(rank: Leaver): Promise<Left> {
  for (let seed = 1; seed <= 400; seed++) {
    await game.newGame({ seed: String(seed), dealer: 0 });
    if ((await settle()) !== 'board') continue;
    for (let step = 0; step < 120; step++) {
      const env = game.envelope!;
      const v = env.state;
      if (v.phase === 4) break;
      const owner = soleOwner(v);
      if (owner !== null && v.phase === 0) {
        const leave = leaverMove(env, rank);
        if (leave >= 0) {
          // Before: the glasses are working, for whichever role is at the board.
          const el = mountScreen();
          if (v.viewer === owner) {
            expect(el.querySelector('[data-testid="opp-hand"]')!.getAttribute('data-revealed')).toBe('true');
          } else {
            expect(v.you.watched).toBe(true);
            expect(el.querySelector('.watched-marker')).not.toBeNull();
          }
          unmountScreen();
          const leaver = v.viewer;
          await game.apply(leave);
          if ((await settle()) !== 'board') break;
          return { owner, leaver };
        }
      }
      let move = -1;
      if (eights([...v.you.permanents, ...v.opponent.permanents]) === 0 && v.phase === 0) {
        move = env.legalMoves.findIndex((m) => m.Kind === Kind.PlayPermanent && m.Card?.Rank === 8);
      }
      if (move < 0) move = quietMove(env);
      await game.apply(move);
      if ((await settle()) !== 'board') break;
    }
  }
  throw new Error(`no seed in 1..400 reached glasses then a ${rank} at them`);
}

/** The glasses are gone: whoever is at the board sees the right thing for their role. */
function expectGlassesGone(owner: PlayerId): void {
  const v = game.view!;
  expect(eights([...v.you.permanents, ...v.opponent.permanents])).toBe(0);
  const el = mountScreen();
  if (v.viewer === owner) {
    // The owner's view: the watcher's hand is hidden again, backs only.
    expect(v.opponent.hand).toBeNull();
    const oppHand = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
    expect(oppHand.getAttribute('data-revealed')).toBe('false');
    expect(oppHand.querySelectorAll('[data-state]').length).toBe(0);
  } else {
    // The watcher's view: no longer watched, no marker, and the hand group describes nothing.
    expect(v.you.watched).toBe(false);
    expect(el.querySelector('.watched-marker')).toBeNull();
    expect(el.querySelector('[role="group"][aria-label="Your hand"]')!.hasAttribute('aria-describedby')).toBe(false);
  }
  unmountScreen();
}

describe('R10 (a): glasses leaving play through the UI hide the hand again and drop the marker', () => {
  for (const rank of [2, 6, 9] as const) {
    it(`a ${rank} one-off at the glasses: both roles see them gone`, async () => {
      const { owner } = await playGlassesThenLeaver(rank);
      const first = game.viewer!;
      expectGlassesGone(owner);

      // Hand the phone over with a quiet move, and check the other role.
      for (let i = 0; i < 6 && game.viewer === first; i++) {
        const env = game.envelope!;
        expect(eights([...env.state.you.permanents, ...env.state.opponent.permanents])).toBe(0);
        await game.apply(quietMove(env));
        expect(await settle()).toBe('board');
      }
      expect(game.viewer).toBe(1 - first);
      expect(eights([...game.view!.you.permanents, ...game.view!.opponent.permanents])).toBe(0);
      expectGlassesGone(owner);
    }, 60_000);
  }
});

/** A reload: another deal clobbers the bridge and the store, then the saved game is put back and restored. */
async function reloadFromSave(): Promise<void> {
  const saved = localStorage.getItem(SNAPSHOT_KEY);
  expect(saved).not.toBeNull();
  await game.newGame({ seed: '999', dealer: 1 });
  localStorage.setItem(SNAPSHOT_KEY, saved!);
  game.envelope = null;
  game.viewer = null;
  game.history = [];
  game.curtain = { kind: 'none' };
  game.screen = 'home';
  await game.restore();
  expect(game.screen).toBe('game');
  // SPEC §5.7 (ruling 2026-09-29): a saved board comes back behind the resume gate.
  expect(game.envelope).toBeNull();
  await passResumeGate(game);
  expect(game.curtain.kind).toBe('none');
}

describe('R10 (b): restore from a save with glasses in play', () => {
  it('the watcher restores hidden-and-marked, the owner restores face up', async () => {
    // Reach glasses for the first player, with the watcher at the board.
    let owner: PlayerId | null = null;
    let ownerHand: Card[] = [];
    for (let seed = 1; seed <= 300 && owner === null; seed++) {
      await game.newGame({ seed: String(seed), dealer: 0 });
      if ((await settle()) !== 'board') continue;
      const env = game.envelope!;
      const index = env.legalMoves.findIndex((m) => m.Kind === Kind.PlayPermanent && m.Card?.Rank === 8);
      if (index < 0) continue;
      const eight = env.legalMoves[index].Card!;
      ownerHand = env.state.you.hand.filter((c) => id(c) !== id(eight));
      if (ownerHand.length === 0) continue;
      const who = env.state.viewer;
      await game.apply(index);
      if ((await settle()) !== 'board') continue;
      owner = who;
    }
    expect(owner).not.toBeNull();
    const watcher = (1 - owner!) as PlayerId;
    expect(game.viewer).toBe(watcher);

    // ── Reload with the watcher's board saved. ─────────────────────────
    await reloadFromSave();
    expect(game.viewer).toBe(watcher);
    const wv = game.view!;
    expect(wv.opponent.hand).toBeNull();
    expect(wv.opponent.handCount).toBe(ownerHand.length);
    expect(wv.you.watched).toBe(true);
    let el = mountScreen();
    expect(el.querySelector('[data-testid="opp-hand"]')!.getAttribute('data-revealed')).toBe('false');
    expect(el.querySelector('.watched-marker')?.textContent).toContain(`${NAMES[owner!]} can see your hand`);
    expectNoLeak(document.body, ownerHand, 'restored watcher board');
    const dump = JSON.stringify(game.envelope);
    for (const c of ownerHand) expect(dump).not.toContain(`{"Rank":${c.Rank},"Suit":${c.Suit}}`);
    unmountScreen();

    // The watcher draws; the owner takes the phone.
    const watcherHand = [...wv.you.hand];
    await game.apply(quietMove(game.envelope!));
    expect(await settle()).toBe('board');
    expect(game.viewer).toBe(owner);

    // ── Reload with the owner's board saved. ───────────────────────────
    await reloadFromSave();
    expect(game.viewer).toBe(owner);
    const ov = game.view!;
    expect(ov.you.watched).toBe(false);
    expect(ov.opponent.hand).not.toBeNull();
    el = mountScreen();
    const revealed = el.querySelector<HTMLElement>('[data-testid="opp-hand"]')!;
    expect(revealed.getAttribute('data-revealed')).toBe('true');
    const faceUp = [...revealed.querySelectorAll('[data-state]')].length;
    expect(faceUp).toBe(ov.opponent.handCount);
    for (const c of watcherHand) expect(ov.opponent.hand!.map(id)).toContain(id(c));
    expect(el.querySelector('.watched-marker')).toBeNull();
  }, 60_000);
});
