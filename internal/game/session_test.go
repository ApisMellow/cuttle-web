package game

// Tests for the typed Go API (two-phone W2, docs/two-phone-plan.md §4):
// Session, Seat, Update, ServerSnapshot and the typed errors.

import (
	"bytes"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %T: %v", v, err)
	}
	return string(out)
}

func mustSession(t *testing.T, seed uint64, dealer Seat) *Session {
	t.Helper()
	s, err := NewSession(seed, dealer)
	if err != nil {
		t.Fatalf("NewSession(%d, %d): %v", seed, dealer, err)
	}
	return s
}

func mustStatus(t *testing.T, s *Session) Status {
	t.Helper()
	st, err := s.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	return st
}

func persisted(t *testing.T, s *Session) string {
	t.Helper()
	snap, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	return string(snap.PersistBytes())
}

func wantErr(t *testing.T, label string, err, target error, code Code) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("%s: err = %v, want %v", label, err, target)
	}
	var ge *Error
	if !errors.As(err, &ge) || ge.Code != code {
		t.Fatalf("%s: err %v does not carry code %s", label, err, code)
	}
}

// walkSession plays one seeded game through the typed API with the same
// move policy as playRandom (xorshift32(seed), dealer seed&1), calling
// visit before every move and once at the end.
func walkSession(t *testing.T, seed uint64, visit func(s *Session, st Status)) *Session {
	t.Helper()
	s := mustSession(t, seed, Seat(seed&1))
	rng := xorshift32(uint32(seed))
	for step := 0; step < 3000; step++ {
		st := mustStatus(t, s)
		visit(s, st)
		if st.Over || st.Stuck {
			return s
		}
		moves, _, err := s.LegalMoves(st.Actor)
		if err != nil {
			t.Fatalf("seed %d step %d: LegalMoves: %v", seed, step, err)
		}
		idx := int(rng() % uint32(len(moves)))
		if _, err := s.Apply(st.Actor, st.Seq, idx); err != nil {
			t.Fatalf("seed %d step %d: Apply(%d, %d, %d): %v", seed, step, st.Actor, st.Seq, idx, err)
		}
	}
	t.Fatalf("seed %d did not terminate", seed)
	return nil
}

// ---------------------------------------------------------------------------
// Construction, Seat, Status.
// ---------------------------------------------------------------------------

func TestW2_NewSessionRejectsBadDealer(t *testing.T) {
	for _, d := range []Seat{-1, 2, 7} {
		s, err := NewSession(1, d)
		if s != nil {
			t.Fatalf("dealer %d: got a session", d)
		}
		wantErr(t, fmt.Sprintf("dealer %d", d), err, ErrBadSeat, CodeBadRequest)
	}
}

func TestW2_SeatHelpers(t *testing.T) {
	if !Seat0.Valid() || !Seat1.Valid() || Seat(2).Valid() || Seat(-1).Valid() {
		t.Fatal("Seat.Valid wrong")
	}
	if Seat0.Other() != Seat1 || Seat1.Other() != Seat0 {
		t.Fatal("Seat.Other wrong")
	}
}

func TestW2_StatusOfFreshAndFinishedGames(t *testing.T) {
	for _, dealer := range []Seat{Seat0, Seat1} {
		s := mustSession(t, 42, dealer)
		st := mustStatus(t, s)
		if st.Seq != 0 || st.Actor != dealer.Other() || st.Phase != engine.PhaseNormal || st.Over || st.Winner != NoSeat || st.Stalemate || st.Stuck {
			t.Fatalf("dealer %d: fresh status %+v", dealer, st)
		}
		if s.Seq() != 0 {
			t.Fatalf("Seq() = %d", s.Seq())
		}
	}
	wins := 0
	for seed := uint64(1); seed <= 30; seed++ {
		final := walkSession(t, seed, func(*Session, Status) {})
		st := mustStatus(t, final)
		if !st.Over || st.Phase != engine.PhaseGameOver {
			t.Fatalf("seed %d: final status %+v", seed, st)
		}
		if st.Seq != final.Seq() || st.Seq != len(final.g.history) {
			t.Fatalf("seed %d: seq %d vs history %d", seed, st.Seq, len(final.g.history))
		}
		if w := final.g.state.Winner; w != nil {
			wins++
			if st.Winner != Seat(*w) || st.Stalemate {
				t.Fatalf("seed %d: winner %v stalemate %v, engine winner %d", seed, st.Winner, st.Stalemate, *w)
			}
		} else if st.Winner != NoSeat || !st.Stalemate {
			t.Fatalf("seed %d: stalemate not reported: %+v", seed, st)
		}
	}
	if wins == 0 {
		t.Fatal("no game in the range ended in a win")
	}
}

// ---------------------------------------------------------------------------
// Equivalence: the typed API and the JSON Bridge produce the same bytes.
// ---------------------------------------------------------------------------

