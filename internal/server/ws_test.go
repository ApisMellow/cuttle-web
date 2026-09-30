package server

// WebSocket play tests (two-phone W6 + W7, SPEC §2.12). Real server, real
// sockets, file-backed store; every test runs under -race in the gate.

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle/engine"
)

// ---- upgrade and origin ----

func TestWS_OriginCheckedBeforeUpgrade(t *testing.T) {
	e := newPlayEnv(t, playOpts{})
	for name, origin := range map[string]string{
		"foreign":               "https://evil.example",
		"missing":               "",
		"dev host without -dev": "http://localhost:5173",
	} {
		_, resp, err := e.dial(t, origin)
		if err == nil {
			t.Fatalf("%s: upgrade accepted", name)
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: want 403, got %v", name, resp)
		}
	}
	if _, _, err := e.dial(t, testOrigin); err != nil {
		t.Fatalf("allowed origin refused: %v", err)
	}
}

func TestWS_DevOriginAllowedWithDevFlag(t *testing.T) {
	e := newPlayEnv(t, playOpts{cfg: func(c *Config) { c.Dev = true }})
	if _, _, err := e.dial(t, "http://localhost:5173"); err != nil {
		t.Fatal(err)
	}
}

// ---- hello ----

func TestWS_HelloWaitingRoomThenJoinAnnounced(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(1)})
	c0 := e.create(t, "Alice")
	a, w := e.connect(t, c0)
	if w.Seat != 0 || w.Status != "waiting" || w.Names[0] == nil || *w.Names[0] != "Alice" || w.Names[1] != nil {
		t.Fatalf("welcome %+v", w)
	}
	a.quiet(150 * time.Millisecond) // nothing dealt: no state
	e.join(t, c0.Code, "Blake")
	w = decodeFrame[welcomeIn](t, a.expect("welcome"))
	if w.Seat != 0 || w.Status != "playing" || *w.Names[1] != "Blake" {
		t.Fatalf("join welcome %+v", w)
	}
	s, env := expectState(t, a)
	if s.Game != 1 || env.Seq != 0 || s.OpponentOnline || s.Tally != [2]int{} {
		t.Fatalf("first state %+v seq %d", s, env.Seq)
	}
}

func TestWS_HelloFailures(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(2), cfg: func(c *Config) { c.tune.helloTimeout = 150 * time.Millisecond }})
	c0 := e.create(t, "Alice")
	e.join(t, c0.Code, "Blake")

	type hello map[string]any
	cases := []struct {
		name  string
		frame any
		raw   string
		code  string // "" = bare close, no frame
	}{
		{name: "wrong version", frame: hello{"t": "hello", "v": 2, "code": c0.Code, "token": c0.Token, "lastSeq": 0}, code: "UPGRADE_REQUIRED"},
		{name: "unknown room", frame: hello{"t": "hello", "v": 1, "code": "ZZZZ", "token": c0.Token, "lastSeq": 0}, code: "ROOM_GONE"},
		{name: "malformed code", frame: hello{"t": "hello", "v": 1, "code": "!!", "token": c0.Token, "lastSeq": 0}, code: "ROOM_GONE"},
		{name: "bad token", frame: hello{"t": "hello", "v": 1, "code": c0.Code, "token": "nope", "lastSeq": 0}, code: "UNAUTHORIZED"},
		{name: "empty token", frame: hello{"t": "hello", "v": 1, "code": c0.Code, "token": "", "lastSeq": 0}, code: "UNAUTHORIZED"},
		{name: "not hello first", frame: hello{"t": "ping"}, code: "BAD_REQUEST"},
		{name: "move first", frame: hello{"t": "move", "game": 1, "seq": 0, "index": 0}, code: "BAD_REQUEST"},
		{name: "no version", frame: hello{"t": "hello", "code": c0.Code, "token": c0.Token}, code: "BAD_REQUEST"},
		{name: "garbage", raw: "{not json", code: "BAD_REQUEST"},
		{name: "seat in frame is not honored", frame: hello{"t": "hello", "v": 1, "code": c0.Code, "token": "nope", "seat": 0}, code: "UNAUTHORIZED"},
	}
	for _, tc := range cases {
		w, _, err := e.dial(t, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		if tc.raw != "" {
			w.sendRaw([]byte(tc.raw))
		} else {
			w.send(tc.frame)
		}
		expectError(t, w, tc.code)
		w.closed(3 * time.Second)
	}

	// Hello deadline: silence after the upgrade is a bare close.
	w, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	w.closed(3 * time.Second)
	if el := time.Since(start); el < 100*time.Millisecond {
		t.Fatalf("closed after %v, before the hello deadline", el)
	}
}

