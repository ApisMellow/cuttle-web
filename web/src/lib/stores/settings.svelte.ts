// SPEC §5.6 rule 5, §5.7 — user preferences (card theme id, reduced motion,
// hold-vs-two-step reveal preference), persisted under their own
// `localStorage` key, independently of the game snapshot key
// (`SNAPSHOT_KEY = 'cuttle-web:game'`, §5.7).
//
// Every storage read and write is wrapped so a throwing or empty
// `localStorage` (private browsing, quota, disabled storage, or a stray
// malformed value) falls back to defaults without crashing — settings are
// a convenience, never a hard dependency of the app booting.

export const SETTINGS_KEY = 'cuttle-web:settings';

export type RevealPreference = 'hold' | 'two-step';

interface StoredSettings {
  themeId: string;
  reducedMotion: boolean;
  revealPreference: RevealPreference;
}

// SPEC §5.6 rule 4: 'vector' is always available and is the fallback theme.
// No SPEC-mandated default for the other two; assumption recorded in the
// developer report (motion on / hold-reveal as the primary interaction).
const DEFAULTS: StoredSettings = {
  themeId: 'vector',
  reducedMotion: false,
  revealPreference: 'hold',
};

function isRevealPreference(value: unknown): value is RevealPreference {
  return value === 'hold' || value === 'two-step';
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
  return result;
}

function writeStoredSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable — in-memory state still works, it just won't
    // survive a reload this run.
  }
}

export class SettingsStore {
  #initial = readStoredSettings();

  themeId = $state<string>(this.#initial.themeId ?? DEFAULTS.themeId);
  reducedMotion = $state<boolean>(this.#initial.reducedMotion ?? DEFAULTS.reducedMotion);
  revealPreference = $state<RevealPreference>(this.#initial.revealPreference ?? DEFAULTS.revealPreference);

  #persist(): void {
    writeStoredSettings({
      themeId: this.themeId,
      reducedMotion: this.reducedMotion,
      revealPreference: this.revealPreference,
    });
  }

  /** SPEC §5.6 rule 5: the theme-toggle menu control calls this. */
  setThemeId(id: string): void {
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
}

export const settings = new SettingsStore();
