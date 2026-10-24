// R25.2 (docs/tutorial-plan.md T3, design §11 S1/S2): every lesson replays
// exactly as the design says through the real wasm bridge (engine v0.2.1),
// every nudge rule is reachable, and the lesson copy fits the bubble.
//
// Engine v0.2.1 rules the checkpoints rely on (module
// github.com/ApisMellow/cuttle@v0.2.1, read-only):
//   - Legal move enumeration in PhaseNormal: engine/apply.go:15-135.
//     Draw needs a deck and a hand under 8: apply.go:11, :34-36.
//     A, 4, 5, 6 one-offs: apply.go:41-43. A 2 targets only permanents and
//     Jacks: apply.go:44-69. A 9 targets opponent points and permanents,
//     Queen-protected: apply.go:70-87. A Jack steals an opponent point unless
//     a Queen protects it: apply.go:88-97. A 3 needs a scrap card:
//     apply.go:98-111. A–10 point plays and scuttles: apply.go:112-123.
//     A 7 one-off needs a deck: apply.go:124-126. Q, K, 8 permanents:
//     apply.go:127-129.
//   - Scuttle beats: higher rank, or same rank and higher suit:
//     card/card.go:49-56, suit order C < D < H < S card/card.go:7-12.
//     A scuttle scraps both cards: apply.go:243-268.
//   - PlayPoint and PlayPermanent check the mover's win at once:
//     apply.go:174-192, :232-242; checkWin apply.go:817-826;
//     Threshold (21, 14 with one King) engine/win.go:5-18, HasWon win.go:38-40.
//   - A Jack steal transplants the point entry: apply.go:201-230.
//   - A one-off opens a counter window only if the opponent holds an
//     unfrozen 2: apply.go:324-341, hasLegalCounter apply.go:489-497; the
//     window offers Decline plus one Counter per 2: apply.go:576-586.
//   - The Ace scraps every point card on both sides: apply.go:626-634.
//   - A Counter that leaves the chain odd cancels the one-off and passes the
//     turn back: apply.go:342-365, resolvePending apply.go:591-608,
//     endTurn apply.go:837-841.
//   - Draw takes the deck top: apply.go:144-153.
//   - Glasses (an 8 permanent) show the opponent's hand to its owner:
//     internal/game/view.go:78-88, :163-166.
//   - Descriptions (the golden lists below): engine/moves.go:36-70; legal
//     moves and descriptions go only to the actor: internal/game/envelope.go:245-250.
//   - The bridge's apply returns the mover's envelope; view(0) is fetched
//     after every move (lib/bridge/engine.ts, SPEC §2.4).
import { beforeAll, describe, expect, it } from 'vitest';

import { boardTargetKey } from '../../src/lib/affordances';
import { apply, legalMoves, restore, view } from '../../src/lib/bridge/engine';
import type { BridgeResult, Card, Envelope, Move } from '../../src/lib/bridge/schema';
import { MoveKind } from '../../src/lib/enums';
import { BLAKE_THINKING, CANCEL_SUFFIX, LESSONS, NEXT_FIRST, SNAG_LINE } from '../../src/lib/tutorial/lessons';
import { matchingIndices, moveMatches, nudgeFor } from '../../src/lib/tutorial/match';
import { c, positionSnapshot } from '../../src/lib/tutorial/position';
import type { Lesson, LessonId, MovePredicate, MoveStep } from '../../src/lib/tutorial/types';
import { createWasmEngine } from '../scenario/wasm-engine';

beforeAll(async () => {
  await createWasmEngine();
});

function ok(res: BridgeResult): Envelope {
  if (!res.ok) throw new Error(`bridge error ${res.code}: ${res.message}`);
  return res;
}