func TestWS_FailedHelloLimitCountsOnlyGuesses(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(3), cfg: func(c *Config) { c.tune.failedHelloPerHour = 3 }})
	c0 := e.create(t, "Alice")
	c1 := e.join(t, c0.Code, "Blake")

	try := func(frame map[string]any, want string) {
		t.Helper()
		w, _, err := e.dial(t, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		w.send(frame)
		if want == "welcome" {
			w.expect("welcome")
			w.c.CloseNow()
			<-w.done
			return
		}
		expectError(t, w, want)
		w.closed(3 * time.Second)
	}
	good := map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": c0.Token, "lastSeq": 0}
	// Not counted: accepted hellos, UPGRADE_REQUIRED, BAD_REQUEST.
	for range 5 {
		try(good, "welcome")
		try(map[string]any{"t": "hello", "v": 9, "code": c0.Code, "token": "x"}, "UPGRADE_REQUIRED")
		try(map[string]any{"t": "nope"}, "BAD_REQUEST")
	}
	// Counted: UNAUTHORIZED and ROOM_GONE.
	try(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": "guess1"}, "UNAUTHORIZED")
	try(map[string]any{"t": "hello", "v": 1, "code": "ZZZZ", "token": "guess2"}, "ROOM_GONE")
	try(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": "guess3"}, "UNAUTHORIZED")
	// Over the limit: even a right token is refused before it is checked.
	try(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": c1.Token}, "RATE_LIMITED")
	try(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": "guess4"}, "RATE_LIMITED")
	// A wrong version is still answered as such: it isn't a guess.
	try(map[string]any{"t": "hello", "v": 9, "code": c0.Code, "token": "x"}, "UPGRADE_REQUIRED")
}

// ---- the two-seat flow and privacy ----

func TestWS_TwoSeatGamesEachSeatSeesOnlyItsOwnView(t *testing.T) {
	var cov coverage
	for seed := uint64(1); seed <= 6; seed++ {
		e := newPlayEnv(t, playOpts{rand: seededRand(seed), cfg: func(c *Config) { c.RespondMin = 5 * time.Millisecond }})
		d := newDuo(t, e, seed)
		d.preferOneOff = seed%2 == 0
		d.playToEnd()
		d.settle()
		c := d.cov
		cov.glasses += c.glasses
		cov.sevenReveal += c.sevenReveal
		cov.counterWindow += c.counterWindow
		cov.noWindowOneOff += c.noWindowOneOff
		cov.gameOver += c.gameOver
		// The final state carries the tally the store holds.
		row, err := e.st.Get(context.Background(), d.code)
		if err != nil {
			t.Fatal(err)
		}
		if row.Tally != d.tally {
			t.Fatalf("seed %d: state tally %v, store %v", seed, d.tally, row.Tally)
		}
		for s := range 2 {
			if d.env[s].State.Phase != engine.PhaseGameOver {
				t.Fatalf("seat %d not at game over", s)
			}
		}
		e.stop()
	}
	t.Logf("coverage over the seeded games: %+v", cov)
	if cov.gameOver == 0 || cov.counterWindow == 0 || cov.noWindowOneOff == 0 || cov.sevenReveal == 0 {
		t.Fatalf("the seeded games never exercised a property: %+v", cov)
	}
}

// ---- errors followed by state ----

func TestWS_MoveErrorsResync(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(11)})
	d := newDuo(t, e, 11)
	d.playMoves(3)
	d.settle()
	st := d.st()
	actor, other := d.p[st.Actor], d.p[st.Actor.Other()]
	seq := d.truth.Seq()

	// NOT_YOUR_TURN: the other seat, current seq.
	other.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 0})
	er := expectError(t, other, "NOT_YOUR_TURN")
	if er.Seq == nil || *er.Seq != seq {
		t.Fatalf("error seq %v, want %d", er.Seq, seq)
	}
	if _, env := expectState(t, other); env.Seq != seq {
		t.Fatalf("resync seq %d", env.Seq)
	}
	// STALE seq.
	actor.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq - 1, "index": 0})
	expectError(t, actor, "STALE")
	if _, env := expectState(t, actor); env.Seq != seq {
		t.Fatalf("resync seq %d", env.Seq)
	}
	// STALE game.
	actor.send(map[string]any{"t": "move", "game": d.gameNo + 1, "seq": seq, "index": 0})
	expectError(t, actor, "STALE")
	expectState(t, actor)
	// INDEX_OUT_OF_RANGE: error only.
	actor.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 999})
	expectError(t, actor, "INDEX_OUT_OF_RANGE")
	actor.quiet(100 * time.Millisecond)
	// Malformed move and unknown type: BAD_REQUEST, socket kept.
	actor.send(map[string]any{"t": "move", "game": d.gameNo, "seq": "x"})
	expectError(t, actor, "BAD_REQUEST")
	actor.send(map[string]any{"t": "teleport"})
	expectError(t, actor, "BAD_REQUEST")
	actor.send(map[string]any{"t": "ping"})
	actor.expect("pong")
	// The session never moved.
	if got := e.sessionSeq(t, d.code); got != seq {
		t.Fatalf("session at %d after rejected moves, want %d", got, seq)
	}
	other.quiet(100 * time.Millisecond)
}

