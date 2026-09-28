// SPEC §2.7 — the complete wire contract, plus runtime validation of every
// bridge result against that exact shape. This is the tripwire the SPEC
// calls for at §5.4: a normalization bug (§2.8) — most dangerously
// `JackOwners` marshalling as base64 instead of an array — must fail loudly
// here instead of surfacing as a rendering oddity three rounds later.
//
// `parseBridgeResult` never rewrites or normalizes anything; normalization
// is a Go-side obligation (§2.8) already discharged by the bridge. This
// file only validates that the Go side kept its promise, then returns the
// parsed value typed as `BridgeResult`.

export type PlayerId = 0 | 1;
export type Suit = 0 | 1 | 2 | 3; // Clubs, Diamonds, Hearts, Spades
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export type Phase = 0 | 1 | 2 | 3 | 4;
export type MoveKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type TargetZone = 0 | 1;

export interface Card {
  Rank: Rank;
  Suit: Suit;
}

export interface Target {
  Owner: PlayerId;
  Zone: TargetZone;
  Index: number;
}

export interface PointEntry {
  Card: Card;
  Owner: PlayerId;
  JackStack: Card[];
  JackOwners: PlayerId[];
  Controller: PlayerId;
}

export interface Move {
  Kind: MoveKind;
  Card: Card | null;
  HandIndex: number;
  Target: Target | null;
  JackTarget: Target | null;
  ScrapIndex: number;
  DiscardA: number;
  DiscardB: number;
  SubMove: Move | null;
}

export interface PlayerView {
  viewer: PlayerId;
  active: PlayerId;
  phase: Phase;
  passesInARow: number;
  winner: PlayerId | null;
  stalemate: boolean;

  you: {
    hand: Card[];
    frozenHandIndices: number[];
    points: PointEntry[];
    permanents: Card[];
  };
  opponent: {
    handCount: number;
    hand: Card[] | null; // deliberate exception (§2.8b): null = hidden, [] = visible+empty
    points: PointEntry[];
    permanents: Card[];
  };

  deckCount: number;
  scrap: Card[];

  scoreboard: {
    you: { points: number; threshold: number; kings: number; hasWon: boolean };
    opponent: { points: number; threshold: number; kings: number; hasWon: boolean };
  };

  sevenRevealed: Card[] | null;

  pending: {
    playedBy: PlayerId;
    card: Card;
    target: Target | null;
    counterChain: Card[];
  } | null;
}

/**
 * `index` is present only when the viewer is the entry's mover; omitted
 * (key absent) for everyone else (§2.7, §3.2, amended 2026-09-26).
 */
export interface AppliedMove {
  index?: number;
  by: PlayerId;
  kind: MoveKind;
  card: Card | null;
  description: string;
  seq: number;
  /** SubMove.Kind for MoveSevenPick; null otherwise, and null for a
   * dead-end SevenPick. Always present as a key. (amended 2026-09-26) */
  subKind: MoveKind | null;
  /** The card the move targeted, read from the PRE-state: Scuttle's
   * Target, a Jack's JackTarget, a targeted OneOff's Target (2-as-scrap,
   * 9), and the same for a SevenPick's SubMove. null for every untargeted
   * move, including a dead-end SevenPick. Always a card that was on the
   * board, so public to both viewers. Always present as a key — never
   * omitted, even when null. (amended 2026-09-27) */
  targetCard: Card | null;
}

export interface Envelope {
  ok: true;
  state: PlayerView;
  legalMoves: Move[];
  descriptions: string[];
  lastMove: AppliedMove | null;
  history: AppliedMove[];
  seq: number;
}

export type EngineErrorCode =
  | 'ILLEGAL_MOVE'
  | 'INDEX_OUT_OF_RANGE'
  | 'BAD_REQUEST'
  | 'NO_GAME'
  | 'NO_LEGAL_MOVES'
  | 'INTERNAL';

