// SPEC §4.5 — the press-and-hold reveal gate. The controller is timer-
// injectable, so these tests drive a fake clock instead of real time.

import { describe, expect, it } from 'vitest';

import { HOLD_DURATION_MS, createHoldGate } from '../../src/lib/curtain';
import type { HoldScheduler } from '../../src/lib/curtain';

function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: HoldScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  function tick(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  }
  return { scheduler, tick, pending: () => timers.size };
}

describe('reveal hold gate — SPEC §4.5', () => {
  it('R13.3: the hold duration is the single constant 600 ms', () => {
    expect(HOLD_DURATION_MS).toBe(600);
  });

  it('R13.3: pointerdown starts the hold and reaching 600 ms fires the reveal exactly once', () => {
    const { scheduler, tick } = fakeScheduler();
    let reveals = 0;
    const gate = createHoldGate({ onReveal: () => reveals++, scheduler });
    expect(gate.progress()).toBe(0);
    gate.pointerdown();
    tick(300);
    expect(gate.progress()).toBeCloseTo(0.5);
    expect(reveals).toBe(0);
    tick(299);
    expect(reveals).toBe(0);
    tick(1);
    expect(reveals).toBe(1);
    expect(gate.revealed()).toBe(true);
    expect(gate.progress()).toBe(1);
    // Releasing after the reveal, or pressing again, changes nothing.
    gate.pointerup();
    gate.pointerdown();
    tick(1000);
    expect(reveals).toBe(1);
    expect(gate.progress()).toBe(1);
  });

  for (const abort of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    it(`R13.3: ${abort} before 600 ms aborts the reveal and resets the progress ring to 0`, () => {
      const { scheduler, tick, pending } = fakeScheduler();
      let reveals = 0;
      const gate = createHoldGate({ onReveal: () => reveals++, scheduler });
      gate.pointerdown();
      tick(599);
      expect(gate.progress()).toBeGreaterThan(0.99);
      gate[abort]();
      expect(gate.progress()).toBe(0);
      expect(gate.holding()).toBe(false);
      expect(pending()).toBe(0);
      tick(10_000);
      expect(reveals).toBe(0);
      expect(gate.revealed()).toBe(false);
      // A fresh full hold still works after the abort.
      gate.pointerdown();
      tick(HOLD_DURATION_MS);
      expect(reveals).toBe(1);
    });
  }

  it('R13.3: a second pointerdown mid-hold does not restart or double-schedule the timer', () => {
    const { scheduler, tick, pending } = fakeScheduler();
    let reveals = 0;
    const gate = createHoldGate({ onReveal: () => reveals++, scheduler });
    gate.pointerdown();
    tick(400);
    gate.pointerdown();
    expect(pending()).toBe(1);
    tick(200);
    expect(reveals).toBe(1);
  });

  it('R13.3: dispose cancels a hold in progress', () => {
    const { scheduler, tick, pending } = fakeScheduler();
    let reveals = 0;
    const gate = createHoldGate({ onReveal: () => reveals++, scheduler });
    gate.pointerdown();
    gate.dispose();
    expect(pending()).toBe(0);
    tick(1000);
    expect(reveals).toBe(0);
  });

  it('R13.3: pointerdown after dispose() does nothing', () => {
    const { scheduler, tick, pending } = fakeScheduler();
    let reveals = 0;
    const gate = createHoldGate({ onReveal: () => reveals++, scheduler });
    gate.dispose();
    gate.pointerdown();
    expect(gate.holding()).toBe(false);
    expect(pending()).toBe(0);
    tick(1000);
    expect(reveals).toBe(0);
    expect(gate.progress()).toBe(0);
  });
});