function lessonOf(id: LessonId): Lesson {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} missing`);
  return l;
}

const key = (x: Card) => `${x.Rank}:${x.Suit}`;
const keys = (xs: Card[]) => xs.map(key).sort();

/**
 * The staging slot a move occupies on the page (plan P4, design §7.2 data
 * rule): its source (a hand index, the deck, or the counter option) and its
 * board target key. Pass, Decline and DiscardPair are never staged from the
 * board, so they have no slot.
 */
function slotOf(m: Move): string | null {
  if (m.Kind === MoveKind.Draw) return 'deck';
  if (m.Kind === MoveKind.Counter) return `counter:${m.HandIndex}`;
  const target = boardTargetKey(m);
  if (target === null) return null;
  return `hand:${m.HandIndex}|${target}`;
}

/** Narrowed predicates, one per alternative the step's `expect` allows. */
type Alternatives = Partial<Record<string, MovePredicate>>;

interface StepTrace {
  id: string;
  /** view(0) when the step begins. */
  arrive: Envelope;
  /** view(0) after the learner's move (move steps). */
  afterMove?: Envelope;
  /** view(0) after each of Blake's replies. */
  afterBlake: Envelope[];
}

interface Trace {
  steps: StepTrace[];
  descriptions: string[];
  /** stepId → indices of nudge rules that matched a wrong legal move. */
  reached: Map<string, Set<number>>;
  /** stepId → engine description of each wrong legal move → the nudge lines it got. */
  wrong: Map<string, Map<string, Set<string>>>;
}

function step(trace: Trace, id: string): StepTrace {
  const s = trace.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no trace for step ${id}`);
  return s;
}

/** Restores the lesson and walks every step through the real bridge. */
function walk(lesson: Lesson, alt: Alternatives): Trace {
  const trace: Trace = { steps: [], descriptions: [], reached: new Map(), wrong: new Map() };
  ok(restore(positionSnapshot(lesson.position), 0));
  for (const st of lesson.steps) {
    const arrive = ok(view(0));
    const entry: StepTrace = { id: st.id, arrive, afterBlake: [] };
    trace.steps.push(entry);
    if (st.kind !== 'move') continue;

    const matches = matchingIndices(arrive, st.expect);
    expect(matches.length, `step ${st.id}: the expected move is legal`).toBeGreaterThan(0);
    // The data rule: each expected move's staging slot holds exactly one legal move.
    for (const i of matches) {
      const slot = slotOf(arrive.legalMoves[i]);
      expect(slot, `step ${st.id}: the expected move has a staging slot`).not.toBeNull();
      const sharing = arrive.legalMoves.filter((m) => slotOf(m) === slot);
      expect(sharing, `step ${st.id}: slot ${slot} holds one legal move`).toHaveLength(1);
    }

    // Nudge reachability, and every wrong move gets a non-empty line.
    const reached = trace.reached.get(st.id) ?? new Set<number>();
    trace.reached.set(st.id, reached);
    const wrong = new Map<string, Set<string>>();
    trace.wrong.set(st.id, wrong);
    arrive.legalMoves.forEach((m, j) => {
      if (matches.includes(j)) return;
      const line = nudgeFor(m, st, arrive.state);
      expect(line.length, `step ${st.id}: wrong move ${j} has a nudge`).toBeGreaterThan(0);
      const d = arrive.descriptions[j];
      wrong.set(d, (wrong.get(d) ?? new Set<string>()).add(line));
      st.nudges.forEach((rule, k) => {
        if (moveMatches(m, rule.when, arrive.state)) reached.add(k);
      });
    });

    let chosen: number;
    const narrow = alt[st.id];
    if (narrow) {
      const picked = matches.filter((i) => moveMatches(arrive.legalMoves[i], narrow, arrive.state));
      expect(picked, `step ${st.id}: the alternative picks one expected move`).toHaveLength(1);
      chosen = picked[0];
    } else {
      expect(matches, `step ${st.id}: one expected move unless alternatives are listed`).toHaveLength(1);
      chosen = matches[0];
    }
    trace.descriptions.push(arrive.descriptions[chosen]);
    ok(apply(chosen));
    entry.afterMove = ok(view(0));

    for (const reply of st.blake) {
      const blakeEnv = ok(legalMoves());
      const idx = matchingIndices(blakeEnv, reply.move);
      expect(idx, `step ${st.id}: Blake's reply matches exactly one legal move`).toHaveLength(1);
      trace.descriptions.push(blakeEnv.descriptions[idx[0]]);
      ok(apply(idx[0]));
      entry.afterBlake.push(ok(view(0)));
    }
  }
  return trace;
}

