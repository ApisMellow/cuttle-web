// @vitest-environment jsdom
// SPEC §6.1, §6.3 — StagingBar shows the staged description verbatim with
// Confirm/Cancel, and is disabled while applying. Testids and the 44px tap
// target floor are contract (AGENTS.md "Testids and tap targets").
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StagingBar from '../../src/lib/components/StagingBar.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  description: string;
  disabled?: boolean;
  onconfirm?: () => void;
  oncancel?: () => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(StagingBar, { target: host, props });
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

function bar(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>('[data-testid="staging-bar"]');
  if (!found) throw new Error('no staging-bar rendered');
  return found;
}

function confirmButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-testid="staging-confirm"]')!;
}

function cancelButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-testid="staging-cancel"]')!;
}

describe('StagingBar', () => {
  it('shows the description verbatim, engine text and all', () => {
    const el = render({ description: 'play A♥ as one-off' });
    expect(bar(el).textContent).toContain('play A♥ as one-off');
  });

  it('carries exactly the three contract testids (the real 44px box sweep is Playwright\'s, SPEC §5.9/§7.4)', () => {
    const el = render({ description: 'draw a card' });
    const ids = [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    expect(ids.sort()).toEqual(['staging-bar', 'staging-cancel', 'staging-confirm']);
  });

  it('calls onconfirm when Confirm is tapped, and oncancel when Cancel is tapped', () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    const el = render({ description: 'draw a card', onconfirm, oncancel });

    confirmButton(el).click();
    expect(onconfirm).toHaveBeenCalledTimes(1);
    expect(oncancel).not.toHaveBeenCalled();

    cancelButton(el).click();
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while applying, and a click fires neither callback', () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    const el = render({ description: 'draw a card', disabled: true, onconfirm, oncancel });

    expect(confirmButton(el).disabled).toBe(true);
    expect(cancelButton(el).disabled).toBe(true);

    confirmButton(el).click();
    cancelButton(el).click();
    expect(onconfirm).not.toHaveBeenCalled();
    expect(oncancel).not.toHaveBeenCalled();
  });
});
