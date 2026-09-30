// Two-phone wire protocol v1 (docs/two-phone-plan.md §3): the typed frames
// the phone and the game server exchange over the WebSocket at /api/play.
// JSON text frames, each with a type field `t`.
//
// `encodeClientFrame` checks outgoing frames; `decodeServerFrame` checks
// incoming ones. A `state` frame's envelope goes through schema.ts's
// `parseBridgeResult`, the same tripwire the local bridge uses, so a server
// normalization or redaction bug fails here instead of on screen. A frame
// with an unknown `t` decodes to `null` (ignored); a known frame with a bad
// shape throws. Error messages never echo field values, so a token can't
// leak through one.

import { parseBridgeResult, type Envelope, type PlayerId } from '../bridge/schema';

export const PROTOCOL_VERSION = 1;

// --- Client to server ------------------------------------------------------

export interface HelloFrame {
  t: 'hello';
  v: typeof PROTOCOL_VERSION;
  code: string;
  token: string;
  lastSeq: number;
}

export interface MoveFrame {
  t: 'move';
  game: number;
  seq: number;
  index: number;
}

export interface RematchRequestFrame {
  t: 'rematch';
  game: number;
}

export interface PingFrame {
  t: 'ping';
}

export type ClientFrame = HelloFrame | MoveFrame | RematchRequestFrame | PingFrame;

// --- Server to client ------------------------------------------------------

export type RoomStatus = 'waiting' | 'playing' | 'over';

/** Seat names, indexed by seat. The second is null until someone joins. */
export type SeatNames = [string | null, string | null];

export interface WelcomeFrame {
  t: 'welcome';
  seat: PlayerId;
  names: SeatNames;
  status: RoomStatus;
}

export interface StateFrame {
  t: 'state';
  /** Games played in this room: 1, 2, ... across rematches. */
  game: number;
  /** Exactly buildEnvelope(state, history, seat), validated by schema.ts. */
  envelope: Envelope;
  opponentOnline: boolean;
  /** Room win tally, indexed by seat. */
  tally: [number, number];
}

export interface RespondingFrame {
  t: 'responding';
  by: PlayerId;
}

export interface PresenceFrame {
  t: 'presence';
  opponentOnline: boolean;
}

export interface RematchOfferFrame {
  t: 'rematch';
  requestedBy: PlayerId;
}

/** Bridge codes (SPEC §2.9) plus the server's own (plan §3). */
export type KnownServerErrorCode =
  | 'ILLEGAL_MOVE'
  | 'INDEX_OUT_OF_RANGE'
  | 'NO_LEGAL_MOVES'
  | 'BAD_REQUEST'
  | 'INTERNAL'
  | 'UNAUTHORIZED'
  | 'ROOM_GONE'
  | 'ROOM_FULL'
  | 'NOT_YOUR_TURN'
  | 'STALE'
  | 'RATE_LIMITED'
  /** The server's room cap is hit (HTTP 503 on create, with Retry-After). Not terminal. */
  | 'SERVER_FULL'
  | 'FORBIDDEN'
  | 'GAME_OVER'
  /**
   * A newer hello for this seat took over (SPEC §2.12). Not terminal: the
   * seat stays valid. The connection stops auto-reconnecting (`replaced`).
   */
  | 'REPLACED'
  | 'UPGRADE_REQUIRED';

export interface ErrorFrame {
  t: 'error';
  /** A known code, or a newer one this build doesn't know (kept, not thrown). */
  code: KnownServerErrorCode | (string & {});
  message: string;
  seq?: number;
}

export interface PongFrame {
  t: 'pong';
}

export type ServerFrame =
  | WelcomeFrame
  | StateFrame
  | RespondingFrame
  | PresenceFrame
  | RematchOfferFrame
  | ErrorFrame
  | PongFrame;

/** Server errors after which the phone stops reconnecting (plan §3). */
export const TERMINAL_ERROR_CODES = ['ROOM_GONE', 'UNAUTHORIZED', 'UPGRADE_REQUIRED'] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