func (e *playEnv) sessionSeq(t *testing.T, code string) int {
	t.Helper()
	row, err := e.st.Get(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	return row.Seq
}

func TestWS_GameOverMoveResyncs(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(12), cfg: func(c *Config) { c.RespondMin = 5 * time.Millisecond }})
	d := newDuo(t, e, 12)
	d.playToEnd()
	d.settle()
	seq := d.truth.Seq()
	d.p[0].send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 0})
	expectError(t, d.p[0], "GAME_OVER")
	if _, env := expectState(t, d.p[0]); env.Seq != seq || env.State.Phase != engine.PhaseGameOver {
		t.Fatalf("resync %d %v", env.Seq, env.State.Phase)
	}
}

func TestWS_SaveFailureSendsInternalAndReloadedState(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(13)})
	d := newDuo(t, e, 13)
	d.playMoves(2)
	d.settle()
	st := d.st()
	actor, other := d.p[st.Actor], d.p[st.Actor.Other()]
	seq := d.truth.Seq()
	e.fs.failSaves.Store(1)
	actor.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 0})
	er := expectError(t, actor, "INTERNAL")
	if er.Seq == nil || *er.Seq != seq {
		t.Fatalf("seq %v", er.Seq)
	}
	if _, env := expectState(t, actor); env.Seq != seq {
		t.Fatalf("reloaded state at %d, want unchanged %d", env.Seq, seq)
	}
	other.quiet(150 * time.Millisecond) // no envelope of the unsaved state
	// The room still plays.
	actor.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 0})
	f := actor.next(3 * time.Second)
	if f.T != "state" && f.T != "responding" {
		t.Fatalf("after recovery got %s", f.raw)
	}
}

// ---- the response hold (W7) ----

// holdScenario drives seeded games until the actor can play a one-off and
// the engine opens (window=true) or doesn't open a counter window; it plays
// that one-off and returns the duo just after the move was sent.
func holdScenario(t *testing.T, hold time.Duration, window bool) (*playEnv, *duo, game.Seat) {
	t.Helper()
	for seed := uint64(100); seed < 160; seed++ {
		e := newPlayEnv(t, playOpts{rand: seededRand(seed), cfg: func(c *Config) { c.RespondMin = hold }})
		d := newDuo(t, e, seed)
		for guard := 0; guard < 400 && !d.st().Over; guard++ {
			seat, env, ok := d.ready()
			if !ok {
				if !d.pump(3 * time.Second) {
					t.Fatal("stalled")
				}
				continue
			}
			for i, m := range env.LegalMoves {
				if m.Kind != engine.MoveOneOff {
					continue
				}
				probe, _ := game.RestoreSession(mustPersist(t, d.truth))
				if _, err := probe.Apply(seat, d.truth.Seq(), i); err != nil {
					t.Fatal(err)
				}
				opened := mustStatus(t, probe).Phase == engine.PhaseAwaitingCounter
				if opened == window {
					// Drain anything in flight so the scenario starts clean.
					d.settle()
					d.move(seat, i)
					return e, d, seat
				}
			}
			d.move(seat, d.pick(env))
		}
		e.stop()
	}
	t.Fatalf("no seed produced a one-off with window=%v", window)
	return nil, nil, 0
}

func mustPersist(t *testing.T, s *game.Session) []byte {
	t.Helper()
	snap, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	return snap.PersistBytes()
}

