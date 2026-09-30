package server

// HTTP API tests (two-phone W5, docs/two-phone-plan.md §3, §9).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/store"
)

type apiEnv struct {
	*env
	h http.Handler
}

func newAPI(t *testing.T, cfg Config, opt RoomsOptions) *apiEnv {
	t.Helper()
	e := newEnv(t, opt)
	if cfg.Addr == "" {
		cfg.Addr = DefaultAddr
	}
	if cfg.AllowedOrigins == nil {
		cfg.AllowedOrigins = []string{prodOrigin}
	}
	return &apiEnv{env: e, h: Handler(cfg, BuildInfo{Version: "v1.2.3", Commit: "abc1234"}, e.log, e.rooms)}
}

type req struct {
	method, path, body string
	remote             string
	hdr                map[string]string
}

func (a *apiEnv) do(r req) *httptest.ResponseRecorder {
	if r.method == "" {
		r.method = http.MethodPost
	}
	hr := httptest.NewRequest(r.method, r.path, strings.NewReader(r.body))
	if r.body != "" {
		hr.Header.Set("Content-Type", "application/json")
	}
	if r.remote != "" {
		hr.RemoteAddr = r.remote
	}
	for k, v := range r.hdr {
		hr.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, hr)
	return rec
}

type claimBody struct {
	Code  string `json:"code"`
	Seat  int    `json:"seat"`
	Token string `json:"token"`
}

type errBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	dec := json.NewDecoder(bytes.NewReader(rec.Body.Bytes()))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode %T from %d %q: %v", v, rec.Code, rec.Body.String(), err)
	}
	return v
}

func wantAPIError(t *testing.T, label string, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("%s: status %d, want %d (%s)", label, rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("%s: content-type %q", label, ct)
	}
	b := decode[errBody](t, rec)
	if b.Code != code || b.Message == "" {
		t.Fatalf("%s: body %+v, want code %s", label, b, code)
	}
}

func (a *apiEnv) create(t *testing.T, name string) claimBody {
	t.Helper()
	rec := a.do(req{path: "/api/rooms", body: fmt.Sprintf(`{"name":%q}`, name)})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	return decode[claimBody](t, rec)
}

func TestAPI_CreateJoinHappyPath(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("create Cache-Control %q", cc)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("create Content-Type %q", ct)
	}
	c0 := decode[claimBody](t, rec)
	if len(c0.Code) != store.CodeLen || c0.Code != strings.ToUpper(c0.Code) || c0.Seat != 0 || !isBase64URL(c0.Token) {
		t.Fatalf("create body %+v", c0)
	}

	// The joiner types the code in lower case.
	rec = a.do(req{path: "/api/rooms/" + strings.ToLower(c0.Code) + "/join", body: `{"name":"Blake"}`})
	if rec.Code != http.StatusOK {
		t.Fatalf("join: %d %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("join Cache-Control %q", cc)
	}
	c1 := decode[claimBody](t, rec)
	if c1.Code != c0.Code || c1.Seat != 1 || !isBase64URL(c1.Token) || c1.Token == c0.Token {
		t.Fatalf("join body %+v", c1)
	}

	// Both seats authenticate, and the game was dealt at join.
	for want, tok := range []string{c0.Token, c1.Token} {
		if seat, err := a.st.Authenticate(bg, c0.Code, tok); err != nil || int(seat) != want {
			t.Fatalf("authenticate seat %d: %v %v", want, seat, err)
		}
	}
	r, err := a.st.Get(bg, c0.Code)
	if err != nil || r.Game != 1 || r.Seq != 0 || r.Snapshot == nil || r.Status != store.StatusActive {
		t.Fatalf("room after join: %+v %v", r.Status, err)
	}
	// Neither reply carries anything but code, seat and token.
	for _, body := range []string{rec.Body.String()} {
		for _, bad := range []string{"snapshot", "hand", "deck", "seed", "Blake", "Alice"} {
			if strings.Contains(strings.ToLower(body), strings.ToLower(bad)) {
				t.Errorf("reply mentions %q: %s", bad, body)
			}
		}
	}
}