func TestW2_TypedAPIMatchesBridge(t *testing.T) {
	plies := 0
	for seed := uint64(1); seed <= 48; seed++ {
		dealer := Seat(seed & 1)
		if seed%3 == 0 {
			dealer = dealer.Other()
		}
		b := NewBridge()
		wire := b.NewGame(fmt.Sprintf(`{"seed":"%d","dealer":%d}`, seed, dealer))
		s := mustSession(t, seed, dealer)
		first, err := s.View(mustStatus(t, s).Actor)
		if err != nil {
			t.Fatal(err)
		}
		if got := jsonOf(t, first); got != wire {
			t.Fatalf("seed %d: first actor view differs from NewGame:\n%s\n%s", seed, got, wire)
		}
		rng := xorshift32(uint32(seed*2654435761 + 7))
		for step := 0; ; step++ {
			if step > 3000 {
				t.Fatalf("seed %d did not terminate", seed)
			}
			st := mustStatus(t, s)
			for _, seat := range []Seat{Seat0, Seat1} {
				v, err := s.View(seat)
				if err != nil {
					t.Fatal(err)
				}
				if got, want := jsonOf(t, v), b.View(float64(seat)); got != want {
					t.Fatalf("seed %d step %d: View(%d) differs:\n%s\n%s", seed, step, seat, got, want)
				}
			}
			if got, want := persisted(t, s), b.Snapshot(); got != want {
				t.Fatalf("seed %d step %d: snapshot differs:\n%s\n%s", seed, step, got, want)
			}
			if st.Over {
				_, err := s.Apply(st.Actor, st.Seq, 0)
				wantErr(t, "apply at game over", err, ErrGameOver, CodeGameOver)
				break
			}
			if st.Stuck {
				_, err := s.Apply(st.Actor, st.Seq, 0)
				wantErr(t, "apply when stuck", err, ErrNoLegalMoves, CodeNoLegalMoves)
				errCode(t, b.Apply(0.0), "NO_LEGAL_MOVES")
				break
			}
			moves, descs, err := s.LegalMoves(st.Actor)
			if err != nil {
				t.Fatal(err)
			}
			bridgeEnv := okEnvelope(t, b.LegalMoves())
			if jsonOf(t, moves) != jsonOf(t, bridgeEnv.LegalMoves) || jsonOf(t, descs) != jsonOf(t, bridgeEnv.Descriptions) {
				t.Fatalf("seed %d step %d: legal moves differ", seed, step)
			}
			idx := int(rng() % uint32(len(moves)))
			up, err := s.Apply(st.Actor, st.Seq, idx)
			if err != nil {
				t.Fatalf("seed %d step %d: Apply: %v", seed, step, err)
			}
			bw := b.Apply(float64(idx))
			if up.Seq != st.Seq+1 || up.Mover != st.Actor {
				t.Fatalf("seed %d step %d: update seq %d mover %d", seed, step, up.Seq, up.Mover)
			}
			if got := jsonOf(t, up.For(st.Actor)); got != bw {
				t.Fatalf("seed %d step %d: mover envelope differs from Bridge.Apply:\n%s\n%s", seed, step, got, bw)
			}
			for _, seat := range []Seat{Seat0, Seat1} {
				if got, want := jsonOf(t, up.For(seat)), b.View(float64(seat)); got != want {
					t.Fatalf("seed %d step %d: update envelope for %d differs from Bridge.View", seed, step, seat)
				}
			}
			plies++
		}
	}
	if plies == 0 {
		t.Fatal("no plies compared")
	}
	t.Logf("48 seeds, %d plies: typed API bytes equal the Bridge's", plies)
}

// ---------------------------------------------------------------------------
// Seat binding, seq, index and game-over errors. Every error leaves the
// session byte-identical.
// ---------------------------------------------------------------------------

func TestW2_SeatBindingRejectsTheOtherSeat(t *testing.T) {
	var normal, counter, discard, seven, over int
	for seed := uint64(1); seed <= 60; seed++ {
		walkSession(t, seed, func(s *Session, st Status) {
			before := persisted(t, s)
			if st.Over {
				over++
				for _, seat := range []Seat{Seat0, Seat1} {
					_, err := s.Apply(seat, st.Seq, 0)
					wantErr(t, "game over", err, ErrGameOver, CodeGameOver)
				}
			} else {
				// The actor is always engine Active: the responder at a
				// counter window, the discarder at a 4, the 7's player
				// while choosing (engine/apply.go:337, :653, :834).
				if st.Actor != Seat(s.g.state.Active) {
					t.Fatalf("seed %d: actor %d != engine Active %d", seed, st.Actor, s.g.state.Active)
				}
				switch st.Phase {
				case engine.PhaseNormal:
					normal++
				case engine.PhaseAwaitingCounter:
					if Seat(s.g.state.Pending.PlayedBy) == st.Actor && len(s.g.state.Pending.CounterChain)%2 == 0 {
						t.Fatalf("seed %d: counter window actor is the one-off's player", seed)
					}
					counter++
				case engine.PhaseAwaitingDiscard:
					discard++
				case engine.PhaseSevenChoosing:
					seven++
				}
				n := len(engine.LegalMoves(s.g.state))
				for _, idx := range []int{0, n - 1} {
					_, err := s.Apply(st.Actor.Other(), st.Seq, idx)
					wantErr(t, fmt.Sprintf("seed %d wrong seat idx %d", seed, idx), err, ErrNotYourTurn, CodeNotYourTurn)
				}
				_, err := s.Apply(st.Actor, st.Seq-1, 0)
				wantErr(t, "stale seq -1", err, ErrStale, CodeStale)
				_, err = s.Apply(st.Actor, st.Seq+1, 0)
				wantErr(t, "stale seq +1", err, ErrStale, CodeStale)
				_, err = s.Apply(st.Actor, st.Seq, n)
				wantErr(t, "index n", err, ErrIndexOutOfRange, CodeIndexOutOfRange)
				_, err = s.Apply(st.Actor, st.Seq, -1)
				wantErr(t, "index -1", err, ErrIndexOutOfRange, CodeIndexOutOfRange)
			}
			for _, bad := range []Seat{-1, 2} {
				_, err := s.Apply(bad, st.Seq, 0)
				wantErr(t, "apply bad seat", err, ErrBadSeat, CodeBadRequest)
				_, err = s.View(bad)
				wantErr(t, "view bad seat", err, ErrBadSeat, CodeBadRequest)
				_, _, err = s.LegalMoves(bad)
				wantErr(t, "legal moves bad seat", err, ErrBadSeat, CodeBadRequest)
			}
			if persisted(t, s) != before || mustStatus(t, s) != st {
				t.Fatalf("seed %d seq %d: a rejected call changed the session", seed, st.Seq)
			}
		})
	}
	if normal == 0 || counter == 0 || discard == 0 || seven == 0 || over == 0 {
		t.Fatalf("phases not all exercised: normal %d counter %d discard %d seven %d over %d", normal, counter, discard, seven, over)
	}
	t.Logf("60 seeds: wrong seat refused at %d normal, %d counter, %d discard, %d seven plies; %d game-overs", normal, counter, discard, seven, over)
}

func TestW2_LegalMovesPerSeat(t *testing.T) {
	s := mustSession(t, 42, Seat1)
	moves, descs, err := s.LegalMoves(Seat0)
	if err != nil || len(moves) == 0 || len(moves) != len(descs) {
		t.Fatalf("actor: %d moves %d descs err %v", len(moves), len(descs), err)
	}
	moves, descs, err = s.LegalMoves(Seat1)
	if err != nil || moves == nil || descs == nil || len(moves) != 0 || len(descs) != 0 {
		t.Fatalf("non-actor: %v %v %v", moves, descs, err)
	}
}

