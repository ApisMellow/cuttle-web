// SPEC §4.6 — the R20 "while you were away" recap formatter.
//
// Turns one `AppliedMove` (SPEC §2.7) into a single per-viewer, redaction-
// safe sentence. `entry.description` — the pre-state `Move.Describe`
// string, frozen at apply time (§2.7's note on `lastMove.description`) —
// is the source of the PLAYED card's identity for every kind.
// `entry.targetCard` (§2.7, amended 2026-09-27) supplies the TARGETED
// card's identity for the two kinds Describe is silent on: a Jack steal's
// stolen point card, and a targeted one-off's target clause. `entry.card`
// and `entry.index` are never read: `index` is redacted for everyone but
// the mover (§3.2) and reading it here would be exactly the kind of
// "history for card identities beyond what the recap formatter allows"
// that §3.3 rule 5 forbids; `entry.card` is skipped too, so the played
// card's identity always comes from `entry.description`, with no fallback
// that could silently diverge from it.
//
// The phrasing parsed below is pinned to the exact strings the published
// engine emits: github.com/ApisMellow/cuttle@v0.2.0
//   engine/moves.go:36-70  (Move.Describe)
//   card/card.go:14-47     (Suit/Rank/Card String())
// A description that doesn't match the expected shape fails loudly
// (`fail`, below) rather than being guessed at — if the engine's Describe
// format ever drifts, this must break the build, not silently mis-render
// or leak something SPEC §3 says it shouldn't. The same applies to a Jack
// steal missing `targetCard`: SPEC §2.7 guarantees it is always set for
// that shape, so a null there fails loudly too rather than silently
// degrading to a vaguer line. A one-off's `targetCard` is NOT checked the
// same way: the formatter has no way to distinguish a targeted one-off
// (ranks 2, 9) from an untargeted one (Ace, 3, 4, 5, 6, 7) — `entry.kind`
// is the same `OneOff` either way and `entry.description` doesn't carry
// the rank distinction — so a null `targetCard` on a `OneOff` is read as
// "this one had no target" and the base line is returned unchanged, with
// no rank-2/rank-9 knowledge encoded here (docs/assumptions.md).

import type { AppliedMove, Card, Move, PlayerId, PlayerView, Rank } from './bridge/schema';
import { NINE_EFFECT, ONE_OFF_EFFECT, PERMANENT_EFFECT, sentenceCase } from './cardText';

// A card token exactly as `card.Card.String()` renders it (card/card.go:14-
// 47), used to render `entry.targetCard` into the same glyph form the
// engine's own Describe strings use.
const RANK_GLYPHS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];

function cardGlyph(cd: Card): string {
  return `${RANK_GLYPHS[cd.Rank - 1]}${SUIT_GLYPHS[cd.Suit]}`;
}

// MoveKind values, private and non-exported, pinned to SPEC §2.5.
const KIND = {
  Draw: 0,
  PlayPoint: 1,
  PlayPermanent: 2,
  Scuttle: 3,
  OneOff: 4,
  Counter: 5,
  Decline: 6,
  SevenPick: 7,
  DiscardPair: 8,
  Pass: 9,
} as const;

// A card token exactly as `card.Card.String()` renders it (card/card.go:45-
// 47): a rank glyph immediately followed by a suit glyph, e.g. "7♥",
// "10♠", "J♣", "A♦". No separator, no spaces.
const CARD = String.raw`(?:10|[2-9]|[AJQK])[♣♦♥♠]`;

/** The rank part of a card token: "10♠" -> "10", "A♥" -> "A". */
function rankOf(token: string): string {
  return token.slice(0, -1);
}

/** The 5's effect clause in a recap line (SPEC §4.6, amended 2026-09-28). */
const FIVE_INTENT = ' to draw 2 cards';

function fail(entry: AppliedMove, reason: string): never {
  throw new Error(
    `formatRecapLine: seq ${entry.seq} kind ${entry.kind}: ${reason} ` +
      `(description was ${JSON.stringify(entry.description)})`,
  );
}

