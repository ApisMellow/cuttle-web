import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply, newGame, view } from '../../src/lib/bridge/engine';

const error = JSON.stringify({ ok: false, code: 'NO_GAME', message: 'none' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engine bridge boundary', () => {
  it('serializes newGame as JSON and never exposes a Move constructor', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleNewGame', fn);
    newGame({ seed: '42', dealer: 1, names: ['Alice', 'Bob'] });
    expect(fn).toHaveBeenCalledWith('{"seed":"42","dealer":1,"names":["Alice","Bob"]}');
  });

  it('applies only an engine-provided legal-move index', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleApply', fn);
    apply(3);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('requests a named redacted viewer', () => {
    const fn = vi.fn(() => error);
    vi.stubGlobal('__cuttleView', fn);
    view(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
});
