// SPEC §6.5, §7.4 — `window.__cuttleTestHook`, the test-only surface the R11
// invariant walk and the e2e scenario driver read. GameScreen installs it
// only when `import.meta.env.DEV` is true, so a production build compiles
// the call (and this module) out.
//
// Everything here reads the CURRENT holder's own envelope, at the moment a
// test calls it, and only while that holder is legitimately looking
// (curtain `none` or a real counter window). Behind any other curtain every
// accessor returns empty.

import { boardTargetKey, groupAffordances, stagingAffordances } from './affordances';
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
 * What the UI makes reachable: the staging pipeline's map on the board, the
 * CounterPrompt's counter and decline slots in a real counter window, and
 * nothing anywhere else. Kinds whose UI is not built yet (SevenPick,
 * DiscardPair, a rank-3's scrap pick) are absent, so an invariant walk over
 * those positions fails until their components land.
 */
export function reachableAffordances(curtain: CurtainState, envelope: Envelope | null): Record<string, number[]> {
  const env = looking(curtain, envelope);
  if (env === null) return {};
  if (curtain.kind === 'none') return stagingAffordances(env.legalMoves);
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
      return env.legalMoves.map((m, index) => ({
        index,
        kind: m.Kind,
        handIndex: m.HandIndex,
        targetKey: boardTargetKey(m),
        description: env.descriptions[index],
      }));
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
