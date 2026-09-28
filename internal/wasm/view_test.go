package main

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// ---------------------------------------------------------------------------
// Helpers shared by the view/envelope/bridge tests.
// ---------------------------------------------------------------------------

func c(r card.Rank, s card.Suit) card.Card { return card.Card{Rank: r, Suit: s} }

// cardJSON is the exact wire form of one card. Grepping serialized output
// for it is the §7.1 "blunt instrument" leak check.
func cardJSON(cd card.Card) string {
	b, err := json.Marshal(cd)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// decodeGeneric decodes a wire string into untyped JSON so tests can assert
// on keys and null-vs-[] exactly as the TypeScript side will see them.
func decodeGeneric(t *testing.T, wire string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(wire), &out); err != nil {
		t.Fatalf("invalid JSON %q: %v", wire, err)
	}
	return out
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func assertKeys(t *testing.T, label string, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := keysOf(m); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s keys = %v, want %v", label, got, want)
	}
}

// arrayKeys are every array-typed wire field (SPEC §2.7). None may be null
// (§2.8b), with the single exception of state.opponent.hand (§3.2).
var arrayKeys = map[string]bool{
	"hand": true, "frozenHandIndices": true, "points": true, "permanents": true,
	"scrap": true, "JackStack": true, "JackOwners": true, "counterChain": true,
	"legalMoves": true, "descriptions": true, "history": true,
}

// assertNoNullArrays walks decoded JSON and fails on any null array field,
// other than opponent.hand.
func assertNoNullArrays(t *testing.T, node any, path string) {
	t.Helper()
	switch v := node.(type) {
	case map[string]any:
		for k, child := range v {
			p := path + "." + k
			if child == nil && arrayKeys[k] && !strings.HasSuffix(p, ".opponent.hand") {
				t.Fatalf("array field %s is null; SPEC §2.8(b) requires []", p)
			}
			assertNoNullArrays(t, child, p)
		}
	case []any:
		for _, child := range v {
			assertNoNullArrays(t, child, path+"[]")
		}
	}
}

// statesByPhase returns one representative state per Phase value (0..4),
// each with a distinct deck and hidden hands, so redaction can be
// asserted "in every phase" (R7.1, R7.3).
func statesByPhase() map[engine.Phase]engine.GameState {
	base := func() engine.GameState {
		return engine.GameState{
			Players: [2]engine.PlayerState{
				{Hand: []card.Card{c(card.Ace, card.Clubs), c(card.Two, card.Diamonds)}},
				{Hand: []card.Card{c(card.Five, card.Diamonds), c(card.Six, card.Spades)}},
			},
			Deck:   []card.Card{c(card.King, card.Spades), c(card.Queen, card.Hearts), c(card.Ten, card.Clubs)},
			Scrap:  []card.Card{c(card.Three, card.Hearts)},
			Active: engine.P1,
		}
	}
	out := map[engine.Phase]engine.GameState{}

	normal := base()
	normal.Phase = engine.PhaseNormal
	out[engine.PhaseNormal] = normal

	counter := base()
	counter.Phase = engine.PhaseAwaitingCounter
	counter.Active = engine.P2
	counter.Pending = &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Three, card.Clubs), ScrapIndex: 0}
	out[engine.PhaseAwaitingCounter] = counter

	seven := base()
	seven.Phase = engine.PhaseSevenChoosing
	seven.Pending = &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts),
		Revealed: []card.Card{c(card.Jack, card.Clubs), c(card.Nine, card.Diamonds)}}
	out[engine.PhaseSevenChoosing] = seven

	discard := base()
	discard.Phase = engine.PhaseAwaitingDiscard
	discard.Active = engine.P2
	discard.Pending = &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Clubs)}
	out[engine.PhaseAwaitingDiscard] = discard

	over := base()
	over.Phase = engine.PhaseGameOver
	w := engine.P1
	over.Winner = &w
	out[engine.PhaseGameOver] = over
	return out
}

// ---------------------------------------------------------------------------
// Pre-existing tests (renamed; assertions unchanged).
// ---------------------------------------------------------------------------

