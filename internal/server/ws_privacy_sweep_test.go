package server

// Wire privacy sweep (two-phone W9, plan §12, R24.4). Two real WebSocket
// clients play seeded games through the real HTTP API, room manager, store
// and socket stack, and every frame either seat receives is checked
// against the engine's full state at that moment. The crafted scripts of
// ws_counter_test.go run through the same checks, so the rare counter-
// rewind shapes (a pending win, a dead-end 7) are covered by construction.
//
// The check is built from what SPEC §3.2 says a seat may see, not from a
// list of hidden zones: specVisible collects the cards a seat may see at a
// seq (its own hand, every point card and Jack, both permanents, the scrap,
// the pending one-off and its counter chain, the opponent's hand only under
// the seat's own glasses, the 7's reveal only for the seat choosing it).
// Every other card of the 52 is hidden, wherever the engine keeps it (the
// other hand, the deck, the other seat's 7 reveal, or a zone added later).
//
//   - Outside history, every card a frame names, as a {Rank, Suit} object
//     (a partial one counts) or as card text in any string, must be visible
//     to the seat now.
//   - Each history entry (and lastMove) may name only cards the seat could
//     see just before or just after that move. Its targetCard is null or a
//     card on the board before the move (points, Jacks, permanents). Its
//     description names only its card and targetCard, and on the seat's own
//     entries it is exactly Move.Describe(pre) of the move at its index.
//   - No hand position reaches a seat except in its own entries and its own
//     legal-move descriptions (issue #69): an entry the other seat made
//     carries no "hand[" text and no digit outside a card name, and nothing
//     else in a state frame carries "hand[".
//   - Frames other than state name no card at all.
//   - The envelope decodes strictly against the SPEC §2.7 shape, so a new
//     field fails even if it holds no card; the other frames decode
//     strictly against SPEC §2.12.2; each error's message is its fixed text.
//   - The §3.2 derivations are checked against the engine truth: hands,
//     counts, opponent.hand null without glasses, you.watched,
//     sevenRevealed only for the actor, the pending one-off, history index
//     only on the seat's own entries, and every Target in range.
//   - There is no counter hold (engine v0.3.0, issue #93, SPEC §2.12.5):
//     no responding frame is ever sent, every move reaches both seats as
//     state, and a reconnecting seat gets welcome then state.
//   - The counter rewind's view rules hold against the engine truth:
//     counterable is engine.CounterAvailable and owedDiscards is Owed, for
//     both seats; no legacy counter window (phase 1) opens; a Counter is
//     offered only when counterable and only at the end of the list; phase
//     3 with no pending offers only DiscardPair and Counter; phase 5 offers
//     the Counters then exactly one Decline ("Let it happen"), and Decline
//     appears nowhere else.
//   - Canaries: on real frames the sweep plants a hidden card (outside
//     history, in a history description, in a non-state frame) and hand
//     position text (in the other seat's latest entry), and requires the
//     check to flag each one, so a check gone blind fails the sweep.
//
// The duo driver's own checks (envelope equals the seat's View at that seq,
// no hidden card outside history, no seed, deck, snapshot or token) run on
// every frame as well.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// sweepSeedCount is the plan's range, seeds 1–240. -short walks every 7th.
const sweepSeedCount = 240

// seedPlan says what a seed does besides playing its game to the end.
type seedPlan struct {
	preferOneOff bool
	reconnectAt  int // ply at which a random seat drops and rejoins (-1: never)
	errorsAt     int // ply at which the seats send refused frames (-1: never)
	rematch      bool
}

func planFor(seed uint64) seedPlan {
	p := seedPlan{preferOneOff: seed%2 == 0, reconnectAt: -1, errorsAt: -1}
	if seed%3 == 1 {
		p.reconnectAt = 2 + int(seed%17)
	}
	if seed%4 == 2 {
		p.errorsAt = 2 + int(seed%13)
	}
	p.rematch = seed%8 == 3
	return p
}

type sweepCov struct {
	coverage
	games, frames, states                                  int
	canaries, historyEntries, ownDescriptions, targetCards int
	reconnects, errorFrames, rematchGames                  int
	// otherDiscards counts the other seat's DiscardPair entries checked for
	// position text (issue #69).
	otherDiscards int
}

// add sums every int field, the embedded coverage's included.
func (c *sweepCov) add(o sweepCov) {
	for _, p := range [][2]*int{
		{&c.games, &o.games}, {&c.frames, &o.frames}, {&c.states, &o.states},
		{&c.canaries, &o.canaries}, {&c.historyEntries, &o.historyEntries},
		{&c.ownDescriptions, &o.ownDescriptions}, {&c.targetCards, &o.targetCards},
		{&c.reconnects, &o.reconnects}, {&c.errorFrames, &o.errorFrames}, {&c.rematchGames, &o.rematchGames},
		{&c.otherDiscards, &o.otherDiscards},
	} {
		*p[0] += *p[1]
	}
	c.coverage.add(o.coverage)
}

// TestW9_SweepCovAddsEveryField keeps add in step with the counters.
func TestW9_SweepCovAddsEveryField(t *testing.T) {
	var one sweepCov
	v := reflect.ValueOf(&one).Elem()
	n := 0
	var fill func(reflect.Value)
	fill = func(v reflect.Value) {
		for i := range v.NumField() {
			switch f := v.Field(i); f.Kind() {
			case reflect.Int:
				reflect.NewAt(f.Type(), f.Addr().UnsafePointer()).Elem().SetInt(1)
				n++
			case reflect.Struct:
				fill(f)
			}
		}
	}
	fill(v)
	var sum sweepCov
	sum.add(one)
	if !reflect.DeepEqual(sum, one) {
		t.Fatalf("add misses a field: %+v", sum)
	}
	if n < 20 {
		t.Fatalf("only %d counters", n)
	}
}

