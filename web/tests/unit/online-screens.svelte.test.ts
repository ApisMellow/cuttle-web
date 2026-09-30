// @vitest-environment jsdom
// Two-phone screens (W13a): Create, Waiting, Join and the OnlineFlow router,
// against the fake OnlineActions. Success and every error.
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateRoomScreen from '../../src/lib/components/CreateRoomScreen.svelte';
import JoinRoomScreen from '../../src/lib/components/JoinRoomScreen.svelte';
import OnlineFlow from '../../src/lib/components/OnlineFlow.svelte';
import WaitingScreen from '../../src/lib/components/WaitingScreen.svelte';
import {
  createFakeOnlineActions,
  ERROR_TEXT,
  type FakeOnlineActions,
  type OnlineErrorCode,
} from '../../src/lib/online/actions';
import { online } from '../../src/lib/stores/online.svelte';
import { settings } from '../../src/lib/stores/settings.svelte';

let host: HTMLDivElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(component: Component<any>, props: Record<string, unknown>): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.append(host);
  instance = mount(component, { target: host, props });
  flushSync();
  return host;
}

function cleanup(): void {
  if (instance) unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
}

function q<T extends HTMLElement>(el: HTMLElement, id: string): T {
  const found = el.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function submit(form: HTMLElement): void {
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
}

async function settle(): Promise<void> {
  await vi.waitFor(() => flushSync());
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  settings.lastNames = null;
  online.close();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ERRORS: OnlineErrorCode[] = ['not-found', 'full', 'expired', 'network', 'rate-limited'];

describe('CreateRoomScreen', () => {
  it('creates a room with the trimmed name and reports the code', async () => {
    const actions = createFakeOnlineActions({ code: 'K7QX' });
    const onCreated = vi.fn();
    const el = render(CreateRoomScreen, { actions, onCreated, onBack: vi.fn() });
    type(q(el, 'online-name-input'), '  Alice ');
    submit(q(el, 'create-screen'));
    await settle();
    expect(actions.calls.create).toEqual(['Alice']);
    expect(onCreated).toHaveBeenCalledWith('K7QX');
  });

  it('asks for a name and does not call the server when it is blank', async () => {
    const actions = createFakeOnlineActions();
    const el = render(CreateRoomScreen, { actions, onCreated: vi.fn(), onBack: vi.fn() });
    submit(q(el, 'create-screen'));
    await settle();
    expect(actions.calls.create).toEqual([]);
    expect(q(el, 'online-error').textContent).toContain('Enter your name');
  });

  it.each(ERRORS)('shows the %s error and stays put', async (error) => {
    const actions = createFakeOnlineActions({ createError: error });
    const onCreated = vi.fn();
    const el = render(CreateRoomScreen, { actions, onCreated, onBack: vi.fn() });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'create-screen'));
    await settle();
    expect(onCreated).not.toHaveBeenCalled();
    expect(q(el, 'online-error').textContent).toBe(ERROR_TEXT[error]);
  });

  it('labels its field, focuses it, and Back works', () => {
    const onBack = vi.fn();
    const el = render(CreateRoomScreen, { actions: createFakeOnlineActions(), onCreated: vi.fn(), onBack });
    const input = q<HTMLInputElement>(el, 'online-name-input');
    expect(input.closest('label')?.textContent).toContain('Your name');
    expect(input.maxLength).toBe(20);
    q(el, 'online-back').click();
    expect(onBack).toHaveBeenCalled();
  });
});

describe('WaitingScreen', () => {
  const base = 'https://example.test/cuttle-web/';

  it('shows the code large with a spoken label, the link, and waiting copy', () => {
    const el = render(WaitingScreen, {
      actions: createFakeOnlineActions(),
      code: 'K7QX',
      onJoined: vi.fn(),
      onCancel: vi.fn(),
      shareEnv: {},
      base,
    });
    expect(q(el, 'room-code').textContent?.trim()).toBe('K7QX');
    expect(q(el, 'room-code').getAttribute('aria-label')).toBe('Room code K 7 Q X');
    expect(q(el, 'invite-link').textContent).toBe(`${base}#/join/K7QX`);
    expect(q(el, 'waiting-status').textContent).toContain('Waiting for someone to join');
  });

  it('Share uses the share sheet when there is one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const el = render(WaitingScreen, {
      actions: createFakeOnlineActions(),
      code: 'K7QX',
      onJoined: vi.fn(),
      onCancel: vi.fn(),
      shareEnv: { share },
      base,
    });
    q(el, 'share-invite').click();
    await settle();
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${base}#/join/K7QX` }));
    expect(q(el, 'share-status').textContent).toBe('');
  });

  it('Share falls back to copying and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const el = render(WaitingScreen, {
      actions: createFakeOnlineActions(),
      code: 'K7QX',
      onJoined: vi.fn(),
      onCancel: vi.fn(),
      shareEnv: { writeText },
      base,
    });
    q(el, 'share-invite').click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(`${base}#/join/K7QX`);
    expect(q(el, 'share-status').textContent).toContain('Link copied');
  });

  it('points to the code when neither share nor copy works', async () => {
    const el = render(WaitingScreen, {
      actions: createFakeOnlineActions(),
      code: 'K7QX',
      onJoined: vi.fn(),
      onCancel: vi.fn(),
      shareEnv: {},
      base,
    });
    q(el, 'copy-link').click();
    await settle();
    expect(q(el, 'share-status').textContent).toContain('code instead');
  });

  it('Cancel gives up the room and goes back', async () => {
    const actions = createFakeOnlineActions();
    const onCancel = vi.fn();
    const el = render(WaitingScreen, { actions, code: 'K7QX', onJoined: vi.fn(), onCancel, shareEnv: {}, base });
    q(el, 'cancel-room').click();
    await settle();
    expect(actions.calls.cancel).toBe(1);
    expect(onCancel).toHaveBeenCalled();
  });

  it('hands off when the guest joins, and stops listening on unmount', () => {
    const actions = createFakeOnlineActions();
    const onJoined = vi.fn();
    render(WaitingScreen, { actions, code: 'K7QX', onJoined, onCancel: vi.fn(), shareEnv: {}, base });
    actions.emit({ kind: 'opponent-joined', opponentName: 'Blake' });
    expect(onJoined).toHaveBeenCalledWith('Blake');
    cleanup();
    actions.emit({ kind: 'opponent-joined', opponentName: 'Blake' });
    expect(onJoined).toHaveBeenCalledTimes(1);
  });
});