func TestAPI_JoinRace(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	c0 := a.create(t, "Alice")
	const n = 16
	codes := make(chan int, n)
	bodies := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: `{"name":"Blake"}`,
				remote: fmt.Sprintf("192.0.2.%d:4000", i+1)})
			codes <- rec.Code
			bodies <- rec.Body.String()
		}(i)
	}
	wg.Wait()
	close(codes)
	close(bodies)
	ok, full := 0, 0
	for c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			full++
		default:
			t.Errorf("status %d", c)
		}
	}
	nFullBodies := 0
	for b := range bodies {
		if strings.Contains(b, `"code":"ROOM_FULL"`) {
			nFullBodies++
		}
	}
	if ok != 1 || full != n-1 || nFullBodies != n-1 {
		t.Fatalf("ok %d full %d (bodies %d)", ok, full, nFullBodies)
	}
}

func TestAPI_JoinGone(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	wantAPIError(t, "unknown", a.do(req{path: "/api/rooms/ZZZZ/join", body: `{"name":"Blake"}`}), 404, "ROOM_GONE")
	wantAPIError(t, "malformed", a.do(req{path: "/api/rooms/ZZ!Z/join", body: `{"name":"Blake"}`}), 404, "ROOM_GONE")
	wantAPIError(t, "too long", a.do(req{path: "/api/rooms/ZZZZZ/join", body: `{"name":"Blake"}`}), 404, "ROOM_GONE")
	c0 := a.create(t, "Alice")
	a.clk.Advance(store.DefaultIdleTTL + time.Second)
	wantAPIError(t, "expired", a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: `{"name":"Blake"}`}), 404, "ROOM_GONE")
}

func TestAPI_JoinFull(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	c0 := a.create(t, "Alice")
	path := "/api/rooms/" + c0.Code + "/join"
	if rec := a.do(req{path: path, body: `{"name":"Blake"}`}); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	wantAPIError(t, "full", a.do(req{path: path, body: `{"name":"Casey"}`}), 409, "ROOM_FULL")
}

func TestAPI_NameValidation(t *testing.T) {
	// Every attempt, valid or not, spends a rate-limit token; lift the
	// limits so this test sees only validation.
	a := newAPI(t, Config{CreatePerHour: 1000, JoinPerHour: 1000}, RoomsOptions{})
	bad := map[string]string{
		"empty":         `{"name":""}`,
		"spaces":        `{"name":"   "}`,
		"controls only": `{"name":"\u0000\u0007\n\t"}`,
		"bidi only":     `{"name":"‮⁦"}`,
		"21 runes":      `{"name":"` + strings.Repeat("a", 21) + `"}`,
		"21 emoji":      `{"name":"` + strings.Repeat("🂡", 21) + `"}`,
		"missing":       `{}`,
		"number":        `{"name":7}`,
		"null":          `{"name":null}`,
	}
	for label, body := range bad {
		wantAPIError(t, "create "+label, a.do(req{path: "/api/rooms", body: body}), 400, "BAD_REQUEST")
	}
	c0 := a.create(t, "Alice")
	for label, body := range bad {
		wantAPIError(t, "join "+label, a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: body}), 400, "BAD_REQUEST")
	}

	good := map[string]string{
		`"  Alice  "`:                       "Alice",
		`"Al\u0007ice\n"`:                   "Alice",
		`"‮Blake"`:                          "Blake",
		`"` + strings.Repeat("é", 20) + `"`: strings.Repeat("é", 20),
		`"Dad 👨‍👩‍👧"`:                       "Dad 👨‍👩‍👧",
		`" \u0000 Al ice \u0000 "`:          "Al ice",
	}
	for raw, want := range good {
		rec := a.do(req{path: "/api/rooms", body: `{"name":` + raw + `}`})
		if rec.Code != http.StatusCreated {
			t.Errorf("name %s: %d %s", raw, rec.Code, rec.Body.String())
			continue
		}
		c := decode[claimBody](t, rec)
		r, err := a.st.Get(bg, c.Code)
		if err != nil || r.Names[0] != want {
			t.Errorf("name %s stored as %q, want %q (%v)", raw, r.Names[0], want, err)
		}
	}
}

