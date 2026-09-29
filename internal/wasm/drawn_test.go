package main

// SPEC §2.7 (amended 2026-09-28) — AppliedMove.drawn: how many cards a 5
// drew, set on the entry whose apply resolved the 5 (its own entry, or the
// Decline/Counter that closed its chain: history is append-only). The
// board's last-move line reads it (SPEC §4.6) so "Alice played 5♥ as a
// one-off and drew 2 cards." can be said without the UI recomputing the
// rule. A count only: the drawn cards' identities never cross the bridge in
// history, and both viewers see the same number (a hand count and the deck
// count are public already, R7).

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

func deckOf(n int) []card.Card {
	ranks := []card.Rank{card.King, card.Queen, card.Ten, card.Eight}
	out := make([]card.Card, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, c(ranks[i%len(ranks)], card.Suit(i/len(ranks))))
	}
	return out
}

func drawnOf(t *testing.T, h AppliedMove) int {
	t.Helper()
	if h.Drawn == nil {
		t.Fatalf("seq %d (%q): drawn is null, want a count", h.Seq, h.Description)
	}
	return *h.Drawn
}

func wantNullDrawn(t *testing.T, h AppliedMove) {
	t.Helper()
	if h.Drawn != nil {
		t.Fatalf("seq %d (%q): drawn = %d, want null", h.Seq, h.Description, *h.Drawn)
	}
}

// A 5 nobody can counter resolves inside its own apply.
func TestSPEC2_7_DrawnSetWhenFiveResolvesImmediately(t *testing.T) {
	tests := []struct {
		name string
		hand []card.Card
		deck int
		want int
	}{
		{"full draw", []card.Card{c(card.Five, card.Hearts), c(card.Three, card.Clubs)}, 5, 2},
		{"deck holds one card", []card.Card{c(card.Five, card.Hearts)}, 1, 1},
		{"deck empty", []card.Card{c(card.Five, card.Hearts)}, 0, 0},
		{"hand limit leaves room for one", append([]card.Card{c(card.Five, card.Hearts)},
			c(card.Three, card.Clubs), c(card.Three, card.Diamonds), c(card.Three, card.Hearts), c(card.Three, card.Spades),
			c(card.Four, card.Clubs), c(card.Four, card.Diamonds), c(card.Four, card.Hearts)), 5, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := engine.GameState{
				Players: [2]engine.PlayerState{{Hand: tc.hand}, {Hand: []card.Card{c(card.Six, card.Clubs)}}},
				Deck:    deckOf(tc.deck),
				Active:  engine.P1,
			}
			b := newBridge()
			env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
			wire := b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 5♥ as one-off")))
			after := okEnvelope(t, wire)
			if got := drawnOf(t, *after.LastMove); got != tc.want {
				t.Fatalf("drawn = %d, want %d", got, tc.want)
			}
			if got := drawnOf(t, after.History[len(after.History)-1]); got != tc.want {
				t.Fatalf("history drawn = %d, want %d", got, tc.want)
			}
			// Public: the other viewer reads the same count.
			other := okEnvelope(t, b.View(1.0))
			if got := drawnOf(t, other.History[len(other.History)-1]); got != tc.want {
				t.Fatalf("non-mover drawn = %d, want %d", got, tc.want)
			}
		})
	}
}

// A 5 facing a counter window has not drawn yet; the decline that resolves
// it carries the count (the 5's own entry stays frozen, null).
func TestSPEC2_7_DrawnSetOnTheDeclineThatResolvesAFive(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Five, card.Hearts), c(card.Three, card.Clubs)}},
			{Hand: []card.Card{c(card.Two, card.Clubs), c(card.Six, card.Clubs)}},
		},
		Deck:   deckOf(4),
		Active: engine.P1,
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
	played := okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 5♥ as one-off"))))
	if played.State.Phase != engine.PhaseAwaitingCounter {
		t.Fatalf("precondition: phase %d, want a counter window", played.State.Phase)
	}
	wantNullDrawn(t, *played.LastMove)

	window := okEnvelope(t, b.View(1.0))
	after := okEnvelope(t, b.Apply(float64(indexOfDescription(t, window.Descriptions, "decline to counter"))))
	wantNullDrawn(t, after.History[0])
	if after.History[1].Kind != engine.MoveDecline {
		t.Fatalf("precondition: history[1] kind %d", after.History[1].Kind)
	}
	if got := drawnOf(t, after.History[1]); got != 2 {
		t.Fatalf("decline drawn = %d, want 2", got)
	}
}