interface Ctx {
  /** Possessive for whoever's point/permanent is being acted on by a
   * Scuttle or a Jack steal — "your" when the viewer is the target
   * (standard §4.6 table case), or "{name}'s" when the viewer is the
   * actor and the target is their opponent (assumption, own-move case). */
  targetPossessive: string;
}

/**
 * Produces the predicate (everything after the subject) for one MoveKind,
 * given the Describe text that names it. Shared between a top-level entry
 * and a SevenPick's embedded SubMove.Describe, which reuses the exact same
 * per-kind formats (§2.7's `subKind` note; engine/moves.go:61-65).
 */
function predicateFor(kind: number, text: string, subKind: number | null, entry: AppliedMove, ctx: Ctx): string {
  switch (kind) {
    case KIND.Draw: {
      if (text !== 'draw a card') fail(entry, 'Draw description did not match the engine format');
      return 'drew a card';
    }
    case KIND.Pass: {
      if (text !== 'pass') fail(entry, 'Pass description did not match the engine format');
      return 'passed';
    }
    case KIND.Decline: {
      // ApisMellow, 2026-09-27 (binding on §4.6): a Decline entry must never
      // reach this function. A real decline writes a `Decline` history
      // row; the synthetic R14 acknowledgment writes none — so rendering
      // "NAME let it resolve." would tell the acting player the opponent
      // actually held a counter-2, and would change whether a recap
      // screen appears at all. Callers MUST filter with `isRecapVisible`
      // first. Fail loudly if that contract was skipped, rather than
      // silently rendering the very leak this exists to prevent.
      fail(entry, 'Decline entries must never be recapped (R14) — filter with isRecapVisible first');
      break;
    }
    case KIND.PlayPoint: {
      const m = text.match(new RegExp(`^play (${CARD}) as point card$`));
      if (!m) fail(entry, 'PlayPoint description did not match the engine format');
      return `played ${m[1]} for points`;
    }
    case KIND.PlayPermanent: {
      // Jack steal: Describe's branch — `"play %s (steal opponent point)"`
      // — never embeds the stolen card's identity, unlike Scuttle's.
      // `entry.targetCard` (§2.7, amended 2026-09-27) supplies it: the
      // JackTarget read from the pre-state, always the stolen point card.
      const jack = text.match(new RegExp(`^play (${CARD}) \\(steal opponent point\\)$`));
      if (jack) {
        if (entry.targetCard === null) {
          fail(entry, 'a Jack steal must always carry a non-null targetCard (SPEC §2.7)');
        }
        return `stole ${ctx.targetPossessive} ${cardGlyph(entry.targetCard)} with ${jack[1]}`;
      }
      const plain = text.match(new RegExp(`^play (${CARD}) as permanent$`));
      if (!plain) fail(entry, 'PlayPermanent description did not match the engine format');
      return `played ${plain[1]} as a permanent`;
    }
    case KIND.Scuttle: {
      const targeted = text.match(new RegExp(`^scuttle opponent's (${CARD}) with (${CARD})$`));
      if (targeted) return `scuttled ${ctx.targetPossessive} ${targeted[1]} with ${targeted[2]}`;
      // Defensive only: engine/apply.go:117-119 always constructs
      // MoveScuttle with a non-nil Target, so moves.go:54's untargeted
      // `"scuttle with %s"` branch is unreachable via LegalMoves and has no
      // test — kept so a future engine change fails loudly here instead of
      // falling through to the generic "unrecognized format" error below.
      const untargeted = text.match(new RegExp(`^scuttle with (${CARD})$`));
      if (!untargeted) fail(entry, 'Scuttle description did not match the engine format');
      return `scuttled with ${untargeted[1]}`;
    }
    case KIND.OneOff: {
      // Describe's one-off branch — `"play %s as one-off"` — is identical
      // whether or not `Move.Target` was set. `entry.targetCard` (§2.7,
      // amended 2026-09-27) supplies the §4.6 "+ target clause when Target
      // is set". Wording assumption (docs/assumptions.md): `targetCard` carries no
      // owner (a rank-2 can target either side; a rank-9 always targets the
      // opponent, but the wording below doesn't lean on that), so the
      // clause names only the targeted card, never whose it is — true
      // regardless of ownership.
      const m = text.match(new RegExp(`^play (${CARD}) as one-off$`));
      if (!m) fail(entry, 'OneOff description did not match the engine format');
      const base = `played ${m[1]} as a one-off`;
      // Amended 2026-09-28 (playtest friction): a 5 says what it does. The
      // recap and the counter prompt show the 5 BEFORE it resolves on the
      // real counter-window path, so this is the card's effect ("to draw 2
      // cards", RULES.md One-Offs), never the count it drew. The count
      // (`entry.drawn`) is never read here: on the synthetic path it is
      // already set, and reading it would make the two paths differ (R14).
      // `lastMoveLine` reports the count once the board is back.
      if (entry.targetCard === null && rankOf(m[1]) === '5') return `${base}${FIVE_INTENT}`;
      if (entry.targetCard === null) return base;
      return `${base}, targeting ${cardGlyph(entry.targetCard)}`;
    }
    case KIND.Counter: {
      const m = text.match(new RegExp(`^counter with (${CARD})$`));
      if (!m) fail(entry, 'Counter description did not match the engine format');
      return `countered with ${m[1]}`;
    }
    case KIND.DiscardPair: {
      // Never extract DiscardA/DiscardB as identities — meaningless to a
      // human and a leak besides (§4.6). The ONE bit read out of the match
      // is whether the second index is the engine's literal one-card
      // sentinel `-1` (engine/apply.go:509-511: a 1-card hand emits
      // `DiscardA:0, DiscardB:-1`, so moves.go:67 renders
      // "discard hand[0] and hand[-1]") — never its numeric value, never
      // DiscardA's value, and the sentinel check itself never appears in
      // the output. §4.6 has no one-card row; count-wording is an
      // assumption (report).
      const m = text.match(/^discard hand\[\d+\] and hand\[(\d+|-1)\]$/);
      if (!m) fail(entry, 'DiscardPair description did not match the engine format');
      return m[1] === '-1' ? 'discarded 1 card' : 'discarded 2 cards';
    }
    case KIND.SevenPick: {
      const wrapped = text.match(/^7: (.+)$/s);
      if (!wrapped) fail(entry, 'SevenPick description did not match the engine format');
      const remainder = wrapped[1];
      const deadEnd = remainder.match(new RegExp(`^no legal play — scrap (${CARD})$`));
      if (deadEnd) {
        if (subKind !== null) fail(entry, 'a dead-end SevenPick must have a null subKind');
        // The scrapped card is public (it lands in scrap, R6); the OTHER
        // revealed card returns face-down to the deck top
        // (engine/apply.go:419-437) and is never named — it isn't even
        // reachable from this entry.
        return `revealed the top of the deck and scrapped ${deadEnd[1]} (no legal play)`;
      }
      if (subKind === null) fail(entry, 'a non-dead-end SevenPick must have a non-null subKind');
      // Whitelist: only these four kinds are ever legal as a Seven's
      // SubMove (engine/apply.go:521-544's legalSevenPickMoves wraps
      // legalForCard's output, which is itself LegalMoves' PhaseNormal
      // enumeration restricted to non-Draw/Pass plays — Draw/Pass are
      // explicitly excluded at apply.go:405-407, and neither Counter,
      // Decline, SevenPick-of-SevenPick, nor DiscardPair can ever be a
      // sub-move). Fail loudly rather than recurse into a shape this kind
      // can't actually produce.
      if (
        subKind !== KIND.PlayPoint &&
        subKind !== KIND.PlayPermanent &&
        subKind !== KIND.Scuttle &&
        subKind !== KIND.OneOff
      ) {
        fail(entry, `SevenPick subKind ${subKind} is not a legal Seven sub-move`);
      }
      // Recurse on the wrapped sub-Describe text using the SAME per-kind
      // formats — R16: only the played card is ever named; the unchosen
      // revealed card returns face-down to the deck top
      // (engine/apply.go:445-456) and never appears in `AppliedMove`.
      const inner = predicateFor(subKind, remainder, null, entry, ctx);
      return `revealed the top of the deck and ${inner}`;
    }
    default:
      fail(entry, `unrecognized MoveKind ${kind}`);
  }
}

