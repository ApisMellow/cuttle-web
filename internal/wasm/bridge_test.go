package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

func okEnvelope(t *testing.T, wire string) Envelope {
	t.Helper()
	generic := decodeGeneric(t, wire)
	if generic["ok"] != true {
		t.Fatalf("expected ok envelope, got %s", wire)
	}
	assertKeys(t, "Envelope", generic, "ok", "state", "legalMoves", "descriptions", "lastMove", "history", "seq")
	assertNoNullArrays(t, generic, "envelope")
	var env Envelope
	if err := json.Unmarshal([]byte(wire), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.LegalMoves) != len(env.Descriptions) {
		t.Fatalf("legalMoves/descriptions length mismatch: %s", wire)
	}
	if env.Seq != len(env.History) {
		t.Fatalf("seq %d != history length %d", env.Seq, len(env.History))
	}
	return env
}

func errCode(t *testing.T, wire, code string) map[string]any {
	t.Helper()
	m := decodeGeneric(t, wire)
	if m["ok"] != false || m["code"] != code {
		t.Fatalf("expected %s error, got %s", code, wire)
	}
	if msg, _ := m["message"].(string); msg == "" {
		t.Fatalf("error must carry a message: %s", wire)
	}
	return m
}

func snapshotOf(t *testing.T, st engine.GameState) string {
	t.Helper()
	return mustJSON(t, snapshotWire{OK: true, V: snapshotVersion, State: st, History: []AppliedMove{}, Seed: "0", Dealer: 0})
}

func newGame42(t *testing.T) *Bridge {
	t.Helper()
	b := newBridge()
	okEnvelope(t, b.NewGame(`{"seed":"42","dealer":1}`))
	return b
}

func xorshift32(seed uint32) func() uint32 {
	state := seed
	if state == 0 {
		state = 0x9e3779b9
	}
	return func() uint32 {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		return state
	}
}

// playRandom drives one seeded game through the bridge to a terminal state,
// calling visit on every envelope (including the first).
func playRandom(t *testing.T, b *Bridge, seed uint64, visit func(env Envelope, wire string)) Envelope {
	t.Helper()
	wire := b.NewGame(mustJSON(t, map[string]any{"seed": itoa(seed), "dealer": seed & 1}))
	env := okEnvelope(t, wire)
	rng := xorshift32(uint32(seed))
	for step := 0; step < 3000; step++ {
		visit(env, wire)
		if env.State.Phase == engine.PhaseGameOver {
			return env
		}
		if len(env.LegalMoves) == 0 {
			t.Fatalf("seed %d step %d: no legal moves in phase %d", seed, step, env.State.Phase)
		}
		idx := int(rng() % uint32(len(env.LegalMoves)))
		wire = b.Apply(float64(idx))
		next := okEnvelope(t, wire)
		if next.Seq != env.Seq+1 {
			t.Fatalf("seed %d step %d: seq %d -> %d", seed, step, env.Seq, next.Seq)
		}
		env = next
	}
	t.Fatalf("seed %d did not terminate", seed)
	return env
}

func itoa(n uint64) string { return strings.TrimSpace(mustJSONNoT(n)) }

