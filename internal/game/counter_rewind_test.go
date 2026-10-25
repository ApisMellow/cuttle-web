package game

// Issue #93, engine v0.3.0 (counter rewind): the bridge side, design §8
// B1-B3 (docs/counter-rewind-design.md). The view gains `counterable`
// (engine.CounterAvailable, engine/apply.go:171) and `owedDiscards`
// (state.Owed); phase 5 (PhasePendingWin) appears; Snapshot.v is 3; and
// nothing of TurnEnd, LastTurn or ThisTurn may cross the boundary.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

type twinStep struct {
	by   engine.PlayerID
	desc string
}

// twinStart builds the start of a twin game. Blake's last card is `last`:
// the twins differ only there, a 2 in one and a non-2 in the other, so both
// hands keep the same size.
func twinStart(alice, blakeCommon []card.Card, last card.Card, active engine.PlayerID) engine.GameState {
	blake := append(append([]card.Card{}, blakeCommon...), last)
	return engine.GameState{
		Players: [2]engine.PlayerState{{Hand: append([]card.Card{}, alice...)}, {Hand: blake}},
		Deck: []card.Card{c(card.Queen, card.Hearts), c(card.Jack, card.Diamonds), c(card.Three, card.Hearts),
			c(card.Ten, card.Spades), c(card.Nine, card.Spades), c(card.Eight, card.Diamonds), c(card.Seven, card.Hearts)},
		Active: active,
	}
}

// B1: the counter flag and every other byte Alice sees never depend on
// whether Blake holds a 2. Three fixed twin games; after every move (none
// of them wins), Alice's post-apply envelope (her own moves) and her view
// (every move) are byte-identical in both twins.
func TestB1_TwinStatesLookIdenticalToAlice(t *testing.T) {
	games := []struct {
		name        string
		alice       []card.Card
		blakeCommon []card.Card
		active      engine.PlayerID
		steps       []twinStep
	}{
		{
			name:        "ace and six one-offs",
			alice:       []card.Card{c(card.Ace, card.Clubs), c(card.Six, card.Spades), c(card.Ten, card.Hearts), c(card.Five, card.Diamonds)},
			blakeCommon: []card.Card{c(card.Seven, card.Clubs), c(card.Eight, card.Spades), c(card.Nine, card.Diamonds)},
			active:      engine.P1,
			steps: []twinStep{
				{engine.P1, "play 10♥ as point card"},
				{engine.P2, "draw a card"},
				{engine.P1, "play A♣ as one-off"},
				{engine.P2, "play 7♣ as point card"},
				{engine.P1, "play 6♠ as one-off"},
				{engine.P2, "draw a card"},
				{engine.P1, "draw a card"},
			},
		},
		{
			name:        "a four and the owed discard",
			alice:       []card.Card{c(card.Four, card.Diamonds), c(card.Ten, card.Hearts), c(card.Five, card.Diamonds)},
			blakeCommon: []card.Card{c(card.Seven, card.Clubs), c(card.Eight, card.Spades), c(card.Nine, card.Diamonds)},
			active:      engine.P1,
			steps: []twinStep{
				{engine.P1, "play 4♦ as one-off"},
				{engine.P2, "discard hand[0] and hand[1]"},
				{engine.P2, "draw a card"},
				{engine.P1, "play 10♥ as point card"},
				{engine.P2, "play 9♦ as point card"},
			},
		},
		{
			name:        "Blake's five, Alice without a 2",
			alice:       []card.Card{c(card.Ten, card.Hearts), c(card.Six, card.Spades), c(card.Three, card.Clubs)},
			blakeCommon: []card.Card{c(card.Five, card.Clubs), c(card.Seven, card.Clubs), c(card.Nine, card.Diamonds)},
			active:      engine.P2,
			steps: []twinStep{
				{engine.P2, "play 5♣ as one-off"},
				{engine.P1, "play 10♥ as point card"},
				{engine.P2, "play 7♣ as point card"},
				{engine.P1, "play 6♠ as one-off"},
				{engine.P2, "draw a card"},
			},
		},
	}
	for _, g := range games {
		t.Run(g.name, func(t *testing.T) {
			var twins [2]*Bridge
			for i, last := range []card.Card{c(card.King, card.Clubs), c(card.Two, card.Clubs)} {
				twins[i] = NewBridge()
				okEnvelope(t, twins[i].Restore(snapshotOf(t, twinStart(g.alice, g.blakeCommon, last, g.active)), 0.0))
			}
			counterableSeen := false
			for n, s := range g.steps {
				var applied [2]string
				for i, b := range twins {
					view := okEnvelope(t, b.View(float64(s.by)))
					applied[i] = b.Apply(float64(indexOfDescription(t, view.Descriptions, s.desc)))
					env := okEnvelope(t, applied[i])
					if env.State.Phase == engine.PhaseGameOver || env.State.Phase == engine.PhasePendingWin {
						t.Fatalf("step %d: the twin games must not reach a win", n)
					}
				}
				if s.by == engine.P1 && applied[0] != applied[1] {
					t.Fatalf("step %d (%s): Alice's post-apply envelopes differ:\n%s\n%s", n, s.desc, applied[0], applied[1])
				}
				a, b := twins[0].View(0.0), twins[1].View(0.0)
				if a != b {
					t.Fatalf("step %d (%s): Alice's views differ:\n%s\n%s", n, s.desc, a, b)
				}
				if okEnvelope(t, a).State.Counterable && twins[1].game.state.Active == engine.P2 {
					// Only the twin with the 2 offers Blake the counter.
					counterIn := func(b *Bridge) bool {
						for _, m := range okEnvelope(t, b.View(1.0)).LegalMoves {
							if m.Kind == engine.MoveCounter {
								return true
							}
						}
						return false
					}
					if counterIn(twins[0]) || !counterIn(twins[1]) {
						t.Fatalf("step %d: the counter must be offered in the 2 twin only", n)
					}
					counterableSeen = true
				}
			}
			if !counterableSeen {
				t.Fatal("the game never offered Blake a counter")
			}
		})
	}
}

