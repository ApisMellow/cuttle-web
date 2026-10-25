package game

// Issue #69: a DiscardPair's description is the engine's "discard hand[a]
// and hand[b]" (engine/moves.go:66-67 at v0.2.1). Hands are kept in arrival
// order, so the positions tell the other seat when the discarded cards
// (public once they land in the scrap) arrived in the discarder's hand.
// Every seat but the discarder must see the description without positions;
// the discarder's own entry, and the stored snapshot, keep the engine's text.
//
// Both front ends are covered: the Bridge (pass-and-play, the WASM shim) and
// the Session (the online server: Update.For on a move, View on a resync).

import (
	"regexp"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// The descriptions every seat but the discarder sees for a DiscardPair
// (issue #69): two cards, or one when the hand held one (DiscardB -1).
const (
	otherSeatTwoCardDiscard = "discards two cards"
	otherSeatOneCardDiscard = "discards one card"
)

// positionText matches hand-position text in any spelling the engine or a
// careless rewrite could produce: "hand[2]", "hand [ -1 ]", "HAND[0]".
var positionText = regexp.MustCompile(`(?i)hand\s*\[`)

// cardNameText is card.Card.String(): rank A, 2–10, J, Q, K, then the suit.
var cardNameText = regexp.MustCompile(`(10|[2-9AJQK])[♣♦♥♠]`)

// digitOutsideCards reports a digit in s once card names ("10♥", "7♣") and a
// SevenPick's "7: " prefix are removed: a position, an index or a count
// written any other way.
func digitOutsideCards(s string) bool {
	s = cardNameText.ReplaceAllString(strings.TrimPrefix(s, "7: "), "")
	return strings.ContainsAny(s, "0123456789")
}

// fourThenDiscard is a position where P1 holds only a 4 and P2 holds
// oppHand with no 2, so the 4 resolves at once and P2 must discard.
func fourThenDiscard(oppHand []card.Card) engine.GameState {
	return engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Four, card.Clubs)}},
			{Hand: oppHand},
		},
		Deck:   []card.Card{c(card.Five, card.Hearts), c(card.Six, card.Clubs), c(card.Ace, card.Spades)},
		Scrap:  []card.Card{},
		Active: engine.P1,
		Phase:  engine.PhaseNormal,
	}
}

// discardEntryCheck holds the two descriptions one viewer's envelope must
// show for the discard entry: mine for the discarder, theirs for the other.
type discardEntryCheck struct {
	seq           int
	engineText    string // Move.Describe(pre), what the discarder sees
	otherSeatText string // "" means: only "no position text" is asserted
}

// assertDiscardEntry checks env's history entry seq and, when it is the
// last entry, lastMove, for one viewer. The discarder is P2.
func assertDiscardEntry(t *testing.T, label string, viewer engine.PlayerID, env Envelope, want discardEntryCheck) {
	t.Helper()
	if len(env.History) < want.seq {
		t.Fatalf("%s: history has %d entries, want entry %d", label, len(env.History), want.seq)
	}
	entries := []AppliedMove{env.History[want.seq-1]}
	if len(env.History) == want.seq {
		if env.LastMove == nil {
			t.Fatalf("%s: lastMove is null", label)
		}
		entries = append(entries, *env.LastMove)
	}
	for i, e := range entries {
		where := label + " history"
		if i == 1 {
			where = label + " lastMove"
		}
		if e.Kind != engine.MoveDiscardPair || e.By != engine.P2 {
			t.Fatalf("%s: precondition: entry kind %d by %d, want DiscardPair by P2", where, e.Kind, e.By)
		}
		if viewer == engine.P2 {
			if e.Description != want.engineText {
				t.Fatalf("%s: the discarder's own description = %q, want the engine's %q", where, e.Description, want.engineText)
			}
			continue
		}
		if positionText.MatchString(e.Description) || digitOutsideCards(e.Description) {
			t.Fatalf("%s: the other seat sees hand positions: %q", where, e.Description)
		}
		if e.Description == "" {
			t.Fatalf("%s: the other seat's description is empty", where)
		}
		if want.otherSeatText != "" && e.Description != want.otherSeatText {
			t.Fatalf("%s: the other seat's description = %q, want %q", where, e.Description, want.otherSeatText)
		}
	}
}