func TestW2_StuckPositionRaisesNoLegalMoves(t *testing.T) {
	// The same shape as TestSPEC2_9_NoLegalMoves: a 4's discard owed by a
	// player with an empty hand.
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
	s, err := RestoreSession([]byte(snapshotOf(t, st)))
	if err != nil {
		t.Fatal(err)
	}
	status := mustStatus(t, s)
	if !status.Stuck || status.Over || status.Actor != Seat1 {
		t.Fatalf("status %+v", status)
	}
	before := persisted(t, s)
	_, err = s.Apply(Seat1, 0, 0)
	wantErr(t, "stuck apply", err, ErrNoLegalMoves, CodeNoLegalMoves)
	_, _, err = s.LegalMoves(Seat1)
	wantErr(t, "stuck legal moves", err, ErrNoLegalMoves, CodeNoLegalMoves)
	// The waiting seat has no moves either way; only the actor sees the defect.
	if m, d, err := s.LegalMoves(Seat0); err != nil || len(m) != 0 || len(d) != 0 {
		t.Fatalf("non-actor at a stuck position: %v %v %v", m, d, err)
	}
	_, err = s.Apply(Seat0, 0, 0)
	wantErr(t, "stuck, wrong seat", err, ErrNotYourTurn, CodeNotYourTurn)
	if _, err := s.View(Seat0); err != nil {
		t.Fatalf("View must never raise NO_LEGAL_MOVES: %v", err)
	}
	if persisted(t, s) != before {
		t.Fatal("stuck apply changed the session")
	}
}

// ---------------------------------------------------------------------------
// Privacy: per-seat output never carries the opponent's hand (without
// glasses), the deck, the seed, or the other seat's 7 reveal.
// ---------------------------------------------------------------------------

type cardKey struct{ rank, suit int }

// cardsIn collects every card-shaped object ({"Rank":n,"Suit":n}) and every
// object key in a decoded JSON value.
func cardsIn(v any, cards map[cardKey]bool, keys map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		r, okR := x["Rank"].(float64)
		su, okS := x["Suit"].(float64)
		if okR && okS && len(x) == 2 {
			cards[cardKey{int(r), int(su)}] = true
		}
		for k, e := range x {
			keys[k] = true
			cardsIn(e, cards, keys)
		}
	case []any:
		for _, e := range x {
			cardsIn(e, cards, keys)
		}
	}
}