/**
 * SPEC §4.6, ApisMellow 2026-09-27 (binding, R14): whether an entry may ever
 * appear in a recap, for ANY viewer. False exactly for `Decline` — a real
 * decline writes a `Decline` history row, but the synthetic R14
 * acknowledgment writes none, so recapping a `Decline` would tell the
 * acting player the opponent actually held a counter-2 and would change
 * whether a recap screen appears at all. True for every other kind.
 *
 * Callers building a recap list (out of this round's scope — the
 * `lastSeenSeq`-filtered list itself is R20.3) must filter with this
 * BEFORE the "skipped entirely when empty" check and before calling
 * `formatRecapLine`.
 */
export function isRecapVisible(entry: AppliedMove): boolean {
  return entry.kind !== KIND.Decline;
}

/**
 * SPEC §4.6 recap line for one applied move, from the viewer's perspective.
 * Throws if `entry` is a `Decline` — callers must check `isRecapVisible`
 * first; see its doc comment for why a Decline can never be rendered.
 *
 * Assumption (docs/assumptions.md): §4.6's table is written entirely for "viewer is
 * the opponent of the actor." For the viewer's own moves — not covered by
 * the table — this uses second-person "You ..." phrasing, symmetric with
 * the table's third-person form.
 */
export function formatRecapLine(entry: AppliedMove, viewer: PlayerId, names: readonly [string, string]): string {
  const isSelf = entry.by === viewer;
  const name = isSelf ? 'You' : names[entry.by];
  const opponentOfActor = (1 - entry.by) as PlayerId;
  const targetPossessive = isSelf ? `${names[opponentOfActor]}'s` : 'your';
  const predicate = predicateFor(entry.kind, entry.description, entry.subKind, entry, { targetPossessive });
  return `${name} ${predicate}.`;
}