func TestAPI_BodyRules(t *testing.T) {
	a := newAPI(t, Config{CreatePerHour: 1000}, RoomsOptions{})
	big := `{"name":"Alice","x":"` + strings.Repeat("a", 2048) + `"}`
	wantAPIError(t, "oversize", a.do(req{path: "/api/rooms", body: big}), 400, "BAD_REQUEST")
	bigPadded := `{"name":"Alice"}` + strings.Repeat(" ", 2048)
	wantAPIError(t, "oversize whitespace", a.do(req{path: "/api/rooms", body: bigPadded}), 400, "BAD_REQUEST")
	wantAPIError(t, "unknown field", a.do(req{path: "/api/rooms", body: `{"name":"Alice","seat":1}`}), 400, "BAD_REQUEST")
	wantAPIError(t, "trailing", a.do(req{path: "/api/rooms", body: `{"name":"Alice"}{"name":"B"}`}), 400, "BAD_REQUEST")
	wantAPIError(t, "not json", a.do(req{path: "/api/rooms", body: `name=Alice`}), 400, "BAD_REQUEST")
	wantAPIError(t, "array", a.do(req{path: "/api/rooms", body: `["Alice"]`}), 400, "BAD_REQUEST")
	wantAPIError(t, "empty body", a.do(req{path: "/api/rooms", hdr: map[string]string{"Content-Type": "application/json"}}), 400, "BAD_REQUEST")
	wantAPIError(t, "form content type", a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`,
		hdr: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}}), 400, "BAD_REQUEST")
	wantAPIError(t, "text/plain", a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`,
		hdr: map[string]string{"Content-Type": "text/plain"}}), 400, "BAD_REQUEST")
	if rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`,
		hdr: map[string]string{"Content-Type": "application/json; charset=utf-8"}}); rec.Code != 201 {
		t.Errorf("json with charset: %d", rec.Code)
	}
	if n, _ := a.st.Count(bg); n != 1 {
		t.Errorf("%d rooms created, want 1", n)
	}
	if c := a.do(req{method: "GET", path: "/api/rooms"}).Code; c != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/rooms = %d", c)
	}
}

func TestAPI_RoomCap(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{MaxRooms: 2})
	a.create(t, "Alice")
	a.create(t, "Alice")
	rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`})
	wantAPIError(t, "cap", rec, 503, "SERVER_FULL")
	if rec.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After on SERVER_FULL")
	}
}

func TestAPI_CreateRateLimit(t *testing.T) {
	a := newAPI(t, Config{CreatePerHour: 3}, RoomsOptions{})
	ip1, ip2 := "198.51.100.7:1111", "198.51.100.8:2222"
	for i := 0; i < 3; i++ {
		if rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip1}); rec.Code != 201 {
			t.Fatalf("create %d: %d", i, rec.Code)
		}
	}
	rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip1})
	wantAPIError(t, "4th create", rec, 429, "RATE_LIMITED")
	if ra := rec.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Errorf("Retry-After %q", ra)
	}
	// Another port on the same IP is the same client.
	wantAPIError(t, "same ip other port", a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "198.51.100.7:9999"}), 429, "RATE_LIMITED")
	// Another IP has its own bucket.
	if rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip2}); rec.Code != 201 {
		t.Fatalf("other ip: %d", rec.Code)
	}
	// A bucket refills at CreatePerHour per hour: one token after 20 min.
	a.clk.Advance(20*time.Minute + time.Second)
	if rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip1}); rec.Code != 201 {
		t.Fatalf("after refill: %d", rec.Code)
	}
	wantAPIError(t, "after one refill", a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip1}), 429, "RATE_LIMITED")
}