// A countered 5 draws nothing (odd chain), and a 5 whose counter is
// countered back resolves (even chain) with its count on the closing Counter.
func TestSPEC2_7_DrawnFollowsCounterChainParity(t *testing.T) {
	base := func(p1Extra []card.Card) engine.GameState {
		return engine.GameState{
			Players: [2]engine.PlayerState{
				{Hand: append([]card.Card{c(card.Five, card.Hearts)}, p1Extra...)},
				{Hand: []card.Card{c(card.Two, card.Clubs), c(card.Six, card.Clubs)}},
			},
			Deck:   deckOf(4),
			Active: engine.P1,
		}
	}

	t.Run("cancelled", func(t *testing.T) {
		b := newBridge()
		env := okEnvelope(t, b.Restore(snapshotOf(t, base([]card.Card{c(card.Three, card.Clubs)})), 0.0))
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 5♥ as one-off"))))
		window := okEnvelope(t, b.View(1.0))
		after := okEnvelope(t, b.Apply(float64(indexOfDescription(t, window.Descriptions, "counter with 2♣"))))
		if after.State.Phase == engine.PhaseAwaitingCounter {
			t.Fatal("precondition: the chain should resolve, P1 holds no 2")
		}
		for _, h := range after.History {
			wantNullDrawn(t, h)
		}
	})

	t.Run("countered back", func(t *testing.T) {
		b := newBridge()
		env := okEnvelope(t, b.Restore(snapshotOf(t, base([]card.Card{c(card.Two, card.Hearts)})), 0.0))
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "play 5♥ as one-off"))))
		window := okEnvelope(t, b.View(1.0))
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, window.Descriptions, "counter with 2♣"))))
		back := okEnvelope(t, b.View(0.0))
		after := okEnvelope(t, b.Apply(float64(indexOfDescription(t, back.Descriptions, "counter with 2♥"))))
		if after.State.Phase == engine.PhaseAwaitingCounter {
			t.Fatal("precondition: P2 holds no second 2, so the chain resolves")
		}
		wantNullDrawn(t, after.History[0])
		wantNullDrawn(t, after.History[1])
		if got := drawnOf(t, after.History[2]); got != 2 {
			t.Fatalf("closing counter drawn = %d, want 2", got)
		}
	})
}

// A 5 revealed by a 7 counts the cards drawn after the unchosen reveal went
// back on top of the deck.
func TestSPEC2_7_DrawnForSevenRevealedFive(t *testing.T) {
	tests := []struct {
		name     string
		revealed []card.Card
		deck     int
		want     int
	}{
		{"one reveal, one deck card", []card.Card{c(card.Five, card.Hearts)}, 1, 1},
		{"two reveals, unchosen returns and is drawn", []card.Card{c(card.Five, card.Hearts), c(card.Nine, card.Clubs)}, 0, 1},
		{"two reveals, deck of three", []card.Card{c(card.Five, card.Hearts), c(card.Nine, card.Clubs)}, 3, 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}},
				},
				Deck:    deckOf(tc.deck),
				Active:  engine.P1,
				Phase:   engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: tc.revealed},
			}
			b := newBridge()
			env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
			after := okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "7: play 5♥ as one-off"))))
			if got := drawnOf(t, *after.LastMove); got != tc.want {
				t.Fatalf("drawn = %d, want %d", got, tc.want)
			}
		})
	}
}

// Over random games: drawn is set only on an entry that resolved a 5 (a 5's
// own one-off entry, or a Decline/Counter answering a chain a 5 opened),
// always 0..2, and the held history passes validateHistory. The property must be
// exercised at least once.
func TestSPEC2_7_DrawnOnlyOnResolvedFivesAcrossRandomGames(t *testing.T) {
	seen, deferred := 0, 0
	for seed := uint64(1); seed <= 160; seed++ {
		b := newBridge()
		okEnvelope(t, b.NewGame(`{"seed":"`+itoa(seed)+`","dealer":0}`))
		env := playRandom(t, b, seed, func(env Envelope, wire string) {})
		var snap snapshotWire
		if err := json.Unmarshal([]byte(b.Snapshot()), &snap); err != nil {
			t.Fatal(err)
		}
		if err := validateHistory(snap.History); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		for i, h := range env.History {
			if h.Drawn == nil {
				continue
			}
			if h.Kind == engine.MoveDecline || h.Kind == engine.MoveCounter {
				o := chainOrigin(env.History, i)
				if o < 0 || !isFiveEntry(env.History[o]) {
					t.Fatalf("seed %d: drawn on a %d entry that closes no 5 chain", seed, h.Kind)
				}
				deferred++
			} else if !isFiveEntry(h) {
				t.Fatalf("seed %d: drawn on a non-5 entry %+v", seed, h)
			}
			if *h.Drawn < 0 || *h.Drawn > 2 {
				t.Fatalf("seed %d: drawn %d out of range", seed, *h.Drawn)
			}
			seen++
		}
	}
	if seen == 0 {
		t.Fatal("no resolved 5 in the corpus; the property was never exercised")
	}
	t.Logf("resolved 5s: %d (%d closed by a Decline/Counter)", seen, deferred)
}

