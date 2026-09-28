// SPEC §5.3 — "session.svelte.ts — R3 tally, player names, `lastDealer`,
// `lastSeed`. Memory only; never persisted" (PRD §4: "the win tally lives
// only for the browser session"; R3: "does not survive a page reload").
//
// This module touches no storage of any kind — that is the point of it
// (groundwork for R3.3, which will assert the R4 Snapshot never carries
// these fields). It exposes what game.svelte.ts (round 2) needs to build a
// `NewGameOpts` dealer value per §2.6 / §8 OQ-12: the first game of a
// session passes no dealer (the bridge assigns one randomly); a rematch
// passes `dealer = 1 - lastDealer`.

import type { PlayerId } from '../bridge/schema';

const DEFAULT_NAMES: [string, string] = ['Player 1', 'Player 2'];

function normalizeName(name: string, fallback: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export class SessionStore {
  names = $state<[string, string]>([...DEFAULT_NAMES]);
  tally = $state<Record<PlayerId, number>>({ 0: 0, 1: 0 });
  lastDealer = $state<PlayerId | null>(null);
  lastSeed = $state<string | null>(null);

  /**
   * SPEC §2.6 / §8 OQ-12: `undefined` (bridge picks randomly) when no game
   * has been dealt yet this session; `1 - lastDealer` on every rematch.
   */
  nextDealer = $derived<PlayerId | undefined>(
    this.lastDealer === null ? undefined : ((1 - this.lastDealer) as PlayerId),
  );

  /** Blank (or whitespace-only) names fall back to "Player 1"/"Player 2". */
  setNames(player1: string, player2: string): void {
    this.names = [normalizeName(player1, DEFAULT_NAMES[0]), normalizeName(player2, DEFAULT_NAMES[1])];
  }

  /** Called by game.svelte.ts once the bridge has assigned/echoed a dealer. */
  recordDealer(dealer: PlayerId): void {
    this.lastDealer = dealer;
  }

  /** For display only (SPEC §8 OQ-12: "surface... and nowhere else"). */
  recordSeed(seed: string): void {
    this.lastSeed = seed;
  }

  /** R3: increments the session-lifetime win tally for the given player. */
  recordResult(winner: PlayerId): void {
    this.tally = { ...this.tally, [winner]: this.tally[winner] + 1 };
  }
}

export const session = new SessionStore();
