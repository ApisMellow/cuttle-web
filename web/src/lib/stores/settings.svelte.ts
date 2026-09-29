// SPEC §5.6 rule 5, §5.7 — user preferences (card theme id, reduced motion,
// hold-vs-two-step reveal preference, and the last-used player names so the
// home screen can pre-fill them after a reload, and table mode, issue #37),
// persisted under their own `localStorage` key, independently of the game
// snapshot key (`SNAPSHOT_KEY = 'cuttle-web:game'`, §5.7).
//
// Every storage read and write is wrapped so a throwing or empty
// `localStorage` (private browsing, quota, disabled storage, or a stray
// malformed value) falls back to defaults without crashing — settings are
// a convenience, never a hard dependency of the app booting.

import { DEFAULT_THEME_ID } from '../theme/default';

export const SETTINGS_KEY = 'cuttle-web:settings';

export type RevealPreference = 'hold' | 'two-step';

interface StoredSettings {
  themeId: string;
  reducedMotion: boolean;
  revealPreference: RevealPreference;
  /** R10: the names last typed on the home screen, trimmed and capped at NAME_MAX_LENGTH; '' for a blank field. */
  lastNames: [string, string] | null;
  /** Issue #37, SPEC §5.10: the phone lies flat between the players; player 2's screens are turned 180°. */
  tableMode: boolean;
}

// SPEC §5.6 rule 4: 'vector' is always available and is the fallback theme.
// No SPEC-mandated default for the other two; assumption recorded in the
// developer report (motion on / hold-reveal as the primary interaction).
const DEFAULTS: StoredSettings = {
  themeId: DEFAULT_THEME_ID,
  reducedMotion: false,
  revealPreference: 'hold',
  lastNames: null,
  // Normal pass-and-play stays the default (issue #37).
  tableMode: false,
};

function isRevealPreference(value: unknown): value is RevealPreference {
  return value === 'hold' || value === 'two-step';
}

/** R10: longest remembered name; anything longer is cut (a name field, not a document). */
export const NAME_MAX_LENGTH = 40;

function cleanName(name: string): string {
  return name.trim().slice(0, NAME_MAX_LENGTH).trim();
}

function isNamePair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string');
}

function readStoredSettings(): Partial<StoredSettings> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const obj = parsed as Record<string, unknown>;
  const result: Partial<StoredSettings> = {};
  if (typeof obj.themeId === 'string') result.themeId = obj.themeId;
  if (typeof obj.reducedMotion === 'boolean') result.reducedMotion = obj.reducedMotion;
  if (isRevealPreference(obj.revealPreference)) result.revealPreference = obj.revealPreference;
  if (typeof obj.tableMode === 'boolean') result.tableMode = obj.tableMode;
  if (isNamePair(obj.lastNames)) result.lastNames = [cleanName(obj.lastNames[0]), cleanName(obj.lastNames[1])];
  return result;
}

function writeStoredSettings(settings: Omit<StoredSettings, 'themeId'> & { themeId: string | undefined }): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable — in-memory state still works, it just won't
    // survive a reload this run.
  }
}

export class SettingsStore {
  #initial = readStoredSettings();
  // Mythic default (2026-09-29): `themeId` is saved only once a player has
  // picked a style (or a saved one was read). Saving names alone never pins
  // whichever style is the default.
  #themeChosen = this.#initial.themeId !== undefined;

  themeId = $state<string>(this.#initial.themeId ?? DEFAULTS.themeId);
  reducedMotion = $state<boolean>(this.#initial.reducedMotion ?? DEFAULTS.reducedMotion);
  revealPreference = $state<RevealPreference>(this.#initial.revealPreference ?? DEFAULTS.revealPreference);
  lastNames = $state<[string, string] | null>(this.#initial.lastNames ?? DEFAULTS.lastNames);
  tableMode = $state<boolean>(this.#initial.tableMode ?? DEFAULTS.tableMode);

  #persist(): void {
    writeStoredSettings({
      themeId: this.#themeChosen ? this.themeId : undefined,
      reducedMotion: this.reducedMotion,
      revealPreference: this.revealPreference,
      lastNames: this.lastNames,
      tableMode: this.tableMode,
    });
  }

  /** SPEC §5.6 rule 5: the theme-toggle menu control calls this. */
  setThemeId(id: string): void {
    this.#themeChosen = true;
    this.themeId = id;
    this.#persist();
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.#persist();
  }

  setRevealPreference(preference: RevealPreference): void {
    this.revealPreference = preference;
    this.#persist();
  }

  /**
   * Issue #37, SPEC §5.10: the home-screen toggle calls this. A game in
   * progress picks the change up at its next curtain or view change, never
   * in the middle of a turn (GameScreen latches it).
   */
  setTableMode(value: boolean): void {
    this.tableMode = value;
    this.#persist();
  }

  /** R10: HomeScreen saves the names it starts a game with, so a reload with no saved game can pre-fill them. */
  setLastNames(player1: string, player2: string): void {
    this.lastNames = [cleanName(player1), cleanName(player2)];
    this.#persist();
  }
}

export const settings = new SettingsStore();
