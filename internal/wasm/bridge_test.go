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
	// §2.8(e) at the wire: no Rank-0 card anywhere (moves, SubMove, history, lastMove).
	if strings.Contains(wire, `"Rank":0,`) {
		t.Fatalf("envelope carries a Rank-0 card: %s", wire)
	}
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
		mover := env.State.Active
		applied := okEnvelope(t, b.Apply(float64(idx)))
		if applied.Seq != env.Seq+1 {
			t.Fatalf("seed %d step %d: seq %d -> %d", seed, step, env.Seq, applied.Seq)
		}
		if applied.State.Viewer != mover {
			t.Fatalf("seed %d step %d: apply returned viewer %d, want the mover %d", seed, step, applied.State.Viewer, mover)
		}
		// The UI fetches the incoming actor's view after the curtain reveal (§3.3 rule 4).
		wire = b.View(float64(applied.State.Active))
		env = okEnvelope(t, wire)
		if env.Seq != applied.Seq {
			t.Fatalf("seed %d step %d: view seq %d != apply seq %d", seed, step, env.Seq, applied.Seq)
		}
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
		var prevHistory []AppliedMove // unredacted, from the snapshot
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
				// History is append-only: earlier entries, including every
				// mover's own index, are frozen. Compared on the unredacted
				// snapshot history.
				var snap snapshotWire
				if err := json.Unmarshal([]byte(b.Snapshot()), &snap); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(snap.History[:len(prevHistory)], prevHistory) {
					t.Fatalf("seed %d: history rewritten", seed)
				}
				for i, h := range snap.History {
					if h.Index == nil {
						t.Fatalf("seed %d: snapshot history[%d] lost its index", seed, i)
					}
				}
				// The envelope's own entries match the snapshot exactly; others only lack index.
				for i, h := range env.History {
					want := snap.History[i]
					if h.By != env.State.Viewer {
						want.Index = nil
					}
					if !reflect.DeepEqual(h, want) {
						t.Fatalf("seed %d: envelope history[%d] = %+v, want %+v", seed, i, h, want)
					}
				}
			} else if env.LastMove != nil {
				t.Fatalf("seed %d: lastMove without history", seed)
			}
			var snap snapshotWire
			if err := json.Unmarshal([]byte(b.Snapshot()), &snap); err != nil {
				t.Fatal(err)
			}
			prevHistory = snap.History
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
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
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
	want := AppliedMove{Index: &idx, By: engine.P1, Kind: engine.MoveScuttle,
		Card: &card.Card{Rank: card.Nine, Suit: card.Clubs}, TargetCard: &card.Card{Rank: card.Five, Suit: card.Hearts},
		Description: "scuttle opponent's 5♥ with 9♣", Seq: 1}
	if after.LastMove == nil || !reflect.DeepEqual(*after.LastMove, want) {
		t.Fatalf("lastMove = %+v, want %+v", after.LastMove, want)
	}
}