// TestSPEC3_2_DiscardPairPositionsRedactedForOtherSeat: P2 discards
// hand[1] and hand[2]. P1 sees "discards two cards" in history and lastMove
// on every path, P2 sees the engine's own text, and P1's wire carries no
// position text at all.
func TestSPEC3_2_DiscardPairPositionsRedactedForOtherSeat(t *testing.T) {
	st := fourThenDiscard([]card.Card{c(card.King, card.Hearts), c(card.Seven, card.Diamonds), c(card.Nine, card.Spades)})
	const engineText = "discard hand[1] and hand[2]"
	want := discardEntryCheck{seq: 2, engineText: engineText, otherSeatText: otherSeatTwoCardDiscard}

	t.Run("bridge", func(t *testing.T) {
		b := NewBridge()
		env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 4♣ as one-off"))))
		if b.game.state.Phase != engine.PhaseAwaitingDiscard || b.game.state.Active != engine.P2 {
			t.Fatalf("precondition: phase %d active %d, want P2 discarding", b.game.state.Phase, b.game.state.Active)
		}
		discarder := okEnvelope(t, b.View(1.0))
		mover := okEnvelope(t, b.Apply(float64(indexOfDescription(t, discarder.Descriptions, engineText))))
		assertDiscardEntry(t, "Apply (discarder)", engine.P2, mover, want)
		for viewer := range 2 {
			wire := b.View(float64(viewer))
			assertDiscardEntry(t, "View", engine.PlayerID(viewer), okEnvelope(t, wire), want)
			if viewer == 0 && positionText.MatchString(wire) {
				t.Fatalf("P1's wire carries position text: %s", wire)
			}
		}
		// The pass-and-play snapshot is unredacted by design (SPEC §3.4), and
		// a restore from it redacts again per viewer.
		snap := b.Snapshot()
		if !strings.Contains(snap, engineText) {
			t.Fatalf("snapshot lost the engine's description: %s", snap)
		}
		for viewer := range 2 {
			r := NewBridge()
			assertDiscardEntry(t, "Restore", engine.PlayerID(viewer), okEnvelope(t, r.Restore(snap, float64(viewer))), want)
		}
	})

	t.Run("session", func(t *testing.T) {
		s, err := RestoreSession([]byte(snapshotOf(t, st)))
		if err != nil {
			t.Fatal(err)
		}
		moves, descs, err := s.LegalMoves(Seat0)
		if err != nil || len(moves) == 0 {
			t.Fatalf("LegalMoves: %v", err)
		}
		if _, err := s.Apply(Seat0, 0, indexOfDescription(t, descs, "play 4♣ as one-off")); err != nil {
			t.Fatal(err)
		}
		_, descs, err = s.LegalMoves(Seat1)
		if err != nil {
			t.Fatal(err)
		}
		up, err := s.Apply(Seat1, 1, indexOfDescription(t, descs, engineText))
		if err != nil {
			t.Fatal(err)
		}
		for viewer := range 2 {
			seat := Seat(viewer)
			// The server's fan-out after a move (Update.For) ...
			sent := up.For(seat)
			assertDiscardEntry(t, "Update.For", engine.PlayerID(viewer), sent, want)
			// ... and its resync (View).
			view, err := s.View(seat)
			if err != nil {
				t.Fatal(err)
			}
			assertDiscardEntry(t, "Session.View", engine.PlayerID(viewer), view, want)
			if viewer == 0 && positionText.MatchString(jsonOf(t, sent)) {
				t.Fatalf("seat 0's frame envelope carries position text: %s", jsonOf(t, sent))
			}
		}
		// The server's stored snapshot is unredacted by design and never sent.
		if p := persisted(t, s); !strings.Contains(p, engineText) {
			t.Fatalf("stored snapshot lost the engine's description: %s", p)
		}
	})
}

// TestSPEC3_2_DiscardPairOneCardRedactedForOtherSeat: P2 holds one card, so
// the engine's move is DiscardA 0, DiscardB -1 (engine/apply.go:509-511),
// described "discard hand[0] and hand[-1]". The other seat sees "discards
// one card" (the count is public: handCount, scrap).
func TestSPEC3_2_DiscardPairOneCardRedactedForOtherSeat(t *testing.T) {
	st := fourThenDiscard([]card.Card{c(card.King, card.Hearts)})
	const engineText = "discard hand[0] and hand[-1]"
	want := discardEntryCheck{seq: 2, engineText: engineText, otherSeatText: otherSeatOneCardDiscard}

	b := NewBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
	okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 4♣ as one-off"))))
	discarder := okEnvelope(t, b.View(1.0))
	if len(discarder.LegalMoves) != 1 || discarder.LegalMoves[0].DiscardB != -1 {
		t.Fatalf("precondition: want the one-card discard, got %+v", discarder.LegalMoves)
	}
	okEnvelope(t, b.Apply(float64(indexOfDescription(t, discarder.Descriptions, engineText))))
	for viewer := range 2 {
		assertDiscardEntry(t, "bridge View", engine.PlayerID(viewer), okEnvelope(t, b.View(float64(viewer))), want)
	}

	s, err := RestoreSession([]byte(b.Snapshot()))
	if err != nil {
		t.Fatal(err)
	}
	for viewer := range 2 {
		view, err := s.View(Seat(viewer))
		if err != nil {
			t.Fatal(err)
		}
		assertDiscardEntry(t, "Session.View", engine.PlayerID(viewer), view, want)
	}
}

