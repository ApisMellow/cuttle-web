import { afterEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_KEY, SettingsStore } from '../../src/lib/stores/settings.svelte';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('settings store (SPEC §5.6 rule 5, §5.7)', () => {
  it('defaults to vector theme, motion on, hold reveal when storage is empty', () => {
    const store = new SettingsStore();
    expect(store.themeId).toBe('vector');
    expect(store.reducedMotion).toBe(false);
    expect(store.revealPreference).toBe('hold');
  });

  it('persists under its own key, separate from the game snapshot key', () => {
    expect(SETTINGS_KEY).not.toBe('cuttle-web:game');

    const store = new SettingsStore();
    store.setThemeId('art-v1');

    const raw = localStorage.getItem(SETTINGS_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).themeId).toBe('art-v1');
  });

  it('round-trips every field across a simulated reload', () => {
    const store = new SettingsStore();
    store.setThemeId('art-v1');
    store.setReducedMotion(true);
    store.setRevealPreference('two-step');

    const reloaded = new SettingsStore();
    expect(reloaded.themeId).toBe('art-v1');
    expect(reloaded.reducedMotion).toBe(true);
    expect(reloaded.revealPreference).toBe('two-step');
  });

  it('SPEC §5.6 rule 5: theme choice persists independently of game-state persistence', () => {
    const store = new SettingsStore();
    store.setThemeId('art-v1');

    expect(localStorage.getItem('cuttle-web:game')).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull();
  });

  it('falls back to defaults when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => new SettingsStore()).not.toThrow();
    const store = new SettingsStore();
    expect(store.themeId).toBe('vector');
    expect(store.reducedMotion).toBe(false);
    expect(store.revealPreference).toBe('hold');
  });

  it('falls back to defaults when the stored value is malformed JSON', () => {
    localStorage.setItem(SETTINGS_KEY, 'not json{{{');
    expect(() => new SettingsStore()).not.toThrow();
    const store = new SettingsStore();
    expect(store.themeId).toBe('vector');
  });

  it('falls back to defaults when the stored value is not an object', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify('vector'));
    const store = new SettingsStore();
    expect(store.themeId).toBe('vector');
  });

  it('does not crash and keeps in-memory state when localStorage.setItem throws', () => {
    const store = new SettingsStore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => store.setThemeId('art-v1')).not.toThrow();
    expect(store.themeId).toBe('art-v1');
  });

  it('partial stored settings fall back to defaults for missing fields', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ themeId: 'art-v1' }));
    const store = new SettingsStore();
    expect(store.themeId).toBe('art-v1');
    expect(store.reducedMotion).toBe(false);
    expect(store.revealPreference).toBe('hold');
  });
});