func TestWS_HoldWithoutWindow(t *testing.T) {
	const hold = 300 * time.Millisecond
	_, d, mover := holdScenario(t, hold, false)
	start := d.heldFrom[mover]
	m, o := d.p[mover], d.p[mover.Other()]
	r := decodeFrame[respondingIn](t, m.expect("responding"))
	if *r.By != int(mover.Other()) {
		t.Fatalf("by %d", *r.By)
	}
	d.expectR[mover], d.held[mover] = false, true
	// The other seat has its state at once.
	f := o.next(hold / 2)
	d.absorb(mover.Other(), f)
	if f.T != "state" || f.at.Sub(start) >= hold {
		t.Fatalf("responder's state late or missing: %s after %v", f.T, f.at.Sub(start))
	}
	m.quiet(hold - time.Since(start) - 30*time.Millisecond)
	f = m.next(2 * time.Second)
	if f.T != "state" || f.at.Sub(start) < hold {
		t.Fatalf("mover got %s after %v, hold %v", f.T, f.at.Sub(start), hold)
	}
	d.absorb(mover, f)
}

func TestWS_HoldDeclineAfterHoldReleasesOnDecline(t *testing.T) {
	const hold = 200 * time.Millisecond
	_, d, mover := holdScenario(t, hold, true)
	start := d.heldFrom[mover]
	m, o := d.p[mover], d.p[mover.Other()]
	d.absorb(mover, m.expect("responding"))
	_, env := expectState(t, o) // the counter prompt, at once
	if env.State.Phase != engine.PhaseAwaitingCounter {
		t.Fatalf("responder phase %v", env.State.Phase)
	}
	d.env[mover.Other()] = &env
	// The responder thinks past the hold: the mover still waits.
	m.quiet(hold + 200*time.Millisecond)
	decline := -1
	for i, mv := range env.LegalMoves {
		if mv.Kind == engine.MoveDecline {
			decline = i
		}
	}
	answered := time.Now()
	d.move(mover.Other(), decline)
	f := m.next(2 * time.Second)
	if f.T != "state" || f.at.Before(answered) || f.at.Sub(start) < hold {
		t.Fatalf("mover got %s at %v (answer at %v)", f.raw, f.at.Sub(start), answered.Sub(start))
	}
	d.absorb(mover, f)
}

func TestWS_HoldQuickDeclineStillWaitsForHold(t *testing.T) {
	const hold = 300 * time.Millisecond
	_, d, mover := holdScenario(t, hold, true)
	start := d.heldFrom[mover]
	m, o := d.p[mover], d.p[mover.Other()]
	d.absorb(mover, m.expect("responding"))
	_, env := expectState(t, o)
	d.env[mover.Other()] = &env
	for i, mv := range env.LegalMoves {
		if mv.Kind == engine.MoveDecline {
			d.move(mover.Other(), i)
		}
	}
	// A move by the mover during the hold is answered with responding, not state.
	m.send(map[string]any{"t": "move", "game": d.gameNo, "seq": 0, "index": 0})
	expectError(t, m, "STALE")
	if f := m.expect("responding"); f.at.Sub(start) >= hold {
		t.Fatal("test too slow to observe the hold")
	}
	f := m.next(2 * time.Second)
	if f.T != "state" || f.at.Sub(start) < hold {
		t.Fatalf("mover got %s after %v, hold %v", f.T, f.at.Sub(start), hold)
	}
	d.absorb(mover, f)
}

func TestWS_HoldCounterReleasesMoverAndHoldsCounterer(t *testing.T) {
	const hold = 150 * time.Millisecond
	_, d, mover := holdScenario(t, hold, true)
	m, o := d.p[mover], d.p[mover.Other()]
	d.absorb(mover, m.expect("responding"))
	_, env := expectState(t, o)
	d.env[mover.Other()] = &env
	counter := -1
	for i, mv := range env.LegalMoves {
		if mv.Kind == engine.MoveCounter {
			counter = i
		}
	}
	if counter < 0 {
		t.Fatal("window without a counter move")
	}
	d.move(mover.Other(), counter)
	// The counterer is now the mover under a hold.
	r := decodeFrame[respondingIn](t, o.expect("responding"))
	if *r.By != int(mover) {
		t.Fatalf("counterer's responding by %d", *r.By)
	}
	d.expectR[mover.Other()], d.held[mover.Other()] = false, true
	// The original mover is released (answer in) once its own hold is over.
	f := m.next(2 * time.Second)
	d.absorb(mover, f)
	if f.T != "state" {
		t.Fatalf("original mover got %s", f.raw)
	}
	d.settle()
}

