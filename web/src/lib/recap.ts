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

import type { AppliedMove, Card, PlayerId } from './bridge/schema';

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
      // David, 2026-09-27 (binding on §4.6): a Decline entry must never
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
 * SPEC §4.6, David 2026-09-27 (binding, R14): whether an entry may ever
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