// TestW9_WirePrivacySweep plays all 240 seeds. It is opt-in: it runs only
// when CUTTLE_SWEEP=1 is set (a few minutes), e.g.
//
//	CUTTLE_SWEEP=1 go test ./internal/server/ -run TestW9_WirePrivacySweep
func TestW9_WirePrivacySweep(t *testing.T) {
	if os.Getenv("CUTTLE_SWEEP") != "1" {
		t.Skip("set CUTTLE_SWEEP=1 to run the 240-seed wire sweep")
	}
	var (
		mu    sync.Mutex
		total sweepCov
		ran   int
	)
	start := time.Now()
	t.Run("seeds", func(t *testing.T) {
		for seed := uint64(1); seed <= sweepSeedCount; seed++ {
			t.Run(fmt.Sprintf("seed%03d", seed), func(t *testing.T) {
				t.Parallel()
				c := sweepOneSeed(t, seed, planFor(seed))
				mu.Lock()
				total.add(c)
				ran++
				mu.Unlock()
			})
		}
		// The crafted scripts (ws_counter_test.go) reach the rare counter-
		// rewind shapes by construction: a pending win and Let it happen, an
		// owed discard, a dead-end 7, a countered 7 and 5, a counter-back.
		for _, sc := range craftedScripts {
			t.Run("crafted/"+sc.name, func(t *testing.T) {
				t.Parallel()
				c := sweepCrafted(t, sc)
				mu.Lock()
				total.add(c)
				mu.Unlock()
			})
		}
	})
	if t.Failed() {
		return
	}
	t.Logf("%d seeds and %d crafted games in %v: %+v", ran, len(craftedScripts), time.Since(start).Round(time.Millisecond), total)
	if ran != sweepSeedCount {
		return // a -run filter picked some seeds; coverage is judged on the whole range
	}
	must := map[string]int{
		"glasses": total.glasses, "a 7 reveal": total.sevenReveal, "a game over": total.gameOver,
		"a reconnect": total.reconnects, "an error frame": total.errorFrames, "a rematch game": total.rematchGames,
		"a caught canary": total.canaries, "a history entry": total.historyEntries,
		"a checked own description": total.ownDescriptions, "a history targetCard": total.targetCards,
	}
	// Edge cases that depend on the deal: judged on the full 1–240 range.
	for name, n := range map[string]int{
		"a counter": total.counter, "a counter-back": total.counterChain2,
		"a countered 7": total.counteredSeven, "a countered 5": total.counteredFive,
		"an owed discard paid at turn start": total.owedDiscard, "a pending win (phase 5)": total.pendingWin,
		"Let it happen": total.letItHappen, "a 4 discard": total.fourDiscard,
		"a 3 taking a scrap card": total.threeFromScrap, "a 9 returning a card to a hand": total.nineToHand,
		"a 5 drawing": total.fiveDraw, "a Jack changing control": total.jackControl,
		"a dead-end 7": total.deadSeven, "glasses leaving play": total.glassesGone,
		"the other seat's DiscardPair entry": total.otherDiscards,
	} {
		must[name] = n
	}
	for name, n := range must {
		if n == 0 {
			t.Errorf("the sweep never exercised %s: %+v", name, total)
		}
	}
}

// ---- one seed ----

type sweeper struct {
	t    *testing.T
	d    *duo
	plan seedPlan
	cov  sweepCov
	// Per game (cacheGame): each seat's visible set around history entry
	// seq n (entryVis), and the entry bytes already checked (entryOK).
	cacheGame int
	entryVis  [2]map[int]map[cardKey]bool
	entryOK   [2]map[string]bool
	nStates   int
}

func sweepOneSeed(t *testing.T, seed uint64, plan seedPlan) sweepCov {
	e := newPlayEnv(t, playOpts{rand: seededRand(seed)})
	defer e.stop()
	s := &sweeper{t: t, plan: plan}
	s.d = newObservedDuo(t, e, seed, func(d *duo, seat game.Seat, f frameIn) {
		s.d = d // set before newObservedDuo returns, for the opening frames
		s.see(seat, f)
	})
	s.d.preferOneOff = plan.preferOneOff
	s.playGame()
	if plan.rematch {
		s.rematch()
		s.playGame()
		s.cov.rematchGames++
	}
	s.cov.coverage = s.d.cov
	return s.cov
}

// sweepCrafted plays one crafted script with every frame through the
// sweeper's checks.
func sweepCrafted(t *testing.T, sc craftedScript) sweepCov {
	e := newPlayEnv(t, playOpts{})
	defer e.stop()
	s := &sweeper{t: t}
	s.d = newCraftedDuo(t, e, sc.start(), func(d *duo, seat game.Seat, f frameIn) {
		s.d = d // set before newCraftedDuo returns, for the opening frames
		s.see(seat, f)
	})
	for _, st := range sc.steps {
		s.d.playDesc(st.by, st.desc)
	}
	s.sync()
	if s.d.st().Over {
		s.d.cov.gameOver++
		s.cov.games++
	}
	s.cov.coverage = s.d.cov
	return s.cov
}

// playGame plays the current game to the end, with the plan's reconnect,
// and refused frames on the way.
func (s *sweeper) playGame() {
	d, t := s.d, s.t
	t.Helper()
	reconnected, errored := false, false
	for guard := 0; guard < 5000; guard++ {
		if d.st().Over && d.bothSee(d.truth.Seq()) {
			d.cov.gameOver++
			s.cov.games++
			return
		}
		ply := d.truth.Seq()
		if !reconnected && s.plan.reconnectAt >= 0 && ply >= s.plan.reconnectAt {
			reconnected = true
			s.rejoin(game.Seat(d.rng.IntN(2)))
			continue
		}
		if !errored && s.plan.errorsAt >= 0 && ply >= s.plan.errorsAt {
			errored = true
			s.refusedFrames()
			continue
		}
		if seat, env, ok := d.ready(); ok {
			if len(env.LegalMoves) == 0 {
				t.Fatalf("seat %d on turn with no legal move at seq %d", seat, env.Seq)
			}
			d.move(seat, d.pick(env))
			continue
		}
		if !d.pump(5 * time.Second) {
			t.Fatalf("stalled at seq %d (actor %d)", d.truth.Seq(), d.st().Actor)
		}
	}
	t.Fatal("game did not end")
}

// quiet reports whether every sent move has reached both seats: each has
// the current envelope.
func (s *sweeper) quiet() bool { return s.d.bothSee(s.d.truth.Seq()) }

// sync pumps until quiet: an event, not a quiet time window, so a loaded
// machine can't cut it short.
func (s *sweeper) sync() {
	s.t.Helper()
	for !s.quiet() {
		if !s.d.pump(5 * time.Second) {
			s.t.Fatalf("no frame while waiting for the seats to catch up (seq %d)", s.d.truth.Seq())
		}
	}
}

// nextFrame returns seat's next frame other than presence; presence frames
// (the other seat dropping or rejoining) go through the duo as usual.
func (s *sweeper) nextFrame(seat game.Seat) frameIn {
	s.t.Helper()
	for {
		f := s.d.p[seat].next(5 * time.Second)
		if f.T != "presence" {
			return f
		}
		s.d.absorb(seat, f)
	}
}

