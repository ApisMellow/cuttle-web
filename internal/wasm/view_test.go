package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

func TestViewForRedactsHandsDeckAndSevenReveal(t *testing.T) {
	state := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{{Rank: card.Ace, Suit: card.Clubs}}},
			{Hand: []card.Card{{Rank: card.Five, Suit: card.Diamonds}}},
		},
		Deck:   []card.Card{{Rank: card.King, Suit: card.Spades}},
		Active: engine.P1,
		Phase:  engine.PhaseSevenChoosing,
		Pending: &engine.PendingOneOff{
			PlayedBy: engine.P1,
			Card:     card.Card{Rank: card.Seven, Suit: card.Hearts},
			Revealed: []card.Card{{Rank: card.Jack, Suit: card.Clubs}},
		},
	}

	p1 := viewFor(state, engine.P1)
	p2 := viewFor(state, engine.P2)
	if p1.Opponent.Hand != nil || p2.Opponent.Hand != nil {
		t.Fatal("opponent hand must be null without glasses")
	}
	if p1.SevenRevealed == nil || p2.SevenRevealed != nil {
		t.Fatal("seven reveal must be visible only to the active viewer")
	}

	encoded, err := json.Marshal(p1)
	if err != nil {
		t.Fatal(err)
	}
	wire := string(encoded)
	for _, forbidden := range []string{`"Deck"`, `"deck"`, `"Rank":13,"Suit":3`} {
		if strings.Contains(wire, forbidden) {
			t.Fatalf("redacted view contains forbidden deck data %q: %s", forbidden, wire)
		}
	}
	if strings.Contains(wire, "ScrapIndex") || strings.Contains(wire, "scrapIndex") {
		t.Fatalf("redacted pending view leaked ScrapIndex: %s", wire)
	}
}

func TestViewForGlassesAndNormalization(t *testing.T) {
	state := engine.GameState{
		Players: [2]engine.PlayerState{
			{
				Hand:       []card.Card{},
				Permanents: []card.Card{{Rank: card.Eight, Suit: card.Hearts}},
				FrozenIDs:  map[int]bool{3: true, 1: true, 2: false},
				Points: []engine.PointEntry{{
					Card:       card.Card{Rank: card.Ten, Suit: card.Hearts},
					Owner:      engine.P1,
					JackStack:  []card.Card{{Rank: card.Jack, Suit: card.Clubs}},
					JackOwners: []engine.PlayerID{engine.P2, engine.P1},
				}},
			},
			{Hand: []card.Card{}},
		},
		Active: engine.P1,
	}

	view := viewFor(state, engine.P1)
	if view.Opponent.Hand == nil || len(*view.Opponent.Hand) != 0 {
		t.Fatal("glasses must preserve visible-empty [] rather than null")
	}
	wantFrozen := []int{1, 3}
	for i := range wantFrozen {
		if view.You.FrozenHandIndices[i] != wantFrozen[i] {
			t.Fatalf("frozen indices = %v, want %v", view.You.FrozenHandIndices, wantFrozen)
		}
	}
	owners := view.You.Points[0].JackOwners
	if len(owners) != 2 || owners[0] != engine.P2 || owners[1] != engine.P1 {
		t.Fatalf("JackOwners = %v, want [1 0]", owners)
	}
}