export interface EngineError {
  ok: false;
  code: EngineErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

export type BridgeResult = Envelope | EngineError;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const ENGINE_ERROR_CODES: readonly EngineErrorCode[] = [
  'ILLEGAL_MOVE',
  'INDEX_OUT_OF_RANGE',
  'BAD_REQUEST',
  'NO_GAME',
  'NO_LEGAL_MOVES',
  'INTERNAL',
];

function fail(path: string, message: string): never {
  throw new SchemaError(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, `must be an object, got ${describeType(value)}`);
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `must be an array, got ${describeType(value)}`);
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail(path, `must be a number, got ${describeType(value)}`);
  }
  return value as number;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `must be a string, got ${describeType(value)}`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `must be a boolean, got ${describeType(value)}`);
  return value;
}

function expectPlayerId(value: unknown, path: string): PlayerId {
  const n = expectNumber(value, path);
  if (n !== 0 && n !== 1) fail(path, `must be 0 or 1, got ${n}`);
  return n as PlayerId;
}

function expectPlayerIdOrNull(value: unknown, path: string): PlayerId | null {
  if (value === null) return null;
  return expectPlayerId(value, path);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  return typeof value;
}

function validateCard(value: unknown, path: string): Card {
  const obj = expectObject(value, path);
  const rank = expectNumber(obj.Rank, `${path}.Rank`);
  if (rank < 1 || rank > 13) fail(`${path}.Rank`, `must be 1..13, got ${rank}`);
  const suit = expectNumber(obj.Suit, `${path}.Suit`);
  if (suit < 0 || suit > 3) fail(`${path}.Suit`, `must be 0..3, got ${suit}`);
  return { Rank: rank as Rank, Suit: suit as Suit };
}

function validateCardArray(value: unknown, path: string): Card[] {
  return expectArray(value, path).map((v, i) => validateCard(v, `${path}[${i}]`));
}

function validateCardOrNull(value: unknown, path: string): Card | null {
  if (value === null) return null;
  return validateCard(value, path);
}

function validateTarget(value: unknown, path: string): Target {
  const obj = expectObject(value, path);
  return {
    Owner: expectPlayerId(obj.Owner, `${path}.Owner`),
    Zone: expectNumber(obj.Zone, `${path}.Zone`) as TargetZone,
    Index: expectNumber(obj.Index, `${path}.Index`),
  };
}

function validateTargetOrNull(value: unknown, path: string): Target | null {
  if (value === null) return null;
  return validateTarget(value, path);
}

function validatePointEntry(value: unknown, path: string): PointEntry {
  const obj = expectObject(value, path);
  const jackOwnersPath = `${path}.JackOwners`;
  if (typeof obj.JackOwners === 'string') {
    fail(
      jackOwnersPath,
      'must be an array of PlayerId, got a base64 string — JackOwners was not re-typed ' +
        'from []byte before crossing the wire (SPEC §2.8a)',
    );
  }
  const jackOwners = expectArray(obj.JackOwners, jackOwnersPath).map((v, i) =>
    expectPlayerId(v, `${jackOwnersPath}[${i}]`),
  );
  return {
    Card: validateCard(obj.Card, `${path}.Card`),
    Owner: expectPlayerId(obj.Owner, `${path}.Owner`),
    JackStack: validateCardArray(obj.JackStack, `${path}.JackStack`),
    JackOwners: jackOwners,
    Controller: expectPlayerId(obj.Controller, `${path}.Controller`),
  };
}

function validateMove(value: unknown, path: string): Move {
  const obj = expectObject(value, path);
  return {
    Kind: expectNumber(obj.Kind, `${path}.Kind`) as MoveKind,
    Card: validateCardOrNull(obj.Card, `${path}.Card`),
    HandIndex: expectNumber(obj.HandIndex, `${path}.HandIndex`),
    Target: validateTargetOrNull(obj.Target, `${path}.Target`),
    JackTarget: validateTargetOrNull(obj.JackTarget, `${path}.JackTarget`),
    ScrapIndex: expectNumber(obj.ScrapIndex, `${path}.ScrapIndex`),
    DiscardA: expectNumber(obj.DiscardA, `${path}.DiscardA`),
    DiscardB: expectNumber(obj.DiscardB, `${path}.DiscardB`),
    SubMove: obj.SubMove === null ? null : validateMove(obj.SubMove, `${path}.SubMove`),
  };
}