// rejoin drops seat's socket mid-game, with frames possibly in flight,
// and says hello again on a new one.
func (s *sweeper) rejoin(seat game.Seat) {
	d, t := s.d, s.t
	t.Helper()
	old := d.p[seat]
	// A move this seat just sent must reach the server before the drop, or
	// the close can beat it and the move is lost (the truth has already
	// applied it). Frames to the seat may still be in flight.
	for deadline := time.Now().Add(5 * time.Second); d.e.roomSeq(t, d.code) != d.truth.Seq(); {
		if time.Now().After(deadline) {
			t.Fatalf("the server never applied seq %d", d.truth.Seq())
		}
		time.Sleep(2 * time.Millisecond)
	}
	_ = old.c.CloseNow()
	<-old.done
	for drained := false; !drained; {
		select {
		case f := <-old.in: // received before the drop: checked like any other
			d.absorb(seat, f)
		default:
			drained = true
		}
	}
	w, _, err := d.e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	w.seat, w.token = seat, old.token
	w.hello(d.code, old.token)
	fw := w.expect("welcome")
	s.see(seat, fw)
	wel := decodeFrame[welcomeIn](t, fw)
	if wel.Seat != int(seat) || wel.Names[0] == nil || wel.Names[1] == nil {
		t.Fatalf("rejoin welcome %s", fw.raw)
	}
	d.p[seat] = w
	// No hold: the rejoin is welcome then the current state, always.
	f := s.nextFrame(seat)
	if f.T != "state" {
		t.Fatalf("seat %d rejoined to %s", seat, f.raw)
	}
	d.absorb(seat, f)
	s.cov.reconnects++
}

// roomSeq is the loaded room's session seq.
func (e *playEnv) roomSeq(t *testing.T, code string) int {
	t.Helper()
	r := e.liveRoom(t, code)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sess == nil {
		return -1
	}
	return r.sess.Seq()
}

// refusedFrames sends frames the server refuses: a move out of turn, a
// stale seq, a stale game, an index out of range and an early rematch.
// Error frames and the resync states go through the same checks.
func (s *sweeper) refusedFrames() {
	d, t := s.d, s.t
	t.Helper()
	s.sync()
	if d.st().Over {
		return
	}
	actor := d.st().Actor
	other := actor.Other()
	seq := d.truth.Seq()
	g := d.gameNo
	move := func(game, seq, index int) map[string]any {
		return map[string]any{"t": "move", "game": game, "seq": seq, "index": index}
	}
	s.refused(other, move(g, seq, 0), CodeNotYourTurn, &seq, true)
	old := seq - 1
	s.refused(actor, move(g, old, 0), CodeStale, &old, true)
	s.refused(actor, move(g+1, seq, 0), CodeStale, &seq, true)
	s.refused(actor, move(g, seq, 999), CodeIndexOutOfRange, &seq, false)
	s.refused(actor, map[string]any{"t": "rematch", "game": g}, CodeBadRequest, nil, false)
}

// refused sends v from seat and checks the error (its seq echoes the sent
// one, nothing more) and, when resync, the state after it.
func (s *sweeper) refused(seat game.Seat, v map[string]any, code string, seq *int, resync bool) {
	d, t := s.d, s.t
	t.Helper()
	d.p[seat].send(v)
	f := s.nextFrame(seat)
	s.see(seat, f)
	er := decodeFrame[errorIn](t, f)
	if er.Code != code {
		t.Fatalf("seat %d sent %v: got %s, want %s", seat, v, f.raw, code)
	}
	if (er.Seq == nil) != (seq == nil) || (seq != nil && *er.Seq != *seq) {
		t.Fatalf("seat %d: error %s echoes seq %v, sent %v", seat, f.raw, er.Seq, seq)
	}
	s.cov.errorFrames++
	if resync {
		f := s.nextFrame(seat)
		if f.T != "state" {
			t.Fatalf("seat %d: after %s got %s, want state", seat, code, f.raw)
		}
		d.absorb(seat, f)
	}
}

// rematch asks for a rematch from a random seat, lets the other accept and
// starts the new game's truth.
func (s *sweeper) rematch() {
	d, t := s.d, s.t
	t.Helper()
	s.sync()
	asker := game.Seat(d.rng.IntN(2))
	d.p[asker].send(map[string]any{"t": "rematch", "game": d.gameNo})
	asked := func() bool {
		return d.rematch[0] != nil && *d.rematch[0] == int(asker) && d.rematch[1] != nil && *d.rematch[1] == int(asker)
	}
	for !asked() {
		if !d.pump(5 * time.Second) {
			t.Fatalf("rematch requests not announced: %v %v", d.rematch[0], d.rematch[1])
		}
	}
	d.p[asker.Other()].send(map[string]any{"t": "rematch", "game": d.gameNo})
	f0, f1 := s.nextFrame(0), s.nextFrame(1)
	if f0.T != "state" || f1.T != "state" {
		t.Fatalf("rematch dealt %s / %s", f0.raw, f1.raw)
	}
	d.startGame(t)
	d.absorb(0, f0)
	d.absorb(1, f1)
}

// ---- the per-frame check ----

// see runs on every frame either seat receives, after the duo's own checks.
func (s *sweeper) see(seat game.Seat, f frameIn) {
	t := s.t
	t.Helper()
	s.cov.frames++
	if v := s.violations(seat, f, &s.cov); len(v) > 0 {
		t.Fatalf("seat %d: %s\nframe: %s", seat, strings.Join(v, "; "), f.raw)
	}
	s.canary(seat, f)
}

// violations lists every way frame f breaks the privacy rules for seat.
// tally, when set, counts what was checked.
func (s *sweeper) violations(seat game.Seat, f frameIn, tally *sweepCov) []string {
	var raw map[string]any
	if err := json.Unmarshal(f.raw, &raw); err != nil {
		return []string{"not a JSON object"}
	}
	var v []string
	decode := func(into any) {
		if err := strictDecodeErr(f.raw, into); err != nil {
			v = append(v, err.Error())
		}
	}
	switch f.T {
	case "state":
		if tally != nil {
			tally.states++
		}
		return s.stateViolations(seat, f, raw, tally)
	case "welcome":
		decode(new(welcomeIn))
	case "presence":
		decode(new(presenceIn))
	case "rematch":
		decode(new(rematchIn))
	case "error":
		var er errorIn
		decode(&er)
		if msg, ok := errorMessages[er.Code]; !ok || er.Message != msg {
			v = append(v, "error message is not the code's fixed text")
		}
	case "pong":
		decode(new(struct {
			T string `json:"t"`
		}))
	default:
		// responding included: there is no counter hold since issue #93
		// (SPEC §2.12.5), so the server never sends one.
		v = append(v, "unknown frame type")
	}
	// Room metadata names no card, as an object or as text.
	cardMentions(raw, func(k cardKey) {
		v = append(v, fmt.Sprintf("%s frame names card %v", f.T, k))
	})
	return v
}

func (s *sweeper) stateViolations(seat game.Seat, f frameIn, raw map[string]any, tally *sweepCov) []string {
	d := s.d
	var fr struct {
		T              string          `json:"t"`
		Game           int             `json:"game"`
		Envelope       json.RawMessage `json:"envelope"`
		OpponentOnline bool            `json:"opponentOnline"`
		Tally          [2]int          `json:"tally"`
	}
	if err := strictDecodeErr(f.raw, &fr); err != nil {
		return []string{err.Error()}
	}
	var env specEnvelope
	if err := strictDecodeErr(fr.Envelope, &env); err != nil {
		return []string{"envelope: " + err.Error()}
	}
	if fr.Game != d.gameNo || env.Seq < 0 || env.Seq >= len(d.truths) {
		return []string{fmt.Sprintf("state for game %d seq %d; truth is game %d with %d seqs", fr.Game, env.Seq, d.gameNo, len(d.truths))}
	}
	st := d.truths[env.Seq].st
	v := specDerivations(seat, env, raw["envelope"].(map[string]any), st)
	return append(v, s.mentionViolations(seat, raw, env.Seq, tally)...)
}

