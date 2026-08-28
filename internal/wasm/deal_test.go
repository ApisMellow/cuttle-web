package main

import (
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

func TestDealNewGameGoldenSeed42(t *testing.T) {
	state := dealNewGame(42, engine.P2)

	wantP1 := []card.Card{
		{Rank: card.Two, Suit: card.Hearts},
		{Rank: card.Three, Suit: card.Clubs},
		{Rank: card.Ace, Suit: card.Hearts},
		{Rank: card.King, Suit: card.Diamonds},
		{Rank: card.Queen, Suit: card.Clubs},
	}
	wantP2 := []card.Card{
		{Rank: card.Five, Suit: card.Hearts},
		{Rank: card.Nine, Suit: card.Hearts},
		{Rank: card.Eight, Suit: card.Diamonds},
		{Rank: card.Four, Suit: card.Diamonds},
		{Rank: card.Five, Suit: card.Spades},
		{Rank: card.Four, Suit: card.Hearts},
	}
	wantTop := []card.Card{
		{Rank: card.Two, Suit: card.Clubs},
		{Rank: card.Nine, Suit: card.Spades},
		{Rank: card.Nine, Suit: card.Diamonds},
		{Rank: card.Jack, Suit: card.Hearts},
		{Rank: card.Seven, Suit: card.Clubs},
	}

	assertCards(t, "P1 hand", state.Players[engine.P1].Hand, wantP1)
	assertCards(t, "P2 hand", state.Players[engine.P2].Hand, wantP2)
	if len(state.Deck) != 41 {
		t.Fatalf("deck length = %d, want 41", len(state.Deck))
	}
	assertCards(t, "deck top", state.Deck[:5], wantTop)
	if state.Active != engine.P1 || state.Phase != engine.PhaseNormal {
		t.Fatalf("kickoff = active %d phase %d, want active 0 phase 0", state.Active, state.Phase)
	}
}

func TestCanonicalDeckIsSuitMajorRankMinor(t *testing.T) {
	deck := canonicalDeck()
	if len(deck) != 52 {
		t.Fatalf("deck length = %d, want 52", len(deck))
	}
	for i, got := range deck {
		want := card.Card{Rank: card.Rank(i%13 + 1), Suit: card.Suit(i / 13)}
		if got != want {
			t.Fatalf("deck[%d] = %+v, want %+v", i, got, want)
		}
	}
}

func assertCards(t *testing.T, label string, got, want []card.Card) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d", label, len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[%d] = %v, want %v", label, i, got[i], want[i])
		}
	}
}