// TestSPEC3_2_DiscardPairRedactionAcrossRandomGames walks seeded games on
// both front ends and checks every history entry and lastMove for both
// seats after every move: a DiscardPair is redacted only for the seat that
// didn't make it, and every other entry's description is the engine's,
// unchanged, for both seats.
func TestSPEC3_2_DiscardPairRedactionAcrossRandomGames(t *testing.T) {
	// Engine v0.3.0 (#93, owed discards at turn start): 2 and 31 reach both
	// shapes, 15 two-card discards, 16 a one-card discard (DiscardB -1).
	discardSeeds := []uint64{2, 15, 16, 31}
	seeds := len(discardSeeds)
	var twoCard, oneCard, otherKinds int

	check := func(t *testing.T, label string, viewer engine.PlayerID, env Envelope, truth []AppliedMove) {
		t.Helper()
		if len(env.History) != len(truth) {
			t.Fatalf("%s: history %d entries, truth %d", label, len(env.History), len(truth))
		}
		entries := append([]AppliedMove{}, env.History...)
		if env.LastMove != nil {
			entries = append(entries, *env.LastMove)
		}
		for i, e := range entries {
			k := i
			if k >= len(truth) {
				k = len(truth) - 1 // lastMove is the last entry
			}
			raw := truth[k]
			switch {
			case raw.By == viewer || raw.Kind != engine.MoveDiscardPair:
				if e.Description != raw.Description {
					t.Fatalf("%s viewer %d entry %d (kind %d by %d): description %q, want the engine's %q",
						label, viewer, raw.Seq, raw.Kind, raw.By, e.Description, raw.Description)
				}
				if raw.By != viewer {
					otherKinds++
				}
			default:
				if positionText.MatchString(e.Description) || digitOutsideCards(e.Description) {
					t.Fatalf("%s viewer %d entry %d: the other seat sees %q", label, viewer, raw.Seq, e.Description)
				}
				want := otherSeatTwoCardDiscard
				if strings.HasSuffix(raw.Description, "hand[-1]") {
					want = otherSeatOneCardDiscard
					oneCard++
				} else {
					twoCard++
				}
				if e.Description != want {
					t.Fatalf("%s viewer %d entry %d: the other seat sees %q, want %q", label, viewer, raw.Seq, e.Description, want)
				}
			}
		}
	}

	for _, seed := range discardSeeds {
		// Bridge: the mover's Apply envelope, then both seats' View.
		b := NewBridge()
		env := okEnvelope(t, b.NewGame(mustJSON(t, map[string]any{"seed": itoa(seed), "dealer": seed & 1})))
		rng := xorshift32(uint32(seed))
		for step := 0; env.State.Phase != engine.PhaseGameOver; step++ {
			if step > 3000 || len(env.LegalMoves) == 0 {
				t.Fatalf("seed %d: bridge game did not finish (step %d)", seed, step)
			}
			mover := env.State.Active
			applied := okEnvelope(t, b.Apply(float64(int(rng()%uint32(len(env.LegalMoves))))))
			check(t, "bridge Apply", mover, applied, b.game.history)
			for viewer := range 2 {
				check(t, "bridge View", engine.PlayerID(viewer), okEnvelope(t, b.View(float64(viewer))), b.game.history)
			}
			env = okEnvelope(t, b.View(float64(applied.State.Active)))
		}

		// Session: Update.For both seats, then View both seats.
		s := mustSession(t, seed, Seat(seed&1))
		rng = xorshift32(uint32(seed))
		for step := 0; ; step++ {
			st := mustStatus(t, s)
			if st.Over || st.Stuck {
				break
			}
			if step > 3000 {
				t.Fatalf("seed %d: session game did not finish", seed)
			}
			moves, _, err := s.LegalMoves(st.Actor)
			if err != nil {
				t.Fatal(err)
			}
			up, err := s.Apply(st.Actor, st.Seq, int(rng()%uint32(len(moves))))
			if err != nil {
				t.Fatal(err)
			}
			for viewer := range 2 {
				check(t, "Update.For", engine.PlayerID(viewer), up.For(Seat(viewer)), s.g.history)
				view, err := s.View(Seat(viewer))
				if err != nil {
					t.Fatal(err)
				}
				check(t, "Session.View", engine.PlayerID(viewer), view, s.g.history)
			}
		}
	}
	t.Logf("%d seeds x 2 front ends: %d two-card and %d one-card other-seat DiscardPair checks, %d other-seat entries of other kinds",
		seeds, twoCard, oneCard, otherKinds)
	if twoCard == 0 || oneCard == 0 {
		t.Fatalf("two-card %d, one-card %d: a DiscardPair shape never reached the other seat", twoCard, oneCard)
	}
	if otherKinds == 0 {
		t.Fatal("no other-seat entry of another kind was checked")
	}
}