// B2: in new play no Decline is offered outside phase 5, where it reads
// "Let it happen"; no legacy counter window (phase 1) ever opens; seq rises
// by exactly one per move (playRandom); and counterable equals the engine's
// CounterAvailable for both viewers at every step.
func TestB2_NewPlayOffersDeclineOnlyAtPendingWin(t *testing.T) {
	steps, counterable := 0, 0
	for _, seed := range []uint64{1, 2, 3, 4, 5} {
		b := NewBridge()
		playRandom(t, b, seed, func(env Envelope, wire string) {
			steps++
			if env.State.Phase == engine.PhaseAwaitingCounter {
				t.Fatalf("seed %d seq %d: a legacy counter window opened in new play", seed, env.Seq)
			}
			for i, m := range env.LegalMoves {
				if m.Kind == engine.MoveDecline && (env.State.Phase != engine.PhasePendingWin || env.Descriptions[i] != "Let it happen") {
					t.Fatalf("seed %d seq %d: Decline %q offered in phase %d", seed, env.Seq, env.Descriptions[i], env.State.Phase)
				}
			}
			want := engine.CounterAvailable(b.game.state)
			if want {
				counterable++
			}
			for viewer := range 2 {
				if got := okEnvelope(t, b.View(float64(viewer))).State.Counterable; got != want {
					t.Fatalf("seed %d seq %d viewer %d: counterable %v, engine says %v", seed, env.Seq, viewer, got, want)
				}
			}
		})
	}
	if counterable == 0 {
		t.Fatal("no counterable position was exercised")
	}
	t.Logf("5 seeds, %d envelopes, %d counterable", steps, counterable)
}

