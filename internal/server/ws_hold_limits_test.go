package server

// Strict-tier review fixes for the WebSocket play server (two-phone W6/W7):
// the held mover learns nothing from its own frames, welcome and rematch
// respect the hold, failed hellos are capped under concurrency without
// locking out a valid token, sockets are capped, withRoom survives a panic,
// and shutdown waits for hijacked sockets.

import (
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle/engine"
)

// ---- fix 1: the held mover can't probe the hold ----

// heldProbe plays a one-off that opens a counter window, optionally lets
// the responder decline (the answer is in, the hold's minimum is not), then
// sends the mover's probes and returns the raw frames it got back.
func heldProbe(t *testing.T, answered bool) (frames []string, mover game.Seat) {
	t.Helper()
	const hold = 2 * time.Second
	e, d, mover := holdScenario(t, hold, true)
	defer e.stop()
	start := d.heldFrom[mover]
	m, o := d.p[mover], d.p[mover.Other()]
	d.absorb(mover, m.expect("responding"))
	_, env := expectState(t, o)
	d.env[mover.Other()] = &env
	s := d.truth.Seq() - 1 // the envelope the mover moved from
	if answered {
		decline := -1
		for i, mv := range env.LegalMoves {
			if mv.Kind == engine.MoveDecline {
				decline = i
			}
		}
		if decline < 0 {
			t.Fatal("window without a decline")
		}
		d.move(mover.Other(), decline)
		// The responder's state proves the server applied the answer.
		expectState(t, o)
	}
	stored := e.sessionSeq(t, d.code)
	probes := []map[string]any{
		{"t": "move", "game": d.gameNo, "seq": s, "index": 0},
		{"t": "move", "game": d.gameNo, "seq": s + 1, "index": 0},
		{"t": "move", "game": d.gameNo, "seq": s + 2, "index": 0},
		{"t": "move", "game": d.gameNo + 1, "seq": s + 1, "index": 0},
		{"t": "rematch", "game": d.gameNo},
		{"t": "rematch", "game": d.gameNo + 1},
	}
	for _, p := range probes {
		m.send(p)
		for range 2 {
			frames = append(frames, string(m.next(time.Second).raw))
		}
	}
	if time.Since(start) >= hold {
		t.Fatal("test too slow to probe inside the hold")
	}
	if got := e.sessionSeq(t, d.code); got != stored {
		t.Fatalf("a held mover's probe moved the session: %d → %d", stored, got)
	}
	o.quiet(100 * time.Millisecond)
	return frames, mover
}

func TestWS_HeldMoverFramesRevealNothing(t *testing.T) {
	quiet, mq := heldProbe(t, false)
	answered, ma := heldProbe(t, true)
	if mq != ma {
		t.Fatalf("scenarios picked different movers: %d, %d", mq, ma)
	}
	want := []string{
		`{"t":"error","code":"STALE","message":"that move is out of date"}`,
		`{"t":"responding","by":` + string(rune('0'+int(mq.Other()))) + `}`,
	}
	for i, f := range quiet {
		if f != want[i%2] {
			t.Errorf("unanswered probe frame %d: %s, want %s", i, f, want[i%2])
		}
	}
	for i := range answered {
		if answered[i] != quiet[i] {
			t.Errorf("frame %d differs once the answer is in: %s vs %s", i, answered[i], quiet[i])
		}
	}
}

// ---- fixes 1, 3a, 3b at game over ----

// setHold marks seat as the mover under a hold with no timer; releaseHold
// ends it through the real release path.
func (e *playEnv) setHold(t *testing.T, code string, seat game.Seat) {
	t.Helper()
	r := e.liveRoom(t, code)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live.holds[seat].clear()
	r.live.holds[seat].active, r.live.holds[seat].t0 = true, time.Now()
}

func (e *playEnv) releaseHold(t *testing.T, code string, seat game.Seat) {
	t.Helper()
	r := e.liveRoom(t, code)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live.holds[seat].t0 = time.Now().Add(-time.Hour)
	e.play.checkHoldsLocked(r, time.Now())
}

