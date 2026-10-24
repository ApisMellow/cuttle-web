// Learn to play (R25): the five lessons as data. Positions, steps, copy,
// nudges, Blake's scripts and done lines are docs/tutorial-design.md
// §5.2–§5.6; lines the design leaves open are docs/tutorial-plan.md
// Appendix A. ApisMellow approves every line. Cards are numeric (`c()`);
// coach copy names cards in words only, never with suit glyphs
// (SPEC §5.6 rule 1).
//
// `tests/unit/tutorial-lessons-wasm.test.ts` replays every lesson through
// the real engine (v0.2.1) and checks the copy fits; it cites the engine
// rules each step relies on.

import { MoveKind } from '../enums';
import { c } from './position';
import type { BlakeReply, Lesson, SpotTarget } from './types';

/** Appended to a nudge while a wrong move is staged (design §7.2, ruling 2026-10-24). */
export const CANCEL_SUFFIX = ' Tap Cancel to try again.';
/** Blake's thinking line, for every reply (plan Appendix A). */
export const BLAKE_THINKING = "Blake's turn.";
/** A commit refused during a `next` step (plan P1). */
export const NEXT_FIRST = 'Tap Next first.';
/** A script or engine error (design §6.2 step 4). */
export const SNAG_LINE = 'This lesson hit a snag.';

const blake = (move: BlakeReply['move'], done?: string): BlakeReply =>
  done === undefined ? { move, thinking: BLAKE_THINKING } : { move, thinking: BLAKE_THINKING, done };

const ZONE_POINTS: SpotTarget = { kind: 'testid', id: 'zone-points' };
const ZONE_PERMANENTS: SpotTarget = { kind: 'testid', id: 'zone-permanents' };
const ZONE_ONEOFF: SpotTarget = { kind: 'testid', id: 'zone-oneoff' };
const DECK: SpotTarget = { kind: 'testid', id: 'deck-pile' };
const CONFIRM: SpotTarget = { kind: 'testid', id: 'staging-confirm' };

// ---------------------------------------------------------------------------
// Lesson 1, The goal (design §5.2)
// ---------------------------------------------------------------------------

const L1_9D: SpotTarget = { kind: 'hand', card: c(9, 'D') };

