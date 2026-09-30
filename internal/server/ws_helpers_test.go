package server

// Test harness for the WebSocket play protocol (two-phone W6, SPEC §2.12):
// a real httptest server over a file-backed store, real WebSocket clients,
// and a two-seat game driver that replays every move on a local Session to
// know the hidden cards at every seq.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/store"
	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

const testOrigin = "https://play.example"

// testHold is the response hold used unless a test sets its own.
const testHold = 60 * time.Millisecond

type playEnv struct {
	t      *testing.T
	clk    *fakeClock
	dbPath string
	st     *store.SQLite
	fs     *flakyStore
	rooms  *Rooms
	play   *play
	cancel context.CancelFunc // ends the handler's context: closes every socket
	srv    *httptest.Server
	logs   *syncBuffer
	cfg    Config

	stopOnce sync.Once
}

type playOpts struct {
	cfg    func(*Config)
	rand   io.Reader
	dbPath string
	clk    *fakeClock
}

func newPlayEnv(t *testing.T, o playOpts) *playEnv {
	t.Helper()
	clk := o.clk
	if clk == nil {
		clk = newClock()
	}
	path := o.dbPath
	if path == "" {
		path = filepath.Join(t.TempDir(), "cuttle.db")
	}
	st, err := store.Open(path, store.Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	log := slog.New(slog.NewJSONHandler(logs, nil))
	fs := &flakyStore{Store: st}
	rooms := NewRooms(fs, RoomsOptions{Now: clk.Now, Rand: o.rand, Log: log})
	cfg := Config{Addr: DefaultAddr, AllowedOrigins: []string{testOrigin}, RespondMin: testHold}
	// The driver plays at machine speed; TestWS_FrameRateLimit pins the
	// SPEC rate itself.
	cfg.tune.frameRate, cfg.tune.frameBurst = 1000, 1000
	if o.cfg != nil {
		o.cfg(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h, p := newHandler(ctx, cfg, BuildInfo{}, log, rooms)
	e := &playEnv{t: t, clk: clk, dbPath: path, st: st, fs: fs, rooms: rooms, play: p, cancel: cancel,
		srv: httptest.NewServer(h), logs: logs, cfg: cfg}
	t.Cleanup(e.stop)
	return e
}

// stop closes every socket, the server and the store.
func (e *playEnv) stop() {
	e.stopOnce.Do(func() {
		e.cancel()
		e.waitClosed()
		e.srv.Close()
		e.srv.Client().CloseIdleConnections()
		e.st.Close()
	})
}

// waitClosed waits until no cached room has a bound socket (the handler's
// context was cancelled and the sockets closed).
func (e *playEnv) waitClosed() {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		busy := false
		e.rooms.mu.Lock()
		rs := make([]*room, 0, len(e.rooms.rooms))
		for _, r := range e.rooms.rooms {
			rs = append(rs, r)
		}
		e.rooms.mu.Unlock()
		for _, r := range rs {
			r.mu.Lock()
			busy = busy || r.live.connected()
			r.mu.Unlock()
		}
		if !busy {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.t.Error("sockets still bound after the handler context ended")
}

func (e *playEnv) wsURL() string { return "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/api/play" }

func (e *playEnv) post(t *testing.T, path, name string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+path, strings.NewReader(fmt.Sprintf(`{"name":%q}`, name)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Close = true
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (e *playEnv) create(t *testing.T, name string) claimBody {
	t.Helper()
	code, b := e.post(t, "/api/rooms", name)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, b)
	}
	var c claimBody
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func (e *playEnv) join(t *testing.T, code, name string) claimBody {
	t.Helper()
	status, b := e.post(t, "/api/rooms/"+code+"/join", name)
	if status != http.StatusOK {
		t.Fatalf("join: %d %s", status, b)
	}
	var c claimBody
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// ---- client ----

type frameIn struct {
	T   string `json:"t"`
	raw []byte
	at  time.Time
}

type wsc struct {
	t     *testing.T
	c     *websocket.Conn
	in    chan frameIn
	done  chan struct{}
	err   error // the read error, valid after done
	token string
	seat  game.Seat
}

// dial opens a socket with the given Origin ("" sends none).
func (e *playEnv) dial(t *testing.T, origin string) (*wsc, *http.Response, error) {
	t.Helper()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return nil, resp, err
	}
	c.SetReadLimit(1 << 20)
	w := &wsc{t: t, c: c, in: make(chan frameIn, 4096), done: make(chan struct{})}
	go w.readLoop()
	t.Cleanup(func() { _ = c.CloseNow() })
	return w, resp, nil
}

// dialRaw opens a socket that is never read (a slow consumer).
func (e *playEnv) dialRaw(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {testOrigin}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func (w *wsc) readLoop() {
	defer close(w.done)
	for {
		_, b, err := w.c.Read(context.Background())
		if err != nil {
			w.err = err
			return
		}
		var f frameIn
		_ = json.Unmarshal(b, &f)
		f.raw, f.at = b, time.Now()
		w.in <- f
	}
}

func (w *wsc) send(v any) {
	w.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		w.t.Fatal(err)
	}
	w.sendRaw(b)
}

func (w *wsc) sendRaw(b []byte) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.c.Write(ctx, websocket.MessageText, b); err != nil {
		w.t.Fatalf("write: %v", err)
	}
}

func (w *wsc) hello(code, token string) {
	w.t.Helper()
	w.send(map[string]any{"t": "hello", "v": 1, "code": code, "token": token, "lastSeq": 0})
}

// next returns the next frame, failing on timeout or close.
func (w *wsc) next(timeout time.Duration) frameIn {
	w.t.Helper()
	select {
	case f := <-w.in:
		return f
	case <-time.After(timeout):
		w.t.Fatalf("seat %d: no frame within %v", w.seat, timeout)
	case <-w.done:
		select {
		case f := <-w.in:
			return f
		default:
		}
		w.t.Fatalf("seat %d: socket closed while waiting for a frame: %v", w.seat, w.err)
	}
	return frameIn{}
}

// expect returns the next frame and fails unless its type is typ.
func (w *wsc) expect(typ string) frameIn {
	w.t.Helper()
	f := w.next(3 * time.Second)
	if f.T != typ {
		w.t.Fatalf("seat %d: got %s, want %s", w.seat, f.raw, typ)
	}
	return f
}

// quiet fails if any frame arrives within d.
func (w *wsc) quiet(d time.Duration) {
	w.t.Helper()
	select {
	case f := <-w.in:
		w.t.Fatalf("seat %d: unexpected frame %s", w.seat, f.raw)
	case <-time.After(d):
	}
}

// closed waits for the socket to close with no further frame and returns
// the close status (-1 for a bare close).
func (w *wsc) closed(timeout time.Duration) websocket.StatusCode {
	w.t.Helper()
	select {
	case <-w.done:
	case f := <-w.in:
		w.t.Fatalf("seat %d: frame %s before the close", w.seat, f.raw)
	case <-time.After(timeout):
		w.t.Fatalf("seat %d: socket still open after %v", w.seat, timeout)
	}
	select {
	case f := <-w.in:
		w.t.Fatalf("seat %d: frame %s before the close", w.seat, f.raw)
	default:
	}
	return websocket.CloseStatus(w.err)
}

func (w *wsc) isOpen() bool {
	select {
	case <-w.done:
		return false
	default:
		return true
	}
}

// connect dials, says hello with claim, and consumes the welcome.
func (e *playEnv) connect(t *testing.T, c claimBody) (*wsc, welcomeIn) {
	t.Helper()
	w, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	w.token, w.seat = c.Token, game.Seat(c.Seat)
	w.hello(c.Code, c.Token)
	return w, decodeFrame[welcomeIn](t, w.expect("welcome"))
}

// ---- frame shapes as a client decodes them ----

type welcomeIn struct {
	T      string     `json:"t"`
	Seat   int        `json:"seat"`
	Names  [2]*string `json:"names"`
	Status string     `json:"status"`
}

type stateIn struct {
	T              string          `json:"t"`
	Game           int             `json:"game"`
	Envelope       json.RawMessage `json:"envelope"`
	OpponentOnline bool            `json:"opponentOnline"`
	Tally          [2]int          `json:"tally"`
}

type respondingIn struct {
	T  string `json:"t"`
	By *int   `json:"by"`
}

type presenceIn struct {
	T              string `json:"t"`
	OpponentOnline *bool  `json:"opponentOnline"`
}

type rematchIn struct {
	T           string `json:"t"`
	RequestedBy *int   `json:"requestedBy"`
}

type errorIn struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Seq     *int   `json:"seq"`
}

// decodeFrame decodes strictly: an unknown field is a test failure, so a
// frame can't grow a field (a seed, a deck) unnoticed.
func decodeFrame[T any](t *testing.T, f frameIn) T {
	t.Helper()
	var v T
	dec := json.NewDecoder(bytes.NewReader(f.raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode %T from %s: %v", v, f.raw, err)
	}
	return v
}

func decodeState(t *testing.T, f frameIn) (stateIn, game.Envelope) {
	t.Helper()
	if f.T != "state" {
		t.Fatalf("want state, got %s", f.raw)
	}
	s := decodeFrame[stateIn](t, f)
	var env game.Envelope
	dec := json.NewDecoder(bytes.NewReader(s.Envelope))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	return s, env
}

func expectError(t *testing.T, w *wsc, code string) errorIn {
	t.Helper()
	e := decodeFrame[errorIn](t, w.expect("error"))
	if e.Code != code {
		t.Fatalf("seat %d: error %s, want %s", w.seat, e.Code, code)
	}
	if e.Message == "" {
		t.Fatalf("error %s has no message", code)
	}
	return e
}

func expectState(t *testing.T, w *wsc) (stateIn, game.Envelope) {
	t.Helper()
	s, env := decodeState(t, w.expect("state"))
	if int(env.State.Viewer) != int(w.seat) {
		t.Fatalf("seat %d received viewer %d's envelope", w.seat, env.State.Viewer)
	}
	return s, env
}

// ---- deterministic deals ----

// seededRand makes the room manager's deals reproducible.
func seededRand(seed uint64) io.Reader {
	var key [32]byte
	for i := range 8 {
		key[i] = byte(seed >> (8 * i))
	}
	return rand.NewChaCha8(key)
}

// ---- the two-seat driver ----

// isCounterable mirrors SPEC §2.12.5's definition from the client side.
func isCounterableView(m game.MoveView) bool {
	switch m.Kind {
	case engine.MoveOneOff, engine.MoveCounter:
		return true
	case engine.MoveSevenPick:
		return m.SubMove != nil && m.SubMove.Kind == engine.MoveOneOff
	}
	return false
}

type cardKey struct{ r, s int }

// truthAt is the full game at one seq, for the privacy check.
type truthAt struct {
	st engine.GameState
	// view[s] is seat s's envelope at this seq from the local replay,
	// decoded generically: what the server must send, byte for byte.
	view [2]any
}

func (tr truthAt) hidden(seat game.Seat) map[cardKey]bool {
	h := map[cardKey]bool{}
	add := func(cs []card.Card) {
		for _, c := range cs {
			h[cardKey{int(c.Rank), int(c.Suit)}] = true
		}
	}
	me, opp := tr.st.Players[seat], tr.st.Players[seat.Other()]
	glasses := false
	for _, c := range me.Permanents {
		if c.Rank == card.Eight {
			glasses = true
		}
	}
	if !glasses {
		add(opp.Hand)
	}
	add(tr.st.Deck)
	if tr.st.Phase == engine.PhaseSevenChoosing && tr.st.Pending != nil && tr.st.Active != engine.PlayerID(seat) {
		add(tr.st.Pending.Revealed)
	}
	return h
}

type coverage struct {
	glasses, sevenReveal, counterWindow, noWindowOneOff, gameOver int
}

type duo struct {
	t    *testing.T
	e    *playEnv
	code string
	p    [2]*wsc
	rng  *rand.Rand
	hold time.Duration

	// truth replays every sent move; truths[n] is the game at seq n.
	gameNo int
	truth  *game.Session
	truths []truthAt

	env      [2]*game.Envelope
	tally    [2]int
	online   [2]bool
	held     [2]bool      // a responding arrived and its state hasn't
	heldFrom [2]time.Time // when the counterable move was sent
	expectR  [2]bool      // the next frame must be responding
	rematch  [2]*int      // last rematch frame seen per seat

	cov coverage
	// preferOneOff makes the driver play a counterable move when it can.
	preferOneOff bool
	// onFrame, when set, sees every frame after the built-in checks.
	onFrame func(seat game.Seat, f frameIn)
}

// newDuo creates a room over HTTP, connects both seats and consumes the
// opening frames.
func newDuo(t *testing.T, e *playEnv, seed uint64) *duo {
	t.Helper()
	c0 := e.create(t, "Alice")
	a, w := e.connect(t, c0)
	if w.Status != "waiting" {
		t.Fatalf("welcome status %q", w.Status)
	}
	c1 := e.join(t, c0.Code, "Blake")
	d := &duo{t: t, e: e, code: c0.Code, rng: rand.New(rand.NewPCG(seed, 7)), hold: e.cfg.RespondMin}
	d.p[0] = a
	// A hears about the join: welcome, then state.
	w = decodeFrame[welcomeIn](t, a.expect("welcome"))
	if w.Status != "playing" || w.Names[1] == nil || *w.Names[1] != "Blake" {
		t.Fatalf("join welcome %+v", w)
	}
	d.startGame(t)
	d.absorb(0, a.expect("state"))
	b, w := e.connect(t, c1)
	if w.Seat != 1 || w.Status != "playing" {
		t.Fatalf("B welcome %+v", w)
	}
	d.p[1] = b
	d.absorb(1, b.expect("state"))
	d.absorb(0, a.expect("presence"))
	if !d.online[0] || !d.online[1] {
		t.Fatalf("presence after both connected: %v", d.online)
	}
	return d
}

// startGame loads the current game's snapshot from the store as the truth.
func (d *duo) startGame(t *testing.T) {
	t.Helper()
	row, err := d.e.st.Get(context.Background(), d.code)
	if err != nil {
		t.Fatal(err)
	}
	s, err := game.RestoreSession(row.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if s.Seq() != 0 {
		t.Fatalf("new game at seq %d", s.Seq())
	}
	d.gameNo, d.truth = row.Game, s
	d.truths = []truthAt{d.snapshotTruth(t)}
	d.env = [2]*game.Envelope{}
}

func (d *duo) snapshotTruth(t *testing.T) truthAt {
	t.Helper()
	snap, err := d.truth.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	var w struct {
		State engine.GameState `json:"state"`
	}
	if err := json.Unmarshal(snap.PersistBytes(), &w); err != nil {
		t.Fatal(err)
	}
	tr := truthAt{st: w.State}
	for s := range 2 {
		env, err := d.truth.View(game.Seat(s))
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, &tr.view[s]); err != nil {
			t.Fatal(err)
		}
	}
	return tr
}

// checkPrivacy fails if frame f, received by seat, carries a card hidden
// from seat at the envelope's seq, or anything server-only.
func (d *duo) checkPrivacy(seat game.Seat, f frameIn, seq int) {
	t := d.t
	t.Helper()
	for _, bad := range []string{`"Deck"`, `"seed"`, `"snapshot"`, `"Seed"`, `"Players"`, d.p0token(), d.p1token()} {
		if bad != "" && bytes.Contains(f.raw, []byte(bad)) {
			t.Fatalf("seat %d frame carries %q: %s", seat, bad, f.raw)
		}
	}
	if seq < 0 {
		return
	}
	if seq >= len(d.truths) {
		t.Fatalf("seat %d got seq %d; only %d known", seat, seq, len(d.truths))
	}
	hidden := d.truths[seq].hidden(seat)
	var v map[string]any
	if err := json.Unmarshal(f.raw, &v); err != nil {
		t.Fatal(err)
	}
	// The envelope is exactly the seat's own redacted view at that seq.
	if !reflect.DeepEqual(v["envelope"], d.truths[seq].view[seat]) {
		t.Fatalf("seat %d at seq %d: envelope differs from the seat's own view", seat, seq)
	}
	// No hidden card anywhere outside the history. History entries name
	// cards at the moment they were played publicly (a point card a 9
	// later returned to its owner's hand stays named there); the
	// comparison above pins history to the bridge's redaction.
	walkCards(v, func(k cardKey) {
		if hidden[k] {
			t.Fatalf("seat %d at seq %d saw hidden card %v in %s", seat, seq, k, f.raw)
		}
	})
}

func (d *duo) p0token() string {
	if d.p[0] == nil {
		return ""
	}
	return d.p[0].token
}

func (d *duo) p1token() string {
	if d.p[1] == nil {
		return ""
	}
	return d.p[1].token
}

// walkCards calls fn for every card-shaped object ({Rank, Suit}) outside
// history and lastMove.
func walkCards(v any, fn func(cardKey)) {
	switch x := v.(type) {
	case map[string]any:
		r, rok := x["Rank"].(float64)
		s, sok := x["Suit"].(float64)
		if rok && sok {
			fn(cardKey{int(r), int(s)})
		}
		for k, c := range x {
			if k == "history" || k == "lastMove" {
				continue
			}
			walkCards(c, fn)
		}
	case []any:
		for _, c := range x {
			walkCards(c, fn)
		}
	}
}

// absorb applies the built-in checks to one frame and records it.
func (d *duo) absorb(seat game.Seat, f frameIn) {
	t := d.t
	t.Helper()
	if d.expectR[seat] {
		if f.T != "responding" {
			t.Fatalf("seat %d: after a counterable move got %s, want responding first", seat, f.raw)
		}
		r := decodeFrame[respondingIn](t, f)
		if r.By == nil || *r.By != int(seat.Other()) {
			t.Fatalf("responding %s", f.raw)
		}
		d.expectR[seat], d.held[seat] = false, true
		d.checkPrivacy(seat, f, -1)
		d.after(seat, f)
		return
	}
	switch f.T {
	case "state":
		s, env := decodeState(t, f)
		if int(env.State.Viewer) != int(seat) {
			t.Fatalf("seat %d got viewer %d", seat, env.State.Viewer)
		}
		if s.Game != d.gameNo {
			t.Fatalf("seat %d: state for game %d, current %d", seat, s.Game, d.gameNo)
		}
		if env.Seq > d.truth.Seq() {
			t.Fatalf("seat %d: state seq %d, truth only at %d", seat, env.Seq, d.truth.Seq())
		}
		if prev := d.env[seat]; prev != nil && prev.Seq > env.Seq && s.Game == d.gameNo {
			t.Fatalf("seat %d: state went back from seq %d to %d", seat, prev.Seq, env.Seq)
		}
		if d.held[seat] {
			if el := f.at.Sub(d.heldFrom[seat]); el < d.hold {
				t.Fatalf("seat %d: held state arrived after %v, hold is %v", seat, el, d.hold)
			}
			if st := d.truths[env.Seq].st; st.Phase == engine.PhaseAwaitingCounter && st.Active != engine.PlayerID(seat) {
				t.Fatalf("seat %d released at seq %d while the other seat still decides", seat, env.Seq)
			}
			d.held[seat] = false
		}
		d.checkPrivacy(seat, f, env.Seq)
		d.tally = s.Tally
		d.online[seat] = s.OpponentOnline
		e := env
		d.env[seat] = &e
		if env.State.Opponent.Hand != nil {
			d.cov.glasses++
		}
		if env.State.Phase == engine.PhaseSevenChoosing && len(env.State.SevenRevealed) > 0 && int(env.State.Active) == int(seat) {
			d.cov.sevenReveal++
		}
	case "presence":
		p := decodeFrame[presenceIn](t, f)
		if p.OpponentOnline == nil {
			t.Fatalf("presence %s", f.raw)
		}
		d.online[seat] = *p.OpponentOnline
		d.checkPrivacy(seat, f, -1)
	case "rematch":
		r := decodeFrame[rematchIn](t, f)
		d.rematch[seat] = r.RequestedBy
		d.checkPrivacy(seat, f, -1)
	case "responding":
		t.Fatalf("seat %d: unexpected responding %s", seat, f.raw)
	default:
		t.Fatalf("seat %d: unexpected frame %s", seat, f.raw)
	}
	d.after(seat, f)
}

func (d *duo) after(seat game.Seat, f frameIn) {
	if d.onFrame != nil {
		d.onFrame(seat, f)
	}
}

// pump reads one frame from either seat.
func (d *duo) pump(timeout time.Duration) bool {
	select {
	case f := <-d.p[0].in:
		d.absorb(0, f)
	case f := <-d.p[1].in:
		d.absorb(1, f)
	case <-time.After(timeout):
		return false
	}
	return true
}

// ready reports the actor when its latest envelope is the current seq.
func (d *duo) ready() (game.Seat, *game.Envelope, bool) {
	st := d.st()
	if st.Over {
		return 0, nil, false
	}
	env := d.env[st.Actor]
	if env == nil || env.Seq != d.truth.Seq() || d.held[st.Actor] || d.expectR[st.Actor] {
		return 0, nil, false
	}
	return st.Actor, env, true
}

// pick chooses a legal move index for the actor.
func (d *duo) pick(env *game.Envelope) int {
	if d.preferOneOff {
		var c []int
		for i, m := range env.LegalMoves {
			if isCounterableView(m) {
				c = append(c, i)
			}
		}
		if len(c) > 0 && d.rng.IntN(3) > 0 {
			return c[d.rng.IntN(len(c))]
		}
	}
	return d.rng.IntN(len(env.LegalMoves))
}

// move sends seat's move index at the current seq and applies it to the truth.
func (d *duo) move(seat game.Seat, index int) {
	t := d.t
	t.Helper()
	env := d.env[seat]
	mv := env.LegalMoves[index]
	seq := d.truth.Seq()
	before := d.st()
	if _, err := d.truth.Apply(seat, seq, index); err != nil {
		t.Fatalf("truth rejected the move: %v", err)
	}
	after := d.st()
	d.truths = append(d.truths, d.snapshotTruth(t))
	if isCounterableView(mv) {
		d.expectR[seat], d.heldFrom[seat] = true, time.Now()
		if mv.Kind == engine.MoveOneOff || mv.Kind == engine.MoveSevenPick {
			if after.Phase == engine.PhaseAwaitingCounter {
				d.cov.counterWindow++
			} else {
				d.cov.noWindowOneOff++
			}
		}
	}
	_ = before
	d.p[seat].send(map[string]any{"t": "move", "game": d.gameNo, "seq": seq, "index": index})
}

// settle pumps frames until nothing arrives for a while.
func (d *duo) settle() {
	for d.pump(d.hold + 150*time.Millisecond) {
	}
}

// step plays one move when the actor is ready, else pumps a frame.
func (d *duo) step() {
	t := d.t
	t.Helper()
	if seat, env, ok := d.ready(); ok {
		if len(env.LegalMoves) == 0 {
			t.Fatalf("seat %d on turn with no legal move at seq %d", seat, env.Seq)
		}
		d.move(seat, d.pick(env))
		return
	}
	if !d.pump(3 * time.Second) {
		t.Fatalf("stalled at seq %d (actor %d, held %v)", d.truth.Seq(), d.st().Actor, d.held)
	}
}

// playMoves plays n moves (or to game over).
func (d *duo) playMoves(n int) {
	for i := 0; i < n && !d.st().Over; {
		before := d.truth.Seq()
		d.step()
		if d.truth.Seq() > before {
			i++
		}
	}
}

// playToEnd plays until both seats hold the game-over state.
func (d *duo) playToEnd() {
	t := d.t
	t.Helper()
	for guard := 0; guard < 5000; guard++ {
		if d.st().Over && d.bothSee(d.truth.Seq()) {
			d.cov.gameOver++
			return
		}
		d.step()
	}
	t.Fatal("game did not end")
}

// st is the truth's status.
func (d *duo) st() game.Status { return mustStatus(d.t, d.truth) }

func mustStatus(t *testing.T, s *game.Session) game.Status {
	t.Helper()
	st, err := s.Status()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func (d *duo) bothSee(seq int) bool {
	for s := range 2 {
		if d.env[s] == nil || d.env[s].Seq != seq || d.held[s] || d.expectR[s] {
			return false
		}
	}
	return true
}

// waitGoroutines polls until the goroutine count is at most base.
func waitGoroutines(t *testing.T, base int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= base {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	t.Fatalf("goroutines: %d, baseline %d\n%s", runtime.NumGoroutine(), base, buf[:n])
}