export function isTerminalErrorCode(code: string): code is TerminalErrorCode {
  return (TERMINAL_ERROR_CODES as readonly string[]).includes(code);
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// --- Validation helpers ------------------------------------------------------
// Messages name the field and the expected type, never the value.

function fail(path: string, expected: string): never {
  throw new ProtocolError(`${path}: must be ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nonNegativeInt(value: unknown, path: string): number {
  if (!isNonNegativeInt(value)) fail(path, 'a non-negative integer');
  return value;
}

function positiveInt(value: unknown, path: string): number {
  if (!isNonNegativeInt(value) || value < 1) fail(path, 'a positive integer');
  return value;
}

function playerId(value: unknown, path: string): PlayerId {
  if (value !== 0 && value !== 1) fail(path, '0 or 1');
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string');
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'a non-empty string');
  return value;
}

// --- Encode --------------------------------------------------------------------

/** Serializes a client frame after checking its fields. Throws ProtocolError. */
export function encodeClientFrame(frame: ClientFrame): string {
  switch (frame.t) {
    case 'hello':
      if (frame.v !== PROTOCOL_VERSION) fail('hello.v', `${PROTOCOL_VERSION}`);
      return JSON.stringify({
        t: 'hello',
        v: frame.v,
        code: nonEmptyString(frame.code, 'hello.code'),
        token: nonEmptyString(frame.token, 'hello.token'),
        lastSeq: nonNegativeInt(frame.lastSeq, 'hello.lastSeq'),
      });
    case 'move':
      return JSON.stringify({
        t: 'move',
        game: positiveInt(frame.game, 'move.game'),
        seq: nonNegativeInt(frame.seq, 'move.seq'),
        index: nonNegativeInt(frame.index, 'move.index'),
      });
    case 'rematch':
      return JSON.stringify({ t: 'rematch', game: positiveInt(frame.game, 'rematch.game') });
    case 'ping':
      return JSON.stringify({ t: 'ping' });
    default:
      return fail('frame.t', 'hello, move, rematch or ping');
  }
}

// --- Decode --------------------------------------------------------------------

const ROOM_STATUSES: readonly RoomStatus[] = ['waiting', 'playing', 'over'];

function decodeNames(value: unknown): SeatNames {
  if (!Array.isArray(value) || value.length !== 2) fail('welcome.names', 'a two-entry array');
  const names = value.map((n, i) => {
    if (n !== null && typeof n !== 'string') fail(`welcome.names[${i}]`, 'a string or null');
    return n as string | null;
  });
  return [names[0], names[1]];
}

function decodeEnvelope(value: unknown): Envelope {
  if (!isRecord(value)) fail('state.envelope', 'an object');
  // parseBridgeResult takes the raw JSON string the wasm bridge returns.
  // Re-serializing keeps schema.ts the single validator for both transports.
  const result = parseBridgeResult(JSON.stringify(value));
  if (!result.ok) fail('state.envelope', 'an envelope (ok: true), not an engine error');
  return result;
}

function decodeTally(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail('state.tally', 'a two-entry array');
  return [nonNegativeInt(value[0], 'state.tally[0]'), nonNegativeInt(value[1], 'state.tally[1]')];
}

const decoders: Record<string, (obj: Record<string, unknown>) => ServerFrame> = {
  welcome: (obj) => {
    const status = obj.status;
    if (typeof status !== 'string' || !ROOM_STATUSES.includes(status as RoomStatus)) {
      fail('welcome.status', 'waiting, playing or over');
    }
    return { t: 'welcome', seat: playerId(obj.seat, 'welcome.seat'), names: decodeNames(obj.names), status: status as RoomStatus };
  },
  state: (obj) => ({
    t: 'state',
    game: positiveInt(obj.game, 'state.game'),
    opponentOnline: boolean(obj.opponentOnline, 'state.opponentOnline'),
    tally: decodeTally(obj.tally),
    envelope: decodeEnvelope(obj.envelope),
  }),
  responding: (obj) => ({ t: 'responding', by: playerId(obj.by, 'responding.by') }),
  presence: (obj) => ({ t: 'presence', opponentOnline: boolean(obj.opponentOnline, 'presence.opponentOnline') }),
  rematch: (obj) => ({ t: 'rematch', requestedBy: playerId(obj.requestedBy, 'rematch.requestedBy') }),
  error: (obj) => {
    const frame: ErrorFrame = {
      t: 'error',
      code: nonEmptyString(obj.code, 'error.code'),
      message: string(obj.message, 'error.message'),
    };
    if (obj.seq !== undefined) frame.seq = nonNegativeInt(obj.seq, 'error.seq');
    return frame;
  },
  pong: () => ({ t: 'pong' }),
};

/**
 * Parses one inbound text frame. Returns null for a frame type this build
 * doesn't know (ignore it). Throws ProtocolError for a malformed frame, or
 * SchemaError for a `state` whose envelope breaks the SPEC §2.7 contract.
 */
export function decodeServerFrame(raw: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError('frame: must be JSON');
  }
  if (!isRecord(value)) fail('frame', 'a JSON object');
  if (typeof value.t !== 'string') fail('frame.t', 'a string');
  if (!Object.prototype.hasOwnProperty.call(decoders, value.t)) return null;
  return decoders[value.t](value);
}