/** The same sentence in the third person for everyone (the result screen, seen by both players). */
function formatNeutralLine(entry: AppliedMove, names: readonly [string, string]): string {
  const opponentOfActor = (1 - entry.by) as PlayerId;
  const predicate = predicateFor(entry.kind, entry.description, entry.subKind, entry, {
    targetPossessive: `${names[opponentOfActor]}'s`,
  });
  return `${names[entry.by]} ${predicate}.`;
}

/** A one-off entry: a OneOff, or a SevenPick whose sub-move was a OneOff. */
function isOneOffEntry(entry: AppliedMove): boolean {
  return entry.kind === KIND.OneOff || (entry.kind === KIND.SevenPick && entry.subKind === KIND.OneOff);
}

/** The one-off a Counter or Decline at `history[i]` answers, walking back over Counters; -1 if none. */
function chainOriginIndex(history: readonly AppliedMove[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (history[j].kind === KIND.Counter) continue;
    return isOneOffEntry(history[j]) ? j : -1;
  }
  return -1;
}

function drewText(count: number): string {
  if (count === 0) return 'drew no cards';
  return count === 1 ? 'drew 1 card' : `drew ${count} cards`;
}

/**
 * SPEC §4.6 idle last-move line (R20.1; amended 2026-09-28): the board's
 * centre line. The last `isRecapVisible` entry in `history` (never raw
 * `lastMove`), as a sentence for this viewer — "You ..." for the viewer's
 * own move, never the raw engine description.
 *
 * A 5 that has resolved adds its draw count, read from `drawn` (SPEC §2.7):
 * "Alice played 5♥ as a one-off and drew 2 cards." The bridge puts `drawn`
 * on the entry whose apply resolved the 5 — the 5 itself when nobody could
 * counter (synthetic path), or the Decline/Counter that closed its chain
 * (real path). Only entries from the last visible one onward are read, and
 * those after it can only be Declines, so both paths read the same line
 * here (R14). The board shows only after the counter prompt is gone, so on
 * both paths the 5 has resolved by the time this line renders. A count
 * only: history never names the drawn cards.
 */
