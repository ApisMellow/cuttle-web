// P2 W13 — an explicit `dealer` for `GameStore.newGame` (SPEC §2.6
// `NewGameOpts.dealer`, §7.4 "a test-only entry point seeds the game"). The
// e2e test hook needs a reproducible deal: seed alone is not enough, because
// the session alternates the dealer. An explicit dealer wins over
// `session.nextDealer`; omitting it keeps the existing alternation.
import { describe, expect, it } from 'vitest';

import type { NewGameOpts } from '../../src/lib/bridge/engine';
import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { createFakeEngine, envelope, fakeStorage, playerView } from './game-test-support';

function capturingStore(session: SessionStore): { store: GameStore; seen: NewGameOpts[] } {
  const seen: NewGameOpts[] = [];
  const engine = createFakeEngine({
    newGame: (opts) => {
      seen.push(opts);
      const dealer = opts.dealer ?? 1;
      const active = (1 - dealer) as 0 | 1;
      return envelope({ state: playerView({ active, viewer: active }) });
    },
  });
  return { store: new GameStore({ engine, storage: fakeStorage(), session }), seen };
}

describe('GameStore.newGame explicit dealer', () => {
  it('passes an explicit dealer through, overriding session.nextDealer', async () => {
    const session = new SessionStore();
    session.recordDealer(1); // nextDealer would be 0
    const { store, seen } = capturingStore(session);

    await store.newGame({ seed: '42', dealer: 1 });

    expect(seen[0]).toEqual({ seed: '42', dealer: 1 });
    expect(session.lastDealer).toBe(1);
  });

  it('an explicit dealer 0 is honoured on the first game of a session too', async () => {
    const session = new SessionStore();
    const { store, seen } = capturingStore(session);

    await store.newGame({ seed: '7', dealer: 0 });

    expect(seen[0]).toEqual({ seed: '7', dealer: 0 });
  });
});
