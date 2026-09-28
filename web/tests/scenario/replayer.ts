// Replays a Scenario (SPEC §7.3) against any engine that satisfies
// ScenarioEngine. Deliberately engine-agnostic: the stub engine (unit
// tests) and the real WASM bridge (tests/scenario/wasm-engine.ts) both
// implement this same three-method surface.
import type { Scenario } from './types';

export interface ScenarioEnvelope {
  descriptions: string[];
  [field: string]: unknown;
}

export interface ScenarioEngine {
  newGame(opts: { seed: string; dealer: number; names?: string[] }): ScenarioEnvelope;
  legalMoves(): ScenarioEnvelope;
  apply(index: number): ScenarioEnvelope;
}

export class ScenarioReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioReplayError';
  }
}

/**
 * Replays every move in `scenario` against `engine`, asserting at each step
 * that the description at the scripted index matches `expect`. Fails with
 * the SPEC §7.3 diagnostic form: `step N: expected "…", got "…"`.
 *
 * `newGame` seeds the position; `legalMoves` fetches the envelope for the
 * first assertion; every subsequent envelope comes from `apply`'s return
 * value (SPEC §2.7 — every bridge call returns a full envelope).
 */
export function replayScenario(engine: ScenarioEngine, scenario: Scenario): ScenarioEnvelope {
  engine.newGame({ seed: scenario.seed, dealer: scenario.dealer, names: scenario.names });
  let envelope: ScenarioEnvelope = engine.legalMoves();

  scenario.moves.forEach((move, step) => {
    const got = envelope.descriptions[move.i];
    if (got !== move.expect) {
      throw new ScenarioReplayError(`step ${step}: expected "${move.expect}", got "${String(got)}"`);
    }

    envelope = engine.apply(move.i);

    const checkpoint = scenario.checkpoints?.find((cp) => cp.afterStep === step);
    if (checkpoint) {
      for (const [key, expected] of Object.entries(checkpoint)) {
        if (key === 'afterStep') continue;
        const actual = envelope[key];
        if (actual !== expected) {
          throw new ScenarioReplayError(
            `step ${step} checkpoint "${key}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  });

  return envelope;
}