describe('JoinRoomScreen', () => {
  function join(actions: FakeOnlineActions, props: Record<string, unknown> = {}) {
    const onJoined = vi.fn();
    const el = render(JoinRoomScreen, { actions, onJoined, onBack: vi.fn(), ...props });
    return { el, onJoined };
  }

  it('prefills the code from a link and focuses the name', () => {
    const { el } = join(createFakeOnlineActions(), { initialCode: 'ABCD' });
    expect(q<HTMLInputElement>(el, 'join-code-input').value).toBe('ABCD');
    expect(document.activeElement).toBe(q(el, 'online-name-input'));
  });

  it('starts on the code when typing it by hand', () => {
    const { el } = join(createFakeOnlineActions());
    expect(q<HTMLInputElement>(el, 'join-code-input').value).toBe('');
    // Not attached to focus in jsdom until mounted into the document: it is.
    expect(document.activeElement).toBe(q(el, 'join-code-input'));
  });

  it('joins, normalizing case and look-alikes', async () => {
    const actions = createFakeOnlineActions();
    const { el, onJoined } = join(actions);
    type(q(el, 'join-code-input'), 'k7qx');
    type(q(el, 'online-name-input'), 'Blake');
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join).toEqual([{ code: 'K7QX', name: 'Blake' }]);
    expect(onJoined).toHaveBeenCalledWith('Alice');
  });

  it('accepts O for 0 and I or L for 1', async () => {
    const actions = createFakeOnlineActions();
    const { el } = join(actions);
    type(q(el, 'join-code-input'), 'ol1i');
    type(q(el, 'online-name-input'), 'Blake');
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join[0]?.code).toBe('0111');
  });

  it('rejects a malformed code without calling the server', async () => {
    const actions = createFakeOnlineActions();
    const { el } = join(actions);
    type(q(el, 'join-code-input'), 'AB');
    type(q(el, 'online-name-input'), 'Blake');
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join).toEqual([]);
    expect(q(el, 'online-error').textContent).toContain('4 letters and numbers');
  });

  it('asks for a name', async () => {
    const actions = createFakeOnlineActions();
    const { el } = join(actions, { initialCode: 'ABCD' });
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join).toEqual([]);
    expect(q(el, 'online-error').textContent).toContain('Enter your name');
  });

  it.each(ERRORS)('shows the %s error', async (error) => {
    const actions = createFakeOnlineActions({ joinError: error });
    const { el, onJoined } = join(actions, { initialCode: 'ABCD' });
    type(q(el, 'online-name-input'), 'Blake');
    submit(q(el, 'join-screen'));
    await settle();
    expect(onJoined).not.toHaveBeenCalled();
    expect(q(el, 'online-error').textContent).toBe(ERROR_TEXT[error]);
  });

  it.each([
    ['0000', 'not-found'],
    ['EEEE', 'expired'],
    ['FFFF', 'full'],
  ] as const)('the dev fake maps code %s to %s', async (code, error) => {
    const actions = createFakeOnlineActions();
    const { el } = join(actions, { initialCode: code });
    type(q(el, 'online-name-input'), 'Blake');
    submit(q(el, 'join-screen'));
    await settle();
    expect(q(el, 'online-error').textContent).toBe(ERROR_TEXT[error]);
  });

  it('explains a bad link and leaves manual entry open', () => {
    const { el } = join(createFakeOnlineActions(), { badLink: true });
    expect(q(el, 'online-error').textContent).toContain('link doesn’t look right');
  });

  it('gives every input a label and the buttons a 44px floor', () => {
    const { el } = join(createFakeOnlineActions());
    for (const input of el.querySelectorAll('input')) expect(input.closest('label')).not.toBeNull();
    expect(q(el, 'join-room').className).toContain('ol-button');
  });
});

