package main

// SPEC §2.7 (amended 2026-09-27) — AppliedMove.targetCard: the card a move
// targeted, read from the PRE-state. R20.2 needs this so the §4.6 recap can
// name a Jack-steal's stolen card and a targeted one-off's target, neither
// of which Move.Describe embeds.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

func cardPtrEqual(a, b *card.Card) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// indexOfDescription finds the unique legal move whose description matches
// exactly, failing the test if it's missing or ambiguous — every fixture
// below is built so exactly one move matches.
func indexOfDescription(t *testing.T, descriptions []string, want string) int {
	t.Helper()
	idx := -1
	for i, d := range descriptions {
		if d == want {
			if idx >= 0 {
				t.Fatalf("description %q is ambiguous: matched both index %d and %d in %q", want, idx, i, descriptions)
			}
			idx = i
		}
	}
	if idx < 0 {
		t.Fatalf("description %q not offered: %q", want, descriptions)
	}
	return idx
}

// ---------------------------------------------------------------------------
// R20.2 / §2.7 — targetCard per MoveKind, both viewers identical (public).
// ---------------------------------------------------------------------------

func TestSPEC2_7_TargetCardPerMoveKind(t *testing.T) {
	tests := []struct {
		name        string
		state       engine.GameState
		description string
		want        *card.Card
	}{
		{
			name: "Scuttle names the scuttled point card",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Nine, card.Clubs)}},
					{Points: []engine.PointEntry{{Card: c(card.Five, card.Hearts), Owner: engine.P2}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "scuttle opponent's 5♥ with 9♣",
			want:        &card.Card{Rank: card.Five, Suit: card.Hearts},
		},
		{
			// Mutation-kill (M3): a Jack-stacked point still names the POINT
			// CARD when the move is a Scuttle, never the Jack sitting on it —
			// jackStackTop is a rank-2-specific special case, not "any target
			// with a JackStack present" (engine/apply.go:258-265: Scuttle
			// always scraps target.Card, plus target.JackStack, wholesale).
			name: "Scuttle of a Jack-stacked point still names the point card, not the Jack",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Nine, card.Spades)}},
					{Points: []engine.PointEntry{{
						Card: c(card.Five, card.Hearts), Owner: engine.P1,
						JackStack: []card.Card{c(card.Jack, card.Clubs)}, JackOwners: []engine.PlayerID{engine.P2},
					}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "scuttle opponent's 5♥ with 9♠",
			want:        &card.Card{Rank: card.Five, Suit: card.Hearts},
		},
		{
			name: "Jack steal (PlayPermanent) names the stolen point card, not just the Jack",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Jack, card.Clubs)}},
					{Points: []engine.PointEntry{{Card: c(card.Ten, card.Hearts), Owner: engine.P2}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play J♣ (steal opponent point)",
			want:        &card.Card{Rank: card.Ten, Suit: card.Hearts},
		},
		{
			// Mutation-kill (M3): re-stealing an ALREADY Jack-stacked point
			// still names the POINT CARD, never the Jack already on it —
			// engine/apply.go:219-224 reads `pe := vp.Points[Index]` (the
			// entry as it stands, existing JackStack included) and appends
			// the NEW Jack; the stolen identity is always pe.Card.
			name: "Jack steal of an already-stolen (Jack-stacked) point names the point card, not the existing Jack",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Jack, card.Spades)}},
					{Points: []engine.PointEntry{{
						Card: c(card.Ten, card.Hearts), Owner: engine.P1,
						JackStack: []card.Card{c(card.Jack, card.Diamonds)}, JackOwners: []engine.PlayerID{engine.P2},
					}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play J♠ (steal opponent point)",
			want:        &card.Card{Rank: card.Ten, Suit: card.Hearts},
		},
		{
			name: "OneOff rank 2 on a permanent names the permanent",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Two, card.Spades)}},
					{Hand: []card.Card{c(card.Five, card.Clubs)}, Permanents: []card.Card{c(card.King, card.Diamonds)}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 2♠ as one-off",
			want:        &card.Card{Rank: card.King, Suit: card.Diamonds},
		},
		{
			// Landmine (engine/apply.go:696-708): a rank-2 on a Jack-topped
			// point stack scraps the TOP JACK, not the point card underneath
			// — the point stays on the board. targetCard must name the Jack.
			name: "OneOff rank 2 on a Jack-topped point stack names the Jack, not the point card",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{
						Hand: []card.Card{c(card.Two, card.Spades)},
						Points: []engine.PointEntry{{
							Card: c(card.Ten, card.Hearts), Owner: engine.P2,
							JackStack: []card.Card{c(card.Jack, card.Clubs)}, JackOwners: []engine.PlayerID{engine.P1},
						}},
					},
					{Hand: []card.Card{c(card.Five, card.Clubs)}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 2♠ as one-off",
			want:        &card.Card{Rank: card.Jack, Suit: card.Clubs},
		},
		{
			// Mutation-kill (M2): with TWO Jacks on the stack, the target
			// must be the TOP one (JackStack[len-1] = J♣, played most
			// recently, current controller), never the bottom (JackStack[0]
			// = J♦). Bottom-up ordering per engine/state.go's PointEntry doc.
			name: "OneOff rank 2 on a TWO-Jack stack names the TOP Jack, not the bottom",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Two, card.Spades)}},
					{Points: []engine.PointEntry{{
						Card: c(card.Ten, card.Hearts), Owner: engine.P1,
						JackStack:  []card.Card{c(card.Jack, card.Diamonds), c(card.Jack, card.Clubs)},
						JackOwners: []engine.PlayerID{engine.P1, engine.P2},
					}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 2♠ as one-off",
			want:        &card.Card{Rank: card.Jack, Suit: card.Clubs},
		},
		{
			// Optional coverage: a rank-2 may target the mover's OWN
			// permanent (engine/apply.go:47-56 loops both players).
			name: "OneOff rank 2 aimed at the mover's own permanent",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Two, card.Diamonds)}, Permanents: []card.Card{c(card.King, card.Hearts)}},
					{},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 2♦ as one-off",
			want:        &card.Card{Rank: card.King, Suit: card.Hearts},
		},
		{
			name: "OneOff rank 9 on a point names the point card (returned to hand)",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Nine, card.Clubs)}},
					{Hand: []card.Card{c(card.Five, card.Clubs)}, Points: []engine.PointEntry{{Card: c(card.Ten, card.Hearts), Owner: engine.P2}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 9♣ as one-off",
			want:        &card.Card{Rank: card.Ten, Suit: card.Hearts},
		},
		{
			// Mutation-kill (M3): a rank-9 on a Jack-stacked point still
			// names the POINT CARD, never the Jack — engine/apply.go:741-752
			// scraps the whole JackStack and returns pe.Card regardless.
			name: "OneOff rank 9 on a Jack-stacked point names the point card, not the Jack",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Nine, card.Clubs)}},
					{Points: []engine.PointEntry{{
						Card: c(card.Ten, card.Diamonds), Owner: engine.P1,
						JackStack: []card.Card{c(card.Jack, card.Hearts)}, JackOwners: []engine.PlayerID{engine.P2},
					}}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 9♣ as one-off",
			want:        &card.Card{Rank: card.Ten, Suit: card.Diamonds},
		},
		{
			name: "OneOff rank 9 on a permanent names the permanent (bounced to hand)",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Nine, card.Clubs)}},
					{Hand: []card.Card{c(card.Five, card.Clubs)}, Permanents: []card.Card{c(card.King, card.Diamonds)}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play 9♣ as one-off",
			want:        &card.Card{Rank: card.King, Suit: card.Diamonds},
		},
		{
			name: "OneOff rank Ace (untargeted) is nil",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Ace, card.Hearts)}},
					{Hand: []card.Card{c(card.Five, card.Clubs)}},
				},
				Active: engine.P1, Phase: engine.PhaseNormal,
			},
			description: "play A♥ as one-off",
			want:        nil,
		},
		{
			name: "Draw is nil",
			state: engine.GameState{
				Players: [2]engine.PlayerState{{Hand: []card.Card{c(card.King, card.Hearts)}}, {}},
				Deck:    []card.Card{c(card.Five, card.Clubs)},
				Active:  engine.P1, Phase: engine.PhaseNormal,
			},
			description: "draw a card",
			want:        nil,
		},
		{
			name: "Pass is nil",
			state: engine.GameState{
				Players: [2]engine.PlayerState{{}, {}},
				Active:  engine.P1, Phase: engine.PhaseNormal,
			},
			description: "pass",
			want:        nil,
		},
		{
			name: "SevenPick wrapping PlayPoint (no target) is nil",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: []card.Card{c(card.Ten, card.Hearts)}},
			},
			description: "7: play 10♥ as point card",
			want:        nil,
		},
		{
			name: "SevenPick wrapping Scuttle names the scuttled card",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}, Points: []engine.PointEntry{{Card: c(card.Seven, card.Hearts), Owner: engine.P2}}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Diamonds), Revealed: []card.Card{c(card.Nine, card.Clubs)}},
			},
			description: "7: scuttle opponent's 7♥ with 9♣",
			want:        &card.Card{Rank: card.Seven, Suit: card.Hearts},
		},
		{
			name: "SevenPick wrapping a Jack steal names the stolen point card",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}, Points: []engine.PointEntry{{Card: c(card.Ten, card.Hearts), Owner: engine.P2}}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Diamonds), Revealed: []card.Card{c(card.Jack, card.Clubs)}},
			},
			description: "7: play J♣ (steal opponent point)",
			want:        &card.Card{Rank: card.Ten, Suit: card.Hearts},
		},
		{
			name: "SevenPick wrapping a targeted OneOff (9) names the target",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}, Points: []engine.PointEntry{{Card: c(card.Ten, card.Diamonds), Owner: engine.P2}}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Diamonds), Revealed: []card.Card{c(card.Nine, card.Clubs)}},
			},
			description: "7: play 9♣ as one-off",
			want:        &card.Card{Rank: card.Ten, Suit: card.Diamonds},
		},
		{
			// Mutation-kill (M2/M3) through the SevenPick recursion: the
			// same "top Jack, only for rank 2" rule must hold for a
			// SubMove, not just a top-level OneOff.
			name: "SevenPick wrapping a rank-2 on a TWO-Jack stack names the TOP Jack",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{},
					{Points: []engine.PointEntry{{
						Card: c(card.Ten, card.Hearts), Owner: engine.P1,
						JackStack:  []card.Card{c(card.Jack, card.Diamonds), c(card.Jack, card.Clubs)},
						JackOwners: []engine.PlayerID{engine.P1, engine.P2},
					}}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Diamonds), Revealed: []card.Card{c(card.Two, card.Spades)}},
			},
			description: "7: play 2♠ as one-off",
			want:        &card.Card{Rank: card.Jack, Suit: card.Clubs},
		},
		{
			// Dead end (engine/apply.go:419-437): no revealed card has any
			// legal play; the player scraps one. No SubMove, so no target.
			name: "SevenPick dead-end (no legal play) is nil",
			state: engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{c(card.Three, card.Clubs)}},
					{Hand: []card.Card{c(card.Six, card.Hearts)}},
				},
				Active:  engine.P1, Phase: engine.PhaseSevenChoosing,
				Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: []card.Card{c(card.Jack, card.Diamonds), c(card.Jack, card.Spades)}},
			},
			description: "7: no legal play — scrap J♦",
			want:        nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := newBridge()
			env := okEnvelope(t, b.Restore(snapshotOf(t, tc.state), 0.0))
			idx := indexOfDescription(t, env.Descriptions, tc.description)
			after := okEnvelope(t, b.Apply(float64(idx)))
			if after.LastMove == nil {
				t.Fatalf("no lastMove after applying %q", tc.description)
			}
			if !cardPtrEqual(after.LastMove.TargetCard, tc.want) {
				t.Fatalf("mover's targetCard = %v, want %v", after.LastMove.TargetCard, tc.want)
			}
			// Public field: the non-mover sees the identical value, only
			// Index is ever redacted (§3.2).
			other := okEnvelope(t, b.View(1.0))
			otherLast := other.History[len(other.History)-1]
			if !cardPtrEqual(otherLast.TargetCard, tc.want) {
				t.Fatalf("non-mover's targetCard = %v, want %v", otherLast.TargetCard, tc.want)
			}
			// The key is always present on the wire, even when the value is
			// null (§2.7's "always emit the key").
			wire := b.View(0.0)
			if tc.want == nil {
				if !strings.Contains(wire, `"targetCard":null`) {
					t.Fatalf("targetCard key must be present as null: %s", wire)
				}
			} else if !strings.Contains(wire, fmt.Sprintf(`"targetCard":%s`, cardJSON(*tc.want))) {
				t.Fatalf("targetCard %s not found verbatim in wire: %s", cardJSON(*tc.want), wire)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// R20.2 / §2.7 — board-only property: targetCard never names a card that
// wasn't on the board (points/permanents of either player) in the
// pre-state, and never a card from a hand or the deck.
// ---------------------------------------------------------------------------

// boardCards is every card visible on the board in st: both players'
// permanents, every point card, and every Jack layered on a point stack
// (a rank-2 target can name any of these three).
func boardCards(st engine.GameState) map[card.Card]bool {
	out := map[card.Card]bool{}
	for _, p := range st.Players {
		for _, cd := range p.Permanents {
			out[cd] = true
		}
		for _, pe := range p.Points {
			out[pe.Card] = true
			for _, j := range pe.JackStack {
				out[j] = true
			}
		}
	}
	return out
}

func inDeck(st engine.GameState, cd card.Card) bool {
	for _, x := range st.Deck {
		if x == cd {
			return true
		}
	}
	return false
}

func inAnyHand(st engine.GameState, cd card.Card) bool {
	for _, p := range st.Players {
		for _, x := range p.Hand {
			if x == cd {
				return true
			}
		}
	}
	return false
}

func TestSPEC2_7_TargetCardNamesOnlyBoardCards(t *testing.T) {
	checked := 0
	for seed := uint64(200); seed < 260; seed++ {
		b := newBridge()
		var pre engine.GameState
		havePre := false
		playRandom(t, b, seed, func(Envelope, string) {
			if havePre && len(b.game.history) > 0 {
				last := b.game.history[len(b.game.history)-1]
				if last.TargetCard != nil {
					tc := *last.TargetCard
					checked++
					if !boardCards(pre)[tc] {
						t.Fatalf("seed %d seq %d (%s): targetCard %s not on the pre-state board",
							seed, last.Seq, last.Description, tc)
					}
					if inDeck(pre, tc) {
						t.Fatalf("seed %d seq %d (%s): targetCard %s was in the deck",
							seed, last.Seq, last.Description, tc)
					}
					if inAnyHand(pre, tc) {
						t.Fatalf("seed %d seq %d (%s): targetCard %s was in a hand",
							seed, last.Seq, last.Description, tc)
					}
				}
			}
			pre = b.game.state
			havePre = true
		})
	}
	if checked == 0 {
		t.Fatal("no targeted move occurred across the corpus — the property was never exercised")
	}
	t.Logf("checked %d targeted moves across seeds 200..259", checked)
}

// ---------------------------------------------------------------------------
// Restore validation — targetCard is checked, not just accepted blind.
// ---------------------------------------------------------------------------

func TestSPEC2_9_RestoreTargetCard(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Nine, card.Clubs)}},
			{Points: []engine.PointEntry{{Card: c(card.Five, card.Hearts), Owner: engine.P2}}},
		},
		Active: engine.P1, Phase: engine.PhaseNormal,
	}
	base := snapshotOf(t, st)

	withHistory := func(entryJSON string) string {
		return strings.Replace(base, `"history":[]`, `"history":[`+entryJSON+`]`, 1)
	}

	// Accepted: explicit null (an untargeted move).
	nullEntry := `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":null,"drawn":null,"description":"draw a card","seq":1}`
	okEnvelope(t, newBridge().Restore(withHistory(nullEntry), 0.0))

	// Accepted: a real, valid card.
	cardEntry := `{"index":0,"by":0,"kind":3,"subKind":null,"card":{"Rank":9,"Suit":0},"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"scuttle opponent's 5♥ with 9♣","seq":1}`
	restored := okEnvelope(t, newBridge().Restore(withHistory(cardEntry), 0.0))
	if restored.History[0].TargetCard == nil || *restored.History[0].TargetCard != (card.Card{Rank: card.Five, Suit: card.Hearts}) {
		t.Fatalf("restored targetCard = %v, want 5♥", restored.History[0].TargetCard)
	}

	// Rejected, held state unchanged: the key is missing entirely.
	b := newGame42(t)
	before := b.Snapshot()
	missingKey := `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"description":"draw a card","seq":1}`
	errCode(t, b.Restore(withHistory(missingKey), 0.0), "BAD_REQUEST")
	if b.Snapshot() != before {
		t.Fatal("held state changed when targetCard key was missing")
	}

	// Rejected, held state unchanged: wrong type.
	wrongType := `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":"9C","drawn":null,"description":"draw a card","seq":1}`
	errCode(t, b.Restore(withHistory(wrongType), 0.0), "BAD_REQUEST")
	if b.Snapshot() != before {
		t.Fatal("held state changed when targetCard had the wrong type")
	}

	// Rejected, held state unchanged: present but not a real card.
	badCard := `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":{"Rank":0,"Suit":0},"drawn":null,"description":"draw a card","seq":1}`
	errCode(t, b.Restore(withHistory(badCard), 0.0), "BAD_REQUEST")
	if b.Snapshot() != before {
		t.Fatal("held state changed when targetCard was not a real card")
	}
}

