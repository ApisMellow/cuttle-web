import type { Page } from '@playwright/test';

import { c, positionSnapshot } from '../../../src/lib/tutorial/position';

// Issue #93: engine v0.3.0 opens no counter window, so the legacy
// CounterPrompt (and the `ack` curtain) is reached only from a v0.2.x save
// at phase 1. This builds one by hand, as counter-rewind-wasm.test.ts's C4
// legacy case does: the player who isn't `to` has played 6♣ as a one-off,
// and `to`, holding 2♣ and 7♦, is in the counter window. The other player
// holds 9♥. Names are Alice (seat 0) and Blake (seat 1).

/** A v2 pass-and-play save at a legacy counter window addressed to `to`. */
export function legacyCounterWindowSave(to: 0 | 1 = 1): string {
  const responder = [c(2, 'C'), c(7, 'D')];
  const mover = [c(9, 'H')];
  const by = to === 1 ? 0 : 1;
  const engine = JSON.parse(
    positionSnapshot({
      aliceHand: to === 0 ? responder : mover,
      alicePoints: [],
      blakeHand: to === 1 ? responder : mover,
      blakePoints: [],
      scrap: [],
      deckTop: [c(6, 'C')],
    }),
  );
  engine.state.Deck = engine.state.Deck.slice(1); // 6♣ is in the pending one-off, not the deck
  engine.state.Active = to;
  engine.state.Phase = 1;
  engine.state.Pending = { PlayedBy: by, Card: c(6, 'C'), Target: null, ScrapIndex: 0, Revealed: null, CounterChain: null };
  const sixEntry = { by, kind: 4, subKind: null, card: c(6, 'C'), targetCard: null, drawn: null, description: 'play 6♣ as one-off', seq: 1 };
  engine.history = [{ ...sixEntry, index: 2 }]; // the engine's snapshot holds unredacted history
  return JSON.stringify({
    v: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    engineState: JSON.stringify(engine),
    history: [sixEntry],
    lastSeenSeq: by === 0 ? { 0: 1, 1: 0 } : { 0: 0, 1: 1 },
    viewer: to,
    curtain: { kind: 'ack', to },
    names: ['Alice', 'Blake'],
    seed: '0',
    dealer: 1,
  });
}

/** Writes the legacy save and reloads, so Home offers Resume into it. */
export async function loadLegacyCounterWindow(page: Page, to: 0 | 1 = 1): Promise<void> {
  await page.evaluate((value) => localStorage.setItem('cuttle-web:game', value), legacyCounterWindowSave(to));
  await page.reload();
}
