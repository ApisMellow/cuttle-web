// @vitest-environment jsdom
// SPEC §5.2 GameScreen — skeleton only this round (W12). The board, curtain
// and staging components are other work items; this component's whole job
// is to mount safely and leak nothing but the session names.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import GameScreen from '../../src/lib/components/GameScreen.svelte';
import { session } from '../../src/lib/stores/session.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

function render(): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(GameScreen, { target: host });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

beforeEach(() => {
  session.setNames('', ''); // reset the shared singleton to defaults
});

afterEach(cleanup);

describe('GameScreen skeleton (SPEC §5.2)', () => {
  it('carries the game-screen testid', () => {
    const el = render();
    expect(el.querySelector('[data-testid="game-screen"]')).not.toBeNull();
  });

  it('shows the session names and nothing else with a data-testid', () => {
    session.setNames('Alice', 'Bob');
    const el = render();
    expect(el.textContent).toContain('Alice');
    expect(el.textContent).toContain('Bob');
    const ids = [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    expect(ids).toEqual(['game-screen']);
  });

  it('defaults to "Player 1" / "Player 2" when no names were set (R1.3)', () => {
    const el = render();
    expect(el.textContent).toContain('Player 1');
    expect(el.textContent).toContain('Player 2');
  });
});
