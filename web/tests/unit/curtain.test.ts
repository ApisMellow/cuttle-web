// SPEC §4 — the curtain state machine (R13, R14). Pure: every case below is
// a hand-built (pre, appliedMove, post) triple that mirrors what the engine
// produces for that §4.4 row. The machine reads only post.active/post.phase
// (plus entry kinds, to trim the recap before a counter prompt), so these
// fixtures stay minimal.
//
// Ruling 2026-09-29 (SPEC §4.3, closes #23): a one-off the engine resolved
// at once gets no acknowledgment step. The only `ack` is the real counter
// window, and the responder sees it only when they hold a legal 2.

import { describe, expect, it } from 'vitest';

import type { AppliedMove, MoveKind, Phase, PlayerId, PlayerView, Rank } from '../../src/lib/bridge/schema';
import {
  CurtainError,
  advance,
  curtainRequired,
  handoffLabel,
  next,
  opening,
} from '../../src/lib/stores/curtain.svelte';
import type { CurtainContext, CurtainState, CurtainView, HandoffReason, RecapEntry } from '../../src/lib/stores/curtain.svelte';

// SPEC §2.5, pinned locally for the fixtures.
const Normal: Phase = 0;
const AwaitingCounter: Phase = 1;
const SevenChoosing: Phase = 2;
const AwaitingDiscard: Phase = 3;
const GameOver: Phase = 4;

const Draw: MoveKind = 0;
const PlayPoint: MoveKind = 1;
const PlayPermanent: MoveKind = 2;
const Scuttle: MoveKind = 3;
const OneOff: MoveKind = 4;
const Counter: MoveKind = 5;
const Decline: MoveKind = 6;
const SevenPick: MoveKind = 7;
const DiscardPair: MoveKind = 8;
const Pass: MoveKind = 9;

const ALL_KINDS: MoveKind[] = [Draw, PlayPoint, PlayPermanent, Scuttle, OneOff, Counter, Decline, SevenPick, DiscardPair, Pass];
const ALL_PHASES: Phase[] = [Normal, AwaitingCounter, SevenChoosing, AwaitingDiscard, GameOver];
const ALL_RANKS: Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

const A: PlayerId = 0;
const O: PlayerId = 1;

function view(active: PlayerId, phase: Phase, viewer: PlayerId = active): PlayerView {
  return {
    viewer,
    active,
    phase,
    passesInARow: 0,
    winner: null,
    stalemate: false,
    you: { hand: [], frozenHandIndices: [], points: [], permanents: [], watched: false },
    opponent: { handCount: 0, hand: null, points: [], permanents: [] },
    deckCount: 30,
    scrap: [],
    scoreboard: {
      you: { points: 0, threshold: 21, kings: 0, hasWon: false },
      opponent: { points: 0, threshold: 21, kings: 0, hasWon: false },
    },
    sevenRevealed: null,
    pending: null,
  };
}

function move(kind: MoveKind, opts: { by?: PlayerId; rank?: Rank; subKind?: MoveKind | null } = {}): AppliedMove {
  return {
    index: 0,
    by: opts.by ?? A,
    kind,
    card: opts.rank === undefined ? null : { Rank: opts.rank, Suit: 2 },
    description: 'fixture',
    seq: 7,
    subKind: opts.subKind ?? null,
    // The curtain machine reads only kind/subKind; targetCard is irrelevant
    // to it, so this fixture pins it to null (SPEC §2.7).
    targetCard: null,
    drawn: null,
  };
}

/** The store-side projection (§3.3 rule 4): the context never holds a full view. */
function project(v: PlayerView): CurtainView {
  return { active: v.active, phase: v.phase };
}

function ctx(pre: PlayerView, mv: AppliedMove, post: PlayerView, recap: Partial<Record<PlayerId, RecapEntry[]>> = {}): CurtainContext {
  return { pre: project(pre), move: mv, post: project(post), recapFor: (p) => recap[p] ?? [] };
}

