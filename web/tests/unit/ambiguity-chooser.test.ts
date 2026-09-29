// @vitest-environment jsdom
// SPEC §6.4 — the AmbiguityChooser: a modal list of the candidate
// descriptions[i] strings, each tappable, plus Cancel. Selecting one must
// only report the choice (via `onchoose`), never anything apply-shaped.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AmbiguityChooser from '../../src/lib/components/AmbiguityChooser.svelte';
import type { ChooserCandidate } from '../../src/lib/stores/staging.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  candidates: ChooserCandidate[];
  onchoose?: (index: number) => void;
  oncancel?: () => void;
  describe?: (candidate: ChooserCandidate) => string;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(AmbiguityChooser, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

afterEach(cleanup);

const CANDIDATES: ChooserCandidate[] = [
  { index: 3, description: 'play A♥ as one-off' },
  { index: 4, description: 'play A♥ as point card' },
];

describe('AmbiguityChooser', () => {
  it('amended 2026-09-28: each option is one plain line saying what it does, never the raw engine text', () => {
    const el = render({ candidates: CANDIDATES });
    const text = el.querySelector('[data-testid="ambiguity-chooser"]')!.textContent ?? '';
    expect(text).toContain('Play A♥ as a one-off: scrap every point card.');
    expect(text).toContain('Play A♥ for points.');
    expect(text).not.toContain('as point card');
    expect(text).not.toContain('as one-off');
  });

  it('the 9 on a point card: scuttle and one-off each say what happens (playtest friction 2026-09-28)', () => {
    const el = render({
      candidates: [
        { index: 6, description: 'play 9♣ as one-off' },
        { index: 7, description: "scuttle opponent's 4♣ with 9♣" },
      ],
    });
    const option = (i: number): string =>
      el.querySelector(`[data-testid="ambiguity-chooser-option-${i}"]`)?.textContent?.trim() ?? '';
    expect(option(6)).toBe('Play 9♣ as a one-off: send a card back to its owner’s hand.');
    expect(option(7)).toBe('Scuttle their 4♣ with 9♣: both cards go to the scrap.');
  });

  it('review B2: a describe prop (GameScreen\'s, which knows the 9 case) sets the option text', () => {
    const el = render({
      candidates: [{ index: 6, description: 'play 9♣ as one-off' }],
      describe: () => 'Play 9♣ as a one-off: your stolen card comes back to you.',
    });
    expect(el.querySelector('[data-testid="ambiguity-chooser-option-6"]')?.textContent?.trim()).toBe(
      'Play 9♣ as a one-off: your stolen card comes back to you.',
    );
  });

  it('tapping a candidate calls onchoose with its engine index, not its list position', () => {
    const onchoose = vi.fn();
    const el = render({ candidates: CANDIDATES, onchoose });
    el.querySelector<HTMLButtonElement>('[data-testid="ambiguity-chooser-option-4"]')!.click();
    expect(onchoose).toHaveBeenCalledTimes(1);
    expect(onchoose).toHaveBeenCalledWith(4);
  });

  it('tapping Cancel calls oncancel, never onchoose', () => {
    const onchoose = vi.fn();
    const oncancel = vi.fn();
    const el = render({ candidates: CANDIDATES, onchoose, oncancel });
    el.querySelector<HTMLButtonElement>('[data-testid="ambiguity-chooser-cancel"]')!.click();
    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(onchoose).not.toHaveBeenCalled();
  });

  it('every candidate gets its own option testid, and Cancel does not collide with the option prefix (AGENTS.md testid discipline; the 44px box sweep itself is Playwright\'s, SPEC §5.9/§7.4)', () => {
    const el = render({ candidates: CANDIDATES });
    for (const testid of ['ambiguity-chooser-option-3', 'ambiguity-chooser-option-4', 'ambiguity-chooser-cancel']) {
      expect(el.querySelector(`[data-testid="${testid}"]`)).not.toBeNull();
    }
    // A child testid must not match a sibling family's prefix selector —
    // the cancel button must not appear under the option prefix.
    expect(el.querySelectorAll('[data-testid^="ambiguity-chooser-option-"]').length).toBe(2);
  });
});