export function lastMoveLine(history: readonly AppliedMove[], viewer: PlayerId, names: readonly [string, string]): string {
  let i = history.length - 1;
  while (i >= 0 && !isRecapVisible(history[i])) i--;
  if (i < 0) return '';
  let line: string;
  try {
    line = formatRecapLine(history[i], viewer, names);
  } catch {
    return '';
  }
  let resolver = -1;
  for (let j = history.length - 1; j >= i; j--) {
    if (history[j].drawn !== null) {
      resolver = j;
      break;
    }
  }
  if (resolver < 0) return line;
  const count = history[resolver].drawn as number;
  const origin = isOneOffEntry(history[resolver]) ? resolver : chainOriginIndex(history, resolver);
  if (origin < 0) return line;
  if (origin === i && line.endsWith(`${FIVE_INTENT}.`)) {
    return `${line.slice(0, -`${FIVE_INTENT}.`.length)} and ${drewText(count)}.`;
  }
  const drawer = history[origin].by;
  return `${line} ${drawer === viewer ? 'You' : names[drawer]} ${drewText(count)}.`;
}

/**
 * Result screen (R2, amended 2026-09-28): one line naming the winning move,
 * third person (both players read it). `points` is the winner's final total
 * and `threshold` their final goal, both read off the engine's scoreboard by
 * the caller. The move is the last `isRecapVisible` history entry; every
 * card it names was played face up (the §4.6 audit), so nothing hidden is
 * named. '' for a stalemate or an empty history.
 */
export function winningMoveLine(
  history: readonly AppliedMove[],
  winner: PlayerId | null,
  names: readonly [string, string],
  points: number,
  threshold?: number,
): string {
  if (winner === null) return '';
  let i = history.length - 1;
  while (i >= 0 && !isRecapVisible(history[i])) i--;
  if (i < 0) return '';
  const entry = history[i];
  const who = names[winner];
  if (entry.by === winner) {
    const fromSeven = entry.kind === KIND.SevenPick;
    const kind = fromSeven ? entry.subKind : entry.kind;
    const text = fromSeven ? entry.description.replace(/^7: /, '') : entry.description;
    const tail = fromSeven ? ', from the top of the deck.' : '.';
    const point = text.match(new RegExp(`^play (${CARD}) as point card$`));
    if (kind === KIND.PlayPoint && point) return `${who} won by reaching ${points} with the ${point[1]}${tail}`;
    const jack = text.match(new RegExp(`^play (${CARD}) \\(steal opponent point\\)$`));
    if (kind === KIND.PlayPermanent && jack && entry.targetCard !== null) {
      return `${who} won by reaching ${points}, stealing the ${cardGlyph(entry.targetCard)} with the ${jack[1]}${tail}`;
    }
    const perm = text.match(new RegExp(`^play (${CARD}) as permanent$`));
    if (kind === KIND.PlayPermanent && perm && rankOf(perm[1]) === 'K' && threshold !== undefined) {
      return `${who} won by playing the ${perm[1]}, which lowered the goal to ${threshold}${tail}`;
    }
  }
  try {
    return `${who} won with ${points} points. Last move: ${formatNeutralLine(entry, names)}`;
  } catch {
    return `${who} won with ${points} points.`;
  }
}

// One-off and permanent effects come from `lib/cardText.ts`, the single
// source the popover, the selected-card hint and the Rules sheet share, so
// the chooser, the staging bar and the cards can never disagree. Nothing
// there decides legality: the engine already offered the move.

