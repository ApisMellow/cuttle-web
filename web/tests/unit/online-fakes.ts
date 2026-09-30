// Test-only fakes for the two-phone client connection module (W11). Not a
// *.test.ts file, so vitest does not collect it as a suite.
//
// FakeSocket stands in for a browser WebSocket: the test plays the server by
// calling serverOpen / serverSend / serverClose. FakeEnvironment stands in
// for navigator.onLine, document.visibilityState and their events.

import type { ConnectionEnvironment, EnvironmentEvent, SocketLike } from '../../src/lib/online/connection';
import { appliedMove, envelope, Kind, playerView } from './game-test-support';
import type { PlayerId } from '../../src/lib/bridge/schema';

export const ORIGIN = 'https://cuttle.example.com';
export const WS_URL = 'wss://cuttle.example.com/api/play';
/** A token shaped like the server's: 32 random bytes, base64url. Fixture only. */
export const TOKEN = 'q9Zt3vYkP1xLm8Rw0aBcDeFgHiJkLmNoPqRsTuVwXyZ';
export const CODE = 'K7QX';

export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('FakeSocket.send while not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  /** Frames the client sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

export function socketFactory() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string): FakeSocket => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return {
    factory,
    sockets,
    get last(): FakeSocket {
      const s = sockets.at(-1);
      if (!s) throw new Error('no socket created yet');
      return s;
    },
  };
}

export class FakeEnvironment implements ConnectionEnvironment {
  online = true;
  visible = true;
  readonly listeners = new Map<EnvironmentEvent, Set<() => void>>();

  isOnline(): boolean {
    return this.online;
  }

  isVisible(): boolean {
    return this.visible;
  }

  listen(type: EnvironmentEvent, fn: () => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  fire(type: EnvironmentEvent): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  goOffline(): void {
    this.online = false;
    this.fire('offline');
  }

  goOnline(): void {
    this.online = true;
    this.fire('online');
  }

  hide(): void {
    this.visible = false;
    this.fire('visibilitychange');
  }

  show(): void {
    this.visible = true;
    this.fire('visibilitychange');
  }
}

export function welcomeFrame(seat: PlayerId = 0) {
  return { t: 'welcome', seat, names: ['Alice', 'Blake'], status: 'playing' };
}

/** A wire-true state frame for `viewer`, with `seq` history entries. */
export function stateFrame(opts: { viewer?: PlayerId; seq?: number; game?: number } = {}) {
  const viewer = opts.viewer ?? 0;
  const seq = opts.seq ?? 0;
  const history = Array.from({ length: seq }, (_, i) =>
    appliedMove({ by: (i % 2) as PlayerId, kind: Kind.Draw, description: 'Draw a card', seq: i + 1 }),
  );
  return {
    t: 'state',
    game: opts.game ?? 1,
    envelope: envelope({ state: playerView({ viewer }), history }),
    opponentOnline: true,
    tally: [0, 0],
  };
}