// B2: counterable and owedDiscards at known points.
func TestB2_CounterableAndOwedDiscardsAtKnownPoints(t *testing.T) {
	t.Run("one-off, then a first move", func(t *testing.T) {
		st := twinStart([]card.Card{c(card.Ace, card.Clubs), c(card.Ten, card.Hearts)},
			[]card.Card{c(card.Seven, card.Clubs)}, c(card.Two, card.Clubs), engine.P1)
		b := NewBridge()
		start := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
		if start.State.Counterable {
			t.Fatal("the dealt position is not counterable")
		}
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, start.Descriptions, "play A♣ as one-off"))))
		for viewer := range 2 {
			if !okEnvelope(t, b.View(float64(viewer))).State.Counterable {
				t.Fatalf("viewer %d: after Alice's one-off, counterable must be true", viewer)
			}
		}
		blake := okEnvelope(t, b.View(1.0))
		if last := blake.Descriptions[len(blake.Descriptions)-1]; last != "counter with 2♣" {
			t.Fatalf("Blake's last move %q, want the counter", last)
		}
		// Blake's first move is a draw, not the counter.
		okEnvelope(t, b.Apply(float64(indexOfDescription(t, blake.Descriptions, "draw a card"))))
		for viewer := range 2 {
			if okEnvelope(t, b.View(float64(viewer))).State.Counterable {
				t.Fatalf("viewer %d: after Blake's draw, counterable must be false", viewer)
			}
		}
	})

	t.Run("a four, then paying", func(t *testing.T) {
		st := twinStart([]card.Card{c(card.Four, card.Diamonds), c(card.Ten, card.Hearts)},
			[]card.Card{c(card.Seven, card.Clubs), c(card.Eight, card.Spades)}, c(card.Nine, card.Diamonds), engine.P1)
		b := NewBridge()
		start := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
		if start.State.OwedDiscards != (OwedView{}) {
			t.Fatalf("owedDiscards at the start = %+v", start.State.OwedDiscards)
		}
		alice := okEnvelope(t, b.Apply(float64(indexOfDescription(t, start.Descriptions, "play 4♦ as one-off"))))
		if alice.State.Phase != engine.PhaseAwaitingDiscard || alice.State.Active != engine.P2 || alice.State.Pending != nil {
			t.Fatalf("after the 4: phase %d active %d pending %v", alice.State.Phase, alice.State.Active, alice.State.Pending)
		}
		if alice.State.OwedDiscards != (OwedView{You: 0, Opponent: 2}) {
			t.Fatalf("the 4-player's owedDiscards = %+v, want {0 2}", alice.State.OwedDiscards)
		}
		if !alice.State.Counterable {
			t.Fatal("the 4's turn is counterable at the owed discard")
		}
		blake := okEnvelope(t, b.View(1.0))
		if blake.State.OwedDiscards != (OwedView{You: 2, Opponent: 0}) {
			t.Fatalf("the debtor's owedDiscards = %+v, want {2 0}", blake.State.OwedDiscards)
		}
		paid := okEnvelope(t, b.Apply(float64(indexOfDescription(t, blake.Descriptions, "discard hand[0] and hand[1]"))))
		if paid.State.OwedDiscards != (OwedView{}) || paid.State.Phase != engine.PhaseNormal || paid.State.Active != engine.P2 {
			t.Fatalf("after paying: owed %+v phase %d active %d", paid.State.OwedDiscards, paid.State.Phase, paid.State.Active)
		}
		if paid.State.Counterable {
			t.Fatal("paying is the turn's first move: counterable must be false")
		}
		if got := okEnvelope(t, b.View(0.0)).State.OwedDiscards; got != (OwedView{}) {
			t.Fatalf("Alice's owedDiscards after paying = %+v", got)
		}
	})
}

// pendingWinStart mirrors the engine's pwBase (engine/pending_win_test.go:35):
// Alice has 10♥ + 4♥ = 14; her 7♥ sits under Blake's J♠ on his side. Blake
// opens with a draw, so Alice's 2♠ popping the J♠ brings the 7♥ back: 21,
// a win on a counterable turn.
func pendingWinStart(blakeLast card.Card) engine.GameState {
	return engine.GameState{
		Players: [2]engine.PlayerState{
			{
				Hand:   []card.Card{c(card.Two, card.Spades), c(card.Ten, card.Diamonds)},
				Points: []engine.PointEntry{{Card: c(card.Ten, card.Hearts), Owner: engine.P1}, {Card: c(card.Four, card.Hearts), Owner: engine.P1}},
			},
			{
				Hand: []card.Card{c(card.Ten, card.Spades), blakeLast},
				Points: []engine.PointEntry{
					{Card: c(card.Seven, card.Hearts), Owner: engine.P1, JackStack: []card.Card{c(card.Jack, card.Spades)}, JackOwners: []engine.PlayerID{engine.P2}},
					{Card: c(card.Five, card.Diamonds), Owner: engine.P2},
				},
			},
		},
		Deck:   []card.Card{c(card.Queen, card.Hearts), c(card.Seven, card.Diamonds), c(card.Three, card.Hearts)},
		Scrap:  []card.Card{c(card.Four, card.Clubs)},
		Active: engine.P2,
	}
}