/** The predicate alternatives the design allows (3.1 either target, 5.2 either Jack). */
const ALTERNATIVES: Record<LessonId, { name: string; alt: Alternatives }[]> = {
  1: [{ name: 'the only line', alt: {} }],
  2: [{ name: 'the only line', alt: {} }],
  3: [
    { name: '3.1 scuttles the 9 of diamonds', alt: { '3.1': { kind: MoveKind.Scuttle, card: c(10, 'H'), target: c(9, 'D') } } },
    { name: '3.1 scuttles the 6 of clubs', alt: { '3.1': { kind: MoveKind.Scuttle, card: c(10, 'H'), target: c(6, 'C') } } },
  ],
  4: [{ name: 'the only line', alt: {} }],
  5: [
    { name: '5.2 steals with the Jack of diamonds', alt: { '5.2': { kind: MoveKind.PlayPermanent, card: c(11, 'D'), target: c(7, 'D') } } },
    { name: '5.2 steals with the Jack of spades', alt: { '5.2': { kind: MoveKind.PlayPermanent, card: c(11, 'S'), target: c(7, 'D') } } },
  ],
};

/** Golden engine descriptions, learner and Blake moves in order (glyphs allowed in tests). */
const GOLDEN: Record<LessonId, string[][]> = {
  1: [['play 9♦ as point card']],
  2: [['play 7♣ as point card', 'play 6♦ as point card', 'draw a card', 'draw a card']],
  3: [
    ["scuttle opponent's 9♦ with 10♥", 'play 8♣ as point card', "scuttle opponent's 8♣ with 8♥"],
    ["scuttle opponent's 6♣ with 10♥", 'play 8♣ as point card', "scuttle opponent's 8♣ with 8♥"],
  ],
  4: [['play A♠ as one-off', 'play 4♦ as one-off', 'counter with 2♥']],
  5: [
    ['play 8♣ as permanent', 'draw a card', 'play J♦ (steal opponent point)', 'play Q♠ as permanent', 'play K♥ as permanent'],
    ['play 8♣ as permanent', 'draw a card', 'play J♠ (steal opponent point)', 'play Q♠ as permanent', 'play K♥ as permanent'],
  ],
};