func TestWS_HoldReconnectGetsResponding(t *testing.T) {
	const hold = 600 * time.Millisecond
	e, d, mover := holdScenario(t, hold, false)
	start := d.heldFrom[mover]
	m := d.p[mover]
	m.expect("responding")
	m.c.CloseNow()
	<-m.done
	w, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	w.seat, w.token = mover, m.token
	w.hello(d.code, m.token)
	w.expect("welcome")
	f := w.expect("responding")
	if f.at.Sub(start) >= hold {
		t.Fatal("test too slow to observe the hold")
	}
	f = w.next(2 * time.Second)
	if f.T != "state" || f.at.Sub(start) < hold {
		t.Fatalf("reconnected mover got %s after %v", f.T, f.at.Sub(start))
	}
}

// ---- one socket per seat, presence ----

func TestWS_NewerHelloReplacesOlderSocket(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(21)})
	d := newDuo(t, e, 21)
	old := d.p[0]
	nw, w := e.connect(t, claimBody{Code: d.code, Seat: 0, Token: old.token})
	if w.Seat != 0 {
		t.Fatalf("seat %d", w.Seat)
	}
	expectError(t, old, "REPLACED")
	old.closed(3 * time.Second)
	expectState(t, nw)
	nw.send(map[string]any{"t": "ping"})
	nw.expect("pong")
	// The opponent never saw seat 0 go offline.
	d.p[1].quiet(150 * time.Millisecond)
}

func TestWS_Presence(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(22)})
	d := newDuo(t, e, 22) // checks presence{true} to A and B's opponentOnline
	d.p[1].c.CloseNow()
	<-d.p[1].done
	p := decodeFrame[presenceIn](t, d.p[0].expect("presence"))
	if *p.OpponentOnline {
		t.Fatal("presence true after B dropped")
	}
	b, _ := e.connect(t, claimBody{Code: d.code, Seat: 1, Token: d.p[1].token})
	s, _ := expectState(t, b)
	if !s.OpponentOnline {
		t.Fatal("B's state says A offline")
	}
	p = decodeFrame[presenceIn](t, d.p[0].expect("presence"))
	if !*p.OpponentOnline {
		t.Fatal("presence false after B returned")
	}
}

// ---- rematch ----

func TestWS_RematchAlternatesDealerAndKeepsTally(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(31), cfg: func(c *Config) { c.RespondMin = 5 * time.Millisecond }})
	d := newDuo(t, e, 31)
	a, b := d.p[0], d.p[1]

	// Before the game is over a rematch is BAD_REQUEST.
	a.send(map[string]any{"t": "rematch", "game": 1})
	expectError(t, a, "BAD_REQUEST")

	d.playToEnd()
	d.settle()
	row1, err := e.st.Get(context.Background(), d.code)
	if err != nil {
		t.Fatal(err)
	}
	tally := row1.Tally

	// Wrong game: STALE + state.
	a.send(map[string]any{"t": "rematch", "game": 7})
	expectError(t, a, "STALE")
	expectState(t, a)

	a.send(map[string]any{"t": "rematch", "game": 1})
	for _, w := range []*wsc{a, b} {
		r := decodeFrame[rematchIn](t, w.expect("rematch"))
		if *r.RequestedBy != 0 {
			t.Fatalf("requestedBy %d", *r.RequestedBy)
		}
	}
	// A repeat is a no-op: the asker hears it again, nothing is dealt.
	a.send(map[string]any{"t": "rematch", "game": 1})
	decodeFrame[rematchIn](t, a.expect("rematch"))
	b.quiet(100 * time.Millisecond)

	// A reconnect while a request is pending: welcome, state, rematch.
	b.c.CloseNow()
	<-b.done
	a.expect("presence")
	b2, _ := e.connect(t, claimBody{Code: d.code, Seat: 1, Token: b.token})
	expectState(t, b2)
	if r := decodeFrame[rematchIn](t, b2.expect("rematch")); *r.RequestedBy != 0 {
		t.Fatalf("pending rematch by %d", *r.RequestedBy)
	}
	a.expect("presence")

	b2.send(map[string]any{"t": "rematch", "game": 1})
	var dealers [2]int
	for i, w := range []*wsc{a, b2} {
		s, env := expectState(t, w)
		if s.Game != 2 || env.Seq != 0 || s.Tally != tally {
			t.Fatalf("seat %d rematch state game %d seq %d tally %v (store %v)", i, s.Game, env.Seq, s.Tally, tally)
		}
		dealers[i] = int(env.State.Active)
	}
	row2, err := e.st.Get(context.Background(), d.code)
	if err != nil {
		t.Fatal(err)
	}
	if row2.Game != 2 || row2.LastDealer != 1-row1.LastDealer || row2.Tally != tally {
		t.Fatalf("game %d dealer %d→%d tally %v", row2.Game, row1.LastDealer, row2.LastDealer, row2.Tally)
	}
	// The dealer's opponent acts first.
	if dealers[0] != 1-row2.LastDealer {
		t.Fatalf("game 2 opens with seat %d, dealer %d", dealers[0], row2.LastDealer)
	}
	if sum := tally[0] + tally[1]; sum > 1 {
		t.Fatalf("tally %v after one game", tally)
	}
}