/** The Rank a card token's rank part names ("A" -> 1, "10" -> 10, "K" -> 13). */
function rankNumber(token: string): Rank {
  return (RANK_GLYPHS.indexOf(rankOf(token)) + 1) as Rank;
}

/** Where a 9 one-off sends its target: 'theirs' (their card) or 'yours' (a card they stole from you). */
export type NineReturn = 'theirs' | 'yours';


/**
 * Which way a 9 one-off (or a 7-revealed 9) sends its target, from public
 * board state only: a permanent always goes to its player (the opponent); a
 * point card goes to its original `Owner` (engine/apply.go v0.2.0,
 * resolveOneOffWith case Nine: `returnTo = pe.Owner`). undefined for any
 * other move, or a target no longer on the board.
 */
export function nineReturn(move: Move, view: Pick<PlayerView, 'viewer' | 'you' | 'opponent'>): NineReturn | undefined {
  const inner = move.Kind === KIND.SevenPick ? move.SubMove : move;
  const played = move.Kind === KIND.SevenPick ? move.Card : inner?.Card;
  if (inner === null || inner === undefined || inner.Kind !== KIND.OneOff || played?.Rank !== 9 || inner.Target === null) {
    return undefined;
  }
  const target = inner.Target;
  if (target.Zone !== 0) return 'theirs';
  const row = target.Owner === view.viewer ? view.you.points : view.opponent.points;
  const entry = row[target.Index];
  if (entry === undefined) return undefined;
  return entry.Owner === view.viewer ? 'yours' : 'theirs';
}

function permanentText(token: string): string {
  const rank = rankNumber(token);
  const effect = PERMANENT_EFFECT[rank];
  if (effect === undefined) return `Play ${token} as a permanent.`;
  if (rank === 8) return `Play ${token} as glasses: ${effect}.`;
  // A Queen can only ever be a permanent, and its targeting clause is long:
  // the short form keeps the staged line whole at 393 wide.
  if (rank === 12) return `Play ${token}: ${effect}.`;
  return `Play ${token} as a permanent: ${effect}.`;
}

/**
 * Plain, player-facing wording for an engine description (SPEC §6.4,
 * amended 2026-09-28): the staging bar, the ambiguity chooser and the
 * counter buttons all show the viewer's OWN options, so the text is an
 * instruction ("Play 7♥ for points.") with, where a card does something,
 * one short clause saying what. It also accepts the composite staging
 * strings built above (`scrapPickStagingText`, `scrapTakeStagingText`,
 * `discardStagingText`). It parses the engine's pinned Describe format
 * (engine/moves.go) like `formatRecapLine` does, but an unrecognised string
 * passes through sentence-cased rather than throwing: this text sits on a
 * control the player must still be able to use.
 */