/** Checkpoints per lesson (design §11 S1, plus the numbers the coach copy states). */
const CHECKPOINTS: Record<LessonId, (t: Trace) => void> = {
  1: (t) => {
    // 1.1: "You have 12. Blake has 10."
    expect(step(t, '1.1').arrive.state.scoreboard.you.points).toBe(12);
    expect(step(t, '1.1').arrive.state.scoreboard.opponent.points).toBe(10);
    const end = step(t, '1.5').afterMove!;
    expect(end.state.phase).toBe(4);
    expect(end.state.winner).toBe(0);
    expect(end.state.scoreboard.you.points).toBe(21);
  },
  2: (t) => {
    // 2.1 success: "5 and 7 make 12."; Blake: "He has 10."
    expect(step(t, '2.1').afterMove!.state.scoreboard.you.points).toBe(12);
    expect(step(t, '2.1').afterBlake[0].state.scoreboard.opponent.points).toBe(10);
    // 2.2 success: "You drew a 10."
    expect(keys(step(t, '2.2').afterMove!.state.you.hand)).toEqual(keys([c(3, 'D'), c(10, 'D')]));
    const end = step(t, '2.3').arrive.state;
    expect(end.scoreboard.you.points).toBe(12);
    expect(keys(end.you.hand)).toEqual(keys([c(3, 'D'), c(10, 'D')]));
    expect(end.phase).toBe(0);
    expect(end.active).toBe(0);
    expect(end.opponent.handCount).toBe(5);
  },
  3: (t) => {
    // 3.1: "Blake has 15."
    expect(step(t, '3.1').arrive.state.scoreboard.opponent.points).toBe(15);
    const after31 = step(t, '3.1').afterMove!.state;
    expect(keys(after31.scrap)).toContain(key(c(10, 'H')));
    expect(after31.opponent.points).toHaveLength(1);
    // Blake's 8 of clubs lands on his points row.
    expect(step(t, '3.2').arrive.state.opponent.points.map((p) => key(p.Card))).toContain(key(c(8, 'C')));
    const end = step(t, '3.2').afterMove!.state;
    expect(end.scrap.map(key)).toContain(key(c(8, 'C')));
    expect(end.scrap.map(key)).toContain(key(c(8, 'H')));
    expect(end.opponent.points.map((p) => key(p.Card))).not.toContain(key(c(8, 'C')));
    expect(end.phase).toBe(0);
  },
  4: (t) => {
    // 4.1: "Blake has 19".
    expect(step(t, '4.1').arrive.state.scoreboard.opponent.points).toBe(19);
    const after41 = step(t, '4.1').afterMove!.state;
    expect(after41.you.points).toEqual([]);
    expect(after41.opponent.points).toEqual([]);
    expect(after41.phase).toBe(0);
    expect(after41.active).toBe(1);
    const ack = step(t, '4.1').afterBlake[0].state;
    expect(ack.phase).toBe(1);
    expect(ack.active).toBe(0);
    // 4.2: "Blake played a 4."
    expect(ack.pending?.card).toEqual(c(4, 'D'));
    expect(ack.pending?.playedBy).toBe(1);
    expect(step(t, '4.2').arrive.legalMoves.map((m) => m.Kind).sort()).toEqual([MoveKind.Counter, MoveKind.Decline].sort());
    const end = step(t, '4.2').afterMove!.state;
    expect(end.phase).toBe(0);
    expect(end.active).toBe(0);
    expect(end.pending).toBeNull();
    // "His 4 does nothing": Alice keeps her 5.
    expect(end.you.hand).toEqual([c(5, 'C')]);
  },
  5: (t) => {
    const after51 = step(t, '5.1').afterMove!.state;
    expect(after51.opponent.hand).not.toBeNull();
    // 5.1 success: "He's holding a Queen."
    expect(after51.opponent.hand!.map(key)).toContain(key(c(12, 'S')));
    // Blake: "Blake drew an Ace. You saw it."
    expect(step(t, '5.1').afterBlake[0].state.opponent.hand!.map(key)).toContain(key(c(1, 'D')));
    // 5.2 success: "You have 15, he has 3."
    const after52 = step(t, '5.2').afterMove!.state.scoreboard;
    expect(after52.you.points).toBe(15);
    expect(after52.opponent.points).toBe(3);
    // 5.3: after the Queen, the Jack still in hand has no legal move.
    const s53 = step(t, '5.3').arrive;
    expect(s53.state.opponent.permanents.map(key)).toContain(key(c(12, 'S')));
    expect(s53.state.you.hand.filter((x) => x.Rank === 11)).toHaveLength(1);
    expect(s53.legalMoves.filter((m) => m.Card?.Rank === 11)).toEqual([]);
    const end = step(t, '5.4').afterMove!.state;
    expect(end.phase).toBe(4);
    expect(end.winner).toBe(0);
    expect(end.scoreboard.you.threshold).toBe(14);
    expect(end.scoreboard.you.points).toBe(15);
  },
};

for (const id of [1, 2, 3, 4, 5] as const) {
  describe(`S1 lesson ${id} replays through the real wasm`, () => {
    ALTERNATIVES[id].forEach(({ name, alt }, n) => {
      it(name, () => {
        const lesson = lessonOf(id);
        const trace = walk(lesson, alt);
        expect(trace.descriptions).toEqual(GOLDEN[id][n]);
        CHECKPOINTS[id](trace);
        // No move before the last one ends the game.
        for (const s of trace.steps.slice(0, -1)) {
          expect(s.afterMove?.state.phase ?? 0, `step ${s.id}`).not.toBe(4);
          for (const b of s.afterBlake) expect(b.state.phase, `step ${s.id} (Blake)`).not.toBe(4);
        }
      });
    });

    it('every predicate alternative is listed', () => {
      const lesson = lessonOf(id);
      const trace = walk(lesson, ALTERNATIVES[id][0].alt);
      for (const st of lesson.steps) {
        if (st.kind !== 'move') continue;
        const arrive = step(trace, st.id).arrive;
        const n = matchingIndices(arrive, st.expect).length;
        const listed = ALTERNATIVES[id].filter((a) => a.alt[st.id]).length;
        expect(n, `step ${st.id}`).toBe(listed === 0 ? 1 : listed);
      }
    });
  });
}

