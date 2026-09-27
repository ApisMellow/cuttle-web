// A deterministic, WASM-free ScenarioEngine for unit-testing the loader
// and replayer in isolation (SPEC §7.3 says the format is the shared
// backbone across layers; this stub is what lets the replayer's own
// logic be pinned without booting the real bridge).
import type { ScenarioEngine, ScenarioEnvelope } from './replayer';

export interface StubScript {
  /** `steps[n]` is the envelope available before the (n+1)th move is applied. */
  steps: Array<Partial<ScenarioEnvelope> & { descriptions: string[] }>;
}

export function createStubEngine(script: StubScript): ScenarioEngine {
  let step = 0;

  const envelopeAt = (index: number): ScenarioEnvelope => {
    const found = script.steps[index];
    if (!found) throw new Error(`stub engine has no step ${index} scripted`);
    return { step: index, ...found };
  };

  return {
    newGame() {
      step = 0;
      return envelopeAt(step);
    },
    legalMoves() {
      return envelopeAt(step);
    },
    apply(_index: number) {
      step += 1;
      return envelopeAt(step);
    },
  };
}
