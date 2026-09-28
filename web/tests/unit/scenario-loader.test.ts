import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadScenario, parseScenario, ScenarioValidationError } from '../scenario/loader';

const here = path.dirname(fileURLToPath(import.meta.url));

const valid = `
id: opening
description: "Golden opening deal."
seed: "42"
dealer: 1
names: ["Alice", "Blake"]
moves:
  - i: 0
    expect: "draw a card"
checkpoints:
  - afterStep: 0
    phase: 0
`;

describe('parseScenario', () => {
  it('parses a well-formed scenario', () => {
    const scenario = parseScenario(valid);
    expect(scenario.id).toBe('opening');
    expect(scenario.seed).toBe('42');
    expect(scenario.dealer).toBe(1);
    expect(scenario.names).toEqual(['Alice', 'Blake']);
    expect(scenario.moves).toEqual([{ i: 0, expect: 'draw a card' }]);
    expect(scenario.checkpoints).toEqual([{ afterStep: 0, phase: 0 }]);
  });

  it('rejects a step missing the required expect field', () => {
    const missingExpect = `
id: bad
description: "no expect"
seed: "42"
dealer: 0
moves:
  - i: 0
`;
    expect(() => parseScenario(missingExpect)).toThrow(ScenarioValidationError);
    expect(() => parseScenario(missingExpect)).toThrow(/expect/);
  });

  it('rejects a dealer outside {0, 1}', () => {
    const badDealer = `
id: bad
description: "bad dealer"
seed: "42"
dealer: 2
moves:
  - i: 0
    expect: "draw a card"
`;
    expect(() => parseScenario(badDealer)).toThrow(/dealer/);
  });

  it('rejects a non-decimal seed', () => {
    const badSeed = `
id: bad
description: "bad seed"
seed: "not-a-number"
dealer: 0
moves:
  - i: 0
    expect: "draw a card"
`;
    expect(() => parseScenario(badSeed)).toThrow(/seed/);
  });

  it('rejects an empty moves array', () => {
    const noMoves = `
id: bad
description: "no moves"
seed: "42"
dealer: 0
moves: []
`;
    expect(() => parseScenario(noMoves)).toThrow(/moves/);
  });
});

describe('loadScenario', () => {
  it('loads the real opening.yaml scenario from disk', async () => {
    const scenario = await loadScenario(path.join(here, '../scenarios/opening.yaml'));
    expect(scenario.id).toBe('opening');
    expect(scenario.dealer).toBe(1);
    expect(scenario.moves[0]).toEqual({ i: 0, expect: 'draw a card' });
  });
});
