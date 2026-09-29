// ROADMAP "Card labels" — the one source of every card's player-facing
// wording: its short name, what it does, and the badge it shows in play.
//
// The staging bar, the ambiguity chooser (both through `plainMoveText` in
// `lib/recap.ts`), the card-detail popover, the selected-card hint and the
// Rules sheet all read the effect clauses below, so they can never disagree
// about what a card does.
//
// Every effect is sourced from the engine this build runs,
// github.com/ApisMellow/cuttle@v0.2.0: RULES.md ("One-Offs", "Permanents")
// checked against engine/apply.go. Nothing here decides legality or
// computes a rule: the engine's legal-move list does the first, and the
// King badge's goal is the bridge's `scoreboard.*.threshold` (engine/win.go
// `Threshold(KingCount(p))`), passed in by the caller, never recomputed.
//
// No rank or suit glyphs: names and effects are words (SPEC §5.6 rule 1).
// A theme may rename ranks (`CardTheme.names`, from a bitmap manifest's
// optional `names`); each rank it leaves out keeps its Classic name.

import type { Card, Rank } from './bridge/schema';
import type { CardTheme } from './theme/types';

/** Classic names, one per rank. Short, and in the Rules sheet's words. */
export const CLASSIC_NAMES: Readonly<Record<Rank, string>> = {
  1: 'Board Wipe',
  2: 'Counter',
  3: 'Recycle',
  4: 'Forced Discard',
  5: 'Draw Two',
  6: 'Royal Wipe',
  7: 'Top Deck',
  8: 'Glasses',
  9: 'Send Back',
  10: 'Points',
  11: 'Thief',
  12: 'Guard',
  13: 'Shortcut',
};

/**
 * What each one-off does, as a lower-case clause. `plainMoveText` appends it
 * to a staged or offered one-off ("Play 5♥ as a one-off: draw 2 cards."),
 * the popover and hint prefix it with "One-off:", and the Rules sheet opens
 * the rank's line with it.
 */
export const ONE_OFF_EFFECT: Readonly<Partial<Record<Rank, string>>> = {
  1: 'scrap every point card',
  2: 'scrap one royal or glasses 8',
  3: 'take a card from the scrap',
  4: 'they discard 2 cards',
  5: 'draw 2 cards',
  6: 'scrap every royal and glasses 8',
  // engine/apply.go (v0.2.0) case Seven reveals up to 2: only the last
  // card when the deck holds one.
  7: 'see the top 2 cards (or the last one), play one',
  // engine/apply.go (v0.2.0) resolveOneOffWith, case Nine: the card goes to
  // its OWNER's hand (a point card's original owner), so a card they stole
  // from you comes back to you. `plainMoveText` narrows this when the
  // caller knows which case applies (`NineReturn`).
  9: 'send a card back to its owner’s hand',
};

/** Where a 9 one-off sends its target, when the caller knows (`nineReturn` in lib/recap.ts). */
export const NINE_EFFECT: Readonly<Record<'theirs' | 'yours', string>> = {
  // The freeze only bites the opponent: their turn is next.
  theirs: 'back to their hand; they can’t play it next turn',
  yours: 'your stolen card comes back to your hand',
};

/**
 * The same two cases with the target named (playtest 2026-09-29: the
 * staging line and the chooser say which card). `target` is the card as
 * runtime text (built by lib/recap.ts from public board state), so this
 * module stays free of glyphs.
 */
export function nineEffectOn(side: 'theirs' | 'yours', target: string): string {
  return side === 'theirs'
    ? `send ${target} back to their hand; they can’t play it next turn`
    : `your stolen ${target} comes back to your hand`;
}

/**
 * What a 5 will draw, when the caller knows (lib/recap.ts `optionContext`,
 * from the viewer's own hand size and the public deck count, capped at the
 * engine's hand limit). `n` is 0, 1 or 2.
 */
export function fiveEffect(n: number, full = false): string {
  // A 9 returning a card can leave a hand at 9 (engine/apply.go v0.2.0 case
  // Nine appends past HandLimit), so a 5 can draw nothing with cards left.
  if (n <= 0) return full ? 'your hand is full, so you draw nothing' : 'the deck is empty, so you draw nothing';
  return n === 1 ? 'draw 1 card' : 'draw 2 cards';
}