// Restore: the key is required, and a count is only valid on a 5's entry.
func TestSPEC2_9_RestoreDrawn(t *testing.T) {
	five := `{"index":0,"by":0,"kind":4,"subKind":null,"card":{"Rank":5,"Suit":2},"targetCard":null,"drawn":2,"description":"play 5♥ as one-off","seq":1}`
	fiveThenDecline := strings.Replace(five, `"drawn":2`, `"drawn":null`, 1) +
		`,{"index":0,"by":1,"kind":6,"subKind":null,"card":null,"targetCard":null,"drawn":2,"description":"decline to counter","seq":2}`
	restore := func(entry string) string {
		return newBridge().Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[`+entry+`]`, 1), 0.0)
	}
	if m := decodeGeneric(t, restore(five)); m["ok"] != true {
		t.Fatalf("a 5 entry with drawn 2 must restore: %v", m)
	}
	if m := decodeGeneric(t, restore(fiveThenDecline)); m["ok"] != true {
		t.Fatalf("a decline closing a 5 with drawn 2 must restore: %v", m)
	}
	bad := map[string]string{
		"missing key":                  strings.Replace(five, `"drawn":2,`, ``, 1),
		"drawn on a draw":              `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":null,"drawn":1,"description":"draw a card","seq":1}`,
		"drawn on a 3":                 strings.Replace(five, `"Rank":5`, `"Rank":3`, 1),
		"drawn too many":               strings.Replace(five, `"drawn":2`, `"drawn":3`, 1),
		"drawn negative":               strings.Replace(five, `"drawn":2`, `"drawn":-1`, 1),
		"drawn wrong type":             strings.Replace(five, `"drawn":2`, `"drawn":"2"`, 1),
		"drawn on a decline after a 3": strings.Replace(strings.Replace(fiveThenDecline, `"Rank":5`, `"Rank":3`, 1), `play 5♥`, `play 3♥`, 1),
	}
	for name, entry := range bad {
		errCode(t, restore(entry), "BAD_REQUEST")
		_ = name
	}
}

func TestSPEC2_7_SnapshotVersionIsTwo(t *testing.T) {
	if snapshotVersion != 2 {
		t.Fatalf("snapshotVersion = %d; the AppliedMove shape gained drawn, so the version is 2 (SPEC §5.7)", snapshotVersion)
	}
}

// SPEC §5.7 (ruling 2026-09-28): a v1 save is migrated, not discarded. The
// fixture is a real __cuttleSnapshot() from the base commit (bce9fb2, v1
// bridge): seed "2", dealer 0 — Blake's 5 one-off, Alice's decline, Alice's
// draw.
func TestSPEC5_7_RestoreMigratesV1Snapshot(t *testing.T) {
	raw, err := os.ReadFile("testdata/snapshot-v1-bce9fb2.json")
	if err != nil {
		t.Fatal(err)
	}
	var v1 map[string]any
	if err := json.Unmarshal(raw, &v1); err != nil {
		t.Fatal(err)
	}
	if v1["v"].(float64) != 1 || strings.Contains(string(raw), `"drawn"`) {
		t.Fatal("precondition: the fixture is a v1 snapshot with no drawn keys")
	}
	for _, viewer := range []float64{0, 1} {
		b := newBridge()
		wire := b.Restore(string(raw), viewer)
		env := okEnvelope(t, wire)
		if len(env.History) != 3 {
			t.Fatalf("history length %d, want 3", len(env.History))
		}
		for _, h := range env.History {
			wantNullDrawn(t, h)
		}
		if strings.Count(wire, `"drawn":null`) < 3 {
			t.Fatalf("every migrated entry must carry the drawn key: %s", wire)
		}
		// The next snapshot is v2 and restores as-is.
		snap := decodeGeneric(t, b.Snapshot())
		if snap["v"].(float64) != 2 {
			t.Fatalf("snapshot after a v1 restore is v%v, want 2", snap["v"])
		}
		again := okEnvelope(t, newBridge().Restore(b.Snapshot(), viewer))
		if !reflect.DeepEqual(again.History, env.History) {
			t.Fatal("v2 re-restore changed history")
		}
		// The game plays on.
		okEnvelope(t, b.LegalMoves())
	}
}

