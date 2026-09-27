package main

import (
	"sort"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// The PlayerView wire types (SPEC §2.7, §3). The raw engine.GameState never
// crosses the WASM boundary; everything a viewer may see is derived here.

// PointEntryView keeps the engine's PascalCase field names (SPEC §2.7
// PointEntry). JackOwners is re-typed to []int: []engine.PlayerID is []byte
// to encoding/json and would cross the wire as base64 (§2.8a).
type PointEntryView struct {
	Card       card.Card       `json:"Card"`
	Owner      engine.PlayerID `json:"Owner"`
	JackStack  []card.Card     `json:"JackStack"`
	JackOwners []int           `json:"JackOwners"`
	Controller engine.PlayerID `json:"Controller"`
}

type SideScore struct {
	Points    int  `json:"points"`
	Threshold int  `json:"threshold"`
	Kings     int  `json:"kings"`
	HasWon    bool `json:"hasWon"`
}

type ScoreboardView struct {
	You      SideScore `json:"you"`
	Opponent SideScore `json:"opponent"`
}

type YouView struct {
	Hand              []card.Card      `json:"hand"`
	FrozenHandIndices []int            `json:"frozenHandIndices"`
	Points            []PointEntryView `json:"points"`
	Permanents        []card.Card      `json:"permanents"`
}

type OpponentView struct {
	HandCount  int              `json:"handCount"`
	Hand       *[]card.Card     `json:"hand"`
	Points     []PointEntryView `json:"points"`
	Permanents []card.Card      `json:"permanents"`
}

type PendingView struct {
	PlayedBy     engine.PlayerID `json:"playedBy"`
	Card         card.Card       `json:"card"`
	Target       *engine.Target  `json:"target"`
	CounterChain []card.Card     `json:"counterChain"`
}

type PlayerView struct {
	Viewer        engine.PlayerID  `json:"viewer"`
	Active        engine.PlayerID  `json:"active"`
	Phase         engine.Phase     `json:"phase"`
	PassesInARow  int              `json:"passesInARow"`
	Winner        *engine.PlayerID `json:"winner"`
	Stalemate     bool             `json:"stalemate"`
	You           YouView          `json:"you"`
	Opponent      OpponentView     `json:"opponent"`
	DeckCount     int              `json:"deckCount"`
	Scrap         []card.Card      `json:"scrap"`
	Scoreboard    ScoreboardView   `json:"scoreboard"`
	SevenRevealed []card.Card      `json:"sevenRevealed"`
	Pending       *PendingView     `json:"pending"`
}

// viewerHasGlasses reports whether the viewer has a glasses-8 among their
// permanents (R7). Permanents holds only Queens, Kings, and glasses-8s, so
// any 8 found there is glasses.
func viewerHasGlasses(p engine.PlayerState) bool {
	for _, c := range p.Permanents {
		if c.Rank == card.Eight {
			return true
		}
	}
	return false
}

func pointEntryViews(entries []engine.PointEntry) []PointEntryView {
	views := make([]PointEntryView, 0, len(entries))
	for _, pe := range entries {
		views = append(views, PointEntryView{
			Card:       pe.Card,
			Owner:      pe.Owner,
			JackStack:  nonNil(pe.JackStack),
			JackOwners: jackOwners(pe.JackOwners),
			Controller: pe.Controller(),
		})
	}
	return views
}

// jackOwners converts []PlayerID to a real numeric array, never nil (§2.8a/b).
func jackOwners(owners []engine.PlayerID) []int {
	out := make([]int, 0, len(owners))
	for _, o := range owners {
		out = append(out, int(o))
	}
	return out
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func sideScore(p engine.PlayerState) SideScore {
	kings := engine.KingCount(p)
	return SideScore{
		Points:    engine.PointTotal(p),
		Threshold: engine.Threshold(kings),
		Kings:     kings,
		HasWon:    engine.HasWon(p),
	}
}

// viewFor derives the redacted view of state for one named viewer (SPEC §3).
func viewFor(state engine.GameState, viewer engine.PlayerID) PlayerView {
	opp := viewer.Other()
	you := state.Players[viewer]
	opponent := state.Players[opp]

	view := PlayerView{
		Viewer:        viewer,
		Active:        state.Active,
		Phase:         state.Phase,
		PassesInARow:  state.PassesInARow,
		Winner:        state.Winner,
		Stalemate:     state.Phase == engine.PhaseGameOver && state.Winner == nil,
		DeckCount:     len(state.Deck),
		Scrap:         nonNil(state.Scrap),
		SevenRevealed: nil,
	}

	// Own hand is always visible to the viewer; opponent's only under glasses.
	view.You = YouView{
		Hand:              nonNil(you.Hand),
		FrozenHandIndices: frozenIndices(you.FrozenIDs),
		Points:            pointEntryViews(you.Points),
		Permanents:        nonNil(you.Permanents),
	}
	view.Opponent = OpponentView{
		HandCount:  len(opponent.Hand),
		Hand:       nil,
		Points:     pointEntryViews(opponent.Points),
		Permanents: nonNil(opponent.Permanents),
	}
	if viewerHasGlasses(you) {
		hand := nonNil(opponent.Hand)
		view.Opponent.Hand = &hand
	}
	view.Scoreboard = ScoreboardView{You: sideScore(you), Opponent: sideScore(opponent)}

	// Seven reveal: only to the acting viewer, only while choosing (R16).
	if state.Phase == engine.PhaseSevenChoosing && state.Pending != nil && viewer == state.Active {
		view.SevenRevealed = nonNil(state.Pending.Revealed)
	}

	// Pending one-off is public the moment it is played (R14), minus
	// ScrapIndex, which would leak the acting player's intent (§3.2).
	if state.Pending != nil {
		view.Pending = &PendingView{
			PlayedBy:     state.Pending.PlayedBy,
			Card:         state.Pending.Card,
			Target:       state.Pending.Target,
			CounterChain: nonNil(state.Pending.CounterChain),
		}
	}

	return view
}

// frozenIndices normalizes FrozenIDs to a sorted index slice, dropping
// explicit false entries (SPEC §2.8c).
func frozenIndices(frozen map[int]bool) []int {
	indices := make([]int, 0, len(frozen))
	for idx, isFrozen := range frozen {
		if isFrozen {
			indices = append(indices, idx)
		}
	}
	sort.Ints(indices)
	return indices
}