// Review F3: a join link (or a create) never silently replaces a saved seat.
describe('a saved online seat asks before it is replaced', () => {
  const saved = { code: 'WXYZ', opponentName: 'Blake' };

  it('join: asks first, names the opponent, and joins only after "Leave it"', async () => {
    const actions = createFakeOnlineActions({ saved });
    const onJoined = vi.fn();
    const el = render(JoinRoomScreen, { actions, onJoined, onBack: vi.fn(), initialCode: 'K7QX' });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join).toEqual([]);
    expect(el.textContent).toContain('You have a game with Blake in progress. Leave it and join this one?');
    q(el, 'replace-seat-leave').click();
    await settle();
    expect(actions.calls.leave).toBe(1);
    expect(actions.savedSeat()).toBeNull();
    expect(actions.calls.join).toEqual([{ code: 'K7QX', name: 'Alice' }]);
    expect(onJoined).toHaveBeenCalledWith('Alice');
  });

  it('join: "Keep my game" joins nothing, keeps the seat and goes back', async () => {
    const actions = createFakeOnlineActions({ saved });
    const onBack = vi.fn();
    const el = render(JoinRoomScreen, { actions, onJoined: vi.fn(), onBack, initialCode: 'K7QX' });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'join-screen'));
    await settle();
    q(el, 'replace-seat-keep').click();
    await settle();
    expect(actions.calls.join).toEqual([]);
    expect(actions.calls.leave).toBe(0);
    expect(actions.savedSeat()).toEqual(saved);
    expect(onBack).toHaveBeenCalled();
  });

  it('join: a link to the saved seat’s own room resumes it instead of joining again', async () => {
    const actions = createFakeOnlineActions({ saved });
    const onJoined = vi.fn();
    const el = render(JoinRoomScreen, { actions, onJoined, onBack: vi.fn(), initialCode: 'WXYZ' });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'join-screen'));
    await settle();
    expect(actions.calls.join).toEqual([]);
    expect(actions.calls.resume).toBe(1);
    expect(onJoined).toHaveBeenCalledWith('Blake');
  });

  it('join: with no saved seat nothing is asked', async () => {
    const actions = createFakeOnlineActions();
    const el = render(JoinRoomScreen, { actions, onJoined: vi.fn(), onBack: vi.fn(), initialCode: 'K7QX' });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'join-screen'));
    await settle();
    expect(el.querySelector('[data-testid="replace-seat-leave"]')).toBeNull();
    expect(actions.calls.join).toHaveLength(1);
  });

  it('join: an unnamed opponent still gets a plain question', async () => {
    const actions = createFakeOnlineActions({ saved: { code: 'WXYZ', opponentName: null } });
    const el = render(JoinRoomScreen, { actions, onJoined: vi.fn(), onBack: vi.fn(), initialCode: 'K7QX' });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'join-screen'));
    await settle();
    expect(el.textContent).toContain('You have an online game in progress. Leave it and join this one?');
  });

  it('create: asks first, and creates only after "Leave it"', async () => {
    const actions = createFakeOnlineActions({ saved, code: 'K7QX' });
    const onCreated = vi.fn();
    const el = render(CreateRoomScreen, { actions, onCreated, onBack: vi.fn() });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'create-screen'));
    await settle();
    expect(actions.calls.create).toEqual([]);
    expect(el.textContent).toContain('You have a game with Blake in progress. Leave it and start a new one?');
    q(el, 'replace-seat-leave').click();
    await settle();
    expect(actions.calls.leave).toBe(1);
    expect(actions.calls.create).toEqual(['Alice']);
    expect(onCreated).toHaveBeenCalledWith('K7QX');
  });
});

describe('OnlineFlow', () => {
  it('walks create -> waiting -> connected', async () => {
    const actions = createFakeOnlineActions({ code: 'K7QX' });
    online.openCreate();
    const el = render(OnlineFlow, { actions });
    type(q(el, 'online-name-input'), 'Alice');
    submit(q(el, 'create-screen'));
    await settle();
    expect(q(el, 'room-code').textContent?.trim()).toBe('K7QX');
    actions.emit({ kind: 'opponent-joined', opponentName: 'Blake' });
    flushSync();
    expect(q(el, 'online-connected').textContent).toContain('Blake');
  });

  it('opens the join screen prefilled from a link hash', () => {
    expect(online.applyHash('#/join/abcd')).toBe(true);
    const el = render(OnlineFlow, { actions: createFakeOnlineActions() });
    expect(q<HTMLInputElement>(el, 'join-code-input').value).toBe('ABCD');
  });

  it('a bad link opens manual entry with a hint', () => {
    expect(online.applyHash('#/join/zz')).toBe(true);
    const el = render(OnlineFlow, { actions: createFakeOnlineActions() });
    expect(q<HTMLInputElement>(el, 'join-code-input').value).toBe('');
    expect(q(el, 'online-error')).not.toBeNull();
  });

  it('ignores other hashes', () => {
    expect(online.applyHash('#/other')).toBe(false);
    expect(online.view).toBe('none');
  });
});