func popJackMove(t *testing.T, env Envelope) int {
	t.Helper()
	for i, m := range env.LegalMoves {
		if m.Kind == engine.MoveOneOff && m.Card != nil && *m.Card == c(card.Two, card.Spades) &&
			m.Target != nil && m.Target.Owner == engine.P2 && m.Target.Zone == engine.ZonePoints && m.Target.Index == 0 {
			return i
		}
	}
	t.Fatalf("the pop is not offered: %q", env.Descriptions)
	return -1
}

// Phase 5 through the bridge: Blake holds a 2, so Alice's win waits; his
// moves are the counter then "Let it happen"; declining ends the game with
// Alice the winner. Without a 2 the win is immediate.
func TestB2_PendingWinThroughTheBridge(t *testing.T) {
	for _, withTwo := range []bool{true, false} {
		t.Run(fmt.Sprintf("withTwo=%v", withTwo), func(t *testing.T) {
			last := c(card.Seven, card.Clubs)
			if withTwo {
				last = c(card.Two, card.Clubs)
			}
			b := NewBridge()
			start := okEnvelope(t, b.Restore(snapshotOf(t, pendingWinStart(last)), 1.0))
			okEnvelope(t, b.Apply(float64(indexOfDescription(t, start.Descriptions, "draw a card"))))
			alice := okEnvelope(t, b.View(0.0))
			popped := okEnvelope(t, b.Apply(float64(popJackMove(t, alice))))
			if !withTwo {
				if popped.State.Phase != engine.PhaseGameOver || popped.State.Winner == nil || *popped.State.Winner != engine.P1 {
					t.Fatalf("no 2: phase %d winner %v, want Alice's win at once", popped.State.Phase, popped.State.Winner)
				}
				return
			}
			if popped.State.Phase != engine.PhasePendingWin || popped.State.Active != engine.P2 || popped.State.Winner != nil {
				t.Fatalf("phase %d active %d winner %v, want phase 5 with Blake deciding", popped.State.Phase, popped.State.Active, popped.State.Winner)
			}
			if len(popped.LegalMoves) != 0 || !popped.State.Counterable || !popped.State.Scoreboard.You.HasWon {
				t.Fatalf("Alice's phase-5 view: %d moves, counterable %v, hasWon %v", len(popped.LegalMoves), popped.State.Counterable, popped.State.Scoreboard.You.HasWon)
			}
			blake := okEnvelope(t, b.View(1.0))
			if want := []string{"counter with 2♣", "Let it happen"}; strings.Join(blake.Descriptions, "|") != strings.Join(want, "|") {
				t.Fatalf("Blake's phase-5 moves %q, want %q", blake.Descriptions, want)
			}
			if blake.LegalMoves[1].Kind != engine.MoveDecline {
				t.Fatalf("the last phase-5 move is kind %d, want Decline", blake.LegalMoves[1].Kind)
			}
			over := okEnvelope(t, b.Apply(1.0))
			if over.State.Phase != engine.PhaseGameOver || over.State.Winner == nil || *over.State.Winner != engine.P1 {
				t.Fatalf("after Let it happen: phase %d winner %v", over.State.Phase, over.State.Winner)
			}
			lm := over.LastMove
			if lm.Kind != engine.MoveDecline || lm.Description != "Let it happen" || lm.TargetCard != nil || lm.Drawn != nil || lm.Card != nil || lm.Seq != 3 {
				t.Fatalf("the decline entry = %+v", *lm)
			}
			if over.State.Counterable {
				t.Fatal("counterable must be false at game over")
			}
		})
	}
}