func mustJSONNoT(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// R1.1 — golden deal through the bridge surface (smoke is the binding layer).
// ---------------------------------------------------------------------------

func TestR1_1c_GoldenDealThroughBridge(t *testing.T) {
	b := newBridge()
	env := okEnvelope(t, b.NewGame(`{"seed":"42","dealer":1,"names":["Alice","Bob"]}`))
	want := []string{
		"draw a card",
		"play 2♥ as point card",
		"play 3♣ as point card",
		"play A♥ as one-off",
		"play A♥ as point card",
		"play K♦ as permanent",
		"play Q♣ as permanent",
	}
	if !reflect.DeepEqual(env.Descriptions, want) {
		t.Fatalf("descriptions = %q, want %q", env.Descriptions, want)
	}
	if env.State.Active != engine.P1 || env.State.Phase != engine.PhaseNormal || env.State.DeckCount != 41 {
		t.Fatalf("kickoff state = %+v", env.State)
	}
	if env.State.Viewer != engine.P1 || env.Seq != 0 || env.LastMove != nil || len(env.History) != 0 {
		t.Fatalf("fresh game metadata wrong: viewer %d seq %d lastMove %v", env.State.Viewer, env.Seq, env.LastMove)
	}
	assertCards(t, "you.hand", env.State.You.Hand, []card.Card{
		c(card.Two, card.Hearts), c(card.Three, card.Clubs), c(card.Ace, card.Hearts),
		c(card.King, card.Diamonds), c(card.Queen, card.Clubs),
	})
	if env.State.Opponent.HandCount != 6 || env.State.Opponent.Hand != nil {
		t.Fatalf("opponent = %+v", env.State.Opponent)
	}
}

// ---------------------------------------------------------------------------
// §2.4 function surface and §2.7 envelope.
// ---------------------------------------------------------------------------

func TestSPEC2_4_ReadCallsDoNotMutate(t *testing.T) {
	b := newGame42(t)
	before := b.Snapshot()
	first := b.LegalMoves()
	okEnvelope(t, first)
	if got := b.Describe(); got != first {
		t.Fatalf("describe differs from legalMoves:\n%s\n%s", got, first)
	}
	okEnvelope(t, b.View(0.0))
	okEnvelope(t, b.View(1.0))
	if b.Snapshot() != before || b.LegalMoves() != first {
		t.Fatal("read-only calls mutated held state")
	}
}

func TestSPEC2_7_EnvelopeInvariantsAcrossRandomGames(t *testing.T) {
	wins, stalemates := 0, 0
	for seed := uint64(1); seed <= 60; seed++ {
		b := newBridge()
		var prevHistory []AppliedMove
		final := playRandom(t, b, seed, func(env Envelope, _ string) {
			if env.State.Viewer != env.State.Active {
				t.Fatalf("seed %d: mutating/read calls must return the actor's view", seed)
			}
			if env.State.Phase != engine.PhaseGameOver && len(env.LegalMoves) == 0 {
				t.Fatalf("seed %d: empty legalMoves outside game over", seed)
			}
			if env.State.Phase == engine.PhaseGameOver && len(env.LegalMoves) != 0 {
				t.Fatalf("seed %d: legalMoves at game over", seed)
			}
			// descriptions are Move.Describe against the held state.
			held := b.game.state
			for i, m := range engine.LegalMoves(held) {
				if env.Descriptions[i] != m.Describe(held) {
					t.Fatalf("seed %d: descriptions[%d] = %q, want %q", seed, i, env.Descriptions[i], m.Describe(held))
				}
			}
			for i, h := range env.History {
				if h.Seq != i+1 {
					t.Fatalf("seed %d: history[%d].seq = %d", seed, i, h.Seq)
				}
			}
			if len(env.History) > 0 {
				if env.LastMove == nil || !reflect.DeepEqual(*env.LastMove, env.History[len(env.History)-1]) {
					t.Fatalf("seed %d: lastMove != last history entry", seed)
				}
				// History is append-only: earlier entries are frozen.
				if !reflect.DeepEqual(env.History[:len(prevHistory)], prevHistory) {
					t.Fatalf("seed %d: history rewritten", seed)
				}
			} else if env.LastMove != nil {
				t.Fatalf("seed %d: lastMove without history", seed)
			}
			prevHistory = env.History
		})
		if final.State.Winner == nil {
			stalemates++
		} else {
			wins++
		}
	}
	if wins == 0 {
		t.Fatal("no wins across the corpus")
	}
	t.Logf("wins=%d stalemates=%d", wins, stalemates)
}

func TestSPEC2_7_AppliedMoveRecordsPreState(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Nine, card.Clubs)}},
			{Points: []engine.PointEntry{{Card: c(card.Five, card.Hearts), Owner: engine.P2}}},
		},
		Deck:   []card.Card{c(card.Ace, card.Spades)},
		Active: engine.P1,
		Phase:  engine.PhaseNormal,
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st)))
	idx := -1
	for i, d := range env.Descriptions {
		if d == "scuttle opponent's 5♥ with 9♣" {
			idx = i
		}
	}
	if idx < 0 {
		t.Fatalf("scuttle not offered: %q", env.Descriptions)
	}
	after := okEnvelope(t, b.Apply(float64(idx)))
	want := AppliedMove{Index: idx, By: engine.P1, Kind: engine.MoveScuttle,
		Card: &card.Card{Rank: card.Nine, Suit: card.Clubs}, Description: "scuttle opponent's 5♥ with 9♣", Seq: 1}
	if after.LastMove == nil || !reflect.DeepEqual(*after.LastMove, want) {
		t.Fatalf("lastMove = %+v, want %+v", after.LastMove, want)
	}
	// The post-state viewer is the new actor.
	if after.State.Viewer != engine.P2 || after.State.Active != engine.P2 {
		t.Fatalf("post-apply envelope must be the new actor's view: %+v", after.State)
	}
}