func TestWS_HeldSeatAtGameOverLearnsNothing(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(33), cfg: func(c *Config) { c.RespondMin = 5 * time.Millisecond }})
	d := newDuo(t, e, 33)
	d.playToEnd()
	d.settle()
	a, b := d.p[0], d.p[1]
	seq := d.truth.Seq()
	// Seat 0 is the mover of the game-ending exchange, still held.
	e.setHold(t, d.code, 0)

	stale := func(w *wsc) {
		t.Helper()
		if er := expectError(t, w, "STALE"); er.Seq != nil {
			t.Fatalf("held STALE echoes seq %d", *er.Seq)
		}
		if r := decodeFrame[respondingIn](t, w.expect("responding")); *r.By != 1 {
			t.Fatalf("responding by %d", *r.By)
		}
	}
	// A move would be GAME_OVER; a rematch would be announced.
	a.send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": 0})
	stale(a)
	a.send(map[string]any{"t": "rematch", "game": d.gameNo})
	stale(a)
	b.quiet(100 * time.Millisecond)
	r := e.liveRoom(t, d.code)
	r.mu.Lock()
	asked := r.live.rematch
	r.mu.Unlock()
	if asked != [2]bool{} {
		t.Fatalf("a held seat's rematch touched the requests: %v", asked)
	}

	// 3b: the other seat's request isn't broadcast to the held seat.
	b.send(map[string]any{"t": "rematch", "game": d.gameNo})
	if rq := decodeFrame[rematchIn](t, b.expect("rematch")); *rq.RequestedBy != 1 {
		t.Fatalf("requestedBy %d", *rq.RequestedBy)
	}
	a.quiet(150 * time.Millisecond)

	// 3a: a reconnect during the hold says playing, then responding, and
	// no pending rematch.
	a2, w := e.connect(t, claimBody{Code: d.code, Seat: 0, Token: a.token})
	if w.Status != "playing" {
		t.Fatalf("welcome during the hold says %q", w.Status)
	}
	a2.expect("responding")
	a2.quiet(150 * time.Millisecond)
	expectError(t, a, "REPLACED")

	// The release delivers the state, then the still-pending request.
	e.releaseHold(t, d.code, 0)
	if _, env := expectState(t, a2); env.Seq != seq || env.State.Phase != engine.PhaseGameOver {
		t.Fatalf("released state seq %d phase %v", env.Seq, env.State.Phase)
	}
	if rq := decodeFrame[rematchIn](t, a2.expect("rematch")); *rq.RequestedBy != 1 {
		t.Fatalf("pending requestedBy %d", *rq.RequestedBy)
	}
	// Released, seat 0 can accept: game 2 is dealt.
	a2.send(map[string]any{"t": "rematch", "game": d.gameNo})
	for _, c := range []*wsc{a2, b} {
		if s, _ := expectState(t, c); s.Game != d.gameNo+1 {
			t.Fatalf("rematch dealt game %d", s.Game)
		}
	}
}

func TestWS_RematchReleasedAfterHoldOnlyIfStillPending(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(34), cfg: func(c *Config) { c.RespondMin = 5 * time.Millisecond }})
	d := newDuo(t, e, 34)
	d.playToEnd()
	d.settle()
	a, b := d.p[0], d.p[1]
	// No request pending: the release sends the state only.
	e.setHold(t, d.code, 0)
	e.releaseHold(t, d.code, 0)
	expectState(t, a)
	a.quiet(100 * time.Millisecond)
	b.quiet(50 * time.Millisecond)
}

// ---- fixes 2 and 5: the failed-hello limiter ----

// parallelHellos sends one hello per token at once, from the same client,
// with every Authenticate held until all have arrived (or a second has
// passed), and returns the error codes (welcome = "").
func parallelHellos(t *testing.T, e *playEnv, code string, tokens []string) []string {
	t.Helper()
	ws := make([]*wsc, len(tokens))
	for i := range tokens {
		w, _, err := e.dial(t, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		ws[i] = w
	}
	var arrived atomic.Int32
	release := make(chan struct{})
	var once sync.Once
	gate := func() {
		if int(arrived.Add(1)) == len(tokens) {
			once.Do(func() { close(release) })
		}
		select {
		case <-release:
		case <-time.After(time.Second):
		}
	}
	e.fs.authGate.Store(&gate)
	defer e.fs.authGate.Store(nil)
	var wg sync.WaitGroup
	for i, w := range ws {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.hello(code, tokens[i])
		}()
	}
	wg.Wait()
	out := make([]string, len(ws))
	for i, w := range ws {
		f := w.next(3 * time.Second)
		switch f.T {
		case "welcome":
		case "error":
			out[i] = decodeFrame[errorIn](t, f).Code
		default:
			t.Fatalf("hello answered %s", f.raw)
		}
	}
	return out
}

func count(codes []string, want string) int {
	n := 0
	for _, c := range codes {
		if c == want {
			n++
		}
	}
	return n
}