// mentionViolations checks every card a state frame names: outside history
// against what seat sees now, and each history entry on its own.
func (s *sweeper) mentionViolations(seat game.Seat, raw map[string]any, seq int, tally *sweepCov) []string {
	var v []string
	visible := specVisible(s.d.truths[seq].st, seat)
	envRaw, _ := raw["envelope"].(map[string]any)
	outer, outerEnv := map[string]any{}, map[string]any{}
	for k, x := range raw {
		outer[k] = x
	}
	var entries []any
	for k, x := range envRaw {
		switch k {
		case "history":
			h, _ := x.([]any)
			entries = append(entries, h...)
		case "lastMove":
			if x != nil {
				entries = append(entries, x)
			}
		default:
			outerEnv[k] = x
		}
	}
	outer["envelope"] = outerEnv
	cardMentions(outer, func(k cardKey) {
		if !visible[k] {
			v = append(v, fmt.Sprintf("names %v, hidden from it at seq %d (SPEC §3.2)", k, seq))
		}
	})
	// Outside history, only the actor's own option list may name a hand
	// position (issue #69).
	stringsOutside(outer, "descriptions", func(x string) {
		if handPosition.MatchString(x) {
			v = append(v, fmt.Sprintf("names a hand position outside history: %q (issue #69)", x))
		}
	})
	for _, e := range entries {
		m, ok := e.(map[string]any)
		if !ok {
			v = append(v, "history entry is not an object")
			continue
		}
		v = append(v, s.entryViolations(seat, m, seq, tally)...)
	}
	return v
}

// entryViolations checks one history entry: the cards it names must have
// been visible to seat just before or just after that move; targetCard is
// null or a card on the board before it; the description names only the
// entry's card and targetCard, and on seat's own entries it is exactly the
// engine's Describe of the move at the entry's index.
func (s *sweeper) entryViolations(seat game.Seat, e map[string]any, seq int, tally *sweepCov) []string {
	d := s.d
	if s.cacheGame != d.gameNo {
		s.cacheGame = d.gameNo
		s.entryVis = [2]map[int]map[cardKey]bool{{}, {}}
		s.entryOK = [2]map[string]bool{{}, {}}
	}
	b, _ := json.Marshal(e)
	if s.entryOK[seat][string(b)] {
		return nil
	}
	es := -1
	if x, ok := e["seq"].(float64); ok {
		es = int(x)
	}
	if es < 1 || es > seq {
		return []string{fmt.Sprintf("history entry seq %d outside 1..%d", es, seq)}
	}
	pre, post := d.truths[es-1].st, d.truths[es].st
	vis := s.entryVis[seat][es]
	if vis == nil {
		vis = specVisible(pre, seat)
		for k := range specVisible(post, seat) {
			vis[k] = true
		}
		s.entryVis[seat][es] = vis
	}
	var v []string
	cardMentions(e, func(k cardKey) {
		if !vis[k] {
			v = append(v, fmt.Sprintf("history entry %d names %v, not visible to the seat before or after that move", es, k))
		}
	})
	own := map[cardKey]bool{}
	for _, field := range []string{"card", "targetCard"} {
		cardMentions(e[field], func(k cardKey) { own[k] = true })
	}
	desc, _ := e["description"].(string)
	cardMentions(desc, func(k cardKey) {
		if !own[k] {
			v = append(v, fmt.Sprintf("history entry %d's description names %v, neither its card nor its targetCard", es, k))
		}
	})
	by, _ := e["by"].(float64)
	if int(by) != int(seat) && namesPosition(desc) {
		v = append(v, fmt.Sprintf("history entry %d's description %q names a hand position to the seat that didn't move (issue #69)", es, desc))
	}
	if tc, ok := e["targetCard"].(map[string]any); ok {
		board := boardCards(pre)
		cardMentions(tc, func(k cardKey) {
			if !board[k] {
				v = append(v, fmt.Sprintf("history entry %d's targetCard %v was not on the board before the move", es, k))
			}
		})
		if tally != nil {
			tally.targetCards++
		}
	}
	if int(by) == int(seat) {
		idx, ok := e["index"].(float64)
		moves := engine.LegalMoves(pre)
		switch {
		case !ok || int(idx) < 0 || int(idx) >= len(moves):
			v = append(v, fmt.Sprintf("own history entry %d has index %v of %d moves", es, e["index"], len(moves)))
		case desc != moves[int(idx)].Describe(pre):
			v = append(v, fmt.Sprintf("own history entry %d's description %q is not the engine's %q", es, desc, moves[int(idx)].Describe(pre)))
		default:
			if tally != nil {
				tally.ownDescriptions++
			}
		}
	}
	if len(v) == 0 {
		s.entryOK[seat][string(b)] = true
		if tally != nil {
			tally.historyEntries++
			if kind, _ := e["kind"].(float64); int(kind) == int(engine.MoveDiscardPair) && int(by) != int(seat) {
				tally.otherDiscards++
			}
		}
	}
	return v
}

// canary plants a hidden card in a copy of a real frame and requires the
// check to flag it: outside history and in a history description for a
// state frame, anywhere for the other frames.
func (s *sweeper) canary(seat game.Seat, f frameIn) {
	t := s.t
	t.Helper()
	if f.T == "state" {
		if s.nStates++; s.nStates%5 != 0 {
			return
		}
	}
	var raw map[string]any
	_ = json.Unmarshal(f.raw, &raw)
	if f.T != "state" {
		raw["planted"] = map[string]any{"Rank": 13.0}
		var v []string
		cardMentions(raw, func(k cardKey) { v = append(v, fmt.Sprint(k)) })
		if len(v) == 0 {
			t.Fatalf("seat %d: a card planted in a %s frame went unflagged", seat, f.T)
		}
		s.cov.canaries++
		return
	}
	envRaw := raw["envelope"].(map[string]any)
	seq := int(envRaw["seq"].(float64))
	hidden, ok := firstHidden(s.d.truths[seq].st, seat)
	if !ok {
		return
	}
	obj := map[string]any{"Rank": float64(hidden.r), "Suit": float64(hidden.s)}
	st := envRaw["state"].(map[string]any)
	st["scrap"] = append(st["scrap"].([]any), obj)
	if len(s.mentionViolations(seat, raw, seq, nil)) == 0 {
		t.Fatalf("seat %d: hidden card %v planted outside history went unflagged", seat, hidden)
	}
	s.cov.canaries++
	_ = json.Unmarshal(f.raw, &raw)
	envRaw = raw["envelope"].(map[string]any)
	h, _ := envRaw["history"].([]any)
	if len(h) == 0 {
		return
	}
	last := h[len(h)-1].(map[string]any)
	last["description"] = fmt.Sprintf("%v %s", last["description"], cardString(hidden))
	if len(s.mentionViolations(seat, raw, seq, nil)) == 0 {
		t.Fatalf("seat %d: hidden card %v planted in a history description went unflagged", seat, hidden)
	}
	s.cov.canaries++
	// Issue #69: the engine's position text planted in the other seat's
	// latest entry, on a fresh copy so nothing else can flag it.
	_ = json.Unmarshal(f.raw, &raw)
	envRaw = raw["envelope"].(map[string]any)
	h, _ = envRaw["history"].([]any)
	for i := len(h) - 1; i >= 0; i-- {
		e := h[i].(map[string]any)
		if by, _ := e["by"].(float64); int(by) == int(seat) {
			continue
		}
		e["description"] = "discard hand[1] and hand[2]"
		if len(s.mentionViolations(seat, raw, seq, nil)) == 0 {
			t.Fatalf("seat %d: position text planted in the other seat's history entry %v went unflagged", seat, e["seq"])
		}
		s.cov.canaries++
		return
	}
}