func TestSPEC5_7_RestoreRejectsBadV1AndUnknownVersions(t *testing.T) {
	raw, err := os.ReadFile("testdata/snapshot-v1-bce9fb2.json")
	if err != nil {
		t.Fatal(err)
	}
	withDrawn := strings.Replace(string(raw), `"seq":1`, `"seq":1,"drawn":null`, 1)
	errCode(t, newBridge().Restore(withDrawn, 0.0), "BAD_REQUEST")
	v3 := strings.Replace(string(raw), `"v":1`, `"v":3`, 1)
	errCode(t, newBridge().Restore(v3, 0.0), "BAD_REQUEST")
	// A v2 snapshot missing drawn is not upgraded.
	v2NoDrawn := strings.Replace(string(raw), `"v":1`, `"v":2`, 1)
	errCode(t, newBridge().Restore(v2NoDrawn, 0.0), "BAD_REQUEST")
}

// Chains of two and four counters (review B1): the count lands only on the
// entry that closed the chain, every earlier entry stays null, and the
// held history survives Snapshot() -> Restore() (validateHistory walks the
// chain back to the 5 through every counter).
func TestSPEC2_7_DrawnOnLongCounterChains(t *testing.T) {
	type step struct {
		viewer float64
		desc   string
	}
	tests := []struct {
		name  string
		p1    []card.Card
		p2    []card.Card
		steps []step
		kind  engine.MoveKind // the closing entry's kind
	}{
		{
			name:  "5, counter, counter, closed by a decline",
			p1:    []card.Card{c(card.Five, card.Hearts), c(card.Two, card.Hearts), c(card.Three, card.Clubs)},
			p2:    []card.Card{c(card.Two, card.Clubs), c(card.Two, card.Diamonds), c(card.Six, card.Clubs)},
			steps: []step{{0, "play 5♥ as one-off"}, {1, "counter with 2♣"}, {0, "counter with 2♥"}, {1, "decline to counter"}},
			kind:  engine.MoveDecline,
		},
		{
			name:  "5 and four counters, closed by the fourth counter",
			p1:    []card.Card{c(card.Five, card.Hearts), c(card.Two, card.Hearts), c(card.Two, card.Spades)},
			p2:    []card.Card{c(card.Two, card.Clubs), c(card.Two, card.Diamonds), c(card.Six, card.Clubs)},
			steps: []step{{0, "play 5♥ as one-off"}, {1, "counter with 2♣"}, {0, "counter with 2♥"}, {1, "counter with 2♦"}, {0, "counter with 2♠"}},
			kind:  engine.MoveCounter,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := engine.GameState{
				Players: [2]engine.PlayerState{{Hand: tc.p1}, {Hand: tc.p2}},
				Deck:    deckOf(4),
				Active:  engine.P1,
			}
			b := newBridge()
			okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
			var after Envelope
			for i, s := range tc.steps {
				view := okEnvelope(t, b.View(s.viewer))
				after = okEnvelope(t, b.Apply(float64(indexOfDescription(t, view.Descriptions, s.desc))))
				if i < len(tc.steps)-1 && after.State.Phase != engine.PhaseAwaitingCounter {
					t.Fatalf("step %d: the chain closed early", i)
				}
			}
			if after.State.Phase == engine.PhaseAwaitingCounter {
				t.Fatal("precondition: the last step closes the chain")
			}
			last := len(after.History) - 1
			if after.History[last].Kind != tc.kind {
				t.Fatalf("closing entry kind %d, want %d", after.History[last].Kind, tc.kind)
			}
			if got := drawnOf(t, after.History[last]); got != 2 {
				t.Fatalf("closing entry drawn = %d, want 2", got)
			}
			for _, h := range after.History[:last] {
				wantNullDrawn(t, h)
			}
			again := okEnvelope(t, newBridge().Restore(b.Snapshot(), 0.0))
			if got := drawnOf(t, again.History[last]); got != 2 {
				t.Fatalf("restored drawn = %d, want 2", got)
			}
		})
	}
}