func TestWS_ParallelFailedHellosAreCapped(t *testing.T) {
	const budget, n = 3, 10
	e := newPlayEnv(t, playOpts{rand: seededRand(35), cfg: func(c *Config) {
		c.tune.failedHelloPerHour, c.MaxSocketsPerClient = budget, 2*n
	}})
	c0 := e.create(t, "Alice")
	tokens := make([]string, n)
	for i := range tokens {
		tokens[i] = "guess-" + string(rune('a'+i))
	}
	codes := parallelHellos(t, e, c0.Code, tokens)
	if u, rl := count(codes, "UNAUTHORIZED"), count(codes, "RATE_LIMITED"); u != budget || rl != n-budget {
		t.Fatalf("%d parallel guesses with a budget of %d: %d UNAUTHORIZED, %d RATE_LIMITED (%v)", n, budget, u, rl, codes)
	}
}

func TestWS_FailedHelloBudgetChargesEveryParallelGuess(t *testing.T) {
	const budget, n = 30, 10
	e := newPlayEnv(t, playOpts{rand: seededRand(36), cfg: func(c *Config) {
		c.tune.failedHelloPerHour, c.MaxSocketsPerClient = budget, 2*n
	}})
	c0 := e.create(t, "Alice")
	tokens := make([]string, n)
	for i := range tokens {
		tokens[i] = "guess-" + string(rune('a'+i))
	}
	if codes := parallelHellos(t, e, c0.Code, tokens); count(codes, "UNAUTHORIZED") != n {
		t.Fatalf("codes %v", codes)
	}
	e.play.failed.mu.Lock()
	defer e.play.failed.mu.Unlock()
	b := e.play.failed.keys["127.0.0.1"]
	if b == nil || b.tokens > budget-n+0.5 {
		t.Fatalf("%d guesses left the bucket at %+v, want %d", n, b, budget-n)
	}
}

func TestWS_ValidTokenPassesAnExhaustedFailedHelloBudget(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(37), cfg: func(c *Config) { c.tune.failedHelloPerHour = 3 }})
	c0 := e.create(t, "Alice")
	c1 := e.join(t, c0.Code, "Blake")
	try := func(code, token, want string) {
		t.Helper()
		w, _, err := e.dial(t, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		w.hello(code, token)
		if want == "welcome" {
			w.expect("welcome")
			w.c.CloseNow()
			<-w.done
			return
		}
		expectError(t, w, want)
		w.closed(3 * time.Second)
	}
	try(c0.Code, "guess1", "UNAUTHORIZED")
	try(c0.Code, "guess2", "UNAUTHORIZED")
	// Valid hellos reserve a token and get it back: they cost nothing.
	for range 5 {
		try(c0.Code, c0.Token, "welcome")
	}
	try(c0.Code, "guess3", "UNAUTHORIZED")
	// Exhausted: guesses are refused without a verdict, a real seat isn't.
	try(c0.Code, "guess4", "RATE_LIMITED")
	try("ZZZZ", "guess5", "RATE_LIMITED")
	try(c0.Code, c1.Token, "welcome")
	try(c0.Code, c0.Token, "welcome")
	try(c0.Code, "guess6", "RATE_LIMITED")
}

// ---- fix 4: socket caps ----

func dialStatus(t *testing.T, e *playEnv) (*wsc, int) {
	t.Helper()
	w, resp, err := e.dial(t, testOrigin)
	if err != nil {
		if resp == nil {
			t.Fatalf("dial: %v", err)
		}
		return nil, resp.StatusCode
	}
	return w, http.StatusSwitchingProtocols
}

func TestWS_SocketCaps(t *testing.T) {
	cases := []struct {
		name          string
		total, perKey int
		allowed       int
	}{
		{name: "per client", total: 100, perKey: 3, allowed: 3},
		{name: "global", total: 2, perKey: 8, allowed: 2},
	}
	base := runtime.NumGoroutine()
	for _, tc := range cases {
		func() {
			e := newPlayEnv(t, playOpts{cfg: func(c *Config) {
				c.MaxSockets, c.MaxSocketsPerClient = tc.total, tc.perKey
			}})
			defer e.stop()
			var open []*wsc
			for range tc.allowed {
				w, st := dialStatus(t, e)
				if st != http.StatusSwitchingProtocols {
					t.Fatalf("%s: socket %d refused with %d", tc.name, len(open)+1, st)
				}
				open = append(open, w)
			}
			for range 3 {
				if _, st := dialStatus(t, e); st != http.StatusServiceUnavailable {
					t.Fatalf("%s: over the cap got %d, want 503", tc.name, st)
				}
			}
			// A closed socket frees its slot.
			open[0].c.CloseNow()
			<-open[0].done
			deadline := time.Now().Add(3 * time.Second)
			for {
				w, st := dialStatus(t, e)
				if st == http.StatusSwitchingProtocols {
					w.c.CloseNow()
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("%s: slot never freed", tc.name)
				}
				time.Sleep(20 * time.Millisecond)
			}
			for _, w := range open {
				w.c.CloseNow()
			}
		}()
	}
	waitGoroutines(t, base)
}