// firstHidden is the lowest card of the 52 that seat can't see.
func firstHidden(st engine.GameState, seat game.Seat) (cardKey, bool) {
	vis := specVisible(st, seat)
	for r := 1; r <= 13; r++ {
		for su := 0; su < 4; su++ {
			if k := (cardKey{r, su}); !vis[k] {
				return k, true
			}
		}
	}
	return cardKey{}, false
}

func cardString(k cardKey) string {
	return card.Card{Rank: card.Rank(k.r), Suit: card.Suit(k.s)}.String()
}

// specVisible is SPEC §3.2 read as a set: the cards seat's view may carry
// at this state. Every other card is hidden from seat.
func specVisible(st engine.GameState, seat game.Seat) map[cardKey]bool {
	v := boardCards(st) // you/opponent points, Jacks, permanents (R5)
	add := func(cs ...card.Card) {
		for _, c := range cs {
			v[cardKey{int(c.Rank), int(c.Suit)}] = true
		}
	}
	me, opp := st.Players[seat], st.Players[seat.Other()]
	add(me.Hand...)        // you.hand
	add(st.Scrap...)       // scrap (R6)
	if st.Pending != nil { // pending.card, pending.counterChain
		add(st.Pending.Card)
		add(st.Pending.CounterChain...)
	}
	if hasGlasses(me) { // opponent.hand, only under the seat's own glasses (R7)
		add(opp.Hand...)
	}
	if st.Phase == engine.PhaseSevenChoosing && st.Pending != nil && st.Active == engine.PlayerID(seat) {
		add(st.Pending.Revealed...) // sevenRevealed, only for the actor (R16)
	}
	return v
}

// boardCards is every point card, Jack and permanent on the table.
func boardCards(st engine.GameState) map[cardKey]bool {
	v := map[cardKey]bool{}
	add := func(cs ...card.Card) {
		for _, c := range cs {
			v[cardKey{int(c.Rank), int(c.Suit)}] = true
		}
	}
	for _, p := range st.Players {
		for _, pe := range p.Points {
			add(pe.Card)
			add(pe.JackStack...)
		}
		add(p.Permanents...)
	}
	return v
}

func hasGlasses(p engine.PlayerState) bool {
	for _, c := range p.Permanents {
		if c.Rank == card.Eight {
			return true
		}
	}
	return false
}

// specDerivations checks the §3.2 rules that aren't card sets against the
// engine truth, independently of the bridge's viewFor.
func specDerivations(seat game.Seat, env specEnvelope, rawEnv map[string]any, st engine.GameState) []string {
	var out []string
	fail := func(format string, a ...any) { out = append(out, fmt.Sprintf(format, a...)) }
	v := env.State
	me, opp := st.Players[seat], st.Players[seat.Other()]
	if v.Viewer != int(seat) {
		fail("viewer %d", v.Viewer)
	}
	if !sameCards(v.You.Hand, me.Hand) {
		fail("you.hand %v, engine %v", v.You.Hand, me.Hand)
	}
	if v.You.Watched != hasGlasses(opp) {
		fail("you.watched %v, opponent has glasses %v", v.You.Watched, hasGlasses(opp))
	}
	if v.Opponent.HandCount != len(opp.Hand) {
		fail("opponent.handCount %d, engine %d", v.Opponent.HandCount, len(opp.Hand))
	}
	if hasGlasses(me) {
		if v.Opponent.Hand == nil || !sameCards(*v.Opponent.Hand, opp.Hand) {
			fail("glasses but opponent.hand %v", v.Opponent.Hand)
		}
	} else if v.Opponent.Hand != nil {
		fail("opponent.hand %v without glasses", *v.Opponent.Hand)
	}
	if v.DeckCount != len(st.Deck) {
		fail("deckCount %d, engine %d", v.DeckCount, len(st.Deck))
	}
	if !sameCards(v.Scrap, st.Scrap) {
		fail("scrap %v, engine %v", v.Scrap, st.Scrap)
	}
	if st.Phase == engine.PhaseSevenChoosing && st.Active == engine.PlayerID(seat) && st.Pending != nil {
		if !sameCards(v.SevenRevealed, st.Pending.Revealed) {
			fail("sevenRevealed %v, engine %v", v.SevenRevealed, st.Pending.Revealed)
		}
	} else if len(v.SevenRevealed) > 0 {
		fail("sevenRevealed %v outside the actor's 7", v.SevenRevealed)
	}
	switch {
	case (v.Pending == nil) != (st.Pending == nil):
		fail("pending %v, engine %v", v.Pending, st.Pending)
	case v.Pending != nil:
		p, tp := v.Pending, st.Pending
		if !sameCards([]specCard{p.Card}, []card.Card{tp.Card}) || !sameCards(p.CounterChain, tp.CounterChain) ||
			p.PlayedBy != int(tp.PlayedBy) || !sameTarget(p.Target, tp.Target) {
			fail("pending %+v, engine %+v", *p, *tp)
		}
		if p.Target != nil {
			out = append(out, targetInRange("pending.target", *p.Target, st)...)
		}
	}
	if (st.Active != engine.PlayerID(seat) || st.Phase == engine.PhaseGameOver) && len(env.LegalMoves)+len(env.Descriptions) > 0 {
		fail("legal moves for a seat that doesn't act")
	}
	out = append(out, counterRules(seat, env, st)...)
	var moveTargets func(where string, m specMove)
	moveTargets = func(where string, m specMove) {
		for name, tg := range map[string]*specTarget{"Target": m.Target, "JackTarget": m.JackTarget} {
			if tg != nil {
				out = append(out, targetInRange(where+"."+name, *tg, st)...)
			}
		}
		if m.SubMove != nil {
			moveTargets(where+".SubMove", *m.SubMove)
		}
	}
	for i, m := range env.LegalMoves {
		moveTargets(fmt.Sprintf("legalMoves[%d]", i), m)
	}
	if env.Seq != len(env.History) {
		fail("seq %d, history %d", env.Seq, len(env.History))
	}
	// history[].index and lastMove.index: the key only on the seat's own entries.
	entries, _ := rawEnv["history"].([]any)
	if lm, ok := rawEnv["lastMove"].(map[string]any); ok {
		entries = append(entries, lm)
	}
	for _, e := range entries {
		m, _ := e.(map[string]any)
		_, has := m["index"]
		if by, _ := m["by"].(float64); has != (int(by) == int(seat)) {
			fail("history entry %v: index key present=%v", m, has)
		}
	}
	return out
}