func TestSPEC2_7_ViewLegalMovesOnlyForActor(t *testing.T) {
	b := newGame42(t)
	actor := okEnvelope(t, b.View(0.0))
	if len(actor.LegalMoves) != 7 || actor.State.Viewer != engine.P1 {
		t.Fatalf("actor view: %d moves, viewer %d", len(actor.LegalMoves), actor.State.Viewer)
	}
	other := okEnvelope(t, b.View(1.0))
	if len(other.LegalMoves) != 0 || len(other.Descriptions) != 0 || other.State.Viewer != engine.P2 {
		t.Fatalf("non-actor view must carry no legal moves: %+v", other)
	}
	if other.State.Opponent.HandCount != 5 || other.State.Opponent.Hand != nil || len(other.State.You.Hand) != 6 {
		t.Fatalf("P2's view wrong: %+v", other.State)
	}
}

func TestSPEC2_4_SnapshotRestoreRoundTrip(t *testing.T) {
	b := newGame42(t)
	rng := xorshift32(7)
	for i := 0; i < 12; i++ {
		env := okEnvelope(t, b.LegalMoves())
		if env.State.Phase == engine.PhaseGameOver {
			break
		}
		okEnvelope(t, b.Apply(float64(int(rng()%uint32(len(env.LegalMoves))))))
	}
	snap := b.Snapshot()
	m := decodeGeneric(t, snap)
	if m["ok"] != true || m["v"].(float64) != 1 || m["seed"] != "42" || m["dealer"].(float64) != 1 {
		t.Fatalf("snapshot metadata = %v", keysOf(m))
	}
	// Full, unredacted (§3.4): both hands and the deck are present.
	stateJSON := mustJSON(t, m["state"])
	for _, key := range []string{`"Deck"`, `"Players"`, `"Hand"`} {
		if !strings.Contains(stateJSON, key) {
			t.Fatalf("snapshot state lacks %s", key)
		}
	}

	restored := newBridge()
	got := okEnvelope(t, restored.Restore(snap))
	want := okEnvelope(t, b.LegalMoves())
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restored envelope differs:\n%+v\n%+v", got, want)
	}
	if restored.Snapshot() != snap {
		t.Fatal("snapshot not stable across restore")
	}
	for _, viewer := range []float64{0, 1} {
		if restored.View(viewer) != b.View(viewer) {
			t.Fatalf("view(%v) differs after restore", viewer)
		}
	}
}

func TestSPEC2_6_SeedIsDecimalStringUint64(t *testing.T) {
	b := newBridge()
	okEnvelope(t, b.NewGame(`{"seed":"18446744073709551615","dealer":0}`))
	if got := decodeGeneric(t, b.Snapshot())["seed"]; got != "18446744073709551615" {
		t.Fatalf("seed = %v", got)
	}
	errCode(t, b.NewGame(`{"seed":"18446744073709551616"}`), "BAD_REQUEST")
	errCode(t, b.NewGame(`{"seed":42}`), "BAD_REQUEST")
}

func TestSPEC2_6_OmittedSeedAndDealerAreRandom(t *testing.T) {
	values := []uint64{123456789, 3}
	b := newBridge()
	b.random = func() (uint64, error) {
		v := values[0]
		values = values[1:]
		return v, nil
	}
	env := okEnvelope(t, b.NewGame(`{}`))
	snap := decodeGeneric(t, b.Snapshot())
	if snap["seed"] != "123456789" || snap["dealer"].(float64) != 1 {
		t.Fatalf("random seed/dealer not used: seed %v dealer %v", snap["seed"], snap["dealer"])
	}
	// Dealer 1 => P1 (non-dealer) is active with 5 cards.
	if env.State.Active != engine.P1 || len(env.State.You.Hand) != 5 {
		t.Fatalf("random dealer deal wrong: %+v", env.State)
	}
	// The same seed/dealer given explicitly reproduces the same game.
	again := newBridge()
	okEnvelope(t, again.NewGame(`{"seed":"123456789","dealer":1}`))
	if again.LegalMoves() != b.LegalMoves() {
		t.Fatal("explicit seed did not reproduce the random-seed game")
	}

	failing := newBridge()
	failing.random = func() (uint64, error) { return 0, errors.New("no entropy") }
	errCode(t, failing.NewGame(`{}`), "INTERNAL")
}

// ---------------------------------------------------------------------------
// §2.9 error codes. On every ok:false the held state is unchanged.
// ---------------------------------------------------------------------------

func TestSPEC2_9_NoGame(t *testing.T) {
	b := newBridge()
	errCode(t, b.LegalMoves(), "NO_GAME")
	errCode(t, b.Describe(), "NO_GAME")
	errCode(t, b.Apply(0.0), "NO_GAME")
	errCode(t, b.View(0.0), "NO_GAME")
	errCode(t, b.Snapshot(), "NO_GAME")
}