// Redaction: no envelope or view carries TurnEnd, LastTurn, ThisTurn, Owed
// or Countered, and a card that exists only inside a TurnEnd snapshot never
// appears. The opponent's hand reaches the state only under glasses.
func TestRedaction_TurnEndNeverCrossesTheBoundary(t *testing.T) {
	forbidden := []string{`"TurnEnd"`, `"LastTurn"`, `"ThisTurn"`, `"Owed"`, `"Countered"`, `"Counterable"`, `"Deck"`, `"Players"`}
	check := func(t *testing.T, label, wire string, held engine.GameState, viewer engine.PlayerID, ghosts []card.Card) {
		t.Helper()
		for _, key := range forbidden {
			if strings.Contains(wire, key) {
				t.Fatalf("%s: %s crossed the boundary: %s", label, key, wire)
			}
		}
		for _, g := range ghosts {
			if strings.Contains(wire, cardJSON(g)) {
				t.Fatalf("%s: TurnEnd-only card %s leaked: %s", label, g, wire)
			}
		}
		env := okEnvelope(t, wire)
		if viewerHasGlasses(held.Players[viewer]) {
			return
		}
		if env.State.Opponent.Hand != nil {
			t.Fatalf("%s: opponent hand visible without glasses", label)
		}
		stateWire := mustJSON(t, env.State)
		for _, hidden := range held.Players[viewer.Other()].Hand {
			if strings.Contains(stateWire, cardJSON(hidden)) {
				t.Fatalf("%s: opponent card %s in the state", label, hidden)
			}
		}
	}

	t.Run("built TurnEnd with ghost cards", func(t *testing.T) {
		// The TurnEnd snapshots hold K♠ and Q♠ (a deck card, a hand card)
		// that the live game does not hold anywhere.
		ghosts := []card.Card{c(card.King, card.Spades), c(card.Queen, card.Spades)}
		for _, glasses := range []bool{false, true} {
			live := twinStart([]card.Card{c(card.Ten, card.Hearts), c(card.Six, card.Spades)},
				[]card.Card{c(card.Seven, card.Clubs)}, c(card.Two, card.Clubs), engine.P1)
			if glasses {
				live.Players[0].Permanents = []card.Card{c(card.Eight, card.Hearts)}
			}
			snap := live
			snap.Deck = append([]card.Card{ghosts[0]}, live.Deck...)
			snap.Players[1].Hand = append([]card.Card{ghosts[1]}, live.Players[1].Hand...)
			live.TurnEnd = [2]*engine.GameState{&snap, &snap}
			live.LastTurn = engine.TurnRecord{Counterable: true, Countered: []card.Card{c(card.Ace, card.Hearts)}}
			live.Owed = [2]int{0, 0}
			b := NewBridge()
			for viewer := range 2 {
				v := engine.PlayerID(viewer)
				check(t, fmt.Sprintf("glasses=%v restore(%d)", glasses, viewer), b.Restore(snapshotOf(t, live), float64(viewer)), live, v, ghosts)
				check(t, fmt.Sprintf("glasses=%v view(%d)", glasses, viewer), b.View(float64(viewer)), live, v, ghosts)
			}
			if !strings.Contains(b.Snapshot(), cardJSON(ghosts[0])) {
				t.Fatal("precondition: the snapshot (server-only) does hold the TurnEnd")
			}
			if env := okEnvelope(t, b.View(1.0)); !env.State.Counterable {
				t.Fatal("precondition: the built state is counterable")
			}
		}
	})

	t.Run("fixed games", func(t *testing.T) {
		withTurnEnd := 0
		for _, seed := range []uint64{1, 2, 3} {
			b := NewBridge()
			playRandom(t, b, seed, func(env Envelope, wire string) {
				held := b.game.state
				if held.TurnEnd[0] != nil || held.TurnEnd[1] != nil {
					withTurnEnd++
				}
				for viewer := range 2 {
					v := engine.PlayerID(viewer)
					check(t, fmt.Sprintf("seed %d seq %d view(%d)", seed, env.Seq, viewer), b.View(float64(viewer)), held, v, nil)
				}
			})
		}
		if withTurnEnd == 0 {
			t.Fatal("no position with a TurnEnd was checked")
		}
		t.Logf("%d positions with a TurnEnd checked for both viewers", withTurnEnd)
	})
}