// counterRules checks the counter rewind's view rules (engine v0.3.0,
// issue #93) against the truth: counterable is engine.CounterAvailable
// (engine/apply.go:171) and owedDiscards is Owed, from seat's side; new
// play never opens the legacy window (phase 1); Counters come last and
// only when counterable (engine/apply.go:143-147); phase 3 with no pending
// offers only DiscardPair and Counter; phase 5 offers the Counters then
// exactly one Decline (engine/apply.go:177-185), and Decline appears
// nowhere else.
func counterRules(seat game.Seat, env specEnvelope, st engine.GameState) []string {
	var out []string
	fail := func(format string, a ...any) { out = append(out, fmt.Sprintf(format, a...)) }
	v := env.State
	if v.Counterable != engine.CounterAvailable(st) {
		fail("counterable %v, engine %v", v.Counterable, engine.CounterAvailable(st))
	}
	if v.OwedDiscards.You != st.Owed[seat] || v.OwedDiscards.Opponent != st.Owed[seat.Other()] {
		fail("owedDiscards %+v, engine %v", v.OwedDiscards, st.Owed)
	}
	if st.Phase == engine.PhaseAwaitingCounter {
		fail("the legacy counter window (phase 1) opened in new play")
	}
	moves := env.LegalMoves
	phase5 := st.Phase == engine.PhasePendingWin
	owedStep := st.Phase == engine.PhaseAwaitingDiscard && st.Pending == nil
	counters, declines := 0, 0
	for i, m := range moves {
		switch k := engine.MoveKind(m.Kind); k {
		case engine.MoveCounter:
			counters++
		case engine.MoveDecline:
			declines++
			if !phase5 || i != len(moves)-1 {
				fail("Decline offered other than last in phase 5")
			}
		default:
			if counters > 0 {
				fail("a move of kind %d after a Counter", m.Kind)
			}
			if phase5 {
				fail("phase 5 offers a move of kind %d", m.Kind)
			}
			if owedStep && k != engine.MoveDiscardPair {
				fail("the owed discard offers a move of kind %d", m.Kind)
			}
		}
	}
	if phase5 && len(moves) > 0 && declines != 1 {
		fail("phase 5 offers %d Declines", declines)
	}
	if counters > 0 && !v.Counterable {
		fail("a Counter offered when the last turn is not counterable")
	}
	return out
}

// targetInRange checks a Target names a real slot of the state: owner and
// zone in range, index within that player's points or permanents.
func targetInRange(where string, tg specTarget, st engine.GameState) []string {
	if tg.Owner < 0 || tg.Owner > 1 {
		return []string{fmt.Sprintf("%s owner %d", where, tg.Owner)}
	}
	n := -1
	switch engine.TargetZone(tg.Zone) {
	case engine.ZonePoints:
		n = len(st.Players[tg.Owner].Points)
	case engine.ZonePermanents:
		n = len(st.Players[tg.Owner].Permanents)
	}
	if tg.Zone < 0 || n < 0 {
		return []string{fmt.Sprintf("%s zone %d", where, tg.Zone)}
	}
	if tg.Index < 0 || tg.Index >= n {
		return []string{fmt.Sprintf("%s index %d of %d", where, tg.Index, n)}
	}
	return nil
}

func sameTarget(a *specTarget, b *engine.Target) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Owner == int(b.Owner) && a.Zone == int(b.Zone) && a.Index == b.Index
}

func sameCards(got []specCard, want []card.Card) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].Rank != int(want[i].Rank) || got[i].Suit != int(want[i].Suit) {
			return false
		}
	}
	return true
}

// cardText is card.Card.String(): rank A, 2–10, J, Q, K, then the suit glyph.
var cardText = regexp.MustCompile(`(10|[2-9AJQK])([♣♦♥♠])`)

// handPosition is hand-position text in any spelling: the engine's
// DiscardPair "hand[2]" (engine/moves.go:66-67), "hand [ -1 ]", "HAND[0]".
var handPosition = regexp.MustCompile(`(?i)hand\s*\[`)

// namesPosition reports whether a description the other seat sees names a
// hand position (issue #69): position text, or any digit left once card
// names and a SevenPick's "7: " prefix are removed, which catches a
// position, index or count written any other way.
func namesPosition(desc string) bool {
	if handPosition.MatchString(desc) {
		return true
	}
	rest := cardText.ReplaceAllString(strings.TrimPrefix(desc, "7: "), "")
	return strings.ContainsAny(rest, "0123456789")
}

// stringsOutside calls fn for every string in v, skipping the value under
// any key named skip.
func stringsOutside(v any, skip string, fn func(string)) {
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			if k != skip {
				stringsOutside(c, skip, fn)
			}
		}
	case []any:
		for _, c := range x {
			stringsOutside(c, skip, fn)
		}
	case string:
		fn(x)
	}
}

var (
	rankText = map[string]int{"A": 1, "J": 11, "Q": 12, "K": 13}
	suitText = map[string]int{"♣": 0, "♦": 1, "♥": 2, "♠": 3}
)

// cardMentions calls fn for every card v names: each object with a Rank or
// a Suit key (a partial one comes out with -1 for the missing half, which
// no visible set holds) and each card written as text inside a string.
func cardMentions(v any, fn func(k cardKey)) {
	switch x := v.(type) {
	case map[string]any:
		r, rok := cardField(x, "Rank", "rank")
		s, sok := cardField(x, "Suit", "suit")
		if rok || sok {
			fn(cardKey{r, s})
		}
		for _, c := range x {
			cardMentions(c, fn)
		}
	case []any:
		for _, c := range x {
			cardMentions(c, fn)
		}
	case string:
		for _, m := range cardText.FindAllStringSubmatch(x, -1) {
			r, ok := rankText[m[1]]
			if !ok {
				fmt.Sscan(m[1], &r)
			}
			fn(cardKey{r, suitText[m[2]]})
		}
	}
}

// cardField reads a card half under either key; a key that is present but
// not a number reads as -1.
func cardField(m map[string]any, keys ...string) (int, bool) {
	for _, k := range keys {
		if x, ok := m[k]; ok {
			if n, ok := x.(float64); ok {
				return int(n), true
			}
			return -1, true
		}
	}
	return -1, false
}