/** engine/apply.go (v0.2.0) `HandLimit = 8`: the most cards a hand may hold. */
export const HAND_LIMIT = 8;

/** What a 2 does when played out of turn, as a lower-case clause. */
export const COUNTER_EFFECT = 'stop a one-off as it’s played';

/**
 * The Rules sheet's line on when a one-off takes effect (ruling 2026-09-29,
 * SPEC §4.3): at once, unless the opponent answers with a 2.
 */
export const ONE_OFF_TIMING = 'A one-off happens right away and ends your turn. Your opponent can answer with a 2 if they have one.';

/** The Rules sheet's extra detail after each one-off's effect. */
const ONE_OFF_DETAIL: Readonly<Partial<Record<Rank, string>>> = {
  1: 'Both sides of the table.',
  2: 'Or play it any time to stop a one-off as it’s played, even on their turn (a 2 can stop a 2).',
  3: 'Any one card, into your hand.',
  4: 'They pick which, or discard all they have if fewer.',
  5: 'Never past 8 in your hand.',
  6: 'Both sides of the table.',
  7: 'Play it right away; any other goes back on top. If none can be played, scrap one instead.',
  // A 9's freeze only matters to the opponent, whose turn is next.
  9: 'If it’s theirs, they can’t play it on their next turn. If it’s a card they stole from you, it comes back to your hand.',
};

/** What a permanent does in play, as a lower-case clause (Queen, King, glasses 8). */
export const PERMANENT_EFFECT: Readonly<Partial<Record<Rank, string>>> = {
  8: 'you see their hand',
  // engine/apply.go (v0.2.0) LegalMoves: a Queen shields its owner's
  // other cards from targeting, but not Queens (`perm.Rank != card.Queen`
  // for a 2 or a 9 on a permanent), so a Queen itself, or a second Queen,
  // can still be hit. `QUEEN_DETAIL` says so on the Rules sheet.
  12: 'their 2s, 9s and Jacks can’t target your other cards',
  13: 'you need fewer points to win',
};

/** The Rules sheet's second sentence for a Queen (see PERMANENT_EFFECT[12]). */
export const QUEEN_DETAIL = 'A Queen itself can still be hit.';

/** What a Jack does, as a lower-case clause. */
export const JACK_EFFECT = 'steal one of their point cards';

/** The Rules sheet's one-off ranks, in order (a 10 has no one-off). */
const ONE_OFF_RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 9];

/** How the Rules sheet names a rank in words (no glyphs). */
const RANK_WORDS: Readonly<Record<Rank, string>> = {
  1: 'Ace',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'Jack',
  12: 'Queen',
  13: 'King',
};

export function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** A card's short name: the theme's, where it names that rank, else Classic's. */
export function cardName(card: Card, theme?: Pick<CardTheme, 'names'>): string {
  const override = theme?.names?.[card.Rank];
  return override !== undefined && override !== '' ? override : CLASSIC_NAMES[card.Rank];
}

/**
 * One line saying what a card does, for the popover and the selected-card
 * hint: "One-off: draw 2 cards.", "Permanent: you need fewer points to
 * win.", "Glasses: you see their hand.", and for a 10 "No one-off: …". Every rank from
 * Ace to 10 can also be played for points; the lit zones already say so.
 */
export function cardEffectLine(card: Card): string {
  const rank = card.Rank;
  const oneOff = ONE_OFF_EFFECT[rank];
  if (rank === 2) return `One-off: ${oneOff}, or ${COUNTER_EFFECT}.`;
  if (oneOff !== undefined) return `One-off: ${oneOff}.`;
  if (rank === 8) return `Glasses: ${PERMANENT_EFFECT[8]}.`;
  if (rank === 11) return `Permanent: ${JACK_EFFECT}.`;
  const permanent = PERMANENT_EFFECT[rank];
  if (permanent !== undefined) return `Permanent: ${permanent}.`;
  return 'No one-off: play it for points or to scuttle.';
}

/** Where a card sits in play, for its badge. */
export type BadgeSlot = 'permanent' | 'jack';

/**
 * The short badge a card in play wears, or null for none. A King shows the
 * points its owner now needs (`goal`, the bridge's threshold for that
 * side), a Queen that it protects, a glasses 8 that it sees the hand, and
 * the top Jack on a stolen point card that it stole. Only for face-up
 * cards on the table; never for a hand card, a back or a pile.
 */
