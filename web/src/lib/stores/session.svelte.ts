// SPEC §5.3 — "session.svelte.ts — R3 tally, player names, `lastDealer`,
// `lastSeed`."
//
// Ruling 2026-09-29 (playtest: a 0–2 tally read 1–0 after a reload; SPEC
// §5.3, §5.7, R3.3 amended): the tally survives a reload. It is kept in
// sessionStorage under its own key (`TALLY_KEY`), so it lives as long as the
// browser tab (PRD §4's "browser session") and never enters the game
// snapshot (§5.7). It belongs to the ordered name pair: setting different
// names starts a fresh tally, and there is no other "new match". Names,
// `lastDealer` and `lastSeed` stay memory only (the snapshot carries names
// and dealer for a resumed game).
//
// A store built without `storage` touches no storage at all; only the app
// singleton below is given sessionStorage. Storage is best-effort: a blocked
// or corrupt value never breaks play.
//
// It also exposes what game.svelte.ts needs to build a `NewGameOpts` dealer
// value per §2.6 / §8 OQ-12: the first game of a session passes no dealer
// (the bridge assigns one randomly); a rematch passes `dealer = 1 - lastDealer`.

import type { PlayerId } from '../bridge/schema';

const DEFAULT_NAMES: [string, string] = ['Player 1', 'Player 2'];

/** sessionStorage key for the R3 tally (ruling 2026-09-29). */
export const TALLY_KEY = 'cuttle-web:tally';

/** The storage calls this store makes; `sessionStorage` in the app. */
export interface TallyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionStoreDeps {
  storage?: TallyStorage;
}

function normalizeName(name: string, fallback: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sameNames(a: readonly [string, string], b: readonly [string, string]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

interface StoredTally {
  names: [string, string];
  tally: Record<PlayerId, number>;
}

function parseStored(raw: string | null): StoredTally | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { names, tally } = value as { names?: unknown; tally?: unknown };
  if (!Array.isArray(names) || names.length !== 2 || typeof names[0] !== 'string' || typeof names[1] !== 'string') return null;
  if (typeof tally !== 'object' || tally === null) return null;
  const t = tally as Record<string, unknown>;
  if (!isCount(t[0]) || !isCount(t[1])) return null;
  return { names: [names[0], names[1]], tally: { 0: t[0], 1: t[1] } };
}

export class SessionStore {
  readonly #storage: TallyStorage | undefined;

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

  constructor(deps: SessionStoreDeps = {}) {
    this.#storage = deps.storage;
    // Players who never set names keep their tally under the default pair.
    this.tally = this.#storedTallyFor(this.names) ?? { 0: 0, 1: 0 };
  }

  /**
   * Blank (or whitespace-only) names fall back to "Player 1"/"Player 2".
   * The same pair keeps its tally; a different pair takes the tally stored
   * for it (a reload putting the names back) or starts at 0–0.
   */
  setNames(player1: string, player2: string): void {
    const next: [string, string] = [normalizeName(player1, DEFAULT_NAMES[0]), normalizeName(player2, DEFAULT_NAMES[1])];
    if (sameNames(next, this.names)) return;
    this.names = next;
    this.tally = this.#storedTallyFor(next) ?? { 0: 0, 1: 0 };
    this.#writeTally();
  }

  /** Called by game.svelte.ts once the bridge has assigned/echoed a dealer. */
  recordDealer(dealer: PlayerId): void {
    this.lastDealer = dealer;
  }

  /** For display only (SPEC §8 OQ-12: "surface... and nowhere else"). */
  recordSeed(seed: string): void {
    this.lastSeed = seed;
  }

  /** R3: increments the win tally for the given player and saves it for this pair. */
  recordResult(winner: PlayerId): void {
    this.tally = { ...this.tally, [winner]: this.tally[winner] + 1 };
    this.#writeTally();
  }

  #storedTallyFor(names: readonly [string, string]): Record<PlayerId, number> | null {
    let raw: string | null;
    try {
      raw = this.#storage?.getItem(TALLY_KEY) ?? null;
    } catch {
      return null;
    }
    const stored = parseStored(raw);
    return stored !== null && sameNames(stored.names, names) ? stored.tally : null;
  }

  #writeTally(): void {
    if (!this.#storage) return;
    const value: StoredTally = { names: [...this.names], tally: { 0: this.tally[0], 1: this.tally[1] } };
    try {
      this.#storage.setItem(TALLY_KEY, JSON.stringify(value));
    } catch {
      // Best-effort: the tally still counts in memory for this page.
    }
  }
}

function defaultTallyStorage(): TallyStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export const session = new SessionStore({ storage: defaultTallyStorage() });