// asV2 rewrites a v3 snapshot as the v2 bridge wrote it: engine v0.2.1's
// state had none of the v3 keys (engine/state.go:120-136).
func asV2(t *testing.T, v3 string) string {
	t.Helper()
	var top map[string]any
	if err := json.Unmarshal([]byte(v3), &top); err != nil {
		t.Fatal(err)
	}
	st := top["state"].(map[string]any)
	for _, k := range v3StateKeys {
		delete(st, k)
	}
	top["v"] = 2
	return mustJSON(t, top)
}

// B3: a v3 snapshot round-trips byte for byte, nil and [] Countered included.
func TestB3_SnapshotV3RoundTrip(t *testing.T) {
	t.Run("nil versus empty Countered", func(t *testing.T) {
		st := twinStart([]card.Card{c(card.Ten, card.Hearts)}, nil, c(card.Two, card.Clubs), engine.P1)
		snap := st
		st.TurnEnd[1] = &snap
		st.LastTurn = engine.TurnRecord{Counterable: true, Countered: []card.Card{}}
		st.Owed = [2]int{0, 1}
		raw := snapshotOf(t, st)
		if !strings.Contains(raw, `"LastTurn":{"Counterable":true,"Countered":[]}`) || !strings.Contains(raw, `"ThisTurn":{"Counterable":false,"Countered":null}`) {
			t.Fatalf("precondition: fixture shape %s", raw)
		}
		b := NewBridge()
		okEnvelope(t, b.Restore(raw, 0.0))
		if got := b.Snapshot(); got != raw {
			t.Fatalf("round trip changed the snapshot:\n%s\n%s", raw, got)
		}
		if got := decodeGeneric(t, b.Snapshot())["v"]; got != float64(3) {
			t.Fatalf("v = %v, want 3", got)
		}
	})

	t.Run("fixed games, every ply", func(t *testing.T) {
		trips, withTurnEnd := 0, 0
		for _, seed := range []uint64{6, 7, 8} {
			b := NewBridge()
			playRandom(t, b, seed, func(Envelope, string) {
				snap := b.Snapshot()
				r := NewBridge()
				okEnvelope(t, r.Restore(snap, 0.0))
				if r.Snapshot() != snap {
					t.Fatalf("seed %d: snapshot not stable across restore", seed)
				}
				trips++
				if st := b.game.state; st.TurnEnd[0] != nil && st.TurnEnd[1] != nil {
					withTurnEnd++
				}
			})
		}
		if withTurnEnd == 0 {
			t.Fatal("no snapshot with both TurnEnd entries was exercised")
		}
		t.Logf("%d snapshot round trips, %d with both TurnEnd entries, zero rejections", trips, withTurnEnd)
	})
}

// B3: a v2 save loads unchanged (no TurnEnd, no debt, so no counter at that
// turn start) and is saved again as v3.
func TestB3_V2SaveLoads(t *testing.T) {
	b := newGame42(t)
	okEnvelope(t, b.Apply(0.0)) // Alice draws: the opening TurnEnd is set
	v2 := asV2(t, b.Snapshot())
	if strings.Contains(v2, `"TurnEnd"`) || !strings.Contains(v2, `"v":2`) {
		t.Fatalf("precondition: %s", v2)
	}
	for _, viewer := range []float64{0, 1} {
		r := NewBridge()
		env := okEnvelope(t, r.Restore(v2, viewer))
		if env.State.Counterable || env.State.OwedDiscards != (OwedView{}) || env.Seq != 1 {
			t.Fatalf("v2 load: counterable %v owed %+v seq %d", env.State.Counterable, env.State.OwedDiscards, env.Seq)
		}
		snap := decodeGeneric(t, r.Snapshot())
		if snap["v"] != float64(3) {
			t.Fatalf("re-saved as v%v, want 3", snap["v"])
		}
		st := snap["state"].(map[string]any)
		if te := st["TurnEnd"].([]any); te[0] != nil || te[1] != nil {
			t.Fatalf("a v2 load holds no TurnEnd, got %v", te)
		}
		okEnvelope(t, r.Apply(0.0)) // the game plays on
	}
	// The session path agrees.
	s, err := RestoreSession([]byte(v2))
	if err != nil {
		t.Fatalf("RestoreSession(v2): %v", err)
	}
	r := NewBridge()
	okEnvelope(t, r.Restore(v2, 0.0))
	if persisted(t, s) != r.Snapshot() {
		t.Fatal("session and bridge disagree on a v2 load")
	}
	// The v1 fixture (bce9fb2) still loads through v2 to v3.
	v1, err := os.ReadFile("testdata/snapshot-v1-bce9fb2.json")
	if err != nil {
		t.Fatal(err)
	}
	okEnvelope(t, NewBridge().Restore(string(v1), 0.0))
}

