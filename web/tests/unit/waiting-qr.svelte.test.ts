// @vitest-environment jsdom
// The waiting-screen QR follows the room code: one mounted instance, the
// `code` prop changed through a $state object.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WaitingScreen from '../../src/lib/components/WaitingScreen.svelte';
import { createFakeOnlineActions } from '../../src/lib/online/actions';
import { qrMatrix, qrPath } from '../../src/lib/online/qr';

const base = 'https://example.test/cuttle-web/';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

describe('WaitingScreen QR', () => {
  it('redraws when the code prop changes', () => {
    const props = $state({
      actions: createFakeOnlineActions(),
      code: 'K7QX',
      onJoined: vi.fn(),
      onCancel: vi.fn(),
      shareEnv: {},
      base,
    });
    host = document.createElement('div');
    document.body.append(host);
    instance = mount(WaitingScreen, { target: host, props });
    flushSync();

    const d = (): string | null =>
      host!.querySelector('[data-testid="invite-qr"] path')?.getAttribute('d') ?? null;
    const first = d();
    expect(first).toBe(qrPath(qrMatrix(`${base}#/join/K7QX`)));

    props.code = 'ABCD';
    flushSync();
    expect(d()).toBe(qrPath(qrMatrix(`${base}#/join/ABCD`)));
    expect(d()).not.toBe(first);
    expect(host.querySelector('[data-testid="invite-link"]')?.textContent).toBe(`${base}#/join/ABCD`);
  });
});