func decodeAny(t *testing.T, wire string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(wire), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestW2_ViewsNeverLeakHiddenCards(t *testing.T) {
	var views, oppHidden, deckChecked, glasses, sevenOther, sevenActor int
	for seed := uint64(1); seed <= 120; seed++ {
		walkSession(t, seed, func(s *Session, st Status) {
			state := s.g.state
			// The snapshot is the full state: it must name the deck, or this
			// property would be vacuous.
			if len(state.Deck) > 0 && !strings.Contains(persisted(t, s), `"Deck":[{`) {
				t.Fatalf("seed %d: snapshot lacks the deck", seed)
			}
			for _, seat := range []Seat{Seat0, Seat1} {
				viewer := engine.PlayerID(seat)
				env, err := s.View(seat)
				if err != nil {
					t.Fatal(err)
				}
				wire := jsonOf(t, env)
				views++
				all := map[cardKey]bool{}
				keys := map[string]bool{}
				cardsIn(decodeAny(t, wire), all, keys)
				for _, k := range []string{"Deck", "deck", "seed", "Seed", "dealer", "Revealed"} {
					if keys[k] {
						t.Fatalf("seed %d seat %d: view carries key %q", seed, seat, k)
					}
				}
				if env.State.Pending != nil && strings.Contains(jsonOf(t, env.State.Pending), "ScrapIndex") {
					t.Fatalf("seed %d: pending carries ScrapIndex", seed)
				}
				// Deck: nowhere in the envelope, except the 7's reveal shown
				// to its own actor while choosing.
				exempt := map[cardKey]bool{}
				if state.Phase == engine.PhaseSevenChoosing && state.Pending != nil {
					if viewer == state.Active {
						sevenActor++
						for _, cd := range state.Pending.Revealed {
							exempt[cardKey{int(cd.Rank), int(cd.Suit)}] = true
						}
					} else {
						sevenOther++
						if len(env.State.SevenRevealed) != 0 {
							t.Fatalf("seed %d: non-actor sees the 7 reveal", seed)
						}
						for _, cd := range state.Pending.Revealed {
							if all[cardKey{int(cd.Rank), int(cd.Suit)}] {
								t.Fatalf("seed %d seat %d: 7-revealed %v reached the other seat", seed, seat, cd)
							}
						}
					}
				}
				for _, cd := range state.Deck {
					k := cardKey{int(cd.Rank), int(cd.Suit)}
					deckChecked++
					if all[k] && !exempt[k] {
						t.Fatalf("seed %d seat %d: deck card %v in view: %s", seed, seat, cd, wire)
					}
				}
				// Opponent's hand: nowhere in the board view or legal moves
				// unless the viewer has glasses. History is excluded: a card
				// bounced back to hand by a 9 was public when played.
				opp := state.Players[viewer.Other()].Hand
				if viewerHasGlasses(state.Players[viewer]) {
					glasses++
					if env.State.Opponent.Hand == nil {
						t.Fatalf("seed %d: glasses viewer lacks the opponent's hand", seed)
					}
					continue
				}
				if env.State.Opponent.Hand != nil {
					t.Fatalf("seed %d seat %d: opponent hand visible without glasses", seed, seat)
				}
				board := map[cardKey]bool{}
				cardsIn(decodeAny(t, jsonOf(t, env.State)), board, map[string]bool{})
				cardsIn(decodeAny(t, jsonOf(t, env.LegalMoves)), board, map[string]bool{})
				for _, cd := range opp {
					oppHidden++
					if board[cardKey{int(cd.Rank), int(cd.Suit)}] {
						t.Fatalf("seed %d seat %d: opponent card %v in view: %s", seed, seat, cd, wire)
					}
				}
			}
		})
	}
	if oppHidden == 0 || deckChecked == 0 || glasses == 0 || sevenOther == 0 || sevenActor == 0 {
		t.Fatalf("property not exercised: oppHidden %d deck %d glasses %d sevenOther %d sevenActor %d", oppHidden, deckChecked, glasses, sevenOther, sevenActor)
	}
	t.Logf("120 seeds, %d views: %d hidden opponent cards, %d deck cards checked; glasses %d, 7 reveal other/actor %d/%d",
		views, oppHidden, deckChecked, glasses, sevenOther, sevenActor)
}

// Returned envelopes share no memory with the session: a caller that edits
// one cannot change the game.
func TestW2_ReturnedEnvelopesDoNotAliasSession(t *testing.T) {
	var mutated int
	for seed := uint64(1); seed <= 12; seed++ {
		walkSession(t, seed, func(s *Session, st Status) {
			if st.Seq == 0 || st.Over {
				return
			}
			before := persisted(t, s)
			want := [2]string{}
			for _, seat := range []Seat{Seat0, Seat1} {
				v, _ := s.View(seat)
				want[seat] = jsonOf(t, v)
			}
			for _, seat := range []Seat{Seat0, Seat1} {
				v, _ := s.View(seat)
				scribble(&v)
				mutated++
			}
			moves, descs, _ := s.LegalMoves(st.Actor)
			for i := range moves {
				moves[i].HandIndex = 99
				if moves[i].Card != nil {
					moves[i].Card.Rank = card.King
				}
			}
			for i := range descs {
				descs[i] = "x"
			}
			if persisted(t, s) != before {
				t.Fatalf("seed %d seq %d: editing a returned envelope changed the session", seed, st.Seq)
			}
			for _, seat := range []Seat{Seat0, Seat1} {
				v, _ := s.View(seat)
				if jsonOf(t, v) != want[seat] {
					t.Fatalf("seed %d seq %d: view %d changed after editing a copy", seed, st.Seq, seat)
				}
			}
		})
	}
	// Update envelopes too.
	s := mustSession(t, 5, Seat0)
	st := mustStatus(t, s)
	up, err := s.Apply(st.Actor, st.Seq, 0)
	if err != nil {
		t.Fatal(err)
	}
	if bad := up.For(Seat(2)); bad.OK || bad.State.You.Hand != nil {
		t.Fatal("Update.For(invalid seat) must be the zero Envelope")
	}
	before := persisted(t, s)
	for _, seat := range []Seat{Seat0, Seat1} {
		want := jsonOf(t, up.For(seat))
		e := up.For(seat)
		scribble(&e)
		if jsonOf(t, up.For(seat)) != want {
			t.Fatalf("editing For(%d) changed the Update", seat)
		}
	}
	if persisted(t, s) != before {
		t.Fatal("editing an Update changed the session")
	}
	if mutated == 0 {
		t.Fatal("nothing mutated")
	}
}

func scribble(e *Envelope) {
	pv := &e.State
	if pv.Winner != nil {
		*pv.Winner = 1 - *pv.Winner
	}
	for i := range pv.You.Hand {
		pv.You.Hand[i] = card.Card{Rank: card.King, Suit: card.Spades}
	}
	for i := range pv.You.FrozenHandIndices {
		pv.You.FrozenHandIndices[i] = 7
	}
	for _, side := range [][]PointEntryView{pv.You.Points, pv.Opponent.Points} {
		for i := range side {
			side[i].Card.Rank = card.King
			for j := range side[i].JackStack {
				side[i].JackStack[j].Rank = card.Two
			}
			for j := range side[i].JackOwners {
				side[i].JackOwners[j] = 9
			}
		}
	}
	for i := range pv.You.Permanents {
		pv.You.Permanents[i].Rank = card.Two
	}
	for i := range pv.Opponent.Permanents {
		pv.Opponent.Permanents[i].Rank = card.Two
	}
	if pv.Opponent.Hand != nil {
		for i := range *pv.Opponent.Hand {
			(*pv.Opponent.Hand)[i].Rank = card.Two
		}
	}
	for i := range pv.Scrap {
		pv.Scrap[i].Rank = card.Two
	}
	for i := range pv.SevenRevealed {
		pv.SevenRevealed[i].Rank = card.Two
	}
	if pv.Pending != nil {
		pv.Pending.Card.Rank = card.Two
		if pv.Pending.Target != nil {
			pv.Pending.Target.Index = 42
		}
		for i := range pv.Pending.CounterChain {
			pv.Pending.CounterChain[i].Rank = card.Three
		}
	}
	for i := range e.History {
		h := &e.History[i]
		if h.Card != nil {
			h.Card.Rank = card.Two
		}
		if h.TargetCard != nil {
			h.TargetCard.Rank = card.Two
		}
		if h.SubKind != nil {
			*h.SubKind = engine.MovePass
		}
		if h.Index != nil {
			*h.Index = 77
		}
		if h.Drawn != nil {
			*h.Drawn = 9
		}
	}
	if e.LastMove != nil && e.LastMove.Card != nil {
		e.LastMove.Card.Suit = card.Spades
	}
}

// ---------------------------------------------------------------------------
// Snapshot and restore.
// ---------------------------------------------------------------------------

// Every ply, the session is replaced by a restore of its own snapshot, and
// the game still matches a Bridge that never restored.
func TestW2_SnapshotRestoreRoundTrip(t *testing.T) {
	restores := 0
	for seed := uint64(1); seed <= 40; seed++ {
		b := NewBridge()
		okEnvelope(t, b.NewGame(fmt.Sprintf(`{"seed":"%d","dealer":%d}`, seed, seed&1)))
		s := mustSession(t, seed, Seat(seed&1))
		rng := xorshift32(uint32(seed))
		for step := 0; step < 3000; step++ {
			snap, err := s.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			r, err := RestoreSession(snap.PersistBytes())
			if err != nil {
				t.Fatalf("seed %d step %d: restore: %v", seed, step, err)
			}
			restores++
			if mustStatus(t, r) != mustStatus(t, s) || persisted(t, r) != string(snap.PersistBytes()) {
				t.Fatalf("seed %d step %d: restore is not exact", seed, step)
			}
			s = r
			for _, seat := range []Seat{Seat0, Seat1} {
				v, _ := s.View(seat)
				if jsonOf(t, v) != b.View(float64(seat)) {
					t.Fatalf("seed %d step %d: restored view %d differs from the bridge", seed, step, seat)
				}
			}
			st := mustStatus(t, s)
			if st.Over {
				break
			}
			moves, _, _ := s.LegalMoves(st.Actor)
			idx := int(rng() % uint32(len(moves)))
			if _, err := s.Apply(st.Actor, st.Seq, idx); err != nil {
				t.Fatal(err)
			}
			okEnvelope(t, b.Apply(float64(idx)))
		}
		if persisted(t, s) != b.Snapshot() {
			t.Fatalf("seed %d: final snapshots differ", seed)
		}
	}
	t.Logf("40 seeds, %d snapshot->restore round trips, zero rejections", restores)
}

func TestW2_RestoreUpgradesV1Snapshot(t *testing.T) {
	v1, err := os.ReadFile("testdata/snapshot-v1-bce9fb2.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := RestoreSession(v1)
	if err != nil {
		t.Fatalf("v1 restore: %v", err)
	}
	b := NewBridge()
	okEnvelope(t, b.Restore(string(v1), 0.0))
	if persisted(t, s) != b.Snapshot() || !strings.Contains(persisted(t, s), `"v":2`) {
		t.Fatal("v1 restore differs from the bridge's")
	}
}

func TestW2_RestoreRejectsInvalidSnapshots(t *testing.T) {
	good := persisted(t, mustSession(t, 9, Seat0))
	edit := func(from, to string) []byte {
		if !strings.Contains(good, from) {
			t.Fatalf("fixture lacks %q", from)
		}
		return []byte(strings.Replace(good, from, to, 1))
	}
	cases := map[string][]byte{
		"empty":          nil,
		"not json":       []byte(`{`),
		"array":          []byte(`[]`),
		"trailing data":  []byte(good + `{}`),
		"unknown field":  edit(`"ok":true`, `"ok":true,"x":1`),
		"version 3":      edit(`"v":2`, `"v":3`),
		"no version":     edit(`"v":2,`, ``),
		"bad seed":       edit(`"seed":"9"`, `"seed":"nine"`),
		"no seed":        edit(`,"seed":"9"`, ``),
		"dealer 2":       edit(`"dealer":0`, `"dealer":2`),
		"active 7":       edit(`"Active":1`, `"Active":7`),
		"history null":   edit(`"history":[]`, `"history":null`),
		"bad history":    edit(`"history":[]`, `"history":[{"by":0,"kind":0,"subKind":null,"card":null,"targetCard":null,"drawn":null,"description":"","seq":5,"index":0}]`),
		"bad card":       edit(`"Deck":[{"Rank":`, `"Deck":[{"Rank":14,"Suit":0},{"Rank":`),
		"v1 with drawn":  []byte(`{"ok":true,"v":1,"state":{},"history":[{"drawn":null}],"seed":"1","dealer":0}`),
		"history target": edit(`"history":[]`, `"history":[{"by":0,"kind":0,"subKind":null,"card":null,"drawn":null,"description":"","seq":1,"index":0}]`),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			s, err := RestoreSession(raw)
			if s != nil {
				t.Fatal("got a session")
			}
			wantErr(t, name, err, ErrInvalidSnapshot, CodeInvalidSnapshot)
		})
	}
}

