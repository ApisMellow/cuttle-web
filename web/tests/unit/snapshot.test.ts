// SPEC §5.7 — pure (de)serialization of the R4 localStorage snapshot shape.
// R4.4's version-mismatch classification lives here as pure logic; the
// store-level acceptance behavior ("discarded ... returning to the home
// screen with a brief notice") is asserted in game-restore.test.ts.

import { describe, expect, it } from 'vitest';

import type { PlayerId } from '../../src/lib/bridge/schema';
import { SNAPSHOT_VERSION, type Snapshot, decodeSnapshot, encodeSnapshot } from '../../src/lib/stores/snapshot';
import { appliedMove } from './game-test-support';

function validSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 2,
    savedAt: '2026-09-27T00:00:00.000Z',
    engineState: '{"ok":true,"v":2,"state":{},"history":[],"seed":"42","dealer":0}',
    history: [],
    lastSeenSeq: { 0: 0, 1: 0 } as Record<PlayerId, number>,
    viewer: 0,
    curtain: { kind: 'none' },
    names: ['Alice', 'Blake'],
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

  it('R4.4: a snapshot with v !== 2 decodes as version-mismatch, not thrown', () => {
    const raw = JSON.stringify({ ...validSnapshot(), v: 3 });
    expect(() => decodeSnapshot(raw)).not.toThrow();
    const result = decodeSnapshot(raw);
    expect(result).toEqual({ ok: false, reason: 'version-mismatch', detail: 'found v=3' });
  });

  it('SPEC §5.7 (ruling 2026-09-28): v is 2; a v1 save migrates, gaining drawn: null on every history and recap entry', () => {
    expect(SNAPSHOT_VERSION).toBe(2);
    const entry = appliedMove({ by: 1, kind: 4, seq: 1, card: { Rank: 5, Suit: 2 }, description: 'play 5♥ as one-off' });
    const v1Entry: Record<string, unknown> = { ...entry };
    delete v1Entry.drawn;
    const v1 = { ...validSnapshot(), v: 1, viewer: 0, history: [v1Entry], curtain: { kind: 'recap', to: 0, entries: [v1Entry] } };
    const result = decodeSnapshot(JSON.stringify(v1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.v).toBe(2);
    expect(result.snapshot.history).toEqual([{ ...entry, drawn: null }]);
    expect(result.snapshot.curtain).toEqual({ kind: 'recap', to: 0, entries: [{ ...entry, drawn: null }] });
    // The opaque engine state is passed through untouched (the bridge migrates it).
    expect(result.snapshot.engineState).toBe(v1.engineState);
  });

  it('SPEC §5.7: a "v1" whose entry already carries drawn is not a real v1 save — malformed', () => {
    const entry = appliedMove({ by: 1, kind: 0, seq: 1 });
    const result = decodeSnapshot(JSON.stringify({ ...validSnapshot(), v: 1, history: [entry] }));
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('R4.4: a v outside {1, 2} is classified even when the rest of the shape is also missing (no migration attempted)', () => {
    // Only v1 migrates (SPEC §5.7, ruling 2026-09-28). Any other version with
    // an old/foreign shape that also fails the structural check must still
    // report version-mismatch, not 'malformed'.
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
    const entry = appliedMove({ by: 0, kind: 0, description: 'draw a card', seq: 1 });
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
  const entry = appliedMove({ by: 0, kind: 0, description: 'draw a card', seq: 1 });
  const withHistory = (curtain: unknown, viewer: PlayerId = 1) =>
    JSON.stringify({ ...validSnapshot({ viewer, history: [entry] }), curtain });

  it.each([
    ['none', { kind: 'none' }, 0],
    ['handoff', { kind: 'handoff', to: 1, reason: 'turn' }, 1],
    ['handoff/seven-return', { kind: 'handoff', to: 1, reason: 'seven-return' }, 1],
    ['reveal', { kind: 'reveal', to: 1 }, 1],
    ['recap', { kind: 'recap', to: 1, entries: [entry] }, 1],
    ['ack', { kind: 'ack', to: 1 }, 1],
    ['result', { kind: 'result' }, 0],
  ] as const)('accepts a well-formed %s curtain', (_label, curtain, viewer) => {
    expect(decodeSnapshot(withHistory(curtain, viewer as PlayerId)).ok).toBe(true);
  });

  // Ruling 2026-09-29 (SPEC §4.3, §5.7): no v bump; a save written before the
  // ruling reads without its retired acknowledgment.
  it.each([
    ['a real-window ack (synthetic: false) drops the flag', { kind: 'ack', to: 1, synthetic: false }, { kind: 'ack', to: 1 }],
    ['a synthetic ack becomes the reveal before it', { kind: 'ack', to: 1, synthetic: true }, { kind: 'reveal', to: 1 }],
    ['an "acknowledge" handoff becomes a turn handoff', { kind: 'handoff', to: 1, reason: 'acknowledge' }, { kind: 'handoff', to: 1, reason: 'turn' }],
  ] as const)('a pre-ruling save: %s', (_label, curtain, expected) => {
    const result = decodeSnapshot(withHistory(curtain, 1));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.curtain).toEqual(expected);
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
    ['ack without to', { kind: 'ack' }],
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
    ['handoff counter', { kind: 'handoff', to: 1, reason: 'counter' }],
    ['handoff discard', { kind: 'handoff', to: 1, reason: 'discard' }],
    ['recap', { kind: 'recap', to: 1, entries: [] }],
    ['ack', { kind: 'ack', to: 1 }],
    ['result', { kind: 'result' }],
  ])('rejects a non-"none", non-opening curtain (%s) with an empty history', (_label, curtain) => {
    const raw = JSON.stringify({ ...validSnapshot({ viewer: 1 }), curtain });
    expect(decodeSnapshot(raw)).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it('rejects a curtain whose target is not the persisted viewer', () => {
    expect(decodeSnapshot(withHistory({ kind: 'reveal', to: 1 }, 0))).toEqual(expect.objectContaining({ ok: false, reason: 'malformed' }));
  });

  it.each([
    ['handoff turn', { kind: 'handoff', to: 1, reason: 'turn' }],
    ['reveal', { kind: 'reveal', to: 1 }],
  ])('W25: the opening curtain (%s) with an empty history is valid (a fresh game behind the curtain)', (_label, curtain) => {
    const raw = JSON.stringify({ ...validSnapshot({ viewer: 1 }), curtain });
    expect(decodeSnapshot(raw).ok).toBe(true);
  });

  it('none with an empty history is still valid (a fresh game)', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot())).ok).toBe(true);
  });

  it('never throws on any of the malformed shapes', () => {
    expect(() => decodeSnapshot(withHistory(null))).not.toThrow();
    expect(() => decodeSnapshot(JSON.stringify({ ...validSnapshot(), lastSeenSeq: null }))).not.toThrow();
  });
});