/**
 * Golden: for every WRONG legal move at every move step (union over the
 * alternative lines), keyed by its engine description, the exact line the
 * coach gives it. Generated from lessons.ts, then checked line by line
 * against design §5.2–§5.6 (and the accepted generic lines). These lines
 * teach rules, so a re-aimed or shadowed rule must fail here.
 */
const LINE_15_9 = 'That would send his 10 back to his hand. This time, put your 9 on your Points row.';
const GEN_15 = 'Not this one. Your 9 gets you to 21.';
const GEN_31 = 'Use your 10 on one of his point cards.';
const GEN_32 = 'Put your 8 on his 8.';
const GEN_41 = 'Use your Ace. Drop it on the middle spot.';
const GLASSES = 'Put the 8 in your Permanents row instead, as glasses.';
const KING = 'Save your King for the finish.';
const WRONG_NUDGES: Record<string, Record<string, string>> = {
  '1.5': {
    'draw a card': GEN_15,
    'play 9♦ as one-off': LINE_15_9,
    'play 4♠ as one-off': GEN_15,
    'play 4♠ as point card': GEN_15,
    'play 2♣ as point card': GEN_15,
  },
  '2.1': {
    'draw a card': 'First, play your 7 for points.',
    "scuttle opponent's 4♥ with 7♣": 'Knocking out his cards is the next lesson. Play the 7 for points.',
    'play 7♣ as one-off': "That uses the 7's power. For now, play it for points.",
    'play 3♦ as point card': 'Your 7 is worth more. Play the 7.',
  },
  '2.2': {
    'play 3♦ as point card': 'That works in a real game. Here, try drawing a card.',
  },
  '3.1': {
    'draw a card': GEN_31,
    'play 10♥ as point card': 'That adds 10, but Blake keeps his 15. Drop the 10 on his cards.',
    'play 8♥ as point card': GEN_31,
    "scuttle opponent's 6♣ with 8♥": GEN_31,
    'play 8♥ as permanent': GEN_31,
    'play 4♣ as one-off': 'A 4 makes him discard. Try a scuttle instead.',
    'play 4♣ as point card': GEN_31,
  },
  '3.2': {
    'draw a card': GEN_32,
    'play 8♥ as point card': GEN_32,
    "scuttle opponent's 6♣ with 8♥": 'That works too. Try the tie: your 8 on his 8.',
    'play 8♥ as permanent': GEN_32,
    'play 4♣ as one-off': GEN_32,
    'play 4♣ as point card': GEN_32,
  },
  '4.1': {
    'draw a card': GEN_41,
    'play A♠ as point card': 'On your Points row an Ace is just 1 point. Drop it on the middle spot to use its power.',
    'play 2♥ as point card': GEN_41,
    'play 5♣ as one-off': 'A 5 draws 2 cards, but Blake would still have 19. Use the Ace.',
    'play 5♣ as point card': GEN_41,
  },
  '4.2': {
    'decline to counter': 'Letting it happen costs you 2 cards. Use your 2: tap it, then Confirm.',
  },
  '5.1': {
    'draw a card': GLASSES,
    'play J♦ (steal opponent point)': 'Jacks are next. First, the 8.',
    'play J♠ (steal opponent point)': 'Jacks are next. First, the 8.',
    'play 8♣ as point card': GLASSES,
    "scuttle opponent's 7♦ with 8♣": GLASSES,
    "scuttle opponent's 3♥ with 8♣": GLASSES,
    'play K♥ as permanent': KING,
  },
  '5.2': {
    'draw a card': 'A Jack steals. Drop one on his 7, and that 7 counts for you.',
    'play J♦ (steal opponent point)': 'That steals 3 points. His 7 is worth more.',
    'play J♠ (steal opponent point)': 'That steals 3 points. His 7 is worth more.',
    'play K♥ as permanent': KING,
  },
  '5.4': {
    'draw a card': 'Play your King.',
  },
};