func TestSPEC3_2_ViewRedactsHandsDeckSevenAndScrapIndex(t *testing.T) {
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

func TestSPEC2_8_GlassesAndNormalization(t *testing.T) {
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
	if len(view.You.FrozenHandIndices) != len(wantFrozen) {
		t.Fatalf("frozen indices = %v, want %v", view.You.FrozenHandIndices, wantFrozen)
	}
	for i := range wantFrozen {
		if view.You.FrozenHandIndices[i] != wantFrozen[i] {
			t.Fatalf("frozen indices = %v, want %v", view.You.FrozenHandIndices, wantFrozen)
		}
	}
	owners := view.You.Points[0].JackOwners
	if len(owners) != 2 || owners[0] != int(engine.P2) || owners[1] != int(engine.P1) {
		t.Fatalf("JackOwners = %v, want [1 0]", owners)
	}
}

// ---------------------------------------------------------------------------
// §2.8 normalization contracts.
// ---------------------------------------------------------------------------

func TestSPEC2_8_JackOwnersArray(t *testing.T) {
	state := engine.GameState{Players: [2]engine.PlayerState{{
		Points: []engine.PointEntry{{
			Card:       c(card.Ten, card.Hearts),
			Owner:      engine.P1,
			JackStack:  []card.Card{c(card.Jack, card.Clubs), c(card.Jack, card.Hearts)},
			JackOwners: []engine.PlayerID{engine.P2, engine.P1},
		}},
	}}}
	wire := mustJSON(t, viewFor(state, engine.P1))
	if strings.Contains(wire, `"AQA="`) {
		t.Fatalf("JackOwners crossed the wire as base64: %s", wire)
	}
	if !strings.Contains(wire, `"JackOwners":[1,0]`) {
		t.Fatalf("JackOwners must be the array [1,0]: %s", wire)
	}
	if !strings.Contains(wire, `"Controller":0`) {
		t.Fatalf("Controller must be derived from the top Jack's owner (P1=0): %s", wire)
	}
}

func TestSPEC2_7_PointEntryWireKeys(t *testing.T) {
	state := engine.GameState{Players: [2]engine.PlayerState{{
		Points: []engine.PointEntry{{Card: c(card.Four, card.Spades), Owner: engine.P1}},
	}}}
	view := decodeGeneric(t, mustJSON(t, viewFor(state, engine.P1)))
	entry := view["you"].(map[string]any)["points"].([]any)[0].(map[string]any)
	assertKeys(t, "PointEntry", entry, "Card", "Owner", "JackStack", "JackOwners", "Controller")
	if got := mustJSON(t, entry["JackStack"]); got != "[]" {
		t.Fatalf("empty JackStack = %s, want []", got)
	}
	if got := mustJSON(t, entry["JackOwners"]); got != "[]" {
		t.Fatalf("empty JackOwners = %s, want []", got)
	}
}

func TestSPEC2_7_PlayerViewWireKeys(t *testing.T) {
	state := statesByPhase()[engine.PhaseAwaitingCounter]
	view := decodeGeneric(t, mustJSON(t, viewFor(state, engine.P2)))
	assertKeys(t, "PlayerView", view, "viewer", "active", "phase", "passesInARow", "winner",
		"stalemate", "you", "opponent", "deckCount", "scrap", "scoreboard", "sevenRevealed", "pending")
	assertKeys(t, "you", view["you"].(map[string]any), "hand", "frozenHandIndices", "points", "permanents")
	assertKeys(t, "opponent", view["opponent"].(map[string]any), "handCount", "hand", "points", "permanents")
	assertKeys(t, "scoreboard", view["scoreboard"].(map[string]any), "you", "opponent")
	assertKeys(t, "scoreboard.you", view["scoreboard"].(map[string]any)["you"].(map[string]any),
		"points", "threshold", "kings", "hasWon")
	assertKeys(t, "pending", view["pending"].(map[string]any), "playedBy", "card", "target", "counterChain")
}

func TestSPEC2_8_NilSlicesAreEmptyArrays(t *testing.T) {
	// Zero-value state: every slice nil, FrozenIDs nil.
	var zero engine.GameState
	for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
		wire := mustJSON(t, viewFor(zero, viewer))
		view := decodeGeneric(t, wire)
		assertNoNullArrays(t, view, "state")
		if view["opponent"].(map[string]any)["hand"] != nil {
			t.Fatalf("opponent.hand must stay null (hidden), got %s", wire)
		}
	}
	// Pending and seven reveal with nil inner slices.
	seven := engine.GameState{Phase: engine.PhaseSevenChoosing,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Clubs)}}
	view := decodeGeneric(t, mustJSON(t, viewFor(seven, engine.P1)))
	assertNoNullArrays(t, view, "state")
	if got := mustJSON(t, view["sevenRevealed"]); got != "[]" {
		t.Fatalf("actor's sevenRevealed with nil Revealed = %s, want []", got)
	}
	if got := mustJSON(t, view["pending"].(map[string]any)["counterChain"]); got != "[]" {
		t.Fatalf("pending.counterChain = %s, want []", got)
	}
}