// B3: a v2 save taken mid-way through a legacy counter window (phase 1) or
// an old-style in-turn discard (phase 3 with a Pending) loads and finishes
// through the engine's frozen legacy path.
func TestB3_LegacyV2SavesFinish(t *testing.T) {
	t.Run("phase 1 window, declined", func(t *testing.T) {
		st := engine.GameState{
			Players: [2]engine.PlayerState{
				{Hand: []card.Card{c(card.Ten, card.Hearts)}},
				{Hand: []card.Card{c(card.Two, card.Clubs), c(card.Six, card.Clubs)}},
			},
			Deck:    deckOf(4),
			Active:  engine.P2,
			Phase:   engine.PhaseAwaitingCounter,
			Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Five, card.Hearts)},
		}
		idx := 1
		five := c(card.Five, card.Hearts)
		v3 := mustJSON(t, snapshotWire{OK: true, V: snapshotVersion, State: st, History: []AppliedMove{{
			Index: &idx, By: engine.P1, Kind: engine.MoveOneOff, Card: &five, Description: "play 5♥ as one-off", Seq: 1,
		}}, Seed: "0", Dealer: 0})
		b := NewBridge()
		window := okEnvelope(t, b.Restore(asV2(t, v3), 1.0))
		if window.State.Phase != engine.PhaseAwaitingCounter {
			t.Fatalf("phase %d, want the legacy window", window.State.Phase)
		}
		want := []string{"decline to counter", "counter with 2♣"}
		if strings.Join(window.Descriptions, "|") != strings.Join(want, "|") {
			t.Fatalf("legacy window moves %q, want %q", window.Descriptions, want)
		}
		after := okEnvelope(t, b.Apply(0.0))
		if after.State.Phase != engine.PhaseNormal || after.State.Active != engine.P2 {
			t.Fatalf("after the decline: phase %d active %d, want Blake's turn", after.State.Phase, after.State.Active)
		}
		if got := drawnOf(t, after.History[1]); got != 2 {
			t.Fatalf("the closing decline drew %d, want 2", got)
		}
		okEnvelope(t, NewBridge().Restore(b.Snapshot(), 1.0))
	})

	t.Run("phase 3 in-turn discard", func(t *testing.T) {
		st := engine.GameState{
			Players: [2]engine.PlayerState{
				{Hand: []card.Card{c(card.Ten, card.Hearts)}},
				{Hand: []card.Card{c(card.Six, card.Clubs), c(card.Seven, card.Clubs), c(card.Nine, card.Clubs)}},
			},
			Deck:    deckOf(4),
			Active:  engine.P2,
			Phase:   engine.PhaseAwaitingDiscard,
			Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Hearts)},
		}
		b := NewBridge()
		env := okEnvelope(t, b.Restore(asV2(t, snapshotOf(t, st)), 1.0))
		after := okEnvelope(t, b.Apply(float64(indexOfDescription(t, env.Descriptions, "discard hand[0] and hand[1]"))))
		// The legacy discard ends the 4-player's turn: Blake moves next
		// (engine/apply.go:480-486), with no debt left over.
		if after.State.Phase != engine.PhaseNormal || after.State.Active != engine.P2 || after.State.OwedDiscards != (OwedView{}) {
			t.Fatalf("after the legacy discard: phase %d active %d owed %+v, want Blake's turn", after.State.Phase, after.State.Active, after.State.OwedDiscards)
		}
	})
}