/** Golden: every step's main line, and each move step's staged, success and tap-route lines (design §5, plan Appendix A). */
const STEP_LINES: Record<string, { main: string; staged?: string; success?: string; tapRoute?: string }> = {
  '1.1': { main: 'Cuttle is a race. First to 21 points wins. You have 12. Blake has 10.' },
  '1.2': { main: "This is Blake's side. His hand stays face down. Cards he plays land here." },
  '1.3': { main: 'In the middle: the deck you draw from, and the scrap pile, where used cards go.' },
  '1.4': { main: 'This is your side. Only you see your hand. Cards you play go in the rows above it.' },
  '1.5': {
    main: 'Your 9 gets you to 21. Drag it onto your Points row.',
    staged: 'Nothing counts until you confirm. Tap Confirm.',
    success: '21. You win!',
    tapRoute: 'Tap your 9, then your Points row, then Confirm.',
  },
  '2.1': {
    main: 'Each turn you do one thing. Play your 7 for points.',
    staged: 'Tap Confirm.',
    success: 'Your points add up: 5 and 7 make 12.',
    tapRoute: 'Tap your 7, then your Points row, then Confirm.',
  },
  '2.2': {
    main: 'No good play? Draw a card instead. Tap the deck, then tap it again.',
    staged: 'Tap the deck again, or tap Confirm.',
    success: 'You drew a 10. Drawing uses up your turn too.',
    tapRoute: 'Tap the deck, then tap it again.',
  },
  '2.3': { main: "You can hold up to 8 cards. With 8 in hand, you can't draw." },
  '3.1': {
    main: 'Blake has 15. Knock some out: drop your 10 on one of his point cards.',
    staged: 'Both cards go to the scrap. Tap Confirm.',
    success: 'Scuttled. His card and your 10 both go to the scrap.',
    tapRoute: 'Tap your 10, then one of his point cards, then Confirm.',
  },
  '3.2': {
    main: 'Same number? The higher suit wins: clubs, then diamonds, hearts, spades. Your 8 of hearts beats his 8 of clubs.',
    staged: 'Tap Confirm to scuttle his 8.',
    success: 'Hearts beat clubs. Scuttled.',
    tapRoute: 'Tap your 8, then his 8, then Confirm.',
  },
  '4.1': {
    main: 'Blake has 19! Your Ace has a one-off power: it wipes every point card off the table. Drop it on the middle spot.',
    staged: 'Tap Confirm to use your Ace.',
    success: 'Wiped, yours too. A one-off happens right away, then goes to the scrap.',
    tapRoute: 'Tap your Ace, then the middle spot, then Confirm.',
  },
  '4.2': {
    main: "Blake played a 4: you'd have to throw away 2 cards. You hold a 2, so you can stop it. Tap your 2, then Confirm.",
    staged: 'Tap Confirm to stop his 4.',
    success: 'Stopped. His 4 does nothing, and his turn is over.',
    tapRoute: 'Tap your 2, then Confirm.',
  },
  '5.1': {
    main: "An 8 can be glasses. Put it in your Permanents row and you'll see Blake's hand.",
    staged: 'Tap Confirm to put on your glasses.',
    success: "Now you can see his cards. He's holding a Queen.",
    tapRoute: 'Tap your 8, then your Permanents row, then Confirm.',
  },
  '5.2': {
    main: 'A Jack steals. Drop one on his 7, and that 7 counts for you.',
    staged: 'Tap Confirm to steal his 7.',
    success: 'Stolen. You have 15, he has 3.',
    tapRoute: 'Tap a Jack, then his 7, then Confirm.',
  },
  '5.3': { main: 'His Queen protects his other cards. Tap your other Jack and see.' },
  '5.4': {
    main: 'A King lowers the points you need to win. With one King you need 14. You have 15.',
    staged: 'Tap Confirm to play your King.',
    success: 'You need 14, and you have 15. You win!',
    tapRoute: 'Tap your King, then your Permanents row, then Confirm.',
  },
};