func strictDecodeErr(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("decode %T: %w", v, err)
	}
	if dec.More() {
		return errors.New("trailing data after the frame")
	}
	return nil
}

// ---- the SPEC §2.7 envelope, written from the SPEC, not from internal/game ----

type specCard struct {
	Rank int `json:"Rank"`
	Suit int `json:"Suit"`
}

type specTarget struct {
	Owner int `json:"Owner"`
	Zone  int `json:"Zone"`
	Index int `json:"Index"`
}

type specPointEntry struct {
	Card       specCard   `json:"Card"`
	Owner      int        `json:"Owner"`
	JackStack  []specCard `json:"JackStack"`
	JackOwners []int      `json:"JackOwners"`
	Controller int        `json:"Controller"`
}

type specMove struct {
	Kind       int         `json:"Kind"`
	Card       *specCard   `json:"Card"`
	HandIndex  int         `json:"HandIndex"`
	Target     *specTarget `json:"Target"`
	JackTarget *specTarget `json:"JackTarget"`
	ScrapIndex int         `json:"ScrapIndex"`
	DiscardA   int         `json:"DiscardA"`
	DiscardB   int         `json:"DiscardB"`
	SubMove    *specMove   `json:"SubMove"`
}

type specSide struct {
	Points    int  `json:"points"`
	Threshold int  `json:"threshold"`
	Kings     int  `json:"kings"`
	HasWon    bool `json:"hasWon"`
}

type specPending struct {
	PlayedBy     int         `json:"playedBy"`
	Card         specCard    `json:"card"`
	Target       *specTarget `json:"target"`
	CounterChain []specCard  `json:"counterChain"`
}

type specView struct {
	Viewer       int  `json:"viewer"`
	Active       int  `json:"active"`
	Phase        int  `json:"phase"`
	PassesInARow int  `json:"passesInARow"`
	Winner       *int `json:"winner"`
	Stalemate    bool `json:"stalemate"`
	You          struct {
		Hand              []specCard       `json:"hand"`
		FrozenHandIndices []int            `json:"frozenHandIndices"`
		Points            []specPointEntry `json:"points"`
		Permanents        []specCard       `json:"permanents"`
		Watched           bool             `json:"watched"`
	} `json:"you"`
	Opponent struct {
		HandCount  int              `json:"handCount"`
		Hand       *[]specCard      `json:"hand"`
		Points     []specPointEntry `json:"points"`
		Permanents []specCard       `json:"permanents"`
	} `json:"opponent"`
	DeckCount  int        `json:"deckCount"`
	Scrap      []specCard `json:"scrap"`
	Scoreboard struct {
		You      specSide `json:"you"`
		Opponent specSide `json:"opponent"`
	} `json:"scoreboard"`
	SevenRevealed []specCard `json:"sevenRevealed"`
	// counterable and owedDiscards: added 2026-10-24 (issue #93).
	Counterable  bool `json:"counterable"`
	OwedDiscards struct {
		You      int `json:"you"`
		Opponent int `json:"opponent"`
	} `json:"owedDiscards"`
	Pending *specPending `json:"pending"`
}

type specApplied struct {
	Index       *int      `json:"index"`
	By          int       `json:"by"`
	Kind        int       `json:"kind"`
	Card        *specCard `json:"card"`
	Description string    `json:"description"`
	Seq         int       `json:"seq"`
	SubKind     *int      `json:"subKind"`
	TargetCard  *specCard `json:"targetCard"`
	Drawn       *int      `json:"drawn"`
}

type specEnvelope struct {
	OK           bool          `json:"ok"`
	State        specView      `json:"state"`
	LegalMoves   []specMove    `json:"legalMoves"`
	Descriptions []string      `json:"descriptions"`
	LastMove     *specApplied  `json:"lastMove"`
	History      []specApplied `json:"history"`
	Seq          int           `json:"seq"`
}

// ---- the check itself, on hand-built frames ----

func ck(r card.Rank, s card.Suit) card.Card { return card.Card{Rank: r, Suit: s} }