export function inPlayBadge(card: Card, slot: BadgeSlot, extra: { goal?: number; stolen?: boolean } = {}): string | null {
  // A Jack says "Stole" only while its point card is really stolen
  // (Controller !== Owner). An even stack, stolen then stolen back, sits
  // at home: no badge.
  if (slot === 'jack') return card.Rank === 11 && extra.stolen === true ? 'Stole' : null;
  if (card.Rank === 13) return extra.goal === undefined ? null : `Goal ${extra.goal}`;
  if (card.Rank === 12) return 'Protects';
  // Playtest 2026-09-29: the glasses face lies sideways, so the badge says
  // it's the 8. The rank as a numeral only; a suit is never written here.
  if (card.Rank === 8) return '8 Sees hand';
  return null;
}

// ---- Why a card or a tap does nothing (playtest 2026-09-29) -------------
// Shown only when the engine offered nothing for that card or tap; never a
// legality decision of its own (lib/blockedReason.ts picks one, from public
// board state and the viewer's own hand only).

/** The fallback when no specific reason is known. */
export const NO_MOVES_REASON = 'No legal moves for this card right now.';

export const BLOCKED_REASON = {
  /** A 9 froze this hand card (the viewer's own `frozenHandIndices`). */
  frozen: 'A 9 just sent this card back: you can play it on your next turn.',
  /** PhaseSevenChoosing, for the 7's player: the hand waits. */
  sevenFirst: 'Play one of the revealed cards first.',
  /** A Jack while the opponent has a Queen in play. */
  jackQueen: 'Their Queen protects their cards from your Jack.',
  /** A Jack while the opponent has no point cards. */
  jackNoPoints: 'They have no point cards for your Jack to steal.',
  /** The deck tapped while it holds no cards. */
  deckEmpty: 'The deck is empty.',
  /** The deck tapped with a full hand. */
  handFull: `Your hand is full (${HAND_LIMIT} cards).`,
  /** A 2 aimed at one of the viewer's own cards their own Queen protects. */
  ownQueen: 'Your own Queen protects that card.',
} as const;

/** A 2, 9 or Jack aimed at a card their Queen protects. */
export function theirQueenProtects(rank: Rank): string {
  return `Their Queen protects that card from your ${RANK_WORDS[rank]}.`;
}

/** One Rules-sheet line: the rank in words, its Classic name, and the text. */
export interface RulesLine {
  rank: string;
  name: string;
  text: string;
}

/** The Rules sheet's one-off lines, built from the same effect clauses the cards use. */
export function rulesOneOffLines(): RulesLine[] {
  return ONE_OFF_RANKS.map((rank) => ({
    rank: RANK_WORDS[rank],
    name: CLASSIC_NAMES[rank],
    text: `${sentenceCase(ONE_OFF_EFFECT[rank] as string)}. ${ONE_OFF_DETAIL[rank]}`,
  }));
}

/** The Rules sheet's permanent lines (Jack, Queen, King, glasses 8), from the same clauses. */
export function rulesPermanentLines(): RulesLine[] {
  return [
    {
      rank: RANK_WORDS[11],
      name: CLASSIC_NAMES[11],
      text: `${sentenceCase(JACK_EFFECT)}. It counts for you until the Jack is scrapped or stolen back, or a 9 sends that card home. A 2 scrapping a Jack takes only the top one, and the card goes to whoever controls the next Jack, or back to its owner.`,
    },
    {
      rank: RANK_WORDS[12],
      name: CLASSIC_NAMES[12],
      text: `${sentenceCase(PERMANENT_EFFECT[12] as string)}. ${QUEEN_DETAIL} It doesn’t stop a scuttle, an Ace, a 4 or a 6.`,
    },
    {
      rank: RANK_WORDS[13],
      name: CLASSIC_NAMES[13],
      text: `${sentenceCase(PERMANENT_EFFECT[13] as string)}.`,
    },
    {
      rank: '8 as glasses',
      name: CLASSIC_NAMES[8],
      text: `${sentenceCase(PERMANENT_EFFECT[8] as string)}. An 8 can also just be 8 points.`,
    },
  ];
}