function validateSideScore(value: unknown, path: string) {
  const obj = expectObject(value, path);
  return {
    points: expectNumber(obj.points, `${path}.points`),
    threshold: expectNumber(obj.threshold, `${path}.threshold`),
    kings: expectNumber(obj.kings, `${path}.kings`),
    hasWon: expectBoolean(obj.hasWon, `${path}.hasWon`),
  };
}

function validatePending(value: unknown, path: string): PlayerView['pending'] {
  if (value === null) return null;
  const obj = expectObject(value, path);
  return {
    playedBy: expectPlayerId(obj.playedBy, `${path}.playedBy`),
    card: validateCard(obj.card, `${path}.card`),
    target: validateTargetOrNull(obj.target, `${path}.target`),
    counterChain: validateCardArray(obj.counterChain, `${path}.counterChain`),
  };
}

function validatePlayerView(value: unknown, path: string): PlayerView {
  const obj = expectObject(value, path);

  // The redaction bypass tripwire (§3.1, §5.4): the raw GameState's `deck`
  // must never cross the boundary. Its presence at all — not just a
  // non-empty value — is the leak.
  if (Object.prototype.hasOwnProperty.call(obj, 'deck')) {
    fail(path, 'must not contain deck contents — only deckCount may cross the bridge (SPEC §2.7, §3.2)');
  }

  const you = expectObject(obj.you, `${path}.you`);
  const youHandPath = `${path}.you.hand`;
  if (obj.you !== undefined && you.hand === null) {
    fail(youHandPath, 'must be an array — the viewer\'s own hand is never hidden (SPEC §2.7)');
  }

  const opponent = expectObject(obj.opponent, `${path}.opponent`);
  const opponentHand =
    opponent.hand === null ? null : validateCardArray(opponent.hand, `${path}.opponent.hand`);

  return {
    viewer: expectPlayerId(obj.viewer, `${path}.viewer`),
    active: expectPlayerId(obj.active, `${path}.active`),
    phase: expectNumber(obj.phase, `${path}.phase`) as Phase,
    passesInARow: expectNumber(obj.passesInARow, `${path}.passesInARow`),
    winner: expectPlayerIdOrNull(obj.winner, `${path}.winner`),
    stalemate: expectBoolean(obj.stalemate, `${path}.stalemate`),
    you: {
      hand: validateCardArray(you.hand, youHandPath),
      frozenHandIndices: expectArray(you.frozenHandIndices, `${path}.you.frozenHandIndices`).map((v, i) =>
        expectNumber(v, `${path}.you.frozenHandIndices[${i}]`),
      ),
      points: expectArray(you.points, `${path}.you.points`).map((v, i) =>
        validatePointEntry(v, `${path}.you.points[${i}]`),
      ),
      permanents: validateCardArray(you.permanents, `${path}.you.permanents`),
    },
    opponent: {
      handCount: expectNumber(opponent.handCount, `${path}.opponent.handCount`),
      hand: opponentHand,
      points: expectArray(opponent.points, `${path}.opponent.points`).map((v, i) =>
        validatePointEntry(v, `${path}.opponent.points[${i}]`),
      ),
      permanents: validateCardArray(opponent.permanents, `${path}.opponent.permanents`),
    },
    deckCount: expectNumber(obj.deckCount, `${path}.deckCount`),
    scrap: validateCardArray(obj.scrap, `${path}.scrap`),
    scoreboard: {
      you: validateSideScore(expectObject(obj.scoreboard, `${path}.scoreboard`).you, `${path}.scoreboard.you`),
      opponent: validateSideScore(
        expectObject(obj.scoreboard, `${path}.scoreboard`).opponent,
        `${path}.scoreboard.opponent`,
      ),
    },
    sevenRevealed: obj.sevenRevealed === null ? null : validateCardArray(obj.sevenRevealed, `${path}.sevenRevealed`),
    pending: validatePending(obj.pending, `${path}.pending`),
  };
}