func TestW9_SweepCheckCatchesLeaks(t *testing.T) {
	five, king, ten := ck(card.Five, card.Hearts), ck(card.King, card.Spades), ck(card.Ten, card.Clubs)
	st := engine.GameState{
		Players: [2]engine.PlayerState{{Hand: []card.Card{five}}, {Hand: []card.Card{king}}},
		Deck:    []card.Card{ten},
	}
	key := func(c card.Card) cardKey { return cardKey{int(c.Rank), int(c.Suit)} }

	t.Run("visible set", func(t *testing.T) {
		vis := specVisible(st, 0)
		if !vis[key(five)] || vis[key(king)] || vis[key(ten)] {
			t.Fatalf("visible set %v", vis)
		}
		g := st
		g.Players[0].Permanents = []card.Card{ck(card.Eight, card.Diamonds)}
		if !specVisible(g, 0)[key(king)] {
			t.Fatal("glasses don't show the opponent's hand")
		}
		if specVisible(g, 1)[key(five)] {
			t.Fatal("the opponent's glasses show the watcher's own hand to it")
		}
	})

	t.Run("mentions", func(t *testing.T) {
		var got []cardKey
		cardMentions(map[string]any{
			"message": "no such move 10♣ or K♠",
			"partial": map[string]any{"Rank": 13.0},
			"lower":   map[string]any{"rank": 2.0, "suit": "x"},
		}, func(k cardKey) { got = append(got, k) })
		want := map[cardKey]bool{{10, 0}: true, {13, 3}: true, {13, -1}: true, {2, -1}: true}
		if len(got) != len(want) {
			t.Fatalf("mentions %v", got)
		}
		for _, k := range got {
			if !want[k] {
				t.Fatalf("unexpected mention %v", k)
			}
		}
	})

	// A sweeper over a two-seq game: seq 1 is seat 1 playing the king as a
	// permanent.
	post := st
	post.Players[1] = engine.PlayerState{Permanents: []card.Card{king}}
	post.Scrap = []card.Card{ck(card.Three, card.Clubs)}
	s := &sweeper{t: t, d: &duo{gameNo: 1, truths: []truthAt{{st: st}, {st: post}}}}
	entry := func(by int, c, target any, desc string) map[string]any {
		return map[string]any{"by": float64(by), "kind": 2.0, "card": c, "targetCard": target, "description": desc, "seq": 1.0}
	}
	kingObj := map[string]any{"Rank": 13.0, "Suit": 3.0}

	t.Run("history entries", func(t *testing.T) {
		if v := s.entryViolations(0, entry(1, kingObj, nil, "play K♠ as permanent"), 1, nil); len(v) != 0 {
			t.Fatalf("a card played face up flagged: %v", v)
		}
		if v := s.entryViolations(0, entry(1, nil, nil, "draw a card 10♣"), 1, nil); len(v) == 0 {
			t.Fatal("a deck card in a history description went unflagged")
		}
		if v := s.entryViolations(0, entry(1, kingObj, nil, "play K♠ as permanent, next is 5♥"), 1, nil); len(v) == 0 {
			t.Fatal("a description naming a card other than its own went unflagged")
		}
		three := map[string]any{"Rank": 3.0, "Suit": 0.0}
		if v := s.entryViolations(0, entry(1, kingObj, three, "play K♠ as permanent"), 1, nil); len(v) == 0 {
			t.Fatal("a targetCard that was never on the board went unflagged")
		}
		if v := s.entryViolations(0, entry(1, nil, nil, "draw a card"), 2, nil); len(v) != 0 {
			t.Fatalf("an entry naming nothing flagged: %v", v)
		}
		// The seat's own entry must carry the engine's own description.
		mine := entry(0, nil, nil, "draw a card, secretly")
		mine["index"] = 0.0
		if v := s.entryViolations(0, mine, 1, nil); len(v) == 0 {
			t.Fatal("an own entry with a made-up description went unflagged")
		}
	})

	// Issue #69: a description the other seat sees names no hand position,
	// in the engine's spelling or any other.
	t.Run("position text", func(t *testing.T) {
		discard := func(by int, desc string) map[string]any {
			e := entry(by, nil, nil, desc)
			e["kind"] = 8.0 // MoveDiscardPair
			return e
		}
		for _, desc := range []string{
			"discard hand[2] and hand[3]",
			"discard hand[0] and hand[-1]",
			"discard HAND [ 1 ] and hand[2]",
			"discard cards 2 and 3",
			"discards two cards from position 4",
		} {
			if v := s.entryViolations(0, discard(1, desc), 1, nil); len(v) == 0 {
				t.Errorf("the other seat's description %q went unflagged", desc)
			}
		}
		for _, e := range []map[string]any{
			discard(1, "discards two cards"),
			entry(1, kingObj, nil, "7: play K♠ as permanent"),
		} {
			if v := s.entryViolations(0, e, 1, nil); len(v) != 0 {
				t.Errorf("a clean description %q flagged: %v", e["description"], v)
			}
		}
		// Outside history only the actor's own option list may carry it.
		frame := func(k string, x any) map[string]any {
			return map[string]any{"t": "state", "envelope": map[string]any{k: x}}
		}
		if v := s.mentionViolations(0, frame("note", "discard hand[1] and hand[2]"), 0, nil); len(v) == 0 {
			t.Error("position text outside history went unflagged")
		}
		if v := s.mentionViolations(0, frame("descriptions", []any{"discard hand[1] and hand[2]"}), 0, nil); len(v) != 0 {
			t.Errorf("the actor's own options flagged: %v", v)
		}
	})

	t.Run("derivations", func(t *testing.T) {
		env := specEnvelope{Seq: 0}
		env.State.You.Hand = []specCard{{5, 2}}
		env.State.Opponent.HandCount = 1
		env.State.DeckCount = 1
		env.State.Scrap = []specCard{}
		if v := specDerivations(0, env, map[string]any{}, st); len(v) != 0 {
			t.Fatalf("a correct view flagged: %v", v)
		}
		for name, mutate := range map[string]func(*specEnvelope){
			"opponent.hand without glasses":  func(e *specEnvelope) { h := []specCard{{13, 3}}; e.State.Opponent.Hand = &h },
			"you.watched":                    func(e *specEnvelope) { e.State.You.Watched = true },
			"sevenRevealed for a non-actor":  func(e *specEnvelope) { e.State.SevenRevealed = []specCard{{10, 0}} },
			"deckCount":                      func(e *specEnvelope) { e.State.DeckCount = 2 },
			"a pending one-off":              func(e *specEnvelope) { e.State.Pending = &specPending{Card: specCard{5, 2}} },
			"counterable":                    func(e *specEnvelope) { e.State.Counterable = true },
			"owedDiscards":                   func(e *specEnvelope) { e.State.OwedDiscards.Opponent = 2 },
			"a Counter when not counterable": func(e *specEnvelope) { e.LegalMoves = []specMove{{Kind: int(engine.MoveCounter)}} },
		} {
			e := env
			mutate(&e)
			if v := specDerivations(0, e, map[string]any{}, st); len(v) == 0 {
				t.Errorf("%s went unflagged", name)
			}
		}
		g := st
		g.Active = 1
		e := env
		e.LegalMoves = []specMove{{}}
		if v := specDerivations(0, e, map[string]any{}, g); len(v) == 0 {
			t.Error("legal moves for a non-actor went unflagged")
		}
		if v := targetInRange("t", specTarget{Owner: 1, Zone: 2}, post); len(v) == 0 {
			t.Error("an out-of-range zone went unflagged")
		}
		if v := targetInRange("t", specTarget{Owner: 1, Zone: 1, Index: 1}, post); len(v) == 0 {
			t.Error("an out-of-range index went unflagged")
		}
		if v := targetInRange("t", specTarget{Owner: 1, Zone: 1, Index: 0}, post); len(v) != 0 {
			t.Errorf("a real permanent flagged: %v", v)
		}
		raw := map[string]any{"history": []any{map[string]any{"by": 1.0, "index": 3.0}}}
		if v := specDerivations(0, env, raw, st); len(v) == 0 {
			t.Error("an index on the other seat's history entry went unflagged")
		}
	})

	t.Run("non-state frames", func(t *testing.T) {
		for _, raw := range []string{
			`{"t":"error","code":"STALE","message":"that move is out of date 10♣"}`,
			`{"t":"presence","opponentOnline":true,"x":{"Rank":13}}`,
			`{"t":"responding","by":1,"card":{"Rank":13,"Suit":3}}`,
			`{"t":"responding","by":1}`,
			`{"t":"welcome","seat":0,"names":["K♠",null],"status":"playing"}`,
		} {
			var f frameIn
			_ = json.Unmarshal([]byte(raw), &f)
			f.raw = []byte(raw)
			if v := s.violations(0, f, nil); len(v) == 0 {
				t.Errorf("%s went unflagged", raw)
			}
		}
		ok := `{"t":"error","code":"STALE","message":"that move is out of date","seq":3}`
		if v := s.violations(0, frameIn{T: "error", raw: []byte(ok)}, nil); len(v) != 0 {
			t.Errorf("a clean error frame flagged: %v", v)
		}
	})

	t.Run("envelope schema", func(t *testing.T) {
		var env specEnvelope
		if err := strictDecodeErr([]byte(`{"ok":true,"state":{"deckTopRank":3}}`), &env); err == nil {
			t.Fatal("an unlisted envelope field decoded")
		}
		if reflect.TypeOf(specEnvelope{}).NumField() != 7 {
			t.Fatal("the SPEC §2.7 envelope has seven fields")
		}
	})
}