export function plainMoveText(text: string, nine?: NineReturn): string {
  const takeFromScrap = text.match(new RegExp(`^(.*?)(?: — take |, taking )(${CARD})(?: from the scrap)?$`, 's'));
  if (takeFromScrap) {
    const inner = takeFromScrap[1].replace(/^7: /, '');
    const three = inner.match(new RegExp(`^play (${CARD}) as one-off$`));
    if (three) return `Play ${three[1]} as a one-off: take ${takeFromScrap[2]} from the scrap.`;
    return `${plainMoveText(takeFromScrap[1]).replace(/\.$/, '')}, taking ${takeFromScrap[2]}.`;
  }
  const t = text.replace(/^7: /, '');
  if (t === 'draw a card') return 'Draw a card.';
  if (t === 'pass') return 'Pass.';
  if (t === 'decline to counter') return 'Let it resolve.';
  let m = t.match(new RegExp(`^play (${CARD}) as point card$`));
  if (m) return `Play ${m[1]} for points.`;
  m = t.match(new RegExp(`^play (${CARD}) \\(steal opponent point\\)$`));
  if (m) return `Play ${m[1]} to steal that point card.`;
  m = t.match(new RegExp(`^play (${CARD}) as permanent$`));
  if (m) return permanentText(m[1]);
  m = t.match(new RegExp(`^scuttle opponent's (${CARD}) with (${CARD})$`));
  if (m) return `Scuttle their ${m[1]} with ${m[2]}: both cards go to the scrap.`;
  m = t.match(new RegExp(`^scuttle with (${CARD})$`));
  if (m) return `Scuttle with ${m[1]}: both cards go to the scrap.`;
  m = t.match(new RegExp(`^play (${CARD}) as one-off$`));
  if (m) {
    const rank = rankNumber(m[1]);
    const effect = rank === 9 && nine !== undefined ? NINE_EFFECT[nine] : ONE_OFF_EFFECT[rank];
    return effect ? `Play ${m[1]} as a one-off: ${effect}.` : `Play ${m[1]} as a one-off.`;
  }
  m = t.match(new RegExp(`^counter with (${CARD})$`));
  if (m) return `Counter with ${m[1]}: stop their card.`;
  m = t.match(new RegExp(`^no legal play — scrap (${CARD})$`));
  if (m) return `Scrap ${m[1]}: no revealed card can be played.`;
  m = t.match(/^discard hand\[\d+\] and hand\[(\d+|-1)\]$/);
  if (m) return m[1] === '-1' ? 'Discard 1 card.' : 'Discard 2 cards.';
  m = t.match(new RegExp(`^Discard (${CARD})(?: and (${CARD}))?$`));
  if (m) return `${t}.`;
  return sentenceCase(text);
}

/**
 * SPEC §4.6 "each line pairs with a small card glyph where a card is named"
 * (design.md §8: a theme `mini` face per named card). The cards a recap
 * line names, in the order its sentence names them, for RecapPanel to render
 * as faces. Additive helper: it doesn't touch `formatRecapLine`.
 *
 * Reads only `entry.kind`, `entry.subKind`, `entry.card` and
 * `entry.targetCard`; never `index` (mover-only, SPEC §3.2) and never the
 * description. Both card fields are public (SPEC §2.7, §3.2 redacts only
 * `index`). Engine v0.2.0 shapes, as the bridge emits them
 * (`internal/wasm/bridge.go` `cardOrNil(move.Card)`, `target.go`
 * `targetCardFor`):
 *   - `card` is null for Draw, Pass, Decline and DiscardPair;
 *   - `card` is the played card for PlayPoint, PlayPermanent, Scuttle,
 *     OneOff and Counter;
 *   - for SevenPick `card` is the chosen revealed card, or the scrapped
 *     card on a dead end (`subKind: null`); the 7's unchosen card never
 *     enters an AppliedMove, so it can't be named here (R16);
 *   - `targetCard` is the target, or null.
 *
 * Order follows `predicateFor`'s sentences:
 *   Scuttle     "scuttled your 7♥ with 9♠"       -> [target, card]
 *   Jack steal  "stole your 10♥ with J♣"          -> [target, card]
 *   OneOff      "played 9♥ as a one-off, targeting 5♣" -> [card, target]
 *   others      "played 7♥ for points", ...      -> [card]
 * A Jack steal is the PlayPermanent whose `targetCard` is set (the bridge
 * rejects a targetCard on any other PlayPermanent). DiscardPair returns []
 * whatever the entry holds: it names no identities (§4.6).
 */
export function recapCards(entry: AppliedMove): Card[] {
  const kind = entry.kind === KIND.SevenPick ? entry.subKind : entry.kind;
  const played = entry.card;
  const target = entry.targetCard;
  let named: (Card | null)[];
  switch (kind) {
    case null: // dead-end SevenPick: the scrapped card only
    case KIND.PlayPoint:
    case KIND.Counter:
      named = [played];
      break;
    case KIND.Scuttle:
      named = [target, played];
      break;
    case KIND.PlayPermanent:
      named = target === null ? [played] : [target, played];
      break;
    case KIND.OneOff:
      named = [played, target];
      break;
    default: // Draw, Pass, Decline, DiscardPair
      named = [];
  }
  return named.filter((cd): cd is Card => cd !== null).map((cd) => ({ Rank: cd.Rank, Suit: cd.Suit }));
}