func TestSPEC2_8_FrozenIDsSortedDropFalse(t *testing.T) {
	cases := []struct {
		frozen map[int]bool
		want   string
	}{
		{nil, "[]"},
		{map[int]bool{}, "[]"},
		{map[int]bool{0: false}, "[]"},
		{map[int]bool{5: true, 0: true, 2: false, 3: true}, "[0,3,5]"},
	}
	for _, tc := range cases {
		state := engine.GameState{Players: [2]engine.PlayerState{{FrozenIDs: tc.frozen}}}
		view := decodeGeneric(t, mustJSON(t, viewFor(state, engine.P1)))
		got := mustJSON(t, view["you"].(map[string]any)["frozenHandIndices"])
		if got != tc.want {
			t.Fatalf("FrozenIDs %v -> %s, want %s", tc.frozen, got, tc.want)
		}
	}
}

func TestSPEC2_8_WinnerBareNumber(t *testing.T) {
	w := engine.P2
	won := engine.GameState{Phase: engine.PhaseGameOver, Winner: &w}
	if wire := mustJSON(t, viewFor(won, engine.P1)); !strings.Contains(wire, `"winner":1,`) {
		t.Fatalf("winner must be a bare number: %s", wire)
	}
	open := engine.GameState{}
	if wire := mustJSON(t, viewFor(open, engine.P1)); !strings.Contains(wire, `"winner":null,`) {
		t.Fatalf("absent winner must be null: %s", wire)
	}
}

func TestSPEC3_2_PendingOmitsScrapIndex(t *testing.T) {
	state := engine.GameState{
		Players: [2]engine.PlayerState{{}, {}},
		Scrap:   []card.Card{c(card.Two, card.Clubs), c(card.Nine, card.Hearts), c(card.Ace, card.Spades)},
		Active:  engine.P2,
		Phase:   engine.PhaseAwaitingCounter,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Three, card.Clubs), ScrapIndex: 2},
	}
	for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
		wire := mustJSON(t, viewFor(state, viewer))
		if strings.Contains(strings.ToLower(wire), "scrapindex") {
			t.Fatalf("viewer %d: pending ScrapIndex leaked: %s", viewer, wire)
		}
		pending := decodeGeneric(t, wire)["pending"].(map[string]any)
		if pending["card"] == nil || pending["playedBy"].(float64) != 0 {
			t.Fatalf("viewer %d: pending one-off must be public: %s", viewer, wire)
		}
	}
}

// ---------------------------------------------------------------------------
// R7 — redaction.
// ---------------------------------------------------------------------------

func TestR7_1a_OpponentHandNullWithoutGlassesEveryPhase(t *testing.T) {
	for phase, state := range statesByPhase() {
		// Variant: the viewer's OPPONENT holds glasses — must not help the viewer.
		for _, oppHasGlasses := range []bool{false, true} {
			for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
				st := state
				st.Players = state.Players
				if oppHasGlasses {
					opp := st.Players[viewer.Other()]
					opp.Permanents = []card.Card{c(card.Eight, card.Clubs)}
					st.Players[viewer.Other()] = opp
				}
				view := viewFor(st, viewer)
				if view.Opponent.Hand != nil {
					t.Fatalf("phase %d viewer %d oppGlasses=%v: opponent.hand must be null", phase, viewer, oppHasGlasses)
				}
				if view.Opponent.HandCount != len(st.Players[viewer.Other()].Hand) {
					t.Fatalf("phase %d viewer %d: handCount = %d", phase, viewer, view.Opponent.HandCount)
				}
				wire := mustJSON(t, view)
				if !strings.Contains(wire, `"hand":null`) {
					t.Fatalf("phase %d viewer %d: opponent.hand must serialize as null: %s", phase, viewer, wire)
				}
				for _, hidden := range st.Players[viewer.Other()].Hand {
					if strings.Contains(wire, cardJSON(hidden)) {
						t.Fatalf("phase %d viewer %d: leaked opponent card %v: %s", phase, viewer, hidden, wire)
					}
				}
			}
		}
	}
}