describe('golden coach lines', () => {
  it('every step has exactly its golden main, staged, success and tap-route lines', () => {
    const actual: Record<string, { main: string; staged?: string; success?: string; tapRoute?: string }> = {};
    for (const l of LESSONS) {
      for (const s of l.steps) {
        actual[s.id] = s.kind === 'move' ? { main: s.main, staged: s.staged, success: s.success, tapRoute: s.tapRoute } : { main: s.main };
      }
    }
    expect(actual).toEqual(STEP_LINES);
  });

  for (const id of [1, 2, 3, 4, 5] as const) {
    it(`lesson ${id}: every wrong legal move gets its golden nudge`, () => {
      const lesson = lessonOf(id);
      const seen = new Map<string, Map<string, Set<string>>>();
      for (const { alt } of ALTERNATIVES[id]) {
        for (const [stepId, byDesc] of walk(lesson, alt).wrong) {
          const into = seen.get(stepId) ?? new Map<string, Set<string>>();
          for (const [d, lines] of byDesc) into.set(d, new Set([...(into.get(d) ?? []), ...lines]));
          seen.set(stepId, into);
        }
      }
      for (const st of lesson.steps) {
        if (st.kind !== 'move') continue;
        const got: Record<string, string[]> = {};
        for (const [d, lines] of seen.get(st.id) ?? []) got[d] = [...lines];
        const want: Record<string, string[]> = {};
        for (const [d, line] of Object.entries(WRONG_NUDGES[st.id] ?? {})) want[d] = [line];
        expect(got, `step ${st.id}`).toEqual(want);
      }
    });
  }
});

describe('every nudge rule is reachable (no dead copy)', () => {
  for (const id of [1, 2, 3, 4, 5] as const) {
    it(`lesson ${id}`, () => {
      const lesson = lessonOf(id);
      // A rule counts as reachable if some alternative line reaches its step
      // with a legal move that matches the rule and fails `expect`.
      const reached = new Map<string, Set<number>>();
      for (const { alt } of ALTERNATIVES[id]) {
        for (const [stepId, ks] of walk(lesson, alt).reached) {
          const into = reached.get(stepId) ?? new Set<number>();
          ks.forEach((k) => into.add(k));
          reached.set(stepId, into);
        }
      }
      for (const st of lesson.steps) {
        if (st.kind !== 'move') continue;
        st.nudges.forEach((rule, k) => {
          expect(reached.get(st.id)?.has(k), `step ${st.id} rule "${rule.text}"`).toBe(true);
        });
        expect(st.nudges.every((r) => r.text.length > 0), `step ${st.id}: every rule has text`).toBe(true);
      }
    });
  }
});

const SUIT_GLYPH = /[♠-♧]/u;

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

type Fit = { where: string; text: string; max: number };

function copyLines(lesson: Lesson): Fit[] {
  const out: Fit[] = [];
  const fit = (where: string, text: string, max: number) => out.push({ where, text, max });
  for (const st of lesson.steps) {
    fit(`${st.id} main`, st.main, 120);
    if (st.kind === 'appear') fit(`${st.id} refusal`, st.refusal, 120);
    if (st.kind !== 'move') continue;
    fit(`${st.id} staged`, st.staged, 120);
    fit(`${st.id} success`, st.success, 120);
    fit(`${st.id} tap route`, st.tapRoute, 120);
    for (const r of st.nudges) fit(`${st.id} nudge`, r.text + CANCEL_SUFFIX, 160);
    fit(`${st.id} generic`, st.generic + CANCEL_SUFFIX, 160);
    for (const b of st.blake) {
      fit(`${st.id} Blake thinking`, b.thinking, 120);
      if (b.done !== undefined) fit(`${st.id} Blake done`, b.done, 120);
    }
  }
  return out;
}