// Change 2: apply returns the MOVER's view (pre-apply Active), so a
// mutating call never loads the incoming player's hand into the JS heap.
func TestSPEC2_7_ApplyReturnsMoverView(t *testing.T) {
	b := newGame42(t)
	incoming := append([]card.Card(nil), b.game.state.Players[engine.P2].Hand...)
	wire := b.Apply(0.0) // P1 draws; P2 becomes active
	after := okEnvelope(t, wire)
	if after.State.Viewer != engine.P1 || after.State.Active != engine.P2 {
		t.Fatalf("apply envelope viewer %d active %d, want viewer 0 active 1", after.State.Viewer, after.State.Active)
	}
	if len(after.LegalMoves) != 0 || after.State.Opponent.Hand != nil || len(after.State.You.Hand) != 6 {
		t.Fatalf("mover's envelope must carry no moves and only the mover's hand: %+v", after)
	}
	for _, hidden := range incoming {
		if strings.Contains(wire, cardJSON(hidden)) {
			t.Fatalf("apply wire leaked the incoming player's card %s", hidden)
		}
	}
	// The incoming actor's moves come from view(newActor), as the UI will call it.
	if next := okEnvelope(t, b.View(1.0)); len(next.LegalMoves) == 0 {
		t.Fatal("incoming actor's view must carry legal moves")
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
	got := okEnvelope(t, restored.Restore(snap, float64(b.game.state.Active)))
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
		"newGame non-string":       b.NewGame(42.0),
		"newGame undefined":        b.NewGame(nil),
		"newGame malformed":        b.NewGame(`{"seed":`),
		"newGame not object":       b.NewGame(`[1]`),
		"newGame trailing":         b.NewGame(`{"seed":"1"} {}`),
		"newGame seed alpha":       b.NewGame(`{"seed":"abc"}`),
		"newGame seed negative":    b.NewGame(`{"seed":"-1"}`),
		"newGame seed empty":       b.NewGame(`{"seed":""}`),
		"newGame dealer 2":         b.NewGame(`{"seed":"1","dealer":2}`),
		"newGame dealer string":    b.NewGame(`{"seed":"1","dealer":"1"}`),
		"newGame unknown field":    b.NewGame(`{"seed":"1","deck":[]}`),
		"newGame names 3":          b.NewGame(`{"names":["a","b","c"]}`),
		"apply string":             b.Apply("0"),
		"apply fraction":           b.Apply(1.5),
		"apply undefined":          b.Apply(nil),
		"apply object":             b.Apply(unsupportedArg{Kind: "object"}),
		"view 2":                   b.View(2.0),
		"view string":              b.View("0"),
		"view fraction":            b.View(0.5),
		"restore viewer 2":         b.Restore(snapshotOf(t, engine.GameState{}), 2.0),
		"restore viewer fraction":  b.Restore(snapshotOf(t, engine.GameState{}), 0.5),
		"restore viewer string":    b.Restore(snapshotOf(t, engine.GameState{}), "0"),
		"restore viewer missing":   b.Restore(snapshotOf(t, engine.GameState{}), nil),
		"restore non-string":       b.Restore(1.0, 0.0),
		"restore malformed":        b.Restore(`{`, 0.0),
		"restore wrong version":    b.Restore(`{"v":2,"state":{},"history":[],"seed":"1","dealer":0}`, 0.0),
		"restore missing state":    b.Restore(`{"v":1,"history":[],"seed":"1","dealer":0}`, 0.0),
		"restore bad active":       b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"Active":0`, `"Active":5`, 1), 0.0),
		"restore bad phase":        b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"Phase":0`, `"Phase":9`, 1), 0.0),
		"restore rank 0 in hand":   b.Restore(snapshotOf(t, engine.GameState{Players: [2]engine.PlayerState{{Hand: []card.Card{{}}}}}), 0.0),
		"restore history no index": b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"by":0,"kind":0,"card":null,"targetCard":null,"subKind":null,"description":"draw a card","seq":1}]`, 1), 0.0),
		"restore subKind on draw":  b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"subKind":4,"card":null,"targetCard":null,"description":"draw a card","seq":1}]`, 1), 0.0),
		"restore bad history":      b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"card":null,"targetCard":null,"description":"draw a card","seq":2}]`, 1), 0.0),
		"restore targetCard missing key": b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"description":"draw a card","seq":1}]`, 1), 0.0),
		"restore targetCard wrong type":  b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":"9C","description":"draw a card","seq":1}]`, 1), 0.0),
		// S2 (review, round 2 cycle 1): AppliedMove.UnmarshalJSON's own
		// dec.DisallowUnknownFields() must reject a history entry carrying
		// an unrecognized field — the outer decodeStrict's setting does NOT
		// propagate into a nested type's custom UnmarshalJSON, so this is a
		// distinct code path from every other "unknown field" check.
		"restore history unknown field": b.Restore(strings.Replace(snapshotOf(t, engine.GameState{}), `"history":[]`, `"history":[{"index":0,"by":0,"kind":0,"subKind":null,"card":null,"targetCard":null,"description":"draw a card","seq":1,"bogus":true}]`, 1), 0.0),
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
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
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
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 1.0))
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
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
	for i := 0; i < 3; i++ {
		if !reflect.DeepEqual(env.Descriptions, []string{"pass"}) || env.State.Stalemate {
			t.Fatalf("pass %d: descriptions %q stalemate %v", i, env.Descriptions, env.State.Stalemate)
		}
		okEnvelope(t, b.Apply(0.0))
		env = okEnvelope(t, b.View(float64(b.game.state.Active)))
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
		okEnvelope(t, first.Restore(snapshotOf(t, tc.state), 0.0))
		second := newBridge()
		okEnvelope(t, second.Restore(first.Snapshot(), 0.0))
		if wire := second.View(0.0); !strings.Contains(wire, tc.want) {
			t.Fatalf("after snapshot round trip want %s in %s", tc.want, wire)
		}
	}
}

