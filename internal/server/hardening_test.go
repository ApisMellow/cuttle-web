package server

// Strict-tier review fixes to W5: panic values never reach a response or
// a log, names lose invisible characters, a trusted proxy that drops
// X-Forwarded-For is reported, and the room map holds up under a
// concurrent sweep.

import (
	"bytes"
	"context"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/store"
)

const handlerSecret = "SECRET-seat-token-and-K-of-spades"

// panicStore panics with handlerSecret from Create.
type panicStore struct{ store.Store }

func (panicStore) Create(context.Context, string) (store.Claim, error) { panic(handlerSecret) }

func TestRecoverMiddlewareKeepsPanicValuesOut(t *testing.T) {
	var std syncBuffer
	prev := log.Writer()
	log.SetOutput(&std)
	t.Cleanup(func() { log.SetOutput(prev) })

	e := newEnv(t, RoomsOptions{})
	rooms := NewRooms(panicStore{e.st}, RoomsOptions{Now: e.clk.Now, Log: e.log})
	h := Handler(t.Context(), Config{AllowedOrigins: []string{prodOrigin}}, BuildInfo{}, e.log, rooms)

	// A panic that escapes every recover reaches net/http itself; its own
	// "panic serving" line must be sanitized too.
	mux := http.NewServeMux()
	mux.Handle("/", h)
	mux.HandleFunc("/raw", func(http.ResponseWriter, *http.Request) { panic(handlerSecret) })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := NewHTTPServer(Config{Addr: ln.Addr().String()}, mux, e.log)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	base := "http://" + ln.Addr().String()

	resp, err := http.Post(base+"/api/rooms", "application/json", strings.NewReader(`{"name":"Alice"}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d %s", resp.StatusCode, body)
	}
	if got := strings.TrimSpace(string(body)); got != `{"code":"INTERNAL","message":"internal error"}` {
		t.Fatalf("body %s", got)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("500 without Cache-Control: no-store")
	}

	if resp, err := http.Get(base + "/raw"); err == nil {
		resp.Body.Close()
	}
	// net/http logs the escaped panic after the connection closes.
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(e.logs.String(), "panic serving") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	logs := e.logs.String() + std.String()
	if strings.Contains(string(body), handlerSecret) || strings.Contains(logs, handlerSecret) {
		t.Fatalf("panic value leaked:\nbody %s\nlogs %s", body, logs)
	}
	for _, want := range []string{`"type":"string"`, `"path":"/api/rooms"`, "panic serving", `"status":500`} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %s:\n%s", want, logs)
		}
	}
}

func TestRecoverMiddlewareAfterHeadersWritten(t *testing.T) {
	var buf bytes.Buffer
	lg := slog.New(slog.NewJSONHandler(&buf, nil))
	h := Recover(lg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("partial"))
		panic(handlerSecret)
	}))
	rec := do(h, "GET", "/x", nil)
	if rec.Code != http.StatusAccepted || rec.Body.String() != "partial" {
		t.Fatalf("recover rewrote a started response: %d %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(buf.String(), handlerSecret) || !strings.Contains(buf.String(), `"type":"string"`) {
		t.Fatalf("log %s", buf.String())
	}
}

func TestRecoverMiddlewareRepanicsAbortHandler(t *testing.T) {
	h := Recover(slog.New(slog.DiscardHandler), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Fatalf("recovered %v, want http.ErrAbortHandler re-panicked", v)
		}
	}()
	do(h, "GET", "/x", nil)
}

func TestHTTPErrorLogPassesOtherLines(t *testing.T) {
	var buf bytes.Buffer
	srv := NewHTTPServer(Config{}, http.NotFoundHandler(), slog.New(slog.NewJSONHandler(&buf, nil)))
	srv.ErrorLog.Printf("http: panic serving 1.2.3.4:5: %s\ngoroutine 1 [running]:\n%s", handlerSecret, handlerSecret)
	srv.ErrorLog.Printf("http: Accept error: too many open files; retrying in 5ms")
	out := buf.String()
	if strings.Contains(out, handlerSecret) {
		t.Fatalf("panic detail logged: %s", out)
	}
	if !strings.Contains(out, "too many open files") {
		t.Fatalf("other server errors dropped: %s", out)
	}
}

func TestCleanNameInvisibleCharacters(t *testing.T) {
	good := map[string]string{
		"Alice\u200b":               "Alice", // zero-width space
		"Al\u200bice":               "Alice",
		"\u2060Alice\u2060":         "Alice", // word joiner
		"\ufeffAlice":               "Alice", // BOM / zero-width no-break space
		"Al\u00adice":               "Alice", // soft hyphen
		"Alice\U000E0041\U000E007F": "Alice", // tag characters
		"Al\u200cice":               "Alice", // zero-width non-joiner
		"Al\u200dice":               "Alice", // a ZWJ between letters joins nothing
		"\u200dAlice\u200d":         "Alice",
		"Cafe\u0301":                "Caf\u00e9",           // NFC
		"Dad 👨\u200d👩\u200d👧":       "Dad 👨\u200d👩\u200d👧", // ZWJ inside an emoji sequence stays
		"🏳\ufe0f\u200d🌈":            "🏳\ufe0f\u200d🌈",      // ZWJ after a variation selector stays
		"👋🏽\u200d":                  "👋🏽",                  // trailing ZWJ goes
	}
	for in, want := range good {
		got, ok := cleanName(in)
		if !ok || got != want {
			t.Errorf("cleanName(%+q) = %+q %t, want %+q", in, got, ok, want)
		}
	}
	for _, in := range []string{"\u200b", "\u200b\u2060\ufeff\u00ad", "\U000E0041\U000E007F", " \u200d ", "\u200c\u200d"} {
		if got, ok := cleanName(in); ok {
			t.Errorf("cleanName(%+q) = %+q accepted, want rejected", in, got)
		}
	}
	// The rune cap applies after NFC: 20 decomposed "é" are 40 runes in,
	// 20 out.
	if got, ok := cleanName(strings.Repeat("e\u0301", 20)); !ok || got != strings.Repeat("\u00e9", 20) {
		t.Errorf("NFC then cap: %+q %t", got, ok)
	}
}

func TestAPI_InvisibleNameRejected(t *testing.T) {
	a := newAPI(t, Config{CreatePerHour: 100}, RoomsOptions{})
	wantAPIError(t, "zwsp only", a.do(req{path: "/api/rooms", body: `{"name":"\u200b\u2060"}`}), 400, "BAD_REQUEST")
	c := a.create(t, "Alice\u200b")
	r, err := a.st.Get(bg, c.Code)
	if err != nil || r.Names[0] != "Alice" {
		t.Fatalf("stored %q (%v)", r.Names[0], err)
	}
}

func TestAPI_TrustedProxyWithoutXFFWarnsOncePerMinute(t *testing.T) {
	a := newAPI(t, Config{CreatePerHour: 100, TrustedProxies: []string{"127.0.0.1"}}, RoomsOptions{})
	count := func() int { return strings.Count(a.logs.String(), "X-Forwarded-For") }
	a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "127.0.0.1:5000",
		hdr: map[string]string{"X-Forwarded-For": "198.51.100.1"}})
	if count() != 0 {
		t.Fatal("warned on a request that carried XFF")
	}
	a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "192.0.2.9:5000"})
	if count() != 0 {
		t.Fatal("warned on a direct (untrusted) peer")
	}
	for i := 0; i < 3; i++ {
		a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "127.0.0.1:5000"})
	}
	if n := count(); n != 1 {
		t.Fatalf("%d warnings for three proxy requests without XFF, want 1", n)
	}
	a.clk.Advance(time.Minute + time.Second)
	a.do(req{path: "/api/rooms/ZZZZ/join", body: `{"name":"Blake"}`, remote: "127.0.0.1:5000"})
	if n := count(); n != 2 {
		t.Fatalf("%d warnings after a minute, want 2", n)
	}
}

// Sweep takes each room's lock while withRoom and Move run on the same
// rooms; -race and the invariants below catch a lock-order or map bug.
func TestRooms_SweepConcurrentWithMoves(t *testing.T) {
	e := newEnv(t, RoomsOptions{MemIdle: time.Nanosecond})
	var codes []string
	for i := 0; i < 4; i++ {
		c0, _ := e.createJoin(t)
		codes = append(codes, c0.Code)
	}
	ctx, cancel := context.WithTimeout(bg, 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	var moves, sweeps atomic.Int32
	for _, code := range codes {
		wg.Add(1)
		go func(code string) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				env, err := e.rooms.View(ctx, code, game.Seat0)
				if err != nil {
					t.Errorf("view %s: %v", code, err)
					return
				}
				seat := game.Seat(env.State.Active)
				env, err = e.rooms.View(ctx, code, seat)
				if err != nil {
					t.Errorf("view %s: %v", code, err)
					return
				}
				if len(env.LegalMoves) == 0 {
					return
				}
				if _, err := e.rooms.Move(ctx, code, seat, env.Seq, 0); err != nil {
					t.Errorf("move %s: %v", code, err)
					return
				}
				moves.Add(1)
			}
		}(code)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			e.clk.Advance(time.Millisecond)
			if _, _, err := e.rooms.Sweep(ctx); err != nil {
				t.Errorf("sweep: %v", err)
				return
			}
			sweeps.Add(1)
		}
	}()
	wg.Wait()
	if moves.Load() == 0 || sweeps.Load() != 50 {
		t.Fatalf("moves %d sweeps %d", moves.Load(), sweeps.Load())
	}
	// Whatever the sweep dropped reloads to the stored state.
	for _, code := range codes {
		r, err := e.st.Get(bg, code)
		if err != nil {
			t.Fatal(err)
		}
		env, err := e.rooms.View(bg, code, game.Seat0)
		if err != nil {
			t.Fatal(err)
		}
		if env.Seq != r.Seq {
			t.Errorf("%s: memory at seq %d, store at %d", code, env.Seq, r.Seq)
		}
	}
}

// Two first accesses of the same code race to load it; exactly one
// Session may come out, or one caller's moves would be lost.
func TestRooms_ConcurrentFirstLoadMakesOneSession(t *testing.T) {
	e := newEnv(t, RoomsOptions{MemIdle: time.Minute})
	c0, _ := e.createJoin(t)
	for round := 0; round < 20; round++ {
		// Evict from memory so the next accesses load from the store. The
		// store's idle TTL (a day) is far off.
		e.clk.Advance(2 * time.Minute)
		if _, _, err := e.rooms.Sweep(bg); err != nil {
			t.Fatal(err)
		}
		if e.cached(c0.Code) {
			t.Fatal("room still cached after an idle sweep")
		}
		const n = 8
		var wg sync.WaitGroup
		start := make(chan struct{})
		sessions := make([]*game.Session, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				err := e.rooms.withRoom(bg, c0.Code, func(r *room) error {
					sessions[i] = r.sess
					return nil
				})
				if err != nil {
					t.Errorf("withRoom: %v", err)
				}
			}(i)
		}
		close(start)
		wg.Wait()
		for i := 1; i < n; i++ {
			if sessions[i] == nil || sessions[i] != sessions[0] {
				t.Fatalf("round %d: caller %d got session %p, caller 0 got %p", round, i, sessions[i], sessions[0])
			}
		}
	}
}