describe('copy fits', () => {
  it('the shared lines are the design text', () => {
    expect(CANCEL_SUFFIX).toBe(' Tap Cancel to try again.');
    expect(BLAKE_THINKING).toBe("Blake's turn.");
    expect(NEXT_FIRST).toBe('Tap Next first.');
    expect(SNAG_LINE).toBe('This lesson hit a snag.');
  });

  for (const id of [1, 2, 3, 4, 5] as const) {
    it(`lesson ${id}: main, staged, success and tap-route lines ≤ 120; nudge + Cancel ≤ 160; no suit glyph`, () => {
      const lesson = lessonOf(id);
      const over: string[] = [];
      for (const { where, text, max } of copyLines(lesson)) {
        expect(text.length, `${where} is empty`).toBeGreaterThan(0);
        if (text.length > max) over.push(`${where} (${text.length} > ${max}): ${text}`);
      }
      expect(over).toEqual([]);
      for (const s of allStrings(lesson)) expect(s, 'suit glyph in lesson copy').not.toMatch(SUIT_GLYPH);
    });
  }
});

describe('lesson structure', () => {
  it('steps, flags and Blake lines are as designed', () => {
    const ids = LESSONS.map((l) => l.steps.map((s) => `${s.id}:${s.kind}`));
    expect(ids).toEqual([
      ['1.1:next', '1.2:next', '1.3:next', '1.4:next', '1.5:move'],
      ['2.1:move', '2.2:move', '2.3:next'],
      ['3.1:move', '3.2:move'],
      ['4.1:move', '4.2:move'],
      ['5.1:move', '5.2:move', '5.3:appear', '5.4:move'],
    ]);
    expect(LESSONS.map((l) => [l.win, l.deal])).toEqual([[true, true], [false, false], [false, false], [false, false], [true, false]]);
    // Titles: design §4.2/§5; subtitles: design §4.2 (1, 2) and plan Appendix A (3–5).
    expect(LESSONS.map((l) => [l.title, l.subtitle])).toEqual([
      ['The goal', 'Race to 21'],
      ['Your turn', 'Points and drawing'],
      ['Scuttling', 'Knock out his points'],
      ['One-offs and the 2', 'Powers, and how to stop them'],
      ['Royals and glasses', 'Jack, Queen, King and glasses'],
    ]);
    expect(LESSONS.map((l) => l.done)).toEqual([
      'You know the goal: reach 21 first.',
      'One thing per turn: play a card or draw.',
      'Scuttle with a bigger card, or the same number in a higher suit.',
      'A one-off happens at once, and only a 2 can stop it. Rules in the menu lists every one-off.',
      "That's Cuttle. Jacks steal, Queens protect, Kings lower your goal, and an 8 can be glasses. You're ready to play.",
    ]);
    const blake = LESSONS.flatMap((l) => l.steps.flatMap((s) => (s.kind === 'move' ? s.blake.map((b) => `${s.id}:${b.thinking}|${b.done ?? '-'}`) : [])));
    expect(blake).toEqual([
      "2.1:Blake's turn.|Blake played a 6. He has 10.",
      "2.2:Blake's turn.|Blake drew a card.",
      "3.1:Blake's turn.|Blake played an 8.",
      "4.1:Blake's turn.|-",
      "5.1:Blake's turn.|Blake drew an Ace. You saw it.",
      "5.2:Blake's turn.|Blake played his Queen.",
    ]);
    const appear = LESSONS.flatMap((l) => l.steps.filter((s) => s.kind === 'appear'));
    expect(appear).toEqual([
      expect.objectContaining({ id: '5.3', testId: 'card-detail-popover', refusal: 'First, tap your other Jack.', spot: [{ kind: 'handRank', rank: 11 }] }),
    ]);
  });

  it('every move step has a generic line and a demo', () => {
    for (const l of LESSONS) {
      for (const s of l.steps) {
        if (s.kind !== 'move') continue;
        const m: MoveStep = s;
        expect(m.generic.length, m.id).toBeGreaterThan(0);
        expect(m.demo.kind, m.id).not.toBe('none');
        expect(m.spot, m.id).toEqual([m.source]);
      }
    }
  });
});