function validateAppliedMove(value: unknown, path: string): AppliedMove {
  const obj = expectObject(value, path);
  const move: AppliedMove = {
    by: expectPlayerId(obj.by, `${path}.by`),
    kind: expectNumber(obj.kind, `${path}.kind`) as MoveKind,
    card: validateCardOrNull(obj.card, `${path}.card`),
    description: expectString(obj.description, `${path}.description`),
    seq: expectNumber(obj.seq, `${path}.seq`),
    subKind: (() => {
      if (!Object.prototype.hasOwnProperty.call(obj, 'subKind')) {
        fail(`${path}.subKind`, 'must be present (a MoveKind or null) — it is never omitted (SPEC §2.7, amended 2026-09-26)');
      }
      return obj.subKind === null ? null : (expectNumber(obj.subKind, `${path}.subKind`) as MoveKind);
    })(),
    targetCard: (() => {
      if (!Object.prototype.hasOwnProperty.call(obj, 'targetCard')) {
        fail(`${path}.targetCard`, 'must be present (a Card or null) — it is never omitted (SPEC §2.7, amended 2026-09-27)');
      }
      return validateCardOrNull(obj.targetCard, `${path}.targetCard`);
    })(),
  };
  if (Object.prototype.hasOwnProperty.call(obj, 'index')) {
    move.index = expectNumber(obj.index, `${path}.index`);
  }
  return move;
}

function validateAppliedMoveOrNull(value: unknown, path: string): AppliedMove | null {
  if (value === null) return null;
  return validateAppliedMove(value, path);
}

function validateEnvelope(obj: Record<string, unknown>): Envelope {
  const state = validatePlayerView(obj.state, 'state');
  const legalMoves = expectArray(obj.legalMoves, 'legalMoves').map((v, i) => validateMove(v, `legalMoves[${i}]`));
  const descriptions = expectArray(obj.descriptions, 'descriptions').map((v, i) =>
    expectString(v, `descriptions[${i}]`),
  );
  if (legalMoves.length !== descriptions.length) {
    fail('legalMoves', `length (${legalMoves.length}) must equal descriptions length (${descriptions.length}) (SPEC §2.7)`);
  }
  const history = expectArray(obj.history, 'history').map((v, i) => validateAppliedMove(v, `history[${i}]`));
  const seq = expectNumber(obj.seq, 'seq');
  if (seq !== history.length) {
    fail('seq', `must equal history.length (${history.length}), got ${seq} (SPEC §2.7)`);
  }
  const lastMove = validateAppliedMoveOrNull(obj.lastMove ?? null, 'lastMove');

  return {
    ok: true,
    state,
    legalMoves,
    descriptions,
    lastMove,
    history,
    seq,
  };
}

function validateEngineError(obj: Record<string, unknown>): EngineError {
  const code = expectString(obj.code, 'code');
  if (!ENGINE_ERROR_CODES.includes(code as EngineErrorCode)) {
    fail('code', `must be one of ${ENGINE_ERROR_CODES.join(', ')}, got ${JSON.stringify(code)}`);
  }
  const message = expectString(obj.message, 'message');
  const result: EngineError = { ok: false, code: code as EngineErrorCode, message };
  if (obj.detail !== undefined) {
    result.detail = expectObject(obj.detail, 'detail');
  }
  return result;
}

/**
 * Parses and validates a raw bridge JSON string against the §2.7 envelope
 * contract. Throws `SchemaError` on any shape violation. Never normalizes —
 * that is a Go-side obligation (§2.8) this function only verifies.
 */
export function parseBridgeResult(raw: string): BridgeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new SchemaError(`bridge result is not valid JSON: ${(err as Error).message}`);
  }
  const obj = expectObject(value, '(root)');
  if (obj.ok === true) return validateEnvelope(obj);
  if (obj.ok === false) return validateEngineError(obj);
  fail('ok', `must be true or false, got ${describeType(obj.ok)}`);
}