func TestSPEC3_2_GlassesOwnerSeesOpponentHandOnly(t *testing.T) {
	state := statesByPhase()[engine.PhaseNormal]
	p1 := state.Players[engine.P1]
	p1.Permanents = []card.Card{c(card.Eight, card.Spades)}
	state.Players[engine.P1] = p1

	owner := viewFor(state, engine.P1)
	if owner.Opponent.Hand == nil || !reflect.DeepEqual(*owner.Opponent.Hand, state.Players[engine.P2].Hand) {
		t.Fatalf("glasses owner must see opponent hand, got %v", owner.Opponent.Hand)
	}
	other := viewFor(state, engine.P2)
	if other.Opponent.Hand != nil {
		t.Fatal("the glasses owner's opponent must not see the owner's hand")
	}
}

func TestR7_3a_DeckNeverTransmittedEveryPhase(t *testing.T) {
	for phase, state := range statesByPhase() {
		for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
			wire := mustJSON(t, viewFor(state, viewer))
			lower := strings.ToLower(wire)
			if strings.Contains(lower, `"deck"`) {
				t.Fatalf("phase %d viewer %d: deck field present: %s", phase, viewer, wire)
			}
			for _, hidden := range state.Deck {
				if strings.Contains(wire, cardJSON(hidden)) {
					t.Fatalf("phase %d viewer %d: deck card %v leaked: %s", phase, viewer, hidden, wire)
				}
			}
			if got := decodeGeneric(t, wire)["deckCount"].(float64); int(got) != len(state.Deck) {
				t.Fatalf("phase %d: deckCount = %v, want %d", phase, got, len(state.Deck))
			}
		}
	}
}

func TestR7_4a_OpponentHandNullVersusEmptyOnWire(t *testing.T) {
	hidden := engine.GameState{Players: [2]engine.PlayerState{{}, {Hand: nil}}}
	if wire := mustJSON(t, viewFor(hidden, engine.P1)); !strings.Contains(wire, `"handCount":0,"hand":null`) {
		t.Fatalf("hidden empty opponent hand must be null: %s", wire)
	}
	visible := engine.GameState{Players: [2]engine.PlayerState{
		{Permanents: []card.Card{c(card.Eight, card.Diamonds)}},
		{Hand: nil},
	}}
	if wire := mustJSON(t, viewFor(visible, engine.P1)); !strings.Contains(wire, `"handCount":0,"hand":[]`) {
		t.Fatalf("visible empty opponent hand must be []: %s", wire)
	}
}

// ---------------------------------------------------------------------------
// R16 — seven-reveal privacy.
// ---------------------------------------------------------------------------

