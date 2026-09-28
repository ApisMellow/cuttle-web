// Loader for the SPEC §7.3 scenario YAML format. Deliberately strict: a
// scenario that omits a step's `expect` field is rejected rather than
// silently accepted, per the guard-rail rationale in SPEC §7.3.
import { parse } from 'yaml';

import type { Scenario, ScenarioCheckpoint, ScenarioMove } from './types';

export class ScenarioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioValidationError';
  }
}

function fail(message: string): never {
  throw new ScenarioValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and validate a scenario from raw YAML text. Throws on any shape violation. */
export function parseScenario(source: string): Scenario {
  const raw: unknown = parse(source);
  if (!isPlainObject(raw)) fail('scenario must be a YAML mapping');

  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) fail('scenario.id must be a non-empty string');

  const description = raw.description;
  if (typeof description !== 'string' || description.length === 0) {
    fail(`scenario "${id}": description must be a non-empty string`);
  }

  const seed = raw.seed;
  if (typeof seed !== 'string' || !/^\d+$/.test(seed)) {
    fail(`scenario "${id}": seed must be a decimal uint64 string (SPEC §7.3), got ${JSON.stringify(seed)}`);
  }

  const dealer = raw.dealer;
  if (dealer !== 0 && dealer !== 1) {
    fail(`scenario "${id}": dealer must be 0 or 1, got ${JSON.stringify(dealer)}`);
  }

  let names: [string, string] | undefined;
  if (raw.names !== undefined) {
    const n = raw.names;
    if (!Array.isArray(n) || n.length !== 2 || !n.every((x) => typeof x === 'string')) {
      fail(`scenario "${id}": names must be an array of exactly 2 strings`);
    }
    names = [n[0] as string, n[1] as string];
  }

  const movesRaw = raw.moves;
  if (!Array.isArray(movesRaw) || movesRaw.length === 0) {
    fail(`scenario "${id}": moves must be a non-empty array`);
  }
  const moves: ScenarioMove[] = movesRaw.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`scenario "${id}": moves[${index}] must be a mapping`);
    const i = entry.i;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) {
      fail(`scenario "${id}": moves[${index}].i must be a non-negative integer`);
    }
    const expect = entry.expect;
    if (typeof expect !== 'string' || expect.length === 0) {
      fail(
        `scenario "${id}": moves[${index}] is missing the required "expect" field ` +
          '(SPEC §7.3 — every step must carry the guard-rail description)',
      );
    }
    return { i, expect };
  });

  let checkpoints: ScenarioCheckpoint[] | undefined;
  if (raw.checkpoints !== undefined) {
    const checkpointsRaw = raw.checkpoints;
    if (!Array.isArray(checkpointsRaw)) fail(`scenario "${id}": checkpoints must be an array`);
    checkpoints = checkpointsRaw.map((entry, index) => {
      if (!isPlainObject(entry)) fail(`scenario "${id}": checkpoints[${index}] must be a mapping`);
      const afterStep = entry.afterStep;
      if (typeof afterStep !== 'number' || !Number.isInteger(afterStep) || afterStep < 0) {
        fail(`scenario "${id}": checkpoints[${index}].afterStep must be a non-negative integer`);
      }
      return { ...entry, afterStep } as ScenarioCheckpoint;
    });
  }

  return { id, description, seed, dealer, names, moves, checkpoints };
}

/** Read and parse a scenario file from disk. */
export async function loadScenario(filePath: string): Promise<Scenario> {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(filePath, 'utf8');
  return parseScenario(source);
}