// B3: malformed v3 state is BAD_REQUEST (INVALID_SNAPSHOT on the session
// path), never a panic, and the held game is unchanged. One fresh bridge
// per case.
func TestB3_MalformedTurnStateRejected(t *testing.T) {
	base := func() engine.GameState {
		return twinStart([]card.Card{c(card.Ten, card.Hearts)}, nil, c(card.Two, card.Clubs), engine.P1)
	}
	inner := base()
	nested := base()
	nested.TurnEnd[0] = &inner
	badCard := base()
	badCard.Deck = []card.Card{{Rank: 14, Suit: 0}}
	pendingInSnap := base()
	pendingInSnap.Pending = &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Clubs)}
	three := []card.Card{c(card.Two, card.Hearts), c(card.Ace, card.Hearts), c(card.Two, card.Spades)}

	cases := map[string]func(st *engine.GameState){
		"nested TurnEnd":          func(st *engine.GameState) { st.TurnEnd[1] = &nested },
		"negative Owed":           func(st *engine.GameState) { st.Owed = [2]int{0, -2} },
		"TurnEnd bad card":        func(st *engine.GameState) { st.TurnEnd[0] = &badCard },
		"TurnEnd pending phase 0": func(st *engine.GameState) { st.TurnEnd[1] = &pendingInSnap },
		"LastTurn three cards":    func(st *engine.GameState) { st.LastTurn.Countered = three },
		"ThisTurn three cards":    func(st *engine.GameState) { st.ThisTurn.Countered = three },
		"ThisTurn bad card":       func(st *engine.GameState) { st.ThisTurn.Countered = []card.Card{{Rank: 0, Suit: 2}} },
		"phase 6":                 func(st *engine.GameState) { st.Phase = 6 },
		"phase 5 with pending": func(st *engine.GameState) {
			st.Phase = engine.PhasePendingWin
			st.Pending = &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Clubs)}
		},
		"owed discard, no debt": func(st *engine.GameState) { st.Phase = engine.PhaseAwaitingDiscard },
	}
	raws := map[string]string{}
	for name, mutate := range cases {
		st := base()
		mutate(&st)
		raws[name] = snapshotOf(t, st)
	}
	good := snapshotOf(t, base())
	raws["TurnEnd unknown field"] = strings.Replace(
		snapshotOf(t, func() engine.GameState { st := base(); s := base(); st.TurnEnd[0] = &s; return st }()),
		`"TurnEnd":[{`, `"TurnEnd":[{"Bogus":1,`, 1)
	raws["TurnEnd wrong type"] = strings.Replace(good, `"TurnEnd":[null,null]`, `"TurnEnd":[null,"x"]`, 1)
	raws["TurnEnd three entries"] = strings.Replace(good, `"TurnEnd":[null,null]`, `"TurnEnd":[null,null,null]`, 1)
	raws["Owed one entry"] = strings.Replace(good, `"Owed":[0,0]`, `"Owed":[0,0,0]`, 1)
	raws["v2 with a v3 key"] = strings.Replace(good, `"v":3`, `"v":2`, 1)
	for name, raw := range raws {
		t.Run(name, func(t *testing.T) {
			if raw == good {
				t.Fatal("precondition: the case did not change the fixture")
			}
			b := newGame42(t)
			before := b.Snapshot()
			errCode(t, b.Restore(raw, 0.0), "BAD_REQUEST")
			if b.Snapshot() != before {
				t.Fatal("held state changed on BAD_REQUEST")
			}
			s, err := RestoreSession([]byte(raw))
			if s != nil {
				t.Fatal("RestoreSession returned a session for a bad snapshot")
			}
			wantErr(t, name, err, ErrInvalidSnapshot, CodeInvalidSnapshot)
		})
	}
	// The unmodified base restores, so each rejection is the mutation's.
	okEnvelope(t, NewBridge().Restore(good, 0.0))
}