// ---- liveness and limits ----

func TestWS_PingPong(t *testing.T) {
	e := newPlayEnv(t, playOpts{})
	c0 := e.create(t, "Alice")
	a, _ := e.connect(t, c0)
	for range 3 {
		a.send(map[string]any{"t": "ping"})
		decodeFrame[struct {
			T string `json:"t"`
		}](t, a.expect("pong"))
	}
}

func TestWS_SilentSocketClosed(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(41), cfg: func(c *Config) { c.tune.idleTimeout = 300 * time.Millisecond }})
	d := newDuo(t, e, 41)
	a, b := d.p[0], d.p[1]
	// A keeps pinging and stays; B goes silent and is closed bare.
	var offline bool
	stop := time.Now().Add(700 * time.Millisecond)
	for time.Now().Before(stop) {
		a.send(map[string]any{"t": "ping"})
		for f := a.next(time.Second); f.T != "pong"; f = a.next(time.Second) {
			p := decodeFrame[presenceIn](t, f)
			offline = !*p.OpponentOnline
		}
		time.Sleep(100 * time.Millisecond)
	}
	b.closed(2 * time.Second)
	if !offline {
		t.Fatal("no presence false after the idle close")
	}
	if !a.isOpen() {
		t.Fatal("pinging socket closed")
	}
}

func TestWS_OversizeFrameCloses(t *testing.T) {
	e := newPlayEnv(t, playOpts{})
	a, _ := e.connect(t, e.create(t, "Alice"))
	a.send(map[string]any{"t": "ping", "pad": strings.Repeat("x", 1100)})
	if st := a.closed(3 * time.Second); st != websocket.StatusMessageTooBig {
		t.Fatalf("close status %v, want 1009", st)
	}
	// Exactly at the limit is fine.
	b, _ := e.connect(t, e.create(t, "Blake"))
	pad := 1024 - len(`{"t":"ping","pad":""}`)
	b.sendRaw([]byte(`{"t":"ping","pad":"` + strings.Repeat("x", pad) + `"}`))
	b.expect("pong")
}