// ---------------------------------------------------------------------------
// Batch 1 follow-up: David-approved contract changes and reviewer minors.
// ---------------------------------------------------------------------------

// Change 1: history[].index / lastMove.index are omitted for every viewer
// other than that move's mover. Reviewer's repro: a 3's index (3) encodes
// its ScrapIndex and the size of the mover's option list.
func TestSPEC3_2_IndexRedactedForNonMover(t *testing.T) {
	for _, oppHasTwo := range []bool{true, false} {
		oppHand := []card.Card{c(card.Five, card.Diamonds)}
		if oppHasTwo {
			oppHand = append(oppHand, c(card.Two, card.Hearts)) // opens a real AwaitingCounter window
		}
		st := engine.GameState{
			Players: [2]engine.PlayerState{
				{Hand: []card.Card{c(card.Three, card.Clubs)}},
				{Hand: oppHand},
			},
			Deck:   []card.Card{c(card.King, card.Hearts), c(card.Six, card.Clubs)},
			Scrap:  []card.Card{c(card.Two, card.Clubs), c(card.Nine, card.Hearts), c(card.Ace, card.Spades)},
			Active: engine.P1,
			Phase:  engine.PhaseNormal,
		}
		b := newBridge()
		env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
		want := []string{"draw a card", "play 3♣ as one-off", "play 3♣ as one-off", "play 3♣ as one-off", "play 3♣ as point card"}
		if !reflect.DeepEqual(env.Descriptions, want) {
			t.Fatalf("precondition: descriptions = %q", env.Descriptions)
		}
		mover := okEnvelope(t, b.Apply(3.0)) // the 3 taking scrap[2]
		if mover.LastMove == nil || mover.LastMove.Index == nil || *mover.LastMove.Index != 3 {
			t.Fatalf("mover must see its own index 3, got %+v", mover.LastMove)
		}
		if oppHasTwo && b.game.state.Phase != engine.PhaseAwaitingCounter {
			t.Fatalf("precondition: expected AwaitingCounter, got %d", b.game.state.Phase)
		}
		oppWire := b.View(1.0)
		opp := decodeGeneric(t, oppWire)
		last := opp["lastMove"].(map[string]any)
		if _, present := last["index"]; present {
			t.Fatalf("oppHasTwo=%v: lastMove.index leaked to non-mover: %s", oppHasTwo, oppWire)
		}
		if _, present := opp["history"].([]any)[0].(map[string]any)["index"]; present {
			t.Fatalf("oppHasTwo=%v: history[0].index leaked to non-mover", oppHasTwo)
		}

		// P2 acts; each viewer sees only their own moves' indices.
		p2 := okEnvelope(t, b.View(1.0))
		okEnvelope(t, b.Apply(float64(len(p2.LegalMoves)-1)))
		for viewer := 0; viewer < 2; viewer++ {
			hist := decodeGeneric(t, b.View(float64(viewer)))["history"].([]any)
			for i, h := range hist {
				entry := h.(map[string]any)
				_, present := entry["index"]
				if mine := int(entry["by"].(float64)) == viewer; present != mine {
					t.Fatalf("oppHasTwo=%v viewer %d history[%d] by %v: index present=%v", oppHasTwo, viewer, i, entry["by"], present)
				}
			}
		}
	}
}