const LESSON_1: Lesson = {
  id: 1,
  title: 'The goal',
  subtitle: 'Race to 21',
  done: 'You know the goal: reach 21 first.',
  win: true,
  deal: true,
  position: {
    aliceHand: [c(9, 'D'), c(4, 'S'), c(2, 'C')],
    alicePoints: [c(7, 'H'), c(5, 'C')],
    blakeHand: [c(3, 'D'), c(6, 'S'), c(11, 'C'), c(12, 'D'), c(8, 'H')],
    blakePoints: [c(10, 'S')],
    scrap: [c(13, 'C'), c(4, 'H')],
    deckTop: [],
  },
  steps: [
    {
      kind: 'next',
      id: '1.1',
      main: 'Cuttle is a race. First to 21 points wins. You have 12. Blake has 10.',
      spot: [{ kind: 'testid', id: 'score-bar' }],
    },
    {
      kind: 'next',
      id: '1.2',
      main: "This is Blake's side. His hand stays face down. Cards he plays land here.",
      spot: [{ kind: 'testid', id: 'opponent-zone' }],
    },
    {
      kind: 'next',
      id: '1.3',
      main: 'In the middle: the deck you draw from, and the scrap pile, where used cards go.',
      spot: [{ kind: 'testid', id: 'center-zone' }],
    },
    {
      kind: 'next',
      id: '1.4',
      main: 'This is your side. Only you see your hand. Cards you play go in the rows above it.',
      spot: [{ kind: 'testid', id: 'player-zone' }],
    },
    {
      kind: 'move',
      id: '1.5',
      main: 'Your 9 gets you to 21. Drag it onto your Points row.',
      spot: [L1_9D],
      expect: { kind: MoveKind.PlayPoint, card: c(9, 'D') },
      source: L1_9D,
      target: ZONE_POINTS,
      staged: 'Nothing counts until you confirm. Tap Confirm.',
      tapRoute: 'Tap your 9, then your Points row, then Confirm.',
      nudges: [
        {
          when: { kind: MoveKind.OneOff, card: c(9, 'D'), target: c(10, 'S') },
          text: 'That would send his 10 back to his hand. This time, put your 9 on your Points row.',
        },
      ],
      generic: 'Not this one. Your 9 gets you to 21.',
      success: '21. You win!',
      demo: { kind: 'drag', from: L1_9D, to: ZONE_POINTS, thenConfirm: true },
      blake: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Lesson 2, Your turn (design §5.3)
// ---------------------------------------------------------------------------

const L2_7C: SpotTarget = { kind: 'hand', card: c(7, 'C') };

const LESSON_2: Lesson = {
  id: 2,
  title: 'Your turn',
  subtitle: 'Points and drawing',
  done: 'One thing per turn: play a card or draw.',
  win: false,
  deal: false,
  position: {
    aliceHand: [c(7, 'C'), c(3, 'D')],
    alicePoints: [c(5, 'S')],
    blakeHand: [c(6, 'D'), c(1, 'C'), c(9, 'S'), c(12, 'H'), c(4, 'C')],
    blakePoints: [c(4, 'H')],
    scrap: [],
    deckTop: [c(10, 'D'), c(8, 'S')],
  },
  steps: [
    {
      kind: 'move',
      id: '2.1',
      main: 'Each turn you do one thing. Play your 7 for points.',
      spot: [L2_7C],
      expect: { kind: MoveKind.PlayPoint, card: c(7, 'C') },
      source: L2_7C,
      target: ZONE_POINTS,
      staged: 'Tap Confirm.',
      tapRoute: 'Tap your 7, then your Points row, then Confirm.',
      nudges: [
        {
          when: { kind: MoveKind.Scuttle, card: c(7, 'C'), target: c(4, 'H') },
          text: 'Knocking out his cards is the next lesson. Play the 7 for points.',
        },
        { when: { kind: MoveKind.OneOff, card: c(7, 'C') }, text: "That uses the 7's power. For now, play it for points." },
        { when: { kind: MoveKind.PlayPoint, card: c(3, 'D') }, text: 'Your 7 is worth more. Play the 7.' },
        { when: { kind: MoveKind.Draw }, text: 'First, play your 7 for points.' },
      ],
      // The design lists a nudge for every wrong move here and no catch-all;
      // the generic reuses the Draw line.
      generic: 'First, play your 7 for points.',
      success: 'Your points add up: 5 and 7 make 12.',
      demo: { kind: 'drag', from: L2_7C, to: ZONE_POINTS, thenConfirm: false },
      blake: [blake({ kind: MoveKind.PlayPoint, card: c(6, 'D') }, 'Blake played a 6. He has 10.')],
    },
    {
      kind: 'move',
      id: '2.2',
      main: 'No good play? Draw a card instead. Tap the deck, then tap it again.',
      spot: [DECK],
      expect: { kind: MoveKind.Draw },
      source: DECK,
      target: DECK,
      staged: 'Tap the deck again, or tap Confirm.',
      tapRoute: 'Tap the deck, then tap it again.',
      nudges: [
        { when: { kind: MoveKind.PlayPoint, card: c(3, 'D') }, text: 'That works in a real game. Here, try drawing a card.' },
      ],
      // No catch-all in the design; the only other legal move is the 3.
      generic: 'That works in a real game. Here, try drawing a card.',
      success: 'You drew a 10. Drawing uses up your turn too.',
      demo: { kind: 'tap', at: [DECK, DECK], thenConfirm: false },
      blake: [blake({ kind: MoveKind.Draw }, 'Blake drew a card.')],
    },
    {
      kind: 'next',
      id: '2.3',
      main: "You can hold up to 8 cards. With 8 in hand, you can't draw.",
      spot: [{ kind: 'testid', id: 'player-hand' }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Lesson 3, Scuttling (design §5.4)
// ---------------------------------------------------------------------------

const L3_10H: SpotTarget = { kind: 'hand', card: c(10, 'H') };
const L3_8H: SpotTarget = { kind: 'hand', card: c(8, 'H') };
const L3_BLAKE_POINTS: SpotTarget = { kind: 'point', card: [c(9, 'D'), c(6, 'C')] };
const L3_8C: SpotTarget = { kind: 'point', card: c(8, 'C') };

const LESSON_3: Lesson = {
  id: 3,
  title: 'Scuttling',
  subtitle: 'Knock out his points',
  done: 'Scuttle with a bigger card, or the same number in a higher suit.',
  win: false,
  deal: false,
  position: {
    aliceHand: [c(10, 'H'), c(8, 'H'), c(4, 'C')],
    alicePoints: [c(6, 'S')],
    blakeHand: [c(8, 'C'), c(5, 'D'), c(11, 'H'), c(3, 'S')],
    blakePoints: [c(9, 'D'), c(6, 'C')],
    scrap: [c(12, 'C'), c(2, 'S')],
    deckTop: [],
  },
  steps: [
    {
      kind: 'move',
      id: '3.1',
      main: 'Blake has 15. Knock some out: drop your 10 on one of his point cards.',
      spot: [L3_10H],
      expect: { kind: MoveKind.Scuttle, card: c(10, 'H'), target: [c(9, 'D'), c(6, 'C')] },
      source: L3_10H,
      target: L3_BLAKE_POINTS,
      staged: 'Both cards go to the scrap. Tap Confirm.',
      tapRoute: 'Tap your 10, then one of his point cards, then Confirm.',
      nudges: [
        { when: { kind: MoveKind.PlayPoint, card: c(10, 'H') }, text: 'That adds 10, but Blake keeps his 15. Drop the 10 on his cards.' },
        { when: { kind: MoveKind.OneOff, card: c(4, 'C') }, text: 'A 4 makes him discard. Try a scuttle instead.' },
      ],
      generic: 'Use your 10 on one of his point cards.',
      success: 'Scuttled. His card and your 10 both go to the scrap.',
      demo: { kind: 'drag', from: L3_10H, to: { kind: 'point', card: c(9, 'D') }, thenConfirm: false },
      blake: [blake({ kind: MoveKind.PlayPoint, card: c(8, 'C') }, 'Blake played an 8.')],
    },
    {
      kind: 'move',
      id: '3.2',
      main: 'Same number? The higher suit wins: clubs, then diamonds, hearts, spades. Your 8 of hearts beats his 8 of clubs.',
      spot: [L3_8H],
      expect: { kind: MoveKind.Scuttle, card: c(8, 'H'), target: c(8, 'C') },
      source: L3_8H,
      target: L3_8C,
      staged: 'Tap Confirm to scuttle his 8.',
      tapRoute: 'Tap your 8, then his 8, then Confirm.',
      nudges: [
        { when: { kind: MoveKind.Scuttle, card: c(8, 'H'), target: c(6, 'C') }, text: 'That works too. Try the tie: your 8 on his 8.' },
        { when: { kind: MoveKind.PlayPoint, card: c(8, 'H') }, text: 'Put your 8 on his 8.' },
        { when: { kind: MoveKind.PlayPermanent, card: c(8, 'H') }, text: 'Put your 8 on his 8.' },
      ],
      // "8H anywhere else" is the rules above; the design has no catch-all
      // for the 4 or a draw, so the generic reuses the same line.
      generic: 'Put your 8 on his 8.',
      success: 'Hearts beat clubs. Scuttled.',
      demo: { kind: 'drag', from: L3_8H, to: L3_8C, thenConfirm: false },
      blake: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Lesson 4, One-offs and the 2 (design §5.5, §5.5.1)
// ---------------------------------------------------------------------------

const L4_AS: SpotTarget = { kind: 'hand', card: c(1, 'S') };
const COUNTER_OPTION: SpotTarget = { kind: 'counterOption' };
const L4_DECLINE_NUDGE = 'Letting it happen costs you 2 cards. Use your 2: tap it, then Confirm.';

const LESSON_4: Lesson = {
  id: 4,
  title: 'One-offs and the 2',
  subtitle: 'Powers, and how to stop them',
  done: 'A one-off happens at once, and only a 2 can stop it. Rules in the menu lists every one-off.',
  win: false,
  deal: false,
  position: {
    aliceHand: [c(1, 'S'), c(2, 'H'), c(5, 'C')],
    alicePoints: [c(3, 'D')],
    blakeHand: [c(4, 'D'), c(7, 'S'), c(13, 'C'), c(9, 'C')],
    blakePoints: [c(10, 'C'), c(9, 'H')],
    scrap: [c(11, 'D'), c(6, 'H')],
    deckTop: [],
  },
  steps: [
    {
      kind: 'move',
      id: '4.1',
      main: 'Blake has 19! Your Ace has a one-off power: it wipes every point card off the table. Drop it on the middle spot.',
      spot: [L4_AS],
      expect: { kind: MoveKind.OneOff, card: c(1, 'S') },
      source: L4_AS,
      target: ZONE_ONEOFF,
      staged: 'Tap Confirm to use your Ace.',
      tapRoute: 'Tap your Ace, then the middle spot, then Confirm.',
      nudges: [
        {
          when: { kind: MoveKind.PlayPoint, card: c(1, 'S') },
          text: 'On your Points row an Ace is just 1 point. Drop it on the middle spot to use its power.',
        },
        { when: { kind: MoveKind.OneOff, card: c(5, 'C') }, text: 'A 5 draws 2 cards, but Blake would still have 19. Use the Ace.' },
      ],
      generic: 'Use your Ace. Drop it on the middle spot.',
      success: 'Wiped, yours too. A one-off happens right away, then goes to the scrap.',
      demo: { kind: 'drag', from: L4_AS, to: ZONE_ONEOFF, thenConfirm: false },
      // Alice holds a 2, so Blake's 4 opens a counter window (design §5.5).
      // No done line: step 4.2's main line follows it (plan Appendix A).
      blake: [blake({ kind: MoveKind.OneOff, card: c(4, 'D') })],
    },
    {
      kind: 'move',
      id: '4.2',
      main: "Blake played a 4: you'd have to throw away 2 cards. You hold a 2, so you can stop it. Tap your 2, then Confirm.",
      spot: [COUNTER_OPTION],
      expect: { kind: MoveKind.Counter, card: c(2, 'H') },
      source: COUNTER_OPTION,
      target: CONFIRM,
      staged: 'Tap Confirm to stop his 4.',
      tapRoute: 'Tap your 2, then Confirm.',
      nudges: [{ when: { kind: MoveKind.Decline }, text: L4_DECLINE_NUDGE }],
      // The window's only wrong move is the Decline (design §5.5.1).
      generic: L4_DECLINE_NUDGE,
      success: 'Stopped. His 4 does nothing, and his turn is over.',
      demo: { kind: 'tap', at: [COUNTER_OPTION], thenConfirm: true },
      blake: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Lesson 5, Royals and glasses (design §5.6)
// ---------------------------------------------------------------------------

const L5_8C: SpotTarget = { kind: 'hand', card: c(8, 'C') };
const L5_JACKS: SpotTarget = { kind: 'hand', card: [c(11, 'D'), c(11, 'S')] };
const L5_JD: SpotTarget = { kind: 'hand', card: c(11, 'D') };
const L5_7D: SpotTarget = { kind: 'point', card: c(7, 'D') };
const L5_KH: SpotTarget = { kind: 'hand', card: c(13, 'H') };
const SAVE_KING = 'Save your King for the finish.';

const LESSON_5: Lesson = {
  id: 5,
  title: 'Royals and glasses',
  subtitle: 'Jack, Queen, King and glasses',
  done: "That's Cuttle. Jacks steal, Queens protect, Kings lower your goal, and an 8 can be glasses. You're ready to play.",
  win: true,
  deal: false,
  position: {
    aliceHand: [c(11, 'D'), c(11, 'S'), c(8, 'C'), c(13, 'H')],
    alicePoints: [c(8, 'S')],
    blakeHand: [c(12, 'S'), c(5, 'H'), c(3, 'C'), c(6, 'D')],
    blakePoints: [c(7, 'D'), c(3, 'H')],
    scrap: [c(2, 'D'), c(4, 'S')],
    deckTop: [c(1, 'D')],
  },
  steps: [
    {
      kind: 'move',
      id: '5.1',
      main: "An 8 can be glasses. Put it in your Permanents row and you'll see Blake's hand.",
      spot: [L5_8C],
      expect: { kind: MoveKind.PlayPermanent, card: c(8, 'C') },
      source: L5_8C,
      target: ZONE_PERMANENTS,
      staged: 'Tap Confirm to put on your glasses.',
      tapRoute: 'Tap your 8, then your Permanents row, then Confirm.',
      nudges: [
        { when: { kind: MoveKind.PlayPoint, card: c(8, 'C') }, text: 'Put the 8 in your Permanents row instead, as glasses.' },
        { when: { kind: MoveKind.Scuttle, card: c(8, 'C') }, text: 'Put the 8 in your Permanents row instead, as glasses.' },
        { when: { kind: MoveKind.PlayPermanent, card: c(13, 'H') }, text: SAVE_KING },
        { when: { kind: MoveKind.PlayPermanent, card: [c(11, 'D'), c(11, 'S')] }, text: 'Jacks are next. First, the 8.' },
      ],
      // No catch-all in the design; only a draw is left, and it reuses the 8 line.
      generic: 'Put the 8 in your Permanents row instead, as glasses.',
      success: "Now you can see his cards. He's holding a Queen.",
      demo: { kind: 'drag', from: L5_8C, to: ZONE_PERMANENTS, thenConfirm: false },
      blake: [blake({ kind: MoveKind.Draw }, 'Blake drew an Ace. You saw it.')],
    },
    {
      kind: 'move',
      id: '5.2',
      main: 'A Jack steals. Drop one on his 7, and that 7 counts for you.',
      spot: [L5_JACKS],
      expect: { kind: MoveKind.PlayPermanent, card: [c(11, 'D'), c(11, 'S')], target: c(7, 'D') },
      source: L5_JACKS,
      target: L5_7D,
      staged: 'Tap Confirm to steal his 7.',
      tapRoute: 'Tap a Jack, then his 7, then Confirm.',
      nudges: [
        {
          when: { kind: MoveKind.PlayPermanent, card: [c(11, 'D'), c(11, 'S')], target: c(3, 'H') },
          text: 'That steals 3 points. His 7 is worth more.',
        },
        { when: { kind: MoveKind.PlayPermanent, card: c(13, 'H') }, text: SAVE_KING },
      ],
      // No catch-all in the design; only a draw is left, and it reuses the main line.
      generic: 'A Jack steals. Drop one on his 7, and that 7 counts for you.',
      success: 'Stolen. You have 15, he has 3.',
      demo: { kind: 'drag', from: L5_JD, to: L5_7D, thenConfirm: false },
      blake: [blake({ kind: MoveKind.PlayPermanent, card: c(12, 'S') }, 'Blake played his Queen.')],
    },
    {
      kind: 'appear',
      id: '5.3',
      main: 'His Queen protects his other cards. Tap your other Jack and see.',
      spot: [{ kind: 'handRank', rank: 11 }],
      testId: 'card-detail-popover',
      refusal: 'First, tap your other Jack.',
    },
    {
      kind: 'move',
      id: '5.4',
      main: 'A King lowers the points you need to win. With one King you need 14. You have 15.',
      spot: [L5_KH],
      expect: { kind: MoveKind.PlayPermanent, card: c(13, 'H') },
      source: L5_KH,
      target: ZONE_PERMANENTS,
      staged: 'Tap Confirm to play your King.',
      tapRoute: 'Tap your King, then your Permanents row, then Confirm.',
      nudges: [{ when: { kind: MoveKind.Draw }, text: 'Play your King.' }],
      generic: 'Play your King.',
      success: 'You need 14, and you have 15. You win!',
      demo: { kind: 'drag', from: L5_KH, to: ZONE_PERMANENTS, thenConfirm: false },
      blake: [],
    },
  ],
};

export const LESSONS: readonly Lesson[] = [LESSON_1, LESSON_2, LESSON_3, LESSON_4, LESSON_5];