func TestWS_FrameRateLimit(t *testing.T) {
	e := newPlayEnv(t, playOpts{cfg: func(c *Config) {
		c.tune.limitedClose = 400 * time.Millisecond
		c.tune.frameRate, c.tune.frameBurst = 0, 0 // SPEC §2.12.6: 10/s, burst 20
	}})
	a, _ := e.connect(t, e.create(t, "Alice"))
	for range 40 {
		a.send(map[string]any{"t": "ping"})
	}
	pongs, limited := 0, 0
	for {
		select {
		case f := <-a.in:
			switch f.T {
			case "pong":
				pongs++
			case "error":
				if decodeFrame[errorIn](t, f).Code != "RATE_LIMITED" {
					t.Fatalf("%s", f.raw)
				}
				limited++
			}
			continue
		case <-time.After(200 * time.Millisecond):
		}
		break
	}
	if pongs < 19 || pongs > 23 || limited != 1 {
		t.Fatalf("burst of 40: %d pongs, %d RATE_LIMITED (want ~20 and exactly 1)", pongs, limited)
	}
	if !a.isOpen() {
		t.Fatal("closed after a short burst")
	}
	// Staying over the limit past limitedClose is a bare close.
	deadline := time.Now().Add(3 * time.Second)
	for a.isOpen() && time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = a.c.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`))
		cancel()
		time.Sleep(20 * time.Millisecond)
	}
	if a.isOpen() {
		t.Fatal("socket over the limit was never closed")
	}
}

func TestWS_SlowConsumerDisconnectedWithoutBlockingTheRoom(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(51), cfg: func(c *Config) { c.tune.sendBuffer = 4 }})
	c0 := e.create(t, "Alice")
	c1 := e.join(t, c0.Code, "Blake")
	a, _ := e.connect(t, c0)
	expectState(t, a)
	// B says hello and then never reads again.
	raw := e.dialRaw(t)
	hello, _ := json.Marshal(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": c1.Token, "lastSeq": 0})
	if err := raw.Write(context.Background(), websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	a.expect("presence")

	// Flood seat 1 from under the room lock. Every enqueue must return at
	// once; the connection must be dropped, not waited on.
	r := e.liveRoom(t, c0.Code)
	var killed bool
	start := time.Now()
	for i := 0; i < 200000 && !killed; i++ {
		r.mu.Lock()
		c := r.live.conns[1]
		if c == nil {
			killed = true
		} else {
			env, err := r.sess.View(1)
			if err != nil {
				t.Fatal(err)
			}
			t0 := time.Now()
			c.enqueue(newStateFrame(r, 1, env))
			if el := time.Since(t0); el > 50*time.Millisecond {
				r.mu.Unlock()
				t.Fatalf("enqueue blocked for %v under the room lock", el)
			}
		}
		r.mu.Unlock()
		if !killed {
			select {
			case <-c.dead:
				killed = true
			default:
			}
		}
	}
	if !killed {
		t.Fatal("slow consumer never disconnected")
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("took %v", el)
	}
	p := decodeFrame[presenceIn](t, a.expect("presence"))
	if *p.OpponentOnline {
		t.Fatal("presence true after the slow consumer was dropped")
	}
}

// liveRoom returns the loaded room for code.
func (e *playEnv) liveRoom(t *testing.T, code string) *room {
	t.Helper()
	e.rooms.mu.Lock()
	defer e.rooms.mu.Unlock()
	r := e.rooms.rooms[code]
	if r == nil {
		t.Fatalf("room %s not loaded", code)
	}
	return r
}

// ---- restart, expiry, shutdown ----

func TestWS_RestartMidGameRestoresAndContinues(t *testing.T) {
	e1 := newPlayEnv(t, playOpts{rand: seededRand(61)})
	d := newDuo(t, e1, 61)
	d.playMoves(5)
	d.settle()
	seq := d.truth.Seq()
	tokens := [2]string{d.p[0].token, d.p[1].token}
	e1.stop()
	for _, w := range d.p {
		<-w.done // closed by the shutdown, no terminal frame required
	}

	e2 := newPlayEnv(t, playOpts{rand: seededRand(999), dbPath: e1.dbPath})
	d.e = e2
	for s := range 2 {
		w, _ := e2.connect(t, claimBody{Code: d.code, Seat: s, Token: tokens[s]})
		d.p[s] = w
		_, env := expectState(t, w)
		if env.Seq != seq {
			t.Fatalf("seat %d restored at seq %d, want %d", s, env.Seq, seq)
		}
		e := env
		d.env[s] = &e
		if s == 1 {
			d.p[0].expect("presence")
		}
	}
	d.held, d.expectR = [2]bool{}, [2]bool{}
	d.playMoves(3)
	d.settle()
	if got := e2.sessionSeq(t, d.code); got != seq+3 && !d.st().Over {
		t.Fatalf("store at %d after 3 more moves from %d", got, seq)
	}
}

func TestWS_RoomExpiryUnderLiveSocketIsRoomGone(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(71)})
	d := newDuo(t, e, 71)
	e.clk.Advance(25 * time.Hour)
	if _, _, err := e.rooms.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, w := range d.p {
		expectError(t, w, "ROOM_GONE")
		w.closed(3 * time.Second)
	}
}

func TestWS_IdleMemSweepKeepsConnectedRooms(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(72)})
	d := newDuo(t, e, 72)
	e.clk.Advance(2 * time.Hour) // past MemIdle, well inside the store TTL
	if _, dropped, err := e.rooms.Sweep(context.Background()); err != nil || dropped != 0 {
		t.Fatalf("dropped %d rooms with live sockets (%v)", dropped, err)
	}
	d.playMoves(2)
	d.settle()
}

func TestWS_ShutdownClosesSocketsAndLeaksNothing(t *testing.T) {
	base := runtime.NumGoroutine()
	func() {
		e := newPlayEnv(t, playOpts{rand: seededRand(81), cfg: func(c *Config) { c.RespondMin = 10 * time.Second }})
		d := newDuo(t, e, 81)
		// Leave a hold timer pending across the shutdown.
		for guard := 0; guard < 300; guard++ {
			if seat, env, ok := d.ready(); ok {
				idx := -1
				for i, m := range env.LegalMoves {
					if isCounterableView(m) {
						idx = i
					}
				}
				if idx >= 0 {
					d.move(seat, idx)
					d.p[seat].expect("responding")
					break
				}
			}
			d.step()
		}
		e.stop()
		for _, w := range d.p {
			select {
			case <-w.done:
			case <-time.After(3 * time.Second):
				t.Fatal("socket open after shutdown")
			}
		}
		if n := e.pendingTimers(); n != 0 {
			t.Fatalf("%d hold timers left after shutdown", n)
		}
	}()
	waitGoroutines(t, base)
}

// pendingTimers counts live hold timers across cached rooms.
func (e *playEnv) pendingTimers() int {
	e.rooms.mu.Lock()
	rs := make([]*room, 0, len(e.rooms.rooms))
	for _, r := range e.rooms.rooms {
		rs = append(rs, r)
	}
	e.rooms.mu.Unlock()
	n := 0
	for _, r := range rs {
		r.mu.Lock()
		for _, h := range r.live.holds {
			if h.timer != nil {
				n++
			}
		}
		r.mu.Unlock()
	}
	return n
}

// ---- privacy of the send path and the logs ----

// TestWS_FramesCarryOnlyClientSafeData pins the frame types: the only
// field that can hold game data is a game.ClientSafe, and every other
// field is a plain scalar, so a snapshot, an Update or a token can't be
// put in a frame by accident.
func TestWS_FramesCarryOnlyClientSafeData(t *testing.T) {
	safe := reflect.TypeOf((*game.ClientSafe)(nil)).Elem()
	for _, f := range allFrameTypes() {
		ty := reflect.TypeOf(f)
		for i := range ty.NumField() {
			fl := ty.Field(i)
			switch k := fl.Type.Kind(); {
			case fl.Type == safe:
			case k == reflect.String || k == reflect.Int || k == reflect.Bool:
			case k == reflect.Array && fl.Type.Elem().Kind() == reflect.Int:
			case k == reflect.Array && fl.Type.Elem() == reflect.TypeOf((*string)(nil)):
			case k == reflect.Pointer && fl.Type.Elem().Kind() == reflect.Int:
			default:
				t.Errorf("%s.%s has type %s", ty.Name(), fl.Name, fl.Type)
			}
			if strings.Contains(strings.ToLower(fl.Name), "token") {
				t.Errorf("%s.%s", ty.Name(), fl.Name)
			}
		}
	}
	// An Update or a ServerSnapshot can't become a state frame's envelope.
	var up any = game.Update{}
	if _, ok := up.(game.ClientSafe); ok {
		t.Fatal("Update is ClientSafe")
	}
	var snap any = game.ServerSnapshot{}
	if _, ok := snap.(game.ClientSafe); ok {
		t.Fatal("ServerSnapshot is ClientSafe")
	}
}

func TestWS_LogsCarryNoTokensNamesOrCards(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(91)})
	d := newDuo(t, e, 91)
	d.playMoves(6)
	d.settle()
	d.p[0].send(map[string]any{"t": "move", "game": 1, "seq": 0, "index": 0})
	d.p[0].expect("error")
	d.p[0].next(time.Second) // the resync
	w, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	w.hello(d.code, "guess-token-value")
	expectError(t, w, "UNAUTHORIZED")
	e.stop()
	logs := e.logs.String()
	for _, bad := range []string{d.p[0].token, d.p[1].token, "guess-token-value", "Alice", "Blake", `"Rank"`, "envelope", "legalMoves"} {
		if strings.Contains(logs, bad) {
			t.Fatalf("logs contain %q", bad)
		}
	}
	if !strings.Contains(logs, d.code) {
		t.Fatal("logs name no room code; the play events aren't logged")
	}
}

// ---- unit: the per-connection writer never blocks a sender ----

type stuckWriter struct{ release chan struct{} }

func (s *stuckWriter) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *stuckWriter) Close(websocket.StatusCode, string) error { return nil }
func (s *stuckWriter) CloseNow() error                          { return nil }

func TestConn_EnqueueNeverBlocksAndDropsWhenFull(t *testing.T) {
	sw := &stuckWriter{release: make(chan struct{})}
	c := newConn(sw, "ABCD", 0, playTuning{sendBuffer: 3, writeTimeout: time.Minute}.withDefaults(), nil)
	done := make(chan struct{})
	go func() { c.writeLoop(); close(done) }()
	start := time.Now()
	ok := 0
	for range 50 {
		if c.enqueue(newPongFrame()) {
			ok++
		}
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("enqueue blocked")
	}
	if ok > 5 {
		t.Fatalf("%d frames accepted with a buffer of 3 and a stuck writer", ok)
	}
	select {
	case <-c.dead:
	default:
		t.Fatal("full buffer did not kill the connection")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("writer goroutine did not exit after the kill")
	}
	if c.enqueue(newPongFrame()) {
		t.Fatal("enqueue accepted on a dead connection")
	}
}