// Change 3: AppliedMove.subKind is the SubMove's kind, or null.
func TestSPEC2_7_SubKindOnAppliedMove(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Three, card.Clubs)}},
			{Hand: []card.Card{c(card.Six, card.Hearts)}},
		},
		Deck:    []card.Card{c(card.King, card.Hearts)},
		Active:  engine.P1,
		Phase:   engine.PhaseSevenChoosing,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: []card.Card{c(card.Five, card.Hearts)}},
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
	if env.Descriptions[0] != "7: play 5♥ as one-off" {
		t.Fatalf("precondition: %q", env.Descriptions)
	}
	wire := b.Apply(0.0)
	after := okEnvelope(t, wire)
	if after.LastMove.SubKind == nil || *after.LastMove.SubKind != engine.MoveOneOff || after.LastMove.Kind != engine.MoveSevenPick {
		t.Fatalf("lastMove = %+v, want kind 7 subKind 4", after.LastMove)
	}
	if !strings.Contains(wire, `"subKind":4`) {
		t.Fatalf("subKind must be a bare number: %s", wire)
	}
	// Both viewers see subKind; it is public once played (§4.3 needs it on the ack side).
	if !strings.Contains(b.View(1.0), `"subKind":4`) {
		t.Fatal("non-mover must see subKind")
	}

	plain := newGame42(t)
	drew := plain.Apply(0.0)
	if !strings.Contains(drew, `"subKind":null`) {
		t.Fatalf("no SubMove => subKind null: %s", drew)
	}
}

// Minor 4: Pending is present iff phase is 1, 2 or 3.
func TestSPEC2_9_RestorePendingMatchesPhase(t *testing.T) {
	b := newGame42(t)
	before := b.Snapshot()
	pending := &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Four, card.Clubs)}
	w := engine.P1
	for phase := engine.PhaseNormal; phase <= engine.PhaseGameOver; phase++ {
		needs := phase == engine.PhaseAwaitingCounter || phase == engine.PhaseSevenChoosing || phase == engine.PhaseAwaitingDiscard
		st := engine.GameState{Players: [2]engine.PlayerState{{Hand: []card.Card{c(card.Ace, card.Clubs)}}, {Hand: []card.Card{c(card.Two, card.Clubs)}}}, Phase: phase}
		if phase == engine.PhaseGameOver {
			st.Winner = &w
		}
		// Mismatched direction first: pending absent where required, present where forbidden.
		bad := st
		if !needs {
			bad.Pending = pending
		}
		errCode(t, b.Restore(snapshotOf(t, bad), 0.0), "BAD_REQUEST")
		if b.Snapshot() != before {
			t.Fatalf("phase %d: held state changed on BAD_REQUEST", phase)
		}
		// Matched direction is accepted.
		good := st
		if needs {
			good.Pending = pending
		}
		if m := decodeGeneric(t, newBridge().Restore(snapshotOf(t, good), 0.0)); m["ok"] != true {
			t.Fatalf("phase %d: consistent pending rejected: %v", phase, m)
		}
	}
}

// David's decision (2026-09-26): restore(snapshotJson, viewerId) returns
// viewerId's envelope; TS passes Snapshot.viewer and re-raises the persisted
// curtain before rendering (R4.2).
func TestSPEC2_4_RestoreReturnsNamedViewer(t *testing.T) {
	b := newGame42(t)
	okEnvelope(t, b.Apply(0.0)) // P1 draws; P2 (incoming) is now active
	snap := b.Snapshot()
	incoming := b.game.state.Players[engine.P2].Hand
	moverHand := b.game.state.Players[engine.P1].Hand

	// Mid-curtain reload: the mover still holds the phone.
	moverWire := newBridge().Restore(snap, 0.0)
	mover := okEnvelope(t, moverWire)
	if mover.State.Viewer != engine.P1 || len(mover.LegalMoves) != 0 {
		t.Fatalf("mover restore: viewer %d moves %d", mover.State.Viewer, len(mover.LegalMoves))
	}
	for _, hidden := range incoming {
		if strings.Contains(moverWire, cardJSON(hidden)) {
			t.Fatalf("mover restore leaked incoming player's card %s", hidden)
		}
	}

	// Post-reveal reload: the actor holds the phone and sees their own hand.
	actorWire := newBridge().Restore(snap, 1.0)
	actor := okEnvelope(t, actorWire)
	if actor.State.Viewer != engine.P2 || !reflect.DeepEqual(actor.State.You.Hand, incoming) || len(actor.LegalMoves) == 0 {
		t.Fatalf("actor restore: %+v", actor.State)
	}
	for _, hidden := range moverHand {
		if strings.Contains(mustJSON(t, actor.State), cardJSON(hidden)) {
			t.Fatalf("actor restore leaked the mover's card %s", hidden)
		}
	}

	// Bad viewerId: BAD_REQUEST, held state unchanged.
	before := b.Snapshot()
	for _, bad := range []any{-1.0, 2.0, 0.5, "1", nil, true} {
		errCode(t, b.Restore(snap, bad), "BAD_REQUEST")
		if b.Snapshot() != before {
			t.Fatalf("viewer %v: held state changed", bad)
		}
	}
}

