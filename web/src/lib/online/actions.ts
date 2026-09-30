// Two-phone play: the seam between the Home/Create/Join screens and the
// connection layer. The screens know only this interface. W12 supplies the
// real implementation (REST create/join plus the WebSocket); tests and local
// dev use `createFakeOnlineActions` below.

export type OnlineErrorCode =
  | 'not-found'
  | 'full'
  | 'expired'
  | 'network'
  | 'rate-limited';

export type Result<T> = { ok: true; value: T } | { ok: false; error: OnlineErrorCode };

export interface CreatedRoom {
  /** 4 Crockford characters, uppercase. */
  code: string;
}

export interface JoinedRoom {
  code: string;
  /** The host's name, for "Connected with Alice". */
  opponentName: string;
}

/** What Home needs to offer "Resume online game with Blake". No token or game data. */
export interface SavedSeat {
  code: string;
  opponentName: string | null;
}

export type RoomEvent = { kind: 'opponent-joined'; opponentName: string };

export interface OnlineActions {
  createRoom(name: string): Promise<Result<CreatedRoom>>;
  joinRoom(code: string, name: string): Promise<Result<JoinedRoom>>;
  /** Give up a room that is still waiting for its second player. */
  cancelRoom(): Promise<void>;
  /** Events for the room this phone created. Returns an unsubscribe function. */
  onRoomEvent(handler: (event: RoomEvent) => void): () => void;
  /** W11 owns storage. One online game per phone: non-null means Home offers Resume only. */
  savedSeat(): SavedSeat | null;
  resume(): void;
}

export const ERROR_TEXT: Record<OnlineErrorCode, string> = {
  'not-found': 'No room has that code. Check it and try again.',
  full: 'That room already has two players.',
  expired: 'That room has expired. Ask your friend to start a new one.',
  network: 'Couldn’t reach the server. Check your connection and try again.',
  'rate-limited': 'Too many tries. Wait a little and try again.',
};

export interface FakeOptions {
  /** Code handed out by createRoom. */
  code?: string;
  /** Force every createRoom to fail. */
  createError?: OnlineErrorCode;
  /** Force every joinRoom to fail. Otherwise the dev codes below apply. */
  joinError?: OnlineErrorCode;
  saved?: SavedSeat | null;
  /** Simulated latency in ms. */
  delay?: number;
}

export interface FakeOnlineActions extends OnlineActions {
  calls: {
    create: string[];
    join: { code: string; name: string }[];
    cancel: number;
    resume: number;
  };
  /** Push a room event to subscribers, as the server would. */
  emit(event: RoomEvent): void;
}

/**
 * In-memory stand-in. Dev join codes: 0000 not found, EEEE expired, FFFF full,
 * anything else joins Alice's room.
 */
export function createFakeOnlineActions(options: FakeOptions = {}): FakeOnlineActions {
  const handlers = new Set<(event: RoomEvent) => void>();
  const calls: FakeOnlineActions['calls'] = { create: [], join: [], cancel: 0, resume: 0 };
  const wait = (): Promise<void> =>
    options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : Promise.resolve();

  return {
    calls,
    async createRoom(name) {
      calls.create.push(name);
      await wait();
      if (options.createError) return { ok: false, error: options.createError };
      return { ok: true, value: { code: options.code ?? 'K7QX' } };
    },
    async joinRoom(code, name) {
      calls.join.push({ code, name });
      await wait();
      if (options.joinError) return { ok: false, error: options.joinError };
      if (code === '0000') return { ok: false, error: 'not-found' };
      if (code === 'EEEE') return { ok: false, error: 'expired' };
      if (code === 'FFFF') return { ok: false, error: 'full' };
      return { ok: true, value: { code, opponentName: 'Alice' } };
    },
    async cancelRoom() {
      calls.cancel += 1;
    },
    onRoomEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    savedSeat: () => options.saved ?? null,
    resume() {
      calls.resume += 1;
    },
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
  };
}
