package main

import (
	"math/rand/v2"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// dealStream is the fixed second PCG word. It must never vary: fixture
// reproducibility (SPEC §7.3) depends on the exact stream.
const dealStream = 0x9E3779B97F4A7C15

// canonicalDeck builds the 52-card deck in canonical order: suit-major
// (Clubs..Spades), rank-minor (Ace..King). Matches cmd/cuttle/main.go.
func canonicalDeck() []card.Card {
	deck := make([]card.Card, 0, 52)
	for s := card.Clubs; s <= card.Spades; s++ {
		for r := card.Ace; r <= card.King; r++ {
			deck = append(deck, card.Card{Rank: r, Suit: s})
		}
	}
	return deck
}

// dealNewGame deals a fresh game: seeded Fisher-Yates shuffle via PCG,
// non-dealer gets 5 cards and goes first, dealer gets 6 (R1).
func dealNewGame(seed uint64, dealer engine.PlayerID) engine.GameState {
	deck := canonicalDeck()
	rng := rand.New(rand.NewPCG(seed, dealStream))
	rng.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })

	nonDealer := dealer.Other()
	var st engine.GameState
	st.Players[nonDealer].Hand = append([]card.Card(nil), deck[0:5]...)
	st.Players[dealer].Hand = append([]card.Card(nil), deck[5:11]...)
	st.Deck = append([]card.Card(nil), deck[11:]...)
	st.Active = nonDealer
	st.Phase = engine.PhaseNormal
	return st
}
