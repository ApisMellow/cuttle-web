import { describe, expect, it } from 'vitest';

import { replayScenario, ScenarioReplayError } from '../scenario/replayer';
import { createStubEngine } from '../scenario/stub-engine';
import type { Scenario } from '../scenario/types';

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'stub',
    description: 'stub scenario',
    seed: '1',
    dealer: 0,
    moves: [
      { i: 0, expect: 'draw a card' },
      { i: 0, expect: 'play 2♥ as point card' },
    ],
    ...overrides,
  };
}

describe('replayScenario', () => {
  it('replays a matching script to completion', () => {
    const engine = createStubEngine({
      steps: [
        { descriptions: ['draw a card'] },
        { descriptions: ['play 2♥ as point card', 'play 3♣ as point card'] },
        { descriptions: ['pass'] },
      ],
    });
    // moves[1].i === 0, so the second assertion reads descriptions[0] of the
    // post-apply envelope, i.e. 'play 2♥ as point card'.
    const result = replayScenario(engine, scenario());
    expect(result.descriptions).toEqual(['pass']);
  });

  it('fails with the SPEC §7.3 diagnostic form on a description mismatch', () => {
    const engine = createStubEngine({
      steps: [{ descriptions: ['draw a card'] }, { descriptions: ['play K♦ as permanent'] }],
    });
    expect(() => replayScenario(engine, scenario())).toThrow(ScenarioReplayError);
    expect(() => replayScenario(engine, scenario())).toThrow(
      'step 1: expected "play 2♥ as point card", got "play K♦ as permanent"',
    );
  });

  it('asserts checkpoint fields keyed by afterStep', () => {
    const engine = createStubEngine({
      steps: [{ descriptions: ['draw a card'] }, { descriptions: ['play 2♥ as point card'] }],
    });
    const single = scenario({ moves: [{ i: 0, expect: 'draw a card' }] });

    const passing = { ...single, checkpoints: [{ afterStep: 0, step: 1 }] };
    expect(() => replayScenario(engine, passing)).not.toThrow();

    const failing = { ...single, checkpoints: [{ afterStep: 0, step: 99 }] };
    expect(() => replayScenario(engine, failing)).toThrow(/checkpoint "step": expected 99, got 1/);
  });
});