// S3 (review, round 2 cycle 1): a cheap kind/targetCard consistency check —
// shape only, not a pre-state board replay. targetCard must be non-null for
// Scuttle and a Jack steal, null for every other kind except OneOff/
// SevenPick (which may legitimately go either way).
func TestSPEC2_9_RestoreTargetCardKindConsistency(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Nine, card.Clubs)}},
			{Points: []engine.PointEntry{{Card: c(card.Five, card.Hearts), Owner: engine.P2}}},
		},
		Active: engine.P1, Phase: engine.PhaseNormal,
	}
	base := snapshotOf(t, st)
	withHistory := func(entryJSON string) string {
		return strings.Replace(base, `"history":[]`, `"history":[`+entryJSON+`]`, 1)
	}

	b := newGame42(t)
	before := b.Snapshot()

	cases := map[string]string{
		"Scuttle with null targetCard": `{"index":0,"by":0,"kind":3,"subKind":null,"card":{"Rank":9,"Suit":0},"targetCard":null,"drawn":null,"description":"scuttle opponent's 5♥ with 9♣","seq":1}`,
		"Jack steal with null targetCard": `{"index":0,"by":0,"kind":2,"subKind":null,"card":{"Rank":11,"Suit":0},"targetCard":null,"drawn":null,"description":"play J♣ (steal opponent point)","seq":1}`,
		"non-Jack PlayPermanent with a non-null targetCard": `{"index":0,"by":0,"kind":2,"subKind":null,"card":{"Rank":12,"Suit":0},"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"play Q♣ as permanent","seq":1}`,
		"Draw with a non-null targetCard": `{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"draw a card","seq":1}`,
		"Pass with a non-null targetCard": `{"index":0,"by":0,"kind":9,"subKind":null,"card":null,"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"pass","seq":1}`,
	}
	for name, entry := range cases {
		errCode(t, b.Restore(withHistory(entry), 0.0), "BAD_REQUEST")
		if b.Snapshot() != before {
			t.Fatalf("%s: held state changed on error", name)
		}
	}

	// Accepted: OneOff and SevenPick may go either way.
	oneOffNull := `{"index":0,"by":0,"kind":4,"subKind":null,"card":{"Rank":1,"Suit":2},"targetCard":null,"drawn":null,"description":"play A♥ as one-off","seq":1}`
	okEnvelope(t, newBridge().Restore(withHistory(oneOffNull), 0.0))
	oneOffTargeted := `{"index":0,"by":0,"kind":4,"subKind":null,"card":{"Rank":9,"Suit":0},"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"play 9♣ as one-off","seq":1}`
	okEnvelope(t, newBridge().Restore(withHistory(oneOffTargeted), 0.0))
	sevenPickNull := `{"index":0,"by":0,"kind":7,"subKind":1,"card":{"Rank":10,"Suit":2},"targetCard":null,"drawn":null,"description":"7: play 10♥ as point card","seq":1}`
	okEnvelope(t, newBridge().Restore(withHistory(sevenPickNull), 0.0))
	sevenPickTargeted := `{"index":0,"by":0,"kind":7,"subKind":3,"card":{"Rank":9,"Suit":0},"targetCard":{"Rank":5,"Suit":2},"drawn":null,"description":"7: scuttle opponent's 5♥ with 9♣","seq":1}`
	okEnvelope(t, newBridge().Restore(withHistory(sevenPickTargeted), 0.0))
}

// Sanity check on the wire-level JSON shape directly (bypassing the bridge),
// proving UnmarshalJSON's presence check in isolation.
func TestSPEC2_7_AppliedMoveUnmarshalRequiresTargetCardKey(t *testing.T) {
	var m AppliedMove
	missing := `{"by":0,"kind":0,"subKind":null,"card":null,"description":"draw a card","seq":1}`
	if err := json.Unmarshal([]byte(missing), &m); err == nil {
		t.Fatal("expected an error when targetCard is missing entirely")
	}
	present := `{"by":0,"kind":0,"subKind":null,"card":null,"targetCard":null,"drawn":null,"description":"draw a card","seq":1}`
	if err := json.Unmarshal([]byte(present), &m); err != nil {
		t.Fatalf("explicit null targetCard must be accepted: %v", err)
	}
	if m.TargetCard != nil {
		t.Fatalf("targetCard = %v, want nil", m.TargetCard)
	}
}