func TestR16_1a_SevenRevealedOnlyToActorWhileChoosing(t *testing.T) {
	state := statesByPhase()[engine.PhaseSevenChoosing]
	revealed := state.Pending.Revealed

	actor := viewFor(state, state.Active)
	if actor.SevenRevealed == nil || !reflect.DeepEqual(actor.SevenRevealed, revealed) {
		t.Fatalf("actor sevenRevealed = %v, want %v", actor.SevenRevealed, revealed)
	}
	opp := viewFor(state, state.Active.Other())
	if opp.SevenRevealed != nil {
		t.Fatalf("opponent sevenRevealed = %v, want null", opp.SevenRevealed)
	}
	wire := mustJSON(t, opp)
	if !strings.Contains(wire, `"sevenRevealed":null`) {
		t.Fatalf("opponent sevenRevealed must serialize null: %s", wire)
	}
	for _, r := range revealed {
		if strings.Contains(wire, cardJSON(r)) {
			t.Fatalf("opponent view leaked revealed card %v: %s", r, wire)
		}
	}

	// Outside PhaseSevenChoosing, a stray Revealed is never shown to anyone.
	for phase, st := range statesByPhase() {
		if phase == engine.PhaseSevenChoosing {
			continue
		}
		st.Pending = &engine.PendingOneOff{PlayedBy: st.Active, Card: c(card.Seven, card.Spades), Revealed: revealed}
		for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
			if v := viewFor(st, viewer); v.SevenRevealed != nil {
				t.Fatalf("phase %d viewer %d: sevenRevealed must be null", phase, viewer)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// R2 — Go derivation half.
// ---------------------------------------------------------------------------

func TestR2_1a_ScoreboardFromEngineHelpers(t *testing.T) {
	kingsOf := func(n int) []card.Card {
		var out []card.Card
		for i := 0; i < n; i++ {
			out = append(out, c(card.King, card.Suit(i%4)))
		}
		return out
	}
	pointsOf := func(ranks ...card.Rank) []engine.PointEntry {
		var out []engine.PointEntry
		for _, r := range ranks {
			out = append(out, engine.PointEntry{Card: c(r, card.Hearts), Owner: engine.P1})
		}
		return out
	}
	for kings := 0; kings <= 4; kings++ {
		for _, pts := range [][]card.Rank{nil, {card.Five}, {card.Ten, card.Four}, {card.Ten, card.Ten, card.Two}} {
			state := engine.GameState{Players: [2]engine.PlayerState{
				{Permanents: kingsOf(kings), Points: pointsOf(pts...)},
				{Permanents: kingsOf(4 - kings), Points: pointsOf(card.Three)},
			}}
			for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
				view := viewFor(state, viewer)
				check := func(label string, got SideScore, p engine.PlayerState) {
					want := SideScore{
						Points:    engine.PointTotal(p),
						Threshold: engine.Threshold(engine.KingCount(p)),
						Kings:     engine.KingCount(p),
						HasWon:    engine.HasWon(p),
					}
					if got != want {
						t.Fatalf("kings=%d pts=%v viewer=%d %s = %+v, want %+v", kings, pts, viewer, label, got, want)
					}
				}
				check("you", view.Scoreboard.You, state.Players[viewer])
				check("opponent", view.Scoreboard.Opponent, state.Players[viewer.Other()])
			}
		}
	}
}

func TestR2_2a_StalemateDerivedFromPhaseAndWinner(t *testing.T) {
	w := engine.P1
	for phase := engine.PhaseNormal; phase <= engine.PhaseGameOver; phase++ {
		for _, winner := range []*engine.PlayerID{nil, &w} {
			state := engine.GameState{Phase: phase, Winner: winner}
			want := phase == engine.PhaseGameOver && winner == nil
			if got := viewFor(state, engine.P1).Stalemate; got != want {
				t.Fatalf("phase %d winner %v: stalemate = %v, want %v", phase, winner, got, want)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// R8 — bridge half: frozen marker straight from engine FrozenIDs.
// ---------------------------------------------------------------------------

// OQ-13: a 9 played on the acting player's own Jack-stolen point returns
// the card to the actor's hand frozen, and the freeze clears before the
// actor's next turn. The bridge reports exactly what the engine holds, at
// each step, with no compensating logic.
func TestR8_2a_FrozenIndicesVerbatimIncludingSelfFreeze(t *testing.T) {
	state := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Nine, card.Clubs), c(card.Ace, card.Diamonds)}},
			{
				Hand: []card.Card{c(card.Three, card.Diamonds)},
				Points: []engine.PointEntry{{
					Card: c(card.Ten, card.Hearts), Owner: engine.P1,
					JackStack: []card.Card{c(card.Jack, card.Spades)}, JackOwners: []engine.PlayerID{engine.P2},
				}},
			},
		},
		Deck:   []card.Card{c(card.Four, card.Spades), c(card.Five, card.Clubs)},
		Active: engine.P1,
		Phase:  engine.PhaseNormal,
	}
	var nine *engine.Move
	for _, m := range engine.LegalMoves(state) {
		if m.Kind == engine.MoveOneOff && m.Card.Rank == card.Nine && m.Target != nil &&
			m.Target.Owner == engine.P2 && m.Target.Zone == engine.ZonePoints {
			mv := m
			nine = &mv
		}
	}
	if nine == nil {
		t.Fatal("engine did not offer the 9 on the stolen point")
	}
	after, err := engine.Apply(state, *nine)
	if err != nil {
		t.Fatal(err)
	}
	actorView := viewFor(after, engine.P1)
	want := frozenIndices(after.Players[engine.P1].FrozenIDs)
	if !reflect.DeepEqual(actorView.You.FrozenHandIndices, want) || len(want) != 1 {
		t.Fatalf("self-freeze: frozenHandIndices = %v, engine FrozenIDs = %v", actorView.You.FrozenHandIndices, after.Players[engine.P1].FrozenIDs)
	}
	if actorView.You.Hand[want[0]] != c(card.Ten, card.Hearts) {
		t.Fatalf("frozen index %d does not point at the returned 10♥: %v", want[0], actorView.You.Hand)
	}

	// Opponent takes a turn; the engine clears the freeze when P1 becomes active.
	var draw *engine.Move
	for _, m := range engine.LegalMoves(after) {
		if m.Kind == engine.MoveDraw {
			mv := m
			draw = &mv
		}
	}
	if draw == nil {
		t.Fatal("opponent has no draw")
	}
	cleared, err := engine.Apply(after, *draw)
	if err != nil {
		t.Fatal(err)
	}
	if got := viewFor(cleared, engine.P1).You.FrozenHandIndices; len(got) != 0 {
		t.Fatalf("after the opponent's turn frozenHandIndices = %v, want [] (engine cleared it)", got)
	}
}