// David's decision (2026-09-26): newGame returns the first actor's view;
// whoever starts the game is the first player, no opening curtain.
func TestSPEC2_4_NewGameReturnsFirstActorView(t *testing.T) {
	for _, dealer := range []int{0, 1} {
		b := newBridge()
		env := okEnvelope(t, b.NewGame(mustJSON(t, map[string]any{"seed": "42", "dealer": dealer})))
		first := engine.PlayerID(dealer).Other()
		if env.State.Viewer != first || env.State.Active != first || len(env.LegalMoves) == 0 || len(env.State.You.Hand) != 5 {
			t.Fatalf("dealer %d: newGame envelope viewer %d active %d", dealer, env.State.Viewer, env.State.Active)
		}
	}
}

// Minor 2: a mutating call commits only if the ACTOR's envelope also
// renders, even when it returns a different viewer's envelope.
func TestSPEC2_9_CommitRequiresActorEnvelope(t *testing.T) {
	b := newGame42(t)
	before := b.Snapshot()
	snap := func() string {
		s := newBridge()
		okEnvelope(t, s.NewGame(`{"seed":"7","dealer":0}`))
		return s.Snapshot()
	}()
	actorOf := decodeGeneric(t, snap)["state"].(map[string]any)["Active"].(float64)

	orig := renderEnvelope
	defer func() { renderEnvelope = orig }()
	renderEnvelope = func(st engine.GameState, h []AppliedMove, viewer engine.PlayerID) Envelope {
		if viewer == st.Active {
			panic("actor envelope failed")
		}
		return orig(st, h, viewer)
	}
	errCode(t, b.Restore(snap, 1-actorOf), "INTERNAL") // restore as non-actor
	errCode(t, b.Apply(0.0), "INTERNAL")               // apply returns the mover's view; actor's must render too
	renderEnvelope = orig
	if b.Snapshot() != before {
		t.Fatal("held state committed although the actor's envelope failed")
	}
}

// Minor 1 boundary: the engine's dead-end SevenPick has no SubMove, so its
// subKind is null and a snapshot holding it must still restore.
func TestSPEC2_7_SubKindNullForDeadEndSevenPick(t *testing.T) {
	st := engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{c(card.Three, card.Clubs)}},
			{Hand: []card.Card{c(card.Six, card.Hearts)}},
		},
		Deck:    []card.Card{c(card.King, card.Hearts)},
		Active:  engine.P1,
		Phase:   engine.PhaseSevenChoosing,
		Pending: &engine.PendingOneOff{PlayedBy: engine.P1, Card: c(card.Seven, card.Hearts), Revealed: []card.Card{c(card.Jack, card.Diamonds), c(card.Jack, card.Spades)}},
	}
	b := newBridge()
	env := okEnvelope(t, b.Restore(snapshotOf(t, st), 0.0))
	if env.Descriptions[0] != "7: no legal play — scrap J♦" {
		t.Fatalf("precondition: %q", env.Descriptions)
	}
	after := okEnvelope(t, b.Apply(0.0))
	if after.LastMove.Kind != engine.MoveSevenPick || after.LastMove.SubKind != nil {
		t.Fatalf("dead-end SevenPick: %+v", after.LastMove)
	}
	okEnvelope(t, newBridge().Restore(b.Snapshot(), 0.0))
}
