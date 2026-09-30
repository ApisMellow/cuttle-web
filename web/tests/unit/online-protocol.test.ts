// Two-phone W11 (docs/two-phone-plan.md §3): typed encode/decode for every
// wire frame. Incoming `state` envelopes go through schema.ts validation;
// unknown frame types are ignored, never thrown.
import { describe, expect, it } from 'vitest';

import { SchemaError } from '../../src/lib/bridge/schema';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  TERMINAL_ERROR_CODES,
  decodeServerFrame,
  encodeClientFrame,
  isTerminalErrorCode,
} from '../../src/lib/online/protocol';
import { CODE, TOKEN, stateFrame } from './online-fakes';

describe('client frames', () => {
  it('encodes hello with the protocol version, code, token and lastSeq', () => {
    const raw = encodeClientFrame({ t: 'hello', v: PROTOCOL_VERSION, code: CODE, token: TOKEN, lastSeq: 7 });
    expect(JSON.parse(raw)).toEqual({ t: 'hello', v: 1, code: CODE, token: TOKEN, lastSeq: 7 });
  });

  it('encodes move, rematch and ping exactly', () => {
    expect(JSON.parse(encodeClientFrame({ t: 'move', game: 2, seq: 14, index: 3 }))).toEqual({
      t: 'move',
      game: 2,
      seq: 14,
      index: 3,
    });
    expect(JSON.parse(encodeClientFrame({ t: 'rematch', game: 2 }))).toEqual({ t: 'rematch', game: 2 });
    expect(JSON.parse(encodeClientFrame({ t: 'ping' }))).toEqual({ t: 'ping' });
  });

  it('refuses non-integer or negative move fields', () => {
    expect(() => encodeClientFrame({ t: 'move', game: 1, seq: 1.5, index: 0 })).toThrow(ProtocolError);
    expect(() => encodeClientFrame({ t: 'move', game: 1, seq: 0, index: -1 })).toThrow(ProtocolError);
    expect(() => encodeClientFrame({ t: 'move', game: 0, seq: 0, index: 0 })).toThrow(ProtocolError);
    expect(() => encodeClientFrame({ t: 'rematch', game: Number.NaN })).toThrow(ProtocolError);
  });

  it('never puts the token in an encode error message', () => {
    try {
      encodeClientFrame({ t: 'hello', v: PROTOCOL_VERSION, code: CODE, token: TOKEN, lastSeq: -3 });
      expect.unreachable('hello with a negative lastSeq must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
  });
});

describe('server frames', () => {
  it('decodes welcome', () => {
    expect(decodeServerFrame(JSON.stringify({ t: 'welcome', seat: 1, names: ['Alice', 'Blake'], status: 'playing' }))).toEqual({
      t: 'welcome',
      seat: 1,
      names: ['Alice', 'Blake'],
      status: 'playing',
    });
    // Waiting room: the second name is not known yet.
    expect(decodeServerFrame(JSON.stringify({ t: 'welcome', seat: 0, names: ['Alice', null], status: 'waiting' }))).toEqual({
      t: 'welcome',
      seat: 0,
      names: ['Alice', null],
      status: 'waiting',
    });
  });

  it('decodes state and validates its envelope through schema.ts', () => {
    const frame = stateFrame({ viewer: 1, seq: 3, game: 2 });
    const decoded = decodeServerFrame(JSON.stringify(frame));
    expect(decoded).toEqual(frame);
  });

  it('decodes responding, presence, rematch, error and pong', () => {
    expect(decodeServerFrame('{"t":"responding","by":1}')).toEqual({ t: 'responding', by: 1 });
    expect(decodeServerFrame('{"t":"presence","opponentOnline":false}')).toEqual({ t: 'presence', opponentOnline: false });
    expect(decodeServerFrame('{"t":"rematch","requestedBy":0}')).toEqual({ t: 'rematch', requestedBy: 0 });
    expect(decodeServerFrame('{"t":"error","code":"STALE","message":"old seq","seq":9}')).toEqual({
      t: 'error',
      code: 'STALE',
      message: 'old seq',
      seq: 9,
    });
    expect(decodeServerFrame('{"t":"error","code":"ROOM_GONE","message":"gone"}')).toEqual({
      t: 'error',
      code: 'ROOM_GONE',
      message: 'gone',
    });
    expect(decodeServerFrame('{"t":"pong"}')).toEqual({ t: 'pong' });
  });

  it('rejects a state whose envelope fails schema validation', () => {
    const noSeq = stateFrame({ seq: 2 }) as unknown as { envelope: Record<string, unknown> };
    delete noSeq.envelope.seq;
    expect(() => decodeServerFrame(JSON.stringify(noSeq))).toThrow(SchemaError);

    // The redaction tripwire: a raw deck must never cross the wire.
    const leaky = stateFrame() as unknown as { envelope: { state: Record<string, unknown> } };
    leaky.envelope.state.deck = [{ Rank: 1, Suit: 0 }];
    expect(() => decodeServerFrame(JSON.stringify(leaky))).toThrow(SchemaError);

    // An engine error is not an envelope.
    const errEnvelope = { ...stateFrame(), envelope: { ok: false, code: 'INTERNAL', message: 'x' } };
    expect(() => decodeServerFrame(JSON.stringify(errEnvelope))).toThrow(ProtocolError);
  });

  it('rejects malformed known frames', () => {
    const bad = [
      '{"t":"welcome","seat":2,"names":["Alice","Blake"],"status":"playing"}',
      '{"t":"welcome","seat":0,"names":["Alice"],"status":"playing"}',
      '{"t":"welcome","seat":0,"names":["Alice","Blake"],"status":"lobby"}',
      '{"t":"responding"}',
      '{"t":"presence","opponentOnline":"yes"}',
      '{"t":"rematch","requestedBy":"Blake"}',
      '{"t":"error","message":"no code"}',
      '{"t":"error","code":"STALE","message":"x","seq":"9"}',
      JSON.stringify({ ...stateFrame(), game: 0 }),
      JSON.stringify({ ...stateFrame(), opponentOnline: 1 }),
      JSON.stringify({ ...stateFrame(), tally: [1] }),
    ];
    for (const raw of bad) {
      expect(() => decodeServerFrame(raw), raw).toThrow(ProtocolError);
    }
  });

  it('rejects non-JSON and non-object frames', () => {
    expect(() => decodeServerFrame('not json')).toThrow(ProtocolError);
    expect(() => decodeServerFrame('[1,2]')).toThrow(ProtocolError);
    expect(() => decodeServerFrame('{"no":"type"}')).toThrow(ProtocolError);
  });

  it('ignores unknown frame types safely', () => {
    expect(decodeServerFrame('{"t":"fireworks","n":3}')).toBeNull();
    expect(decodeServerFrame('{"t":"__proto__"}')).toBeNull();
    expect(decodeServerFrame('{"t":"toString"}')).toBeNull();
  });
});

describe('terminal error codes', () => {
  it('are exactly ROOM_GONE, UNAUTHORIZED and UPGRADE_REQUIRED', () => {
    expect([...TERMINAL_ERROR_CODES].sort()).toEqual(['ROOM_GONE', 'UNAUTHORIZED', 'UPGRADE_REQUIRED']);
    for (const code of TERMINAL_ERROR_CODES) expect(isTerminalErrorCode(code)).toBe(true);
    for (const code of ['STALE', 'NOT_YOUR_TURN', 'RATE_LIMITED', 'ILLEGAL_MOVE', 'ROOM_FULL', 'INTERNAL', 'SOMETHING_NEW']) {
      expect(isTerminalErrorCode(code)).toBe(false);
    }
  });
});