/** Walks the receiving sequence from next() until it rests (none/result/ack). */
function walk(c: CurtainContext): CurtainState[] {
  const states: CurtainState[] = [c.move === null ? opening(c.post.active) : next(c.pre, c.move, c.post)];
  for (let i = 0; i < 20; i++) {
    const s = states[states.length - 1];
    if (s.kind === 'none' || s.kind === 'result' || s.kind === 'ack') return states;
    states.push(advance(s, c));
  }
  throw new Error('curtain walk did not terminate');
}

interface Row {
  name: string;
  prePhase: Phase;
  mv: AppliedMove;
  postPhase: Phase;
  postActive: PlayerId;
  /** The full receiving sequence (no recap entries). */
  expected: CurtainState[];
}

const none: CurtainState = { kind: 'none' };
const result: CurtainState = { kind: 'result' };
const handoff = (to: PlayerId, reason: 'turn' | 'counter' | 'discard' | 'seven-return'): CurtainState => ({ kind: 'handoff', to, reason });
const reveal = (to: PlayerId): CurtainState => ({ kind: 'reveal', to });
const ack = (to: PlayerId): CurtainState => ({ kind: 'ack', to });

// Every reachable row of SPEC §4.4. A = pre-state actor, O = other(A).
const ROWS: Row[] = [
  // --- From PhaseNormal (0) ---
  { name: 'Normal/Draw → Normal, O: turn curtain', prePhase: Normal, mv: move(Draw), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/PlayPoint → Normal, O: turn curtain', prePhase: Normal, mv: move(PlayPoint, { rank: 7 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/PlayPoint wins → GameOver: result, no curtain', prePhase: Normal, mv: move(PlayPoint, { rank: 10 }), postPhase: GameOver, postActive: A, expected: [result] },
  { name: 'Normal/PlayPermanent non-Jack → Normal, O: turn curtain', prePhase: Normal, mv: move(PlayPermanent, { rank: 12 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/PlayPermanent non-Jack wins → GameOver: result', prePhase: Normal, mv: move(PlayPermanent, { rank: 13 }), postPhase: GameOver, postActive: A, expected: [result] },
  { name: 'Normal/PlayPermanent Jack → Normal, O: turn curtain', prePhase: Normal, mv: move(PlayPermanent, { rank: 11 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/PlayPermanent Jack wins → GameOver: result', prePhase: Normal, mv: move(PlayPermanent, { rank: 11 }), postPhase: GameOver, postActive: A, expected: [result] },
  { name: 'Normal/Scuttle → Normal, O: turn curtain', prePhase: Normal, mv: move(Scuttle, { rank: 9 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/OneOff, O has a 2 → AwaitingCounter, O: counter curtain → counter prompt', prePhase: Normal, mv: move(OneOff, { rank: 9 }), postPhase: AwaitingCounter, postActive: O, expected: [handoff(O, 'counter'), reveal(O), ack(O)] },
  { name: 'Normal/OneOff rank 4, no 2 → AwaitingDiscard, O: discard curtain → discard picker, no ack', prePhase: Normal, mv: move(OneOff, { rank: 4 }), postPhase: AwaitingDiscard, postActive: O, expected: [handoff(O, 'discard'), reveal(O), none] },
  { name: 'Normal/OneOff rank 4, no 2, O hand empty → Normal, O: turn curtain → live', prePhase: Normal, mv: move(OneOff, { rank: 4 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/OneOff rank 7, no 2 → SevenChoosing, A keeps the phone: no curtain, straight to the seven panel', prePhase: Normal, mv: move(OneOff, { rank: 7 }), postPhase: SevenChoosing, postActive: A, expected: [none] },
  { name: 'Normal/OneOff other rank, no 2 → Normal, O: turn curtain → live, no ack', prePhase: Normal, mv: move(OneOff, { rank: 9 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'Normal/OneOff other rank, no 2, wins → GameOver: result', prePhase: Normal, mv: move(OneOff, { rank: 1 }), postPhase: GameOver, postActive: O, expected: [result] },
  { name: 'Normal/Pass reaching 3 → GameOver (stalemate): result', prePhase: Normal, mv: move(Pass), postPhase: GameOver, postActive: O, expected: [result] },
  { name: 'Normal/Pass otherwise → Normal, O: turn curtain', prePhase: Normal, mv: move(Pass), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },

  // --- From PhaseAwaitingCounter (1): A is the player offered the counter ---
  { name: 'AwaitingCounter/Decline, even chain, resolves → Normal, A keeps control: no curtain', prePhase: AwaitingCounter, mv: move(Decline), postPhase: Normal, postActive: A, expected: [none] },
  { name: 'AwaitingCounter/Decline, even chain, resolves a 7 → SevenChoosing, O: seven-return curtain', prePhase: AwaitingCounter, mv: move(Decline), postPhase: SevenChoosing, postActive: O, expected: [handoff(O, 'seven-return'), reveal(O), none] },
  { name: 'AwaitingCounter/Decline, even chain, resolves a 4 → AwaitingDiscard, A discards: no curtain', prePhase: AwaitingCounter, mv: move(Decline), postPhase: AwaitingDiscard, postActive: A, expected: [none] },
  { name: 'AwaitingCounter/Decline, even chain, resolution wins → GameOver: result', prePhase: AwaitingCounter, mv: move(Decline), postPhase: GameOver, postActive: A, expected: [result] },
  { name: 'AwaitingCounter/Decline, odd chain, cancelled → Normal, O: turn curtain', prePhase: AwaitingCounter, mv: move(Decline), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'AwaitingCounter/Counter, next player has a 2 → AwaitingCounter, O: counter curtain', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: AwaitingCounter, postActive: O, expected: [handoff(O, 'counter'), reveal(O), ack(O)] },
  { name: 'AwaitingCounter/Counter, next has none, odd chain cancels → Normal, A (the counterer) plays on: no curtain', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: Normal, postActive: A, expected: [none] },
  { name: 'AwaitingCounter/Counter, next has none, even chain resolves → Normal, O: turn curtain → live', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'AwaitingCounter/Counter, next has none, even chain resolves a 4 → AwaitingDiscard, O: discard curtain', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: AwaitingDiscard, postActive: O, expected: [handoff(O, 'discard'), reveal(O), none] },
  { name: 'AwaitingCounter/Counter, next has none, even chain resolves a 7 → SevenChoosing, A keeps the phone: no curtain', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: SevenChoosing, postActive: A, expected: [none] },
  { name: 'AwaitingCounter/Counter, next has none, resolution wins → GameOver: result', prePhase: AwaitingCounter, mv: move(Counter, { rank: 2 }), postPhase: GameOver, postActive: A, expected: [result] },

  // --- From PhaseSevenChoosing (2): A played the 7 ---
  { name: 'SevenChoosing/SevenPick(PlayPoint) → Normal, O: turn curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 5, subKind: PlayPoint }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'SevenChoosing/SevenPick(PlayPermanent) → Normal, O: turn curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 12, subKind: PlayPermanent }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'SevenChoosing/SevenPick(Scuttle) → Normal, O: turn curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 9, subKind: Scuttle }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'SevenChoosing/SevenPick(PlayPoint) wins → GameOver: result', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 10, subKind: PlayPoint }), postPhase: GameOver, postActive: A, expected: [result] },
  { name: 'SevenChoosing/SevenPick(OneOff), O has a 2 → AwaitingCounter, O: counter curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 9, subKind: OneOff }), postPhase: AwaitingCounter, postActive: O, expected: [handoff(O, 'counter'), reveal(O), ack(O)] },
  { name: 'SevenChoosing/SevenPick(OneOff), no 2 → Normal, O: turn curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 9, subKind: OneOff }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },
  { name: 'SevenChoosing/SevenPick(OneOff 4), no 2 → AwaitingDiscard, O: discard curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 4, subKind: OneOff }), postPhase: AwaitingDiscard, postActive: O, expected: [handoff(O, 'discard'), reveal(O), none] },
  { name: 'SevenChoosing/SevenPick(OneOff 7), no 2 → SevenChoosing, A keeps the phone: no curtain', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 7, subKind: OneOff }), postPhase: SevenChoosing, postActive: A, expected: [none] },
  { name: 'SevenChoosing/SevenPick(OneOff), no 2, wins → GameOver: result', prePhase: SevenChoosing, mv: move(SevenPick, { rank: 1, subKind: OneOff }), postPhase: GameOver, postActive: O, expected: [result] },
  { name: 'SevenChoosing/SevenPick dead-end (subKind null) → Normal, O: turn curtain', prePhase: SevenChoosing, mv: move(SevenPick, { subKind: null }), postPhase: Normal, postActive: O, expected: [handoff(O, 'turn'), reveal(O), none] },

  // --- From PhaseAwaitingDiscard (3): A is the 4's victim ---
  { name: 'AwaitingDiscard/DiscardPair → Normal, double flip lands on A: no curtain', prePhase: AwaitingDiscard, mv: move(DiscardPair), postPhase: Normal, postActive: A, expected: [none] },
];

// SPEC §4.4 unreachable pairs: everything not listed per phase.
const REACHABLE: Record<Phase, MoveKind[]> = {
  0: [Draw, PlayPoint, PlayPermanent, Scuttle, OneOff, Pass],
  1: [Counter, Decline],
  2: [SevenPick],
  3: [DiscardPair],
  4: [],
};

describe('curtain machine — SPEC §4.4 full transition table', () => {
  for (const actor of [A, O] as PlayerId[]) {
    const flip = (p: PlayerId): PlayerId => (actor === A ? p : ((1 - p) as PlayerId));
    for (const row of ROWS) {
      it(`R13.1: [actor P${actor + 1}] ${row.name}`, () => {
        const pre = view(actor, row.prePhase);
        const post = view(flip(row.postActive), row.postPhase, actor);
        const mv = { ...row.mv, by: actor };
        const expected = row.expected.map((s) => ('to' in s ? { ...s, to: flip(s.to) } : s));
        expect(walk(ctx(pre, mv, post))).toEqual(expected);
      });
    }
  }

  it('R13.1: curtainRequired matches post.active!==pre.active && post.phase!==PhaseGameOver on every phase pair', () => {
    for (const preActive of [A, O] as PlayerId[]) {
      for (const postActive of [A, O] as PlayerId[]) {
        for (const prePhase of ALL_PHASES) {
          for (const postPhase of ALL_PHASES) {
            const want = postActive !== preActive && postPhase !== GameOver;
            expect(curtainRequired(view(preActive, prePhase), view(postActive, postPhase))).toBe(want);
          }
        }
      }
    }
  });

  it('R13.1: PhaseAwaitingDiscard double flip — post.active === pre.active, predicate false, no curtain', () => {
    const pre = view(O, AwaitingDiscard);
    const post = view(O, Normal, O);
    expect(curtainRequired(pre, post)).toBe(false);
    expect(next(pre, move(DiscardPair, { by: O }), post)).toEqual({ kind: 'none' });
  });

  it('R13.1: every unreachable (phase, MoveKind) pair raises an INTERNAL CurtainError', () => {
    let count = 0;
    for (const phase of ALL_PHASES) {
      for (const kind of ALL_KINDS) {
        if (REACHABLE[phase].includes(kind)) continue;
        count++;
        const call = () => next(view(A, phase), move(kind, { subKind: kind === SevenPick ? PlayPoint : null }), view(O, Normal, A));
        expect(call, `phase ${phase} kind ${kind}`).toThrow(CurtainError);
        try {
          call();
        } catch (err) {
          expect((err as CurtainError).code).toBe('INTERNAL');
        }
      }
    }
    // 4 from Normal, 8 from AwaitingCounter, 9 each from SevenChoosing/AwaitingDiscard, 10 from GameOver.
    expect(count).toBe(40);
  });

  it('R13.1: the receiving sequence inserts a recap step only when the incoming player has entries', () => {
    const entry: RecapEntry = move(Draw, { by: A });
    const pre = view(A, Normal);
    const post = view(O, Normal, A);
    expect(walk(ctx(pre, move(Draw), post, { [O]: [entry] }))).toEqual([
      handoff(O, 'turn'),
      reveal(O),
      { kind: 'recap', to: O, entries: [entry] },
      none,
    ]);
    // A 7 with no 2 against it: the actor keeps the phone, no recap step.
    const sevenPost = view(A, SevenChoosing, A);
    expect(walk(ctx(pre, move(OneOff, { rank: 7 }), sevenPost, { [O]: [entry], [A]: [entry] }))).toEqual([none]);
  });

  it('R13.1: advancing a resting state (none, result, real counter window) is a bug', () => {
    const c = ctx(view(A, Normal), move(OneOff, { rank: 9 }), view(O, AwaitingCounter, A));
    expect(() => advance({ kind: 'none' }, c)).toThrow(CurtainError);
    expect(() => advance({ kind: 'result' }, c)).toThrow(CurtainError);
    expect(() => advance(ack(O), c)).toThrow(CurtainError);
  });

  it('a reveal addressed to someone who is not the decider hands the phone on (a pre-ruling save), never exposes the decider\'s board', () => {
    // A save from before 2026-09-29 can rest at O's synthetic ack after A's 7
    // (snapshot.ts maps it to reveal(O)). Passing it must go to A, not show
    // A's seven panel to O.
    const c = ctx(view(A, Normal), move(OneOff, { rank: 7 }), view(A, SevenChoosing, A));
    expect(advance(reveal(O), c)).toEqual(handoff(A, 'seven-return'));
    const entry: RecapEntry = move(OneOff, { by: A, rank: 7 });
    const withRecap = ctx(view(A, Normal), move(OneOff, { rank: 7 }), view(A, SevenChoosing, A), { [O]: [entry] });
    const recap = advance(reveal(O), withRecap);
    expect(recap).toEqual({ kind: 'recap', to: O, entries: [entry] });
    expect(advance(recap, withRecap)).toEqual(handoff(A, 'seven-return'));
  });
});

describe('SPEC §4.3 (ruling 2026-09-29): no acknowledgment for a one-off that opened no window', () => {
  const postPhasesWithoutWindow: Phase[] = [Normal, SevenChoosing, AwaitingDiscard, GameOver];
  const ACTORS: PlayerId[] = [A, O];
  const reasonFor = (phase: Phase): 'turn' | 'discard' | 'seven-return' =>
    phase === AwaitingDiscard ? 'discard' : phase === SevenChoosing ? 'seven-return' : 'turn';

  it('R14.2: a OneOff, Counter or SevenPick-wrapping-OneOff with no window follows §4.1 alone, for every rank: no ack, no extra handoff', () => {
    const counterable: Array<{ kind: MoveKind; subKind: MoveKind | null; prePhase: Phase }> = [
      { kind: OneOff, subKind: null, prePhase: Normal },
      { kind: Counter, subKind: null, prePhase: AwaitingCounter },
      { kind: SevenPick, subKind: OneOff, prePhase: SevenChoosing },
    ];
    for (const c of counterable) {
      for (const rank of ALL_RANKS) {
        for (const postPhase of postPhasesWithoutWindow) {
          for (const postActive of ACTORS) {
            const mv = move(c.kind, { rank, subKind: c.subKind });
            const label = `kind ${c.kind} rank ${rank} post ${postPhase} active ${postActive}`;
            const states = walk(ctx(view(A, c.prePhase), mv, view(postActive, postPhase, A)));
            let want: CurtainState[];
            if (postPhase === GameOver) want = [result];
            else if (postActive === A) want = [none];
            else want = [handoff(O, reasonFor(postPhase)), reveal(O), none];
            expect(states, label).toEqual(want);
            expect(states.some((st) => st.kind === 'ack'), label).toBe(false);
          }
        }
      }
    }
  });

  it('R14.2: an ack follows exactly when the engine opened the window (post.phase === PhaseAwaitingCounter), addressed to the decider', () => {
    for (const rank of ALL_RANKS) {
      expect(walk(ctx(view(A, Normal), move(OneOff, { rank }), view(O, AwaitingCounter, A)))).toEqual([handoff(O, 'counter'), reveal(O), ack(O)]);
      expect(walk(ctx(view(A, SevenChoosing), move(SevenPick, { rank, subKind: OneOff }), view(O, AwaitingCounter, A)))).toEqual([handoff(O, 'counter'), reveal(O), ack(O)]);
    }
    expect(walk(ctx(view(A, AwaitingCounter), move(Counter, { rank: 2 }), view(O, AwaitingCounter, A)))).toEqual([handoff(O, 'counter'), reveal(O), ack(O)]);
  });

  it('R14.2: never reads AppliedMove.index (absent for non-movers)', () => {
    const mv = move(OneOff, { rank: 9 });
    delete mv.index;
    expect(next(view(A, Normal), mv, view(O, Normal, A))).toEqual(handoff(O, 'turn'));
  });
});

describe('ruling 2026-09-29: no recap line the counter prompt already shows', () => {
  const oneOff = (seq: number, by: PlayerId = A): RecapEntry => ({ ...move(OneOff, { by, rank: 5 }), seq });
  const counter = (seq: number, by: PlayerId): RecapEntry => ({ ...move(Counter, { by, rank: 2 }), seq });
  const windowFor = (recap: RecapEntry[], preActive: PlayerId = A, prePhase: Phase = Normal): CurtainContext =>
    ctx(view(preActive, prePhase), move(prePhase === AwaitingCounter ? Counter : OneOff, { by: preActive, rank: 5 }), view(O, AwaitingCounter, preActive), { [O]: recap });

  it('the recap is skipped when it holds only the one-off the prompt shows (one tap fewer)', () => {
    expect(walk(windowFor([oneOff(8)]))).toEqual([handoff(O, 'counter'), reveal(O), ack(O)]);
  });

  it('the recap is skipped when it holds only the 2 the prompt shows (a counter-back)', () => {
    // A played the one-off, O countered (O has seen both), A countered back.
    expect(walk(windowFor([counter(10, A)], A, AwaitingCounter))).toEqual([handoff(O, 'counter'), reveal(O), ack(O)]);
  });

  it('a move the prompt does not show stays in the recap; the chain is dropped from it', () => {
    const discard: RecapEntry = { ...move(DiscardPair, { by: A }), seq: 7 };
    expect(walk(windowFor([discard, oneOff(8)]))).toEqual([
      handoff(O, 'counter'),
      reveal(O),
      { kind: 'recap', to: O, entries: [discard] },
      ack(O),
    ]);
  });

  it('only the one-off that opened the chain is dropped: an earlier one-off (a 7) stays', () => {
    const seven: RecapEntry = { ...move(OneOff, { by: A, rank: 7 }), seq: 7 };
    const pick: RecapEntry = { ...move(SevenPick, { by: A, rank: 5, subKind: OneOff }), seq: 8 };
    const c = ctx(view(A, SevenChoosing), pick, view(O, AwaitingCounter, A), { [O]: [seven, pick] });
    expect(walk(c)).toEqual([handoff(O, 'counter'), reveal(O), { kind: 'recap', to: O, entries: [seven] }, ack(O)]);
  });

  it('a recap before a board keeps every entry, one-offs included', () => {
    const entries = [oneOff(8), counter(9, O), counter(10, A)];
    const c = ctx(view(A, AwaitingCounter), move(Counter, { by: A, rank: 2 }), view(O, Normal, A), { [O]: entries });
    expect(walk(c)).toEqual([handoff(O, 'turn'), reveal(O), { kind: 'recap', to: O, entries }, none]);
  });
});

describe('counter-chain resolution — SPEC §4.4 PhaseAwaitingCounter parity', () => {
  // P1 plays a one-off (a 9 unless noted); P2 and P1 alternate counters.
  const P1: PlayerId = 0;
  const P2: PlayerId = 1;

  it('R14.3: issues one counter curtain per counter link, each to the next decider', () => {
    // one-off by P1 → window to P2 → P2 counters → window to P1 → P1 counters → window to P2
    const links: Array<{ pre: PlayerView; mv: AppliedMove; post: PlayerView; to: PlayerId }> = [
      { pre: view(P1, Normal), mv: move(OneOff, { by: P1, rank: 9 }), post: view(P2, AwaitingCounter, P1), to: P2 },
      { pre: view(P2, AwaitingCounter), mv: move(Counter, { by: P2, rank: 2 }), post: view(P1, AwaitingCounter, P2), to: P1 },
      { pre: view(P1, AwaitingCounter), mv: move(Counter, { by: P1, rank: 2 }), post: view(P2, AwaitingCounter, P1), to: P2 },
    ];
    for (const l of links) {
      expect(walk(ctx(l.pre, l.mv, l.post))).toEqual([handoff(l.to, 'counter'), reveal(l.to), ack(l.to)]);
    }
  });

  it('R14.3: even chain length (0) — decline resolves the one-off\'s own effect; control follows the effect', () => {
    // 9 resolves → P2's turn; P2 declined, so P2 keeps the phone: no curtain.
    expect(walk(ctx(view(P2, AwaitingCounter), move(Decline, { by: P2 }), view(P2, Normal, P2)))).toEqual([none]);
    // A 7 resolves → SevenChoosing for P1: curtain back to P1.
    expect(walk(ctx(view(P2, AwaitingCounter), move(Decline, { by: P2 }), view(P1, SevenChoosing, P2)))).toEqual([
      handoff(P1, 'seven-return'),
      reveal(P1),
      none,
    ]);
  });

  it('R14.3: even chain length (2) — decline resolves the one-off; its effect decides the next curtain', () => {
    // P1 one-off, P2 counters, P1 counters, P2 declines → resolves (P1's 7) → SevenChoosing for P1.
    expect(walk(ctx(view(P2, AwaitingCounter), move(Decline, { by: P2 }), view(P1, SevenChoosing, P2)))).toEqual([
      handoff(P1, 'seven-return'),
      reveal(P1),
      none,
    ]);
    // Last counter (P1) meets no 2 in P2's hand → resolves (a 9) → P2's turn, no ack.
    expect(walk(ctx(view(P1, AwaitingCounter), move(Counter, { by: P1, rank: 2 }), view(P2, Normal, P1)))).toEqual([
      handoff(P2, 'turn'),
      reveal(P2),
      none,
    ]);
  });

  it('R14.3: odd chain length — decline cancels with no effect; turn passes to the original player\'s opponent', () => {
    // P1 one-off, P2 counters (chain 1), P1 declines → cancelled → P2's turn.
    expect(walk(ctx(view(P1, AwaitingCounter), move(Decline, { by: P1 }), view(P2, Normal, P1)))).toEqual([
      handoff(P2, 'turn'),
      reveal(P2),
      none,
    ]);
    // P1 one-off, P2 counters and P1 has no 2 → cancelled at once → P2 plays on, no curtain.
    expect(walk(ctx(view(P2, AwaitingCounter), move(Counter, { by: P2, rank: 2 }), view(P2, Normal, P2)))).toEqual([none]);
  });
});

describe('handoff label — SPEC §4.5 (amended 2026-09-27)', () => {
  it('R14.2: handoff label is identical for counter and discard', () => {
    const responses: HandoffReason[] = ['counter', 'discard'];
    for (const r of responses) expect(handoffLabel(r)).toBe('Your response');
  });

  it('R14.2: handoff label is "Your turn" for turn and seven-return', () => {
    expect(handoffLabel('turn')).toBe('Your turn');
    expect(handoffLabel('seven-return')).toBe('Your turn');
  });

  it('the resume gate reads "Resume game", one label whatever it resumes into (SPEC §4.5, §5.7, ruling 2026-09-29)', () => {
    expect(handoffLabel('resume')).toBe('Resume game');
  });
});

describe('W25: the opening deal\'s curtain (move null)', () => {
  const first: CurtainView = { active: 1, phase: 0 as Phase };
  const openingCtx = (recap: RecapEntry[] = [], view: CurtainView = first): CurtainContext => ({
    pre: view,
    move: null,
    post: view,
    recapFor: () => recap,
  });

  it('is a handoff to the first actor with the neutral turn label', () => {
    expect(opening(1)).toEqual({ kind: 'handoff', to: 1, reason: 'turn' });
    expect(handoffLabel('turn')).toBe('Your turn');
  });

  it('walks handoff -> reveal -> none, with no ack', () => {
    expect(walk(openingCtx())).toEqual([
      { kind: 'handoff', to: 1, reason: 'turn' },
      { kind: 'reveal', to: 1 },
      { kind: 'none' },
    ]);
  });
});
