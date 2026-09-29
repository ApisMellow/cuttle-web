// @vitest-environment jsdom
// PRD §10 A-6 + SPEC §5.7 — STRICT tier (save/resume). The card theme is a
// look preference: it lives under the settings key, never in the game
// snapshot, and changing it never changes a save or a resume. Runs the real
// engine through the wasm bridge.
import { describe, expect, it } from 'vitest';

import { GameStore } from '../../src/lib/stores/game.svelte';
import { SessionStore } from '../../src/lib/stores/session.svelte';
import { SETTINGS_KEY, settings } from '../../src/lib/stores/settings.svelte';
import { SNAPSHOT_KEY } from '../../src/lib/stores/snapshot';
import { createWasmEngine } from '../scenario/wasm-engine';
import { Kind, fakeStorage } from './game-test-support';

async function advance(store: GameStore): Promise<void> {
  for (let i = 0; i < 6 && store.curtain.kind !== 'none'; i++) await store.advanceCurtain();
  expect(store.curtain.kind).toBe('none');
}

/** Plays seed 42 to the first handoff with `themeId` chosen; returns the raw save. */
async function playWithTheme(themeId: string): Promise<{ raw: string; storage: Storage; live: GameStore }> {
  settings.setThemeId(themeId);
  const storage = fakeStorage();
  const live = new GameStore({ storage, session: new SessionStore() });
  await live.newGame({ seed: '42', dealer: 1 });
  await advance(live);
  const draw = live.envelope!.legalMoves.findIndex((m) => m.Kind === Kind.Draw);
  expect(draw).toBeGreaterThanOrEqual(0);
  await live.apply(draw);
  const raw = storage.getItem(SNAPSHOT_KEY);
  expect(raw).not.toBeNull();
  return { raw: raw as string, storage, live };
}

function withoutSavedAt(raw: string): unknown {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.savedAt;
  return parsed;
}

describe('the card theme never touches the game save (A-6, SPEC §5.7)', () => {
  it('the same game saved under Classic and under Mythic is identical (bar the timestamp)', async () => {
    await createWasmEngine();
    const classic = await playWithTheme('vector');
    const mythic = await playWithTheme('mythic');
    expect(withoutSavedAt(mythic.raw)).toEqual(withoutSavedAt(classic.raw));
  }, 15_000);

  it('the save names no theme, and the game store writes nothing but the snapshot', async () => {
    await createWasmEngine();
    const { raw, storage } = await playWithTheme('mythic');
    expect(raw).not.toMatch(/mythic|themeId/);
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(SNAPSHOT_KEY);
    // the choice itself persists, under the settings key only
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) as string).themeId).toBe('mythic');
  }, 15_000);

  it('a save made under Classic resumes identically with Mythic chosen, and vice versa', async () => {
    await createWasmEngine();
    for (const [saveTheme, resumeTheme] of [
      ['vector', 'mythic'],
      ['mythic', 'vector'],
    ]) {
      const { raw, live } = await playWithTheme(saveTheme);
      settings.setThemeId(resumeTheme);
      const restoredStorage = fakeStorage();
      restoredStorage.setItem(SNAPSHOT_KEY, raw);
      const reloaded = new GameStore({ storage: restoredStorage, session: new SessionStore() });
      await reloaded.restore();
      expect(reloaded.curtain).toEqual(live.curtain);
      expect(reloaded.history).toEqual(live.history);
      await advance(live);
      await advance(reloaded);
      expect(reloaded.viewer).toBe(live.viewer);
      expect(reloaded.view).toEqual(live.view);
      expect(reloaded.envelope?.legalMoves).toEqual(live.envelope?.legalMoves);
    }
    settings.setThemeId('vector');
  }, 30_000);
});
