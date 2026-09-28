// SPEC §5.7 — pure (de)serialization of the R4 localStorage snapshot shape.
// R4.4's version-mismatch classification lives here as pure logic; the
// store-level acceptance behavior ("discarded ... returning to the home
// screen with a brief notice") is asserted in game-restore.test.ts.

import { describe, expect, it } from 'vitest';

import type { PlayerId } from '../../src/lib/bridge/schema';
import { type Snapshot, decodeSnapshot, encodeSnapshot } from '../../src/lib/stores/snapshot';

function validSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    savedAt: '2026-09-27T00:00:00.000Z',
    engineState: '{"ok":true,"v":1,"state":{},"history":[],"seed":"42","dealer":0}',
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 } as Record<PlayerId, number>,
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Bob'],
    seed: '42',
    dealer: 1,
    ...overrides,
  };
}

describe('snapshot encode/decode (SPEC §5.7)', () => {
  it('round-trips a well-formed snapshot exactly', () => {
    const snap = validSnapshot();
    const result = decodeSnapshot(encodeSnapshot(snap));
    expect(result).toEqual({ ok: true, snapshot: snap });
  });

  it('R4.4: a snapshot with v !== 1 decodes as version-mismatch, not thrown', () => {
    const raw = JSON.stringify({ ...validSnapshot(), v: 2 });
    expect(() => decodeSnapshot(raw)).not.toThrow();
    const result = decodeSnapshot(raw);
    expect(result).toEqual({ ok: false, reason: 'version-mismatch', detail: 'found v=2' });
  });

  it('R4.4: v !== 1 is classified even when the rest of the shape is also missing (no migration attempted)', () => {
    // A record with an old/foreign shape that also happens to fail the v=1
    // structural check must still report version-mismatch, not 'malformed' —
    // SPEC §5.7 "no migration code in v1; a bump means the old game is gone."
    const raw = JSON.stringify({ v: 0, somethingElseEntirely: true });
    expect(decodeSnapshot(raw)).toEqual({ ok: false, reason: 'version-mismatch', detail: 'found v=0' });
  });

  it('reports empty for null/missing raw input without throwing', () => {
    expect(decodeSnapshot(null)).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports invalid-json for unparseable input without throwing', () => {
    const result = decodeSnapshot('not json{{{');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid-json');
  });

  it('reports malformed for a non-object JSON value', () => {
    expect(decodeSnapshot(JSON.stringify('just a string'))).toEqual(
      expect.objectContaining({ ok: false, reason: 'malformed' }),
    );
  });

  it('reports malformed when a v=1 snapshot is missing a required field', () => {
    const broken = validSnapshot() as unknown as Record<string, unknown>;
    delete broken.dealer;
    const result = decodeSnapshot(JSON.stringify(broken));
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it('reports malformed when names is not a 2-tuple of strings', () => {
    const broken = validSnapshot({ names: ['solo'] as unknown as [string, string] });
    const result = decodeSnapshot(JSON.stringify(broken));
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it('preserves opponent.hand-style null-vs-empty-array distinctions inside history entries untouched', () => {
    // engineState is opaque, but history/curtain are ordinary JSON this
    // module DOES look inside the shape of (not the content of) — prove
    // round-tripping doesn't coerce null into [] or vice versa anywhere.
    const entry = { by: 0 as const, kind: 0 as const, card: null, description: 'draw a card', seq: 1, subKind: null };
    const snap = validSnapshot({
      viewer: 1,
      history: [entry],
      curtain: { kind: 'recap', to: 1, entries: [entry] },
    });
    const result = decodeSnapshot(encodeSnapshot(snap));
    expect(result).toEqual({ ok: true, snapshot: snap });
  });

  it('never inspects inside engineState — an arbitrary opaque string round-trips untouched', () => {
    const snap = validSnapshot({ engineState: 'not even json, deliberately' });
    const result = decodeSnapshot(encodeSnapshot(snap));
    expect(result).toEqual({ ok: true, snapshot: snap });
  });
});

describe('N1: structural validation of curtain and lastSeenSeq (malformed, cleanly, like a v mismatch)', () => {
  const entry = { by: 0 as const, kind: 0 as const, card: null, description: 'draw a card', seq: 1, subKind: null };
  const withHistory = (curtain: unknown, viewer: PlayerId = 1) =>
    JSON.stringify({ ...validSnapshot({ viewer, history: [entry] }), curtain });

  it.each([
    ['none', { kind: 'none' }, 0],
    ['handoff', { kind: 'handoff', to: 1, reason: 'turn' }, 1],
    ['handoff/seven-return', { kind: 'handoff', to: 1, reason: 'seven-return' }, 1],
    ['reveal', { kind: 'reveal', to: 1 }, 1],
    ['recap', { kind: 'recap', to: 1, entries: [entry] }, 1],
    ['ack real', { kind: 'ack', to: 1, synthetic: false }, 1],
    ['ack synthetic', { kind: 'ack', to: 1, synthetic: true }, 1],
    ['result', { kind: 'result' }, 0],
  ] as const)('accepts a well-formed %s curtain', (_label, curtain, viewer) => {
    expect(decodeSnapshot(withHistory(curtain, viewer as PlayerId)).ok).toBe(true);
  });

  it.each([
    ['unknown kind', { kind: 'curtain-call', to: 1 }],
    ['missing kind', { to: 1 }],
    ['handoff without to', { kind: 'handoff', reason: 'turn' }],
    ['handoff with bad to', { kind: 'handoff', to: 2, reason: 'turn' }],
    ['handoff without reason', { kind: 'handoff', to: 1 }],
    ['handoff with unknown reason', { kind: 'handoff', to: 1, reason: 'because' }],
    ['reveal without to', { kind: 'reveal' }],
    ['recap without entries', { kind: 'recap', to: 1 }],
    ['recap with non-array entries', { kind: 'recap', to: 1, entries: 'x' }],
    ['ack without synthetic', { kind: 'ack', to: 1 }],
    ['ack with non-boolean synthetic', { kind: 'ack', to: 1, synthetic: 'yes' }],
    ['curtain not an object', 'none'],
  ])('rejects %s as malformed', (_label, curtain) => {
    const result = decodeSnapshot(withHistory(curtain));
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it.each([
    ['missing [1]', { 0: 0 }],
    ['string [0]', { 0: '0', 1: 0 }],
    ['null [1]', { 0: 0, 1: null }],
    ['NaN-ish', { 0: 0, 1: 'NaN' }],
  ])('rejects lastSeenSeq %s as malformed', (_label, lastSeenSeq) => {
    const raw = JSON.stringify({ ...validSnapshot(), lastSeenSeq });
    expect(decodeSnapshot(raw)).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it.each([
    ['handoff', { kind: 'handoff', to: 1, reason: 'turn' }],
    ['reveal', { kind: 'reveal', to: 1 }],
    ['ack', { kind: 'ack', to: 1, synthetic: false }],
    ['result', { kind: 'result' }],
  ])('rejects a non-"none" curtain (%s) with an empty history', (_label, curtain) => {
    const raw = JSON.stringify({ ...validSnapshot({ viewer: 1 }), curtain });
    expect(decodeSnapshot(raw)).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it('rejects a curtain whose target is not the persisted viewer', () => {
    expect(decodeSnapshot(withHistory({ kind: 'reveal', to: 1 }, 0))).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it('none with an empty history is still valid (a fresh game)', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot())).ok).toBe(true);
  });

  it('never throws on any of the malformed shapes', () => {
    expect(() => decodeSnapshot(withHistory(null))).not.toThrow();
    expect(() => decodeSnapshot(JSON.stringify({ ...validSnapshot(), lastSeenSeq: null }))).not.toThrow();
  });
});