func TestParseConfigSocketCaps(t *testing.T) {
	cfg, err := ParseConfig(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxSockets != DefaultMaxSockets || cfg.MaxSocketsPerClient != DefaultMaxSocketsPerClient {
		t.Fatalf("defaults %d %d", cfg.MaxSockets, cfg.MaxSocketsPerClient)
	}
	env := map[string]string{"CUTTLE_MAX_SOCKETS": "40", "CUTTLE_MAX_SOCKETS_PER_CLIENT": "4"}
	cfg, err = ParseConfig(nil, func(k string) string { return env[k] })
	if err != nil || cfg.MaxSockets != 40 || cfg.MaxSocketsPerClient != 4 {
		t.Fatalf("env: %+v %v", cfg, err)
	}
	cfg, err = ParseConfig([]string{"-max-sockets", "50", "-max-sockets-per-client", "5"}, func(k string) string { return env[k] })
	if err != nil || cfg.MaxSockets != 50 || cfg.MaxSocketsPerClient != 5 {
		t.Fatalf("flags: %+v %v", cfg, err)
	}
	for _, args := range [][]string{{"-max-sockets", "0"}, {"-max-sockets-per-client", "0"}} {
		if _, err := ParseConfig(args, func(string) string { return "" }); err == nil {
			t.Errorf("%v accepted", args)
		}
	}
}

// ---- fix 6: withRoom releases the room lock on a panic ----

func TestRooms_WithRoomPanicDoesNotWedgeTheRoom(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("no panic")
			}
		}()
		_ = e.rooms.withRoom(bg, c0.Code, func(*room) error { panic("boom") })
	}()
	done := make(chan error, 2)
	go func() { done <- e.rooms.withRoom(bg, c0.Code, func(*room) error { return nil }) }()
	go func() { _, _, err := e.rooms.Sweep(bg); done <- err }()
	for range 2 {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("room lock still held after a panicking callback")
		}
	}
}

// ---- fix 7: shutdown waits for hijacked sockets ----

func TestWS_WaitSocketsWaitsForHandlers(t *testing.T) {
	e := newPlayEnv(t, playOpts{})
	a, _ := e.connect(t, e.create(t, "Alice"))
	// A socket that hasn't said hello is bound to no room; it must close
	// too, not wait out the hello deadline.
	pre, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if e.rooms.WaitSockets(150 * time.Millisecond) {
		t.Fatal("WaitSockets returned true with a socket open")
	}
	e.cancel() // closeAll
	<-a.done
	if !e.rooms.WaitSockets(3 * time.Second) {
		t.Fatal("socket handlers still running after the shutdown")
	}
	select {
	case <-pre.done:
	case <-time.After(time.Second):
		t.Fatal("a socket before hello survived the shutdown")
	}
}

// ---- test gap: concurrent hellos for one seat ----

func TestWS_ConcurrentHellosExactlyOneSurvives(t *testing.T) {
	e := newPlayEnv(t, playOpts{rand: seededRand(39)})
	c0 := e.create(t, "Alice")
	e.join(t, c0.Code, "Blake")
	ws := make([]*wsc, 2)
	for i := range ws {
		w, _, err := e.dial(t, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		w.seat, ws[i] = 0, w
	}
	var wg sync.WaitGroup
	for _, w := range ws {
		wg.Add(1)
		go func() { defer wg.Done(); w.hello(c0.Code, c0.Token) }()
	}
	wg.Wait()
	// Each hears welcome and state; one then gets REPLACED and a close.
	replaced := -1
	for i, w := range ws {
		w.expect("welcome")
		expectState(t, w)
		select {
		case f := <-w.in:
			if er := decodeFrame[errorIn](t, f); er.Code != "REPLACED" {
				t.Fatalf("socket %d got %s", i, f.raw)
			}
			w.closed(3 * time.Second)
			if replaced >= 0 {
				t.Fatal("both sockets replaced")
			}
			replaced = i
		case <-time.After(300 * time.Millisecond):
		}
	}
	if replaced < 0 {
		t.Fatal("neither socket was replaced")
	}
	survivor := ws[1-replaced]
	survivor.send(map[string]any{"t": "ping"})
	survivor.expect("pong")
	r := e.liveRoom(t, c0.Code)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.live.conns[0] == nil || r.live.conns[1] != nil {
		t.Fatal("seat binding wrong after the race")
	}
}
