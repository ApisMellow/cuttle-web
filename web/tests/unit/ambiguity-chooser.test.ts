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
  it('lists every candidate description verbatim, engine text and all', () => {
    const el = render({ candidates: CANDIDATES });
    const text = el.querySelector('[data-testid="ambiguity-chooser"]')!.textContent ?? '';
    expect(text).toContain('play A♥ as one-off');
    expect(text).toContain('play A♥ as point card');
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
