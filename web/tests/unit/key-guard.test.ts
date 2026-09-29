// @vitest-environment jsdom
// lib/keyGuard.ts (r16 review B1/B2, issue #24): a click produced by a stale
// or auto-repeated key is refused; a pointer click is always allowed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keyActivationGuard, type KeyActivationGuard } from '../../src/lib/keyGuard';

function key(type: 'keydown' | 'keyup', k: string, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: k, repeat, bubbles: true }));
}

describe('keyActivationGuard', () => {
  let guard: KeyActivationGuard | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    guard?.dispose();
    guard = null;
    vi.useRealTimers();
  });

  it('allows a fresh Enter and refuses an auto-repeated Enter', () => {
    guard = keyActivationGuard();
    key('keydown', 'Enter');
    expect(guard.allows()).toBe(true);
    key('keydown', 'Enter', true);
    expect(guard.allows()).toBe(false);
  });

  it('refuses a Space keyup whose keydown came before mount', () => {
    key('keydown', ' ');
    guard = keyActivationGuard();
    key('keyup', ' ');
    expect(guard.allows()).toBe(false);
  });

  it('allows a Space keyup whose keydown came after mount', () => {
    guard = keyActivationGuard();
    key('keydown', ' ');
    key('keyup', ' ');
    expect(guard.allows()).toBe(true);
  });

  it('allows a pointer click with no key in flight', () => {
    guard = keyActivationGuard();
    expect(guard.allows()).toBe(true);
    // A refused key clears on the next task, so a later pointer click passes.
    key('keydown', 'Enter', true);
    expect(guard.allows()).toBe(false);
    vi.runAllTimers();
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(guard.allows()).toBe(true);
  });

  it('stops listening once disposed', () => {
    guard = keyActivationGuard();
    guard.dispose();
    key('keydown', 'Enter', true);
    expect(guard.allows()).toBe(true);
  });
});
