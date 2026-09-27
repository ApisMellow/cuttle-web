// Shared type for the SPEC §7.3 scenario format (formerly "fixture").
// One shape, reused by the loader, the replayer, and every test layer
// that drives a scenario (unit, e2e, invariant, judge — see SPEC §7.3).

export interface ScenarioMove {
  /** Index into the engine's `legalMoves` at this position. */
  i: number;
  /**
   * The engine-authored description that must appear at `legalMoves[i]`.
   * Required on every step — this is the guard rail SPEC §7.3 describes:
   * an engine enumeration-order change fails loudly with a diagnosis
   * instead of silently repointing the script at a different move.
   */
  expect: string;
}

export interface ScenarioCheckpoint {
  /** 0-based index into `moves` after which this checkpoint is asserted. */
  afterStep: number;
  /** Remaining fields are engine-envelope keys checked by strict equality. */
  [field: string]: unknown;
}

export interface Scenario {
  id: string;
  description: string;
  /** Decimal uint64, carried as a string (SPEC §2.6/§7.3). */
  seed: string;
  dealer: 0 | 1;
  names?: [string, string];
  moves: ScenarioMove[];
  checkpoints?: ScenarioCheckpoint[];
}
