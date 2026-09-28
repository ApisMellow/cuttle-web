// SPEC §4.6 — the R20 "while you were away" recap formatter.
//
// Turns one `AppliedMove` (SPEC §2.7) into a single per-viewer, redaction-
// safe sentence. `entry.description` — the pre-state `Move.Describe`
// string, frozen at apply time (§2.7's note on `lastMove.description`) —
// is the ONLY source of card identities. `entry.card` and `entry.index`
// are never read: `index` is redacted for everyone but the mover (§3.2)
// and reading it here would be exactly the kind of "history for card
// identities beyond what the recap formatter allows" that §3.3 rule 5
// forbids; `entry.card` is skipped too, so the formatter's only channel
// for an identity is the one SPEC §4.6 names, with no fallback that could
// silently diverge from it.
//
// The phrasing parsed below is pinned to the exact strings the published
// engine emits: github.com/ApisMellow/cuttle@v0.2.0
//   engine/moves.go:36-70  (Move.Describe)
//   card/card.go:14-47     (Suit/Rank/Card String())
// A description that doesn't match the expected shape fails loudly
// (`fail`, below) rather than being guessed at — if the engine's Describe
// format ever drifts, this must break the build, not silently mis-render
// or leak something SPEC §3 says it shouldn't.
//
// Two SPEC §4.6 table rows cannot be produced from `entry.description`
// alone; see the PlayPermanent-Jack and OneOff branches for where and why
// (also reported to the dispatcher separately).

import type { AppliedMove, PlayerId } from './bridge/schema';

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
      // SPEC problem (report): Describe's Jack-steal branch —
      // `"play %s (steal opponent point)"` — never embeds the stolen
      // card's identity, unlike Scuttle's. The §4.6 table's literal
      // "stole your 10♥ with J♣" cannot be produced from `description`
      // alone. We name only the Jack and generalize the stolen card to
      // "point card" rather than inventing or guessing an identity.
      const jack = text.match(new RegExp(`^play (${CARD}) \\(steal opponent point\\)$`));
      if (jack) return `stole ${ctx.targetPossessive} point card with ${jack[1]}`;
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
      // SPEC problem (report): Describe's one-off branch —
      // `"play %s as one-off"` — is identical whether or not `Move.Target`
      // was set, and `AppliedMove` carries no `Target` field at all. The
      // §4.6 table's "+ target clause when Target is set" cannot be
      // implemented from `description` — there is no signal to key off —
      // so no target clause is ever added.
      const m = text.match(new RegExp(`^play (${CARD}) as one-off$`));
      if (!m) fail(entry, 'OneOff description did not match the engine format');
      return `played ${m[1]} as a one-off`;
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
        // reachable from this entry. Wording note (David, 2026-09-27): this
        // dead-end line also said "two cards" and is updated alongside the
        // played branch below; it can be inaccurate when the deck holds
        // only 1 card — a SPEC wording question, not this formatter's call.
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
 * Assumption (report §5): §4.6's table is written entirely for "viewer is
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