func TestSPEC2_9_BadRequest(t *testing.T) {
	b := newGame42(t)
	before := b.Snapshot()
	for name, wire := range map[string]string{
		"newGame non-string":     b.NewGame(42.0),
		"newGame undefined":      b.NewGame(nil),
		"newGame malformed":      b.NewGame(`{"seed":`),
		"newGame not object":     b.NewGame(`[1]`),
		"newGame trailing":       b.NewGame(`{"seed":"1"} {}`),
		"newGame seed alpha":     b.NewGame(`{"seed":"abc"}`),
		"newGame seed negative":  b.NewGame(`{"seed":"-1"}`),
		"newGame seed empty":     b.NewGame(`{"seed":""}`),
		"newGame dealer 2":       b.NewGame(`{"seed":"1","dealer":2}`),
		"newGame dealer string":  b.NewGame(`{"seed":"1","dealer":"1"}`),
		"newGame unknown field":  b.NewGame(`{"seed":"1","deck":[]}`),
		"newGame names 3":        b.NewGame(`{"names":["a","b","c"]}`),
		"apply string":           b.Apply("0"),
		"apply fraction":         b.Apply(1.5),
		"apply undefined":        b.Apply(nil),
		"apply object":           b.Apply(unsupportedArg{Kind: "object"}),
		"view 2":                 b.View(2.0),
		"view string":            b.View("0"),
		"view fraction":          b.View(0.5),
		"restore non-string":     b.Restore(1.0),
		"restore malformed":      b.Restore(`{`),
		"restore wrong version":  b.Restore(`{"v":2,"state":{},"history":[],"seed":"1","dealer":0}`),
		"restore missing state":  b.Restore(`{"v":1,"history":[],"seed":"1","dealer":0}`),
		"restore bad active":     b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"Active":0`, `"Active":5`, 1)),
		"restore bad phase":      b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"Phase":0`, `"Phase":9`, 1)),
		"restore rank 0 in hand": b.Restore(snapshotOf(t, engine.GameState{Players: [2]engine.PlayerState{{Hand: []card.Card{{}}}}})),
		"restore bad history":    b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"card":null,"description":"draw a card","seq":2}]`, 1)),
	} {
		errCode(t, wire, "BAD_REQUEST")
		if b.Snapshot() != before {
			t.Fatalf("%s: held state changed on error", name)
		}
	}
}

func TestSPEC2_9_IndexOutOfRange(t *testing.T) {
	b := newGame42(t)
	before := b.Snapshot()
	for _, idx := range []float64{-1, 7, 1e18} {
		m := errCode(t, b.Apply(idx), "INDEX_OUT_OF_RANGE")
		if m["detail"].(map[string]any)["count"].(float64) != 7 {
			t.Fatalf("detail = %v", m["detail"])
		}
		if b.Snapshot() != before {
			t.Fatal("held state changed on INDEX_OUT_OF_RANGE")
		}
	}
}

// E-1 (SPEC §2.10) as a restored position: the engine offers moves that its
// own Apply rejects. The bridge reports ILLEGAL_MOVE and does not work around it.
func TestSPEC2_9_IllegalMove(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Three, card.Clubs), c(card.Four, card.Clubs)}, FrozenIDs: map[int]bool{2: true}},
			{Hand: []card.Card{c(card.Six, card.Hearts)}},
		},
		Deck:    []card.Card{c(card.King, card.Hearts)},
		Active:  engine.P1,
		Phase:   engine.PhaseSevenChoosing,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: []card.Card{c(card.Five, card.Hearts)}},
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st)))
	want := []string{"7: play 5♥ as one-off", "7: play 5♥ as point card"}
	if !reflect.DeepEqual(env.Descriptions, want) {
		t.Fatalf("descriptions = %q, want %q", env.Descriptions, want)
	}
	before := b.Snapshot()
	for i := range want {
		m := errCode(t, b.Apply(float64(i)), "ILLEGAL_MOVE")
		detail := m["detail"].(map[string]any)
		if detail["description"] != want[i] || detail["index"].(float64) != float64(i) {
			t.Fatalf("detail = %v", detail)
		}
		if b.Snapshot() != before {
			t.Fatal("held state changed on ILLEGAL_MOVE")
		}
	}
}

// A non-game-over position where the engine offers nothing. Mutating calls
// that land here return the truthful envelope (legalMoves []); the
// move-list calls and apply raise NO_LEGAL_MOVES (SPEC §2.9, §2.10).
func TestSPEC2_9_NoLegalMoves(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Ace, card.Clubs)}},
			{Hand: nil},
		},
		Active:  engine.P2,
		Phase:   engine.PhaseAwaitingDiscard,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Clubs)},
	}
	if len(engine.LegalMoves(st)) != 0 {
		t.Fatal("precondition: engine must offer no moves here")
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st)))
	if len(env.LegalMoves) != 0 || env.State.Phase != engine.PhaseAwaitingDiscard {
		t.Fatalf("restore envelope = %+v", env)
	}
	before := b.Snapshot()
	errCode(t, b.LegalMoves(), "NO_LEGAL_MOVES")
	errCode(t, b.Describe(), "NO_LEGAL_MOVES")
	errCode(t, b.Apply(0.0), "NO_LEGAL_MOVES")
	okEnvelope(t, b.View(1.0)) // the stuck screen can still read history via view
	if b.Snapshot() != before {
		t.Fatal("held state changed on NO_LEGAL_MOVES")
	}
}

// ---------------------------------------------------------------------------
// R2.2 — stalemate through the real engine, R7 over sampled real positions.
// ---------------------------------------------------------------------------

func TestR2_2b_ThreePassesReachStalemateThroughBridge(t *testing.T) {
	st := engine.GameState{Players: [2]engine.PlayerState{{}, {}}, Phase: engine.PhaseNormal}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st)))
	for i := 0; i < 3; i++ {
		if !reflect.DeepEqual(env.Descriptions, []string{"pass"}) || env.State.Stalemate {
			t.Fatalf("pass %d: descriptions %q stalemate %v", i, env.Descriptions, env.State.Stalemate)
		}
		env = okEnvelope(t, b.Apply(0.0))
	}
	if env.State.Phase != engine.PhaseGameOver || env.State.Winner != nil || !env.State.Stalemate {
		t.Fatalf("after three passes: phase %d winner %v stalemate %v", env.State.Phase, env.State.Winner, env.State.Stalemate)
	}
	if len(env.LegalMoves) != 0 || env.Seq != 3 {
		t.Fatalf("game-over envelope: %d moves seq %d", len(env.LegalMoves), env.Seq)
	}
}

// The §7.1 blunt instrument over real positions: at every step of seeded
// games, neither viewer's envelope contains any current deck card, and the
// redacted state never contains the opponent's hand without glasses.
func TestR7_3b_SampledGamesLeakNoDeckOrHiddenHand(t *testing.T) {
	for seed := uint64(100); seed < 130; seed++ {
		b := newBridge()
		playRandom(t, b, seed, func(Envelope, string) {
			held := b.game.state
			for _, viewer := range []engine.PlayerID{engine.P1, engine.P2} {
				wire := b.View(float64(viewer))
				env := okEnvelope(t, wire)
				for _, hidden := range held.Deck {
					if strings.Contains(wire, cardJSON(hidden)) || strings.Contains(wire, hidden.String()) {
						t.Fatalf("seed %d viewer %d: deck card %s leaked", seed, viewer, hidden)
					}
				}
				if viewerHasGlasses(held.Players[viewer]) {
					continue
				}
				if env.State.Opponent.Hand != nil {
					t.Fatalf("seed %d viewer %d: opponent hand visible without glasses", seed, viewer)
				}
				stateWire := mustJSON(t, env.State)
				for _, hidden := range held.Players[viewer.Other()].Hand {
					if strings.Contains(stateWire, cardJSON(hidden)) {
						t.Fatalf("seed %d viewer %d: opponent card %s leaked into state", seed, viewer, hidden)
					}
				}
			}
		})
	}
}

func TestR7_4b_NullVersusEmptySurvivesSnapshotRoundTrip(t *testing.T) {
	visible := engine.GameState{Players: [2]engine.PlayerState{
		{Hand: []card.Card{c(card.Ace, card.Clubs)}, Permanents: []card.Card{c(card.Eight, card.Hearts)}},
		{Hand: nil},
	}, Deck: []card.Card{c(card.Two, card.Spades)}}
	for _, tc := range []struct {
		state engine.GameState
		want  string
	}{
		{visible, `"handCount":0,"hand":[]`},
		{engine.GameState{Players: [2]engine.PlayerState{{}, {}}, Deck: []card.Card{c(card.Two, card.Spades)}}, `"handCount":0,"hand":null`},
	} {
		first := newBridge()
		okEnvelope(t, first.Restore(snapshotOf(t, tc.state)))
		second := newBridge()
		okEnvelope(t, second.Restore(first.Snapshot()))
		if wire := second.View(0.0); !strings.Contains(wire, tc.want) {
			t.Fatalf("after snapshot round trip want %s in %s", tc.want, wire)
		}
	}
}
