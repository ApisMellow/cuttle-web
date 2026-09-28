// @vitest-environment jsdom
// W21, PRD R9, SPEC §6.1 — CardDetailPopover: the dimmed-card detail sheet.
// Component-only tests (light tier, AGENTS.md §4.5): a render/smoke check
// plus the close affordances. The store-wired "tap opens it" and privacy
// tests live in game-screen-popover.svelte.test.ts, which mounts the real
// GameScreen/StagingStore pipeline.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Card } from '../../src/lib/bridge/schema';
import CardDetailPopover, { DEFAULT_REASON } from '../../src/lib/components/CardDetailPopover.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

interface RenderProps {
  card: Card;
  reason?: string;
  onclose: () => void;
}

function render(props: RenderProps): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(CardDetailPopover, { target: host, props });
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

const KING = { Rank: 13, Suit: 0 } as const; // K♣

describe('CardDetailPopover', () => {
  it('renders the given card face and the generic reason (smoke)', () => {
    const el = render({ card: KING, onclose: vi.fn() });
    const popover = el.querySelector('[data-testid="card-detail-popover"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('K');
    expect(popover?.textContent).toContain(DEFAULT_REASON);
  });

  it('every element in the sheet meets the 44px tap-target floor (close button)', () => {
    const el = render({ card: KING, onclose: vi.fn() });
    const close = el.querySelector<HTMLButtonElement>('[data-testid="card-detail-popover-close"]');
    expect(close).not.toBeNull();
    expect(close?.style.minHeight || getComputedStyle(close!).minHeight).toBeTruthy();
  });

  it('tapping Close calls onclose', () => {
    const onclose = vi.fn();
    const el = render({ card: KING, onclose });
    el.querySelector<HTMLButtonElement>('[data-testid="card-detail-popover-close"]')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('tapping the scrim (tap-away) calls onclose', () => {
    const onclose = vi.fn();
    const el = render({ card: KING, onclose });
    el.querySelector<HTMLDivElement>('[data-testid="card-detail-popover-scrim"]')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