/**
 * P2 W13, SPEC §4.3 Presentation table — the entries the CounterPrompt
 * shows: the counterable one-off that opened the chain (a `OneOff`, or a
 * `SevenPick` whose `subKind` is `OneOff`), then every `Counter` played on
 * it, oldest first. `[]` when the history does not end in such a chain.
 *
 * ONE derivation for both paths. The real window could read
 * `pending.card`/`pending.counterChain` instead, but the synthetic ack has
 * no pending (the engine already resolved the one-off), so SPEC §4.3 takes
 * its card and chain "from `lastMove`" and "from `history`". Reading history
 * for both means the two prompts cannot render differently, which is the
 * R14 property. Every entry returned is one a §4.6 recap line already names
 * (played face-up, public), and the kind check reads no identity.
 */
export function counterPromptEntries(history: readonly AppliedMove[]): AppliedMove[] {
  let i = history.length - 1;
  while (i >= 0 && history[i].kind === KIND.Counter) i--;
  if (i < 0) return [];
  const origin = history[i];
  const counterable =
    origin.kind === KIND.OneOff || (origin.kind === KIND.SevenPick && origin.subKind === KIND.OneOff);
  return counterable ? history.slice(i) : [];
}

/**
 * P2 W15, SPEC §6.3 DiscardPair row — the StagingBar text for a staged
 * discard: "Discard 4♦ and 5♠", or "Discard 4♦" for the one-card hand
 * (`b === -1`, apply.go:485-488). Engine `Describe` gives hand indices
 * ("discard hand[0] and hand[3]"), which mean nothing to a player. Only the
 * DISCARDER's own staging bar shows this; the opponent's recap line for the
 * same move stays "NAME discarded 2 cards." (§4.6).
 */
export function discardStagingText(hand: readonly Card[], a: number, b: number): string {
  const first = hand[a];
  if (first === undefined) throw new Error(`discardStagingText: no hand card at ${a}`);
  if (b === -1) return `Discard ${cardGlyph(first)}`;
  const second = hand[b];
  if (second === undefined) throw new Error(`discardStagingText: no hand card at ${b}`);
  return `Discard ${cardGlyph(first)} and ${cardGlyph(second)}`;
}

/**
 * P2 W15, SPEC §6.3 rank-3 row — the StagingBar text once a scrap card is
 * picked for a 3: the engine's own description plus the card taken, e.g.
 * "play 3♣ as one-off — take 5♠ from the scrap". The scrap is public (R6).
 */
export function scrapPickStagingText(description: string, taken: Card): string {
  return `${description} — take ${cardGlyph(taken)} from the scrap`;
}

/**
 * W19 — the StagingBar text when a 3 stages with no pick sheet because the
 * scrap holds one card: the engine's description plus the card taken, e.g.
 * "play 3♣ as one-off, taking 7♥". The viewer's own staging only; the scrap
 * is public (R6). Returns null for any other move, which keeps the engine's
 * text. `ScrapIndex` means something only for a rank-3 one-off
 * (engine/moves.go:30), so that is the one shape named here; a 3 revealed
 * by a 7 is matched one level down, through its `SubMove`.
 */
export function scrapTakeStagingText(move: Move, description: string, scrap: readonly Card[]): string | null {
  const oneOff = move.Kind === KIND.SevenPick ? move.SubMove : move;
  if (oneOff === null || oneOff.Kind !== KIND.OneOff || oneOff.Target !== null) return null;
  if (oneOff.Card === null || oneOff.Card.Rank !== 3) return null;
  const taken = scrap[oneOff.ScrapIndex];
  if (taken === undefined) return null;
  return `${description}, taking ${cardGlyph(taken)}`;
}