func TestAPI_JoinRateLimitCountsFailures(t *testing.T) {
	// Code guessing burns join tokens whatever the outcome.
	a := newAPI(t, Config{JoinPerHour: 5}, RoomsOptions{})
	ip := "203.0.113.9:1234"
	for i := 0; i < 5; i++ {
		wantAPIError(t, "guess", a.do(req{path: "/api/rooms/ZZZZ/join", body: `{"name":"Blake"}`, remote: ip}), 404, "ROOM_GONE")
	}
	c0 := a.create(t, "Alice")
	wantAPIError(t, "limited", a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: `{"name":"Blake"}`, remote: ip}), 429, "RATE_LIMITED")
	// Create and join have separate buckets.
	if rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: ip}); rec.Code != 201 {
		t.Fatalf("create after join limit: %d", rec.Code)
	}
}

func TestAPI_ForwardedForTrustedOnlyFromProxy(t *testing.T) {
	t.Run("no trusted proxy: XFF ignored", func(t *testing.T) {
		a := newAPI(t, Config{CreatePerHour: 1}, RoomsOptions{})
		for i, xff := range []string{"198.51.100.1", "198.51.100.2"} {
			rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "127.0.0.1:5000",
				hdr: map[string]string{"X-Forwarded-For": xff}})
			if want := []int{201, 429}[i]; rec.Code != want {
				t.Fatalf("xff %s: %d, want %d", xff, rec.Code, want)
			}
		}
	})
	t.Run("trusted proxy: XFF used", func(t *testing.T) {
		a := newAPI(t, Config{CreatePerHour: 1, TrustedProxies: []string{"127.0.0.1"}}, RoomsOptions{})
		for _, xff := range []string{"198.51.100.1", "198.51.100.2"} {
			rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "127.0.0.1:5000",
				hdr: map[string]string{"X-Forwarded-For": xff}})
			if rec.Code != 201 {
				t.Fatalf("xff %s: %d", xff, rec.Code)
			}
		}
		// The rightmost entry is the one the proxy saw; a client-supplied
		// leftmost entry can't dodge the limit.
		rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "127.0.0.1:5000",
			hdr: map[string]string{"X-Forwarded-For": "10.9.9.9, 198.51.100.1"}})
		wantAPIError(t, "spoofed left", rec, 429, "RATE_LIMITED")
	})
	t.Run("trusted proxy: XFF from elsewhere ignored", func(t *testing.T) {
		a := newAPI(t, Config{CreatePerHour: 1, TrustedProxies: []string{"127.0.0.1"}}, RoomsOptions{})
		for i, xff := range []string{"198.51.100.1", "198.51.100.2"} {
			rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, remote: "192.0.2.50:5000",
				hdr: map[string]string{"X-Forwarded-For": xff}})
			if want := []int{201, 429}[i]; rec.Code != want {
				t.Fatalf("xff %s: %d, want %d", xff, rec.Code, want)
			}
		}
	})
}

