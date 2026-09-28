// SPEC §6.5, §7.4 — `window.__cuttleTestHook`, the test-only surface the R11
// invariant walk and the e2e scenario driver read. GameScreen installs it
// only when `import.meta.env.DEV` is true, so a production build compiles
// the call (and this module) out.
//
// Everything here reads the CURRENT holder's own envelope, at the moment a
// test calls it, and only while that holder is legitimately looking
// (curtain `none` or a real counter window). Behind any other curtain every
// accessor returns empty.

import { boardAffordances, boardTargetKey, groupAffordances } from './affordances';
import type { Envelope, MoveKind, PlayerId } from './bridge/schema';
import { MoveKind as MK } from './enums';
import type { CurtainState } from './stores/curtain.svelte';
import type { TargetKey } from './targetKey';

export interface TestHookMove {
  index: number;
  kind: MoveKind;
  handIndex: number;
  targetKey: TargetKey | null;
  description: string;
  /** P2 W15: the ScrapIndex a 3 takes (one level down for a SevenPick). */
  scrapIndex: number;
  discardA: number;
  discardB: number;
  /** P2 W15: for a SevenPick, which `sevenRevealed` card it plays; otherwise null. */
  revealIndex: number | null;
}

export interface CuttleTestHook {
  /** SPEC §6.5: the affordance map the UI can reach right now, slot key → move indices. */
  affordances(): Record<string, number[]>;
  /** The current holder's legal moves, for a test to pick one to drive through the UI. */
  moves(): TestHookMove[];
  curtain(): CurtainState['kind'];
  viewer(): PlayerId | null;
  seq(): number;
  /** SPEC §7.4 "a test-only entry point seeds the game": a reproducible deal. */
  newGame(seed: string, dealer: PlayerId): Promise<void>;
}

declare global {
  interface Window {
    __cuttleTestHook?: CuttleTestHook;
  }
}

/** The envelope a test may read, or null behind a curtain. */
function looking(curtain: CurtainState, envelope: Envelope | null): Envelope | null {
  if (envelope === null) return null;
  if (curtain.kind === 'none') return envelope;
  if (curtain.kind === 'ack' && !curtain.synthetic) return envelope;
  return null;
}

/**
 * What the UI makes reachable: the board's map at `none` (the staging
 * pipeline plus, since P2 W15, the SevenRevealPanel, DiscardPicker and
 * ScrapBrowser pick mode), the CounterPrompt's counter and decline slots in
 * a real counter window, and nothing anywhere else.
 */
export function reachableAffordances(curtain: CurtainState, envelope: Envelope | null): Record<string, number[]> {
  const env = looking(curtain, envelope);
  if (env === null) return {};
  if (curtain.kind === 'none') return boardAffordances(env.legalMoves);
  const grouped = groupAffordances(env.legalMoves);
  const out: Record<string, number[]> = {};
  for (const [key, indices] of Object.entries(grouped)) {
    const kind = env.legalMoves[indices[0]].Kind;
    if (kind === MK.Counter || kind === MK.Decline) out[key] = indices;
  }
  return out;
}

export interface TestHookSource {
  curtain(): CurtainState;
  envelope(): Envelope | null;
  viewer(): PlayerId | null;
  seq(): number;
  newGame(seed: string, dealer: PlayerId): Promise<void>;
}

/** Installs the hook; returns the uninstaller. */
export function installTestHook(source: TestHookSource): () => void {
  const hook: CuttleTestHook = {
    affordances: () => reachableAffordances(source.curtain(), source.envelope()),
    moves: () => {
      const env = looking(source.curtain(), source.envelope());
      if (env === null) return [];
      const revealed = env.state.sevenRevealed ?? [];
      return env.legalMoves.map((m, index) => {
        const reveal =
          m.Kind === MK.SevenPick && m.Card !== null
            ? revealed.findIndex((c) => c.Rank === m.Card?.Rank && c.Suit === m.Card?.Suit)
            : -1;
        return {
          index,
          kind: m.Kind,
          handIndex: m.HandIndex,
          targetKey: boardTargetKey(m),
          description: env.descriptions[index],
          scrapIndex: m.Kind === MK.SevenPick && m.SubMove !== null ? m.SubMove.ScrapIndex : m.ScrapIndex,
          discardA: m.DiscardA,
          discardB: m.DiscardB,
          revealIndex: reveal >= 0 ? reveal : null,
        };
      });
    },
    curtain: () => source.curtain().kind,
    viewer: source.viewer,
    seq: source.seq,
    newGame: source.newGame,
  };
  window.__cuttleTestHook = hook;
  return () => {
    if (window.__cuttleTestHook === hook) delete window.__cuttleTestHook;
  };
}