// ---------------------------------------------------------------------------
// ServerSnapshot can't be serialized, printed or logged by accident; only
// Envelope is ClientSafe.
// ---------------------------------------------------------------------------

func TestW2_ServerSnapshotRefusesToLeak(t *testing.T) {
	s := mustSession(t, 42, Seat1)
	snap, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	raw := string(snap.PersistBytes())
	if !strings.Contains(raw, `"Deck"`) || !strings.Contains(raw, `"seed":"42"`) {
		t.Fatalf("persist bytes are not the full snapshot: %s", raw)
	}
	// PersistBytes hands out a copy.
	p := snap.PersistBytes()
	p[0] = 'X'
	if string(snap.PersistBytes()) != raw {
		t.Fatal("PersistBytes aliases the snapshot")
	}

	for label, v := range map[string]any{
		"value":   snap,
		"pointer": &snap,
		"field":   struct{ S ServerSnapshot }{snap},
		"in map":  map[string]any{"s": snap},
	} {
		if out, err := json.Marshal(v); err == nil {
			t.Fatalf("json.Marshal(%s) succeeded: %s", label, out)
		} else if !errors.Is(err, ErrSnapshotNotForClients) {
			t.Fatalf("json.Marshal(%s): %v", label, err)
		}
	}
	if _, err := snap.MarshalJSON(); !errors.Is(err, ErrSnapshotNotForClients) {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if _, err := snap.MarshalText(); !errors.Is(err, ErrSnapshotNotForClients) {
		t.Fatalf("MarshalText: %v", err)
	}
	if _, err := snap.MarshalBinary(); !errors.Is(err, ErrSnapshotNotForClients) {
		t.Fatalf("MarshalBinary: %v", err)
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		out := fmt.Sprintf(verb, snap)
		if strings.Contains(out, "Deck") || strings.Contains(out, "Rank") || strings.Contains(out, "7b") || strings.Contains(out, "7B") || len(out) > 64 {
			t.Fatalf("fmt %s leaks the snapshot: %s", verb, out)
		}
	}
	var buf bytes.Buffer
	slog.New(slog.NewTextHandler(&buf, nil)).Info("x", "snap", snap)
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("x", "snap", snap)
	if strings.Contains(buf.String(), "Deck") || strings.Contains(buf.String(), "Rank") {
		t.Fatalf("slog leaks the snapshot: %s", buf.String())
	}
	// Every print form is exactly the marker, and slog shows it without an
	// encoding error.
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		if out := fmt.Sprintf(verb, snap); out != redactedSnapshot {
			t.Fatalf("fmt %s = %q, want %q", verb, out, redactedSnapshot)
		}
	}
	if snap.String() != redactedSnapshot || snap.GoString() != redactedSnapshot {
		t.Fatal("String/GoString not redacted")
	}
	if strings.Count(buf.String(), redactedSnapshot) != 2 || strings.Contains(buf.String(), "ERROR") {
		t.Fatalf("slog: %s", buf.String())
	}

	if _, ok := any(snap).(ClientSafe); ok {
		t.Fatal("ServerSnapshot must not be ClientSafe")
	}
	if _, ok := any(&snap).(ClientSafe); ok {
		t.Fatal("*ServerSnapshot must not be ClientSafe")
	}
	env, _ := s.View(Seat0)
	var safe ClientSafe = env
	if _, ok := safe.(Envelope); !ok {
		t.Fatal("Envelope must be ClientSafe")
	}
	// The zero ServerSnapshot restores to nothing.
	if _, err := RestoreSession(ServerSnapshot{}.PersistBytes()); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("zero snapshot restore: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Commit atomicity (§2.9) with a per-instance renderer.
// ---------------------------------------------------------------------------

func TestW2_ApplyCommitsOnlyIfBothEnvelopesRender(t *testing.T) {
	for _, failSeat := range []Seat{Seat0, Seat1} {
		for seed := uint64(1); seed <= 6; seed++ {
			s := mustSession(t, seed, Seat(seed&1))
			st := mustStatus(t, s)
			before := persisted(t, s)
			s.render = func(g engine.GameState, h []AppliedMove, viewer engine.PlayerID) Envelope {
				if viewer == engine.PlayerID(failSeat) {
					panic("render failed")
				}
				return buildEnvelope(g, h, viewer)
			}
			_, err := s.Apply(st.Actor, st.Seq, 0)
			wantErr(t, fmt.Sprintf("fail seat %d", failSeat), err, ErrInternal, CodeInternal)
			if persisted(t, s) != before || mustStatus(t, s) != st {
				t.Fatalf("fail seat %d seed %d: state committed although an envelope failed", failSeat, seed)
			}
			s.render = nil
			if _, err := s.Apply(st.Actor, st.Seq, 0); err != nil {
				t.Fatalf("apply after restoring the renderer: %v", err)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Concurrency: independent sessions share no mutable state. Run with -race.
// ---------------------------------------------------------------------------

func TestW2_ParallelSessionsShareNoState(t *testing.T) {
	const games = 48
	want := make([]string, games+1)
	for seed := uint64(1); seed <= games; seed++ {
		want[seed] = persisted(t, walkSession(t, seed, func(*Session, Status) {}))
	}
	var wg sync.WaitGroup
	got := make([]string, games+1)
	errs := make(chan string, games*2)
	for round := 0; round < 2; round++ {
		for seed := uint64(1); seed <= games; seed++ {
			wg.Add(1)
			go func(seed uint64, round int) {
				defer wg.Done()
				s, err := NewSession(seed, Seat(seed&1))
				if err != nil {
					errs <- err.Error()
					return
				}
				if round == 1 && seed%4 == 0 {
					// A per-instance failing renderer must not touch any
					// other session running at the same time.
					s.render = func(engine.GameState, []AppliedMove, engine.PlayerID) Envelope { panic("boom") }
					st := mustStatus(t, s)
					if _, err := s.Apply(st.Actor, st.Seq, 0); !errors.Is(err, ErrInternal) {
						errs <- "failing renderer did not fail"
					}
					s.render = nil
				}
				rng := xorshift32(uint32(seed))
				for {
					st := mustStatus(t, s)
					for _, seat := range []Seat{Seat0, Seat1} {
						if _, err := s.View(seat); err != nil {
							errs <- err.Error()
							return
						}
					}
					if st.Over || st.Stuck {
						break
					}
					moves, _, err := s.LegalMoves(st.Actor)
					if err != nil {
						errs <- err.Error()
						return
					}
					if _, err := s.Apply(st.Actor, st.Seq, int(rng()%uint32(len(moves)))); err != nil {
						errs <- err.Error()
						return
					}
				}
				snap, err := s.Snapshot()
				if err != nil {
					errs <- err.Error()
					return
				}
				if round == 0 {
					got[seed] = string(snap.PersistBytes())
				} else if string(snap.PersistBytes()) != want[seed] {
					errs <- "round 1 seed " + strconv.FormatUint(seed, 10) + " diverged"
				}
			}(seed, round)
		}
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	for seed := uint64(1); seed <= games; seed++ {
		if got[seed] != want[seed] {
			t.Errorf("seed %d: parallel game differs from the sequential one", seed)
		}
	}
}

// ---------------------------------------------------------------------------
// Error type.
// ---------------------------------------------------------------------------

func TestW2_ErrorsMatchOnlyTheirOwnSentinel(t *testing.T) {
	sentinels := []errKind{ErrNotYourTurn, ErrStale, ErrIndexOutOfRange, ErrIllegalMove, ErrNoLegalMoves, ErrGameOver, ErrBadSeat, ErrInvalidSnapshot, ErrInternal}
	codes := []Code{CodeNotYourTurn, CodeStale, CodeIndexOutOfRange, CodeIllegalMove, CodeNoLegalMoves, CodeGameOver, CodeBadRequest, CodeInvalidSnapshot, CodeInternal}
	for i, a := range sentinels {
		e := newError(a, "detail text", map[string]any{"k": 1})
		if e.Code != codes[i] || a.code() != codes[i] || !strings.Contains(e.Error(), string(codes[i])) || !strings.Contains(e.Error(), "detail text") {
			t.Fatalf("%s: %v", codes[i], e)
		}
		if a.Error() != string(codes[i])+": "+string(a) {
			t.Fatalf("sentinel text %q", a.Error())
		}
		for j, b := range sentinels {
			if errors.Is(e, b) != (i == j) {
				t.Fatalf("errors.Is(%s instance, %s) = %v", codes[i], codes[j], i != j)
			}
		}
		// A foreign error with the same text, or an *Error with no kind,
		// matches nothing.
		if errors.Is(errors.New(a.Error()), a) || errors.Is(&Error{Code: codes[i], Message: string(a)}, a) {
			t.Fatalf("%s: a lookalike error matched the sentinel", codes[i])
		}
	}
	// ErrBadSeat shares BAD_REQUEST's wire code but is its own sentinel.
	if ErrBadSeat.code() != CodeBadRequest {
		t.Fatal("ErrBadSeat code")
	}
}

// ---------------------------------------------------------------------------
// Reflection-level leaks: fmt and slog don't call Format/String/LogValue on
// a value they reach through an unexported field (it can't be turned back
// into an interface), so they print its fields raw. Nothing a ServerSnapshot
// or an Update holds may be reachable that way, at any depth.
// ---------------------------------------------------------------------------

// leakForms returns tok as it would look in the output of every printer we
// check: raw, %q-escaped, %v of a []byte (decimal), %x, and %#v of a []byte.
func leakForms(tok string) []string {
	b := []byte(tok)
	dec := make([]string, len(b))
	gox := make([]string, len(b))
	for i, c := range b {
		dec[i] = strconv.Itoa(int(c))
		gox[i] = fmt.Sprintf("0x%x", c)
	}
	q := strconv.Quote(tok)
	return []string{tok, q[1 : len(q)-1], strings.Join(dec, " "), hex.EncodeToString(b), strings.ToUpper(hex.EncodeToString(b)), strings.Join(gox, ", ")}
}

func assertNoLeak(t *testing.T, label, out string, tokens []string, maxLen int) {
	t.Helper()
	for _, tok := range tokens {
		for _, form := range leakForms(tok) {
			if strings.Contains(out, form) {
				t.Fatalf("%s leaks %q (as %q): %.400s", label, tok, form, out)
			}
		}
	}
	if len(out) > maxLen {
		t.Fatalf("%s printed %d bytes (cap %d), content is reachable: %.400s", label, len(out), maxLen, out)
	}
}

// printAll renders v with every fmt verb a log line might use, slog's text
// and JSON handlers, encoding/json and gob, and returns labelled outputs.
// Encoding errors are fine (a refusal is not a leak); their text is checked
// too.
func printAll(v any) map[string]string {
	out := map[string]string{}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s"} {
		out["fmt "+verb] = fmt.Sprintf(verb, v)
	}
	var tb, jb bytes.Buffer
	slog.New(slog.NewTextHandler(&tb, nil)).Info("x", "v", v)
	slog.New(slog.NewJSONHandler(&jb, nil)).Info("x", "v", v)
	out["slog text"] = tb.String()
	out["slog json"] = jb.String()
	j, err := json.Marshal(v)
	out["json"] = string(j) + fmt.Sprint(err)
	var gb bytes.Buffer
	err = gob.NewEncoder(&gb).Encode(v)
	out["gob"] = gb.String() + fmt.Sprint(err)
	return out
}

type snapRoom struct{ snap ServerSnapshot }

type snapNest struct {
	room  snapRoom
	byID  map[string]ServerSnapshot
	list  []ServerSnapshot
	ptr   *ServerSnapshot
	arr   [1]ServerSnapshot
	iface any
	Pub   int // gives gob something to encode
}

func TestW2_ServerSnapshotUnreachableByReflection(t *testing.T) {
	s := mustSession(t, 42, Seat1)
	snap, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	raw := string(snap.PersistBytes())
	deckCard := jsonOf(t, s.g.state.Deck[0])
	tokens := []string{`"Deck"`, deckCard, `"seed":"42"`, `{"ok":true`}
	for _, tok := range tokens {
		if !strings.Contains(raw, tok) {
			t.Fatalf("precondition: snapshot lacks %q", tok)
		}
	}
	nest := snapNest{
		room:  snapRoom{snap},
		byID:  map[string]ServerSnapshot{"r": snap},
		list:  []ServerSnapshot{snap},
		ptr:   &snap,
		arr:   [1]ServerSnapshot{snap},
		iface: snap,
		Pub:   1,
	}
	for label, v := range map[string]any{
		"unexported field":  snapRoom{snap},
		"pointer to room":   &snapRoom{snap},
		"nest":              nest,
		"pointer to nest":   &nest,
		"slice of nest":     []snapNest{nest},
		"map of nest":       map[string]snapNest{"n": nest},
		"nest in any field": struct{ v any }{nest},
	} {
		for how, out := range printAll(v) {
			assertNoLeak(t, label+" / "+how, out, tokens, 1200)
		}
	}
	// Direct gob of a snapshot, or of a struct exporting one, refuses loudly.
	for label, v := range map[string]any{"value": snap, "exported field": struct{ S ServerSnapshot }{snap}} {
		var gb bytes.Buffer
		if err := gob.NewEncoder(&gb).Encode(v); !errors.Is(err, ErrSnapshotNotForClients) {
			t.Fatalf("gob %s: err = %v, want ErrSnapshotNotForClients", label, err)
		}
		assertNoLeak(t, "gob "+label, gb.String(), tokens, 1200)
	}
}

type updRoom struct{ last Update }

type updNest struct {
	room  updRoom
	byID  map[string]Update
	list  []Update
	ptr   *Update
	iface any
	Pub   int
}

func TestW2_UpdateCannotBeSentWhole(t *testing.T) {
	s := mustSession(t, 42, Seat1)
	st := mustStatus(t, s)
	up, err := s.Apply(st.Actor, st.Seq, 0)
	if err != nil {
		t.Fatal(err)
	}
	// The envelopes are reachable only through For.
	ty := reflect.TypeOf(up)
	for i := 0; i < ty.NumField(); i++ {
		f := ty.Field(i)
		if f.IsExported() && strings.Contains(f.Type.String(), "Envelope") {
			t.Fatalf("Update exports %s %s", f.Name, f.Type)
		}
	}
	env0, env1 := up.For(Seat0), up.For(Seat1)
	if !env0.OK || !env1.OK || up.Seq != 1 || up.Mover != st.Actor {
		t.Fatalf("update content: seq %d mover %d ok %v/%v", up.Seq, up.Mover, env0.OK, env1.OK)
	}
	// For hands out a fresh copy each call.
	scribble(&env0)
	if jsonOf(t, up.For(Seat0)) == jsonOf(t, env0) {
		t.Fatal("For aliases the Update's envelope")
	}
	w0, w1 := jsonOf(t, up.For(Seat0)), jsonOf(t, up.For(Seat1))
	hand0 := jsonOf(t, s.g.state.Players[0].Hand[0])
	hand1 := jsonOf(t, s.g.state.Players[1].Hand[0])
	if !strings.Contains(w0, hand0) || !strings.Contains(w1, hand1) || !strings.Contains(w0+w1, "draw a card") {
		t.Fatal("precondition: envelopes lack the tokens this test searches for")
	}
	tokens := []string{hand0, hand1, "draw a card", `"legalMoves"`}
	fields := []string{"Hand", "Descriptions", "LegalMoves", "Envelopes", "OK:true"}

	// Top level: every encoder refuses, every print form is the marker.
	want := fmt.Sprintf("game.Update(seq=%d, mover=%d, redacted)", up.Seq, up.Mover)
	for label, v := range map[string]any{"value": up, "pointer": &up, "field": struct{ U Update }{up}, "in map": map[string]any{"u": up}} {
		if out, err := json.Marshal(v); !errors.Is(err, ErrUpdateNotForClients) {
			t.Fatalf("json.Marshal(%s) = %s, %v; want ErrUpdateNotForClients", label, out, err)
		}
		var gb bytes.Buffer
		if err := gob.NewEncoder(&gb).Encode(v); !errors.Is(err, ErrUpdateNotForClients) && label != "in map" {
			t.Fatalf("gob(%s): %v; want ErrUpdateNotForClients", label, err)
		}
	}
	if _, err := up.MarshalJSON(); !errors.Is(err, ErrUpdateNotForClients) {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if _, err := up.MarshalText(); !errors.Is(err, ErrUpdateNotForClients) {
		t.Fatalf("MarshalText: %v", err)
	}
	if _, err := up.MarshalBinary(); !errors.Is(err, ErrUpdateNotForClients) {
		t.Fatalf("MarshalBinary: %v", err)
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		if out := fmt.Sprintf(verb, up); out != want {
			t.Fatalf("fmt %s = %q, want %q", verb, out, want)
		}
	}
	if up.String() != want || up.GoString() != want {
		t.Fatalf("String/GoString: %q %q", up.String(), up.GoString())
	}
	var tb, jb bytes.Buffer
	slog.New(slog.NewTextHandler(&tb, nil)).Info("x", "up", up)
	slog.New(slog.NewJSONHandler(&jb, nil)).Info("x", "up", up)
	for label, out := range map[string]string{"text": tb.String(), "json": jb.String()} {
		if !strings.Contains(out, "redacted") || strings.Contains(out, "ERROR") {
			t.Fatalf("slog %s: %s", label, out)
		}
	}

	// Nested where the methods can't run.
	nest := updNest{room: updRoom{up}, byID: map[string]Update{"r": up}, list: []Update{up}, ptr: &up, iface: up, Pub: 1}
	for label, v := range map[string]any{
		"unexported field": updRoom{up},
		"pointer to room":  &updRoom{up},
		"nest":             nest,
		"pointer to nest":  &nest,
		"slice of nest":    []updNest{nest},
	} {
		for how, out := range printAll(v) {
			assertNoLeak(t, label+" / "+how, out, append(tokens, fields...), 1200)
		}
	}
	if _, ok := any(up).(ClientSafe); ok {
		t.Fatal("Update must not be ClientSafe")
	}
	// The zero Update gives zero envelopes and still prints redacted.
	var zero Update
	if z := zero.For(Seat0); z.OK {
		t.Fatal("zero Update.For must be the zero Envelope")
	}
	if fmt.Sprint(zero) != "game.Update(seq=0, mover=0, redacted)" {
		t.Fatalf("zero update prints %q", fmt.Sprint(zero))
	}
}

// ---------------------------------------------------------------------------
// Sentinels are immutable.
// ---------------------------------------------------------------------------

func allSentinels() []error {
	return []error{ErrNotYourTurn, ErrStale, ErrIndexOutOfRange, ErrIllegalMove, ErrNoLegalMoves, ErrGameOver, ErrBadSeat, ErrInvalidSnapshot, ErrInternal}
}

func TestW2_SentinelsAreImmutable(t *testing.T) {
	before := map[int]string{}
	for i, sen := range allSentinels() {
		before[i] = sen.Error()
		// No exported sentinel may be a pointer: through a pointer, a type
		// assertion would reach the shared value and rewrite it.
		if k := reflect.ValueOf(sen).Kind(); k == reflect.Ptr || k == reflect.Map || k == reflect.Slice {
			t.Fatalf("sentinel %v is a %s; its fields are writable through the exported name", sen, k)
		}
		if p, ok := any(sen).(*Error); ok {
			p.Code, p.Message = "HIJACKED", "hijacked"
		}
	}
	// Mutate every field of real returned errors.
	s := mustSession(t, 42, Seat1)
	st := mustStatus(t, s)
	for _, call := range []func() error{
		func() error { _, err := s.Apply(st.Actor, st.Seq+1, 0); return err },
		func() error { _, err := s.Apply(st.Actor.Other(), st.Seq, 0); return err },
		func() error { _, err := s.View(7); return err },
		func() error { _, err := RestoreSession(nil); return err },
	} {
		err := call()
		var ge *Error
		if !errors.As(err, &ge) {
			t.Fatalf("not an *Error: %v", err)
		}
		ge.Code, ge.Message = "HIJACKED", "hijacked"
		ge.Detail = map[string]any{"x": 1}
	}
	for i, sen := range allSentinels() {
		if sen.Error() != before[i] || strings.Contains(sen.Error(), "HIJACKED") {
			t.Fatalf("sentinel %d changed: %q -> %q", i, before[i], sen.Error())
		}
	}
	_, err := s.Apply(st.Actor, st.Seq+1, 0)
	wantErr(t, "stale after mutation", err, ErrStale, CodeStale)
	_, err = s.Apply(st.Actor.Other(), st.Seq, 0)
	wantErr(t, "not your turn after mutation", err, ErrNotYourTurn, CodeNotYourTurn)
}

// ---------------------------------------------------------------------------
// RestoreSession renders both seats before it returns (the Bridge.Restore
// render-before-commit check).
// ---------------------------------------------------------------------------

func TestW2_RestoreRendersBothSeatsBeforeReturning(t *testing.T) {
	// The engine and validateState leave no known snapshot that decodes yet
	// fails to render (a 40-seed mutation fuzz of phase, pending, reveals and
	// out-of-range targets found none), so the render failure is injected
	// through the per-instance renderer, as in the Apply atomicity test.
	good := []byte(persisted(t, mustSession(t, 9, Seat0)))
	for _, failSeat := range []Seat{Seat0, Seat1} {
		var rendered [2]int
		render := func(g engine.GameState, h []AppliedMove, viewer engine.PlayerID) Envelope {
			rendered[viewer]++
			if viewer == engine.PlayerID(failSeat) {
				panic("render failed")
			}
			return buildEnvelope(g, h, viewer)
		}
		s, err := restoreSession(good, render)
		if s != nil {
			t.Fatalf("fail seat %d: got a session", failSeat)
		}
		wantErr(t, fmt.Sprintf("fail seat %d", failSeat), err, ErrInvalidSnapshot, CodeInvalidSnapshot)
		if rendered[failSeat] == 0 {
			t.Fatalf("fail seat %d was never rendered", failSeat)
		}
	}
	var rendered [2]int
	s, err := restoreSession(good, func(g engine.GameState, h []AppliedMove, viewer engine.PlayerID) Envelope {
		rendered[viewer]++
		return buildEnvelope(g, h, viewer)
	})
	if err != nil || s == nil || rendered[0] == 0 || rendered[1] == 0 {
		t.Fatalf("good restore: %v, renders %v", err, rendered)
	}
	if persisted(t, s) != string(good) {
		t.Fatal("good restore is not exact")
	}
}