func TestAPI_CORSOnRoomRoutes(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	rec := a.do(req{path: "/api/rooms", body: `{"name":"Alice"}`, hdr: map[string]string{"Origin": prodOrigin}})
	if rec.Code != 201 || rec.Header().Get("Access-Control-Allow-Origin") != prodOrigin {
		t.Fatalf("allowed origin create: %d ACAO %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
	c0 := decode[claimBody](t, rec)
	join := "/api/rooms/" + c0.Code + "/join"
	for _, path := range []string{"/api/rooms", join} {
		rec := a.do(req{path: path, body: `{"name":"Blake"}`, hdr: map[string]string{"Origin": "https://evil.example"}})
		wantAPIError(t, "evil origin "+path, rec, http.StatusForbidden, "FORBIDDEN")
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("evil origin %s: ACAO set", path)
		}
		pre := a.do(req{method: "OPTIONS", path: path, hdr: map[string]string{
			"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}})
		wantAPIError(t, "evil preflight "+path, pre, http.StatusForbidden, "FORBIDDEN")
		pre = a.do(req{method: "OPTIONS", path: path, hdr: map[string]string{
			"Origin": prodOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}})
		if pre.Code != http.StatusNoContent || pre.Header().Get("Access-Control-Allow-Origin") != prodOrigin ||
			!strings.Contains(strings.ToLower(pre.Header().Get("Access-Control-Allow-Headers")), "content-type") {
			t.Errorf("preflight %s: %d %v", path, pre.Code, pre.Header())
		}
	}
	if n, _ := a.st.Count(bg); n != 1 {
		t.Errorf("a disallowed origin created a room: %d rooms", n)
	}
	rec = a.do(req{path: join, body: `{"name":"Blake"}`, hdr: map[string]string{"Origin": prodOrigin}})
	if rec.Code != 200 || rec.Header().Get("Access-Control-Allow-Origin") != prodOrigin {
		t.Fatalf("allowed origin join: %d", rec.Code)
	}
}

func TestAPI_TokensNeverLogged(t *testing.T) {
	// Capture the package log too: the store writes warnings there.
	var std syncBuffer
	prev := log.Writer()
	log.SetOutput(&std)
	t.Cleanup(func() { log.SetOutput(prev) })

	a := newAPI(t, Config{}, RoomsOptions{})
	c0 := a.create(t, "Alice")
	rec := a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: `{"name":"Blake"}`})
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	c1 := decode[claimBody](t, rec)
	// Error paths log too.
	a.do(req{path: "/api/rooms/" + c0.Code + "/join", body: `{"name":"Casey"}`})
	a.fs.failSaves.Store(1)
	c2 := a.create(t, "Alice")
	rec = a.do(req{path: "/api/rooms/" + c2.Code + "/join", body: `{"name":"Blake"}`})
	c3 := decode[claimBody](t, rec)

	logs := a.logs.String() + std.String()
	if !strings.Contains(logs, c0.Code) {
		t.Fatalf("expected the room code in the logs (proves logging ran):\n%s", logs)
	}
	for _, tok := range []string{c0.Token, c1.Token, c2.Token, c3.Token} {
		if tok == "" || strings.Contains(logs, tok) {
			t.Fatalf("token %q in logs:\n%s", tok, logs)
		}
		if strings.Contains(logs, tok[:12]) {
			t.Fatalf("token prefix in logs:\n%s", logs)
		}
	}
	for _, name := range []string{"Alice", "Blake", "Casey"} {
		if strings.Contains(logs, name) {
			t.Errorf("player name %q in logs", name)
		}
	}
}

func TestAPI_Healthz(t *testing.T) {
	a := newAPI(t, Config{}, RoomsOptions{})
	a.create(t, "Alice")
	a.create(t, "Alice")
	rec := a.do(req{method: "GET", path: "/healthz"})
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("healthz: %d", rec.Code)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["ok"] != true || got["status"] != "ok" || got["rooms"] != float64(2) || got["version"] != "v1.2.3" || got["commit"] != "abc1234" {
		t.Fatalf("body %v", got)
	}
	if len(got) != 5 {
		t.Fatalf("unexpected fields %v", got)
	}

	a.st.Close()
	rec = a.do(req{method: "GET", path: "/healthz"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz with a dead db: %d", rec.Code)
	}
	got = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["ok"] != false || got["status"] != "db" {
		t.Fatalf("dead-db body %v", got)
	}
}

// isBase64URL: the W11 client accepts a token of at least 16 base64url
// characters; ours are 43 (32 bytes, unpadded).
func isBase64URL(tok string) bool {
	if len(tok) != 43 {
		return false
	}
	for _, r := range tok {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
