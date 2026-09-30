package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/store"
)

const prodOrigin = "https://apismellow.github.io"

func testHandler(t *testing.T, dev bool) (http.Handler, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	cfg := Config{Addr: DefaultAddr, AllowedOrigins: []string{prodOrigin}, Dev: dev}
	st, err := store.OpenMemory(store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	rooms := NewRooms(st, RoomsOptions{Log: log})
	return Handler(cfg, BuildInfo{Version: "v1.2.3", Commit: "abc1234"}, log, rooms), &buf
}

func do(h http.Handler, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthz(t *testing.T) {
	h, _ := testHandler(t, false)
	rec := do(h, "GET", "/healthz", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q", ct)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["status"] != "ok" || got["version"] != "v1.2.3" || got["commit"] != "abc1234" || got["rooms"] != float64(0) {
		t.Errorf("body %v", got)
	}
}

func TestHealthzWrongMethodAndUnknownPath(t *testing.T) {
	h, _ := testHandler(t, false)
	if c := do(h, "POST", "/healthz", nil).Code; c != http.StatusMethodNotAllowed {
		t.Errorf("POST healthz = %d", c)
	}
	if c := do(h, "GET", "/nope", nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown path = %d", c)
	}
}

func TestCORSAllowedOrigin(t *testing.T) {
	h, _ := testHandler(t, false)
	rec := do(h, "GET", "/healthz", map[string]string{"Origin": prodOrigin})
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != prodOrigin {
		t.Errorf("ACAO %q", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Origin") {
		t.Errorf("Vary %q", rec.Header().Get("Vary"))
	}
}

func TestCORSNeverWildcard(t *testing.T) {
	h, _ := testHandler(t, true)
	for _, o := range []string{prodOrigin, "http://localhost:5173", "http://127.0.0.1:4173"} {
		rec := do(h, "GET", "/healthz", map[string]string{"Origin": o})
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != o {
			t.Errorf("origin %q echoed as %q", o, got)
		}
	}
}

func TestCORSDeniedOrigins(t *testing.T) {
	h, _ := testHandler(t, false)
	for _, o := range []string{
		"https://evil.example",
		"http://apismellow.github.io", // wrong scheme
		"https://apismellow.github.io.evil.example",
		"https://apismellow.github.io:8443",
		"null",
		"http://localhost:5173", // dev flag off
		"http://127.0.0.1:5173",
	} {
		rec := do(h, "GET", "/healthz", map[string]string{"Origin": o})
		if rec.Code != http.StatusForbidden {
			t.Errorf("origin %q: status %d, want 403", o, rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q: ACAO %q leaked", o, got)
		}
	}
}

func TestCORSNoOriginPassesThrough(t *testing.T) {
	h, _ := testHandler(t, false)
	rec := do(h, "GET", "/healthz", nil)
	if rec.Code != 200 || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("status %d headers %v", rec.Code, rec.Header())
	}
}

func TestCORSPreflight(t *testing.T) {
	h, _ := testHandler(t, false)
	hdr := map[string]string{
		"Origin":                         prodOrigin,
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "content-type",
	}
	rec := do(h, "OPTIONS", "/healthz", hdr)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != prodOrigin {
		t.Errorf("ACAO %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("methods %q", rec.Header().Get("Access-Control-Allow-Methods"))
	}
	if rec.Header().Get("Access-Control-Allow-Headers") == "" || rec.Header().Get("Access-Control-Max-Age") == "" {
		t.Errorf("headers %v", rec.Header())
	}

	hdr["Origin"] = "https://evil.example"
	rec = do(h, "OPTIONS", "/healthz", hdr)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("denied preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestDevFlagAllowsLocalOrigins(t *testing.T) {
	h, _ := testHandler(t, true)
	for _, o := range []string{"http://localhost:5173", "http://localhost", "http://127.0.0.1:4173"} {
		if c := do(h, "GET", "/healthz", map[string]string{"Origin": o}).Code; c != 200 {
			t.Errorf("dev origin %q: %d", o, c)
		}
	}
	for _, o := range []string{
		"https://localhost:5173",        // https not admitted
		"http://localhost.evil.example", // suffix trick
		"http://evil.example:5173",
		"http://127.0.0.1.evil.example",
		"http://[::1]:5173",
	} {
		if c := do(h, "GET", "/healthz", map[string]string{"Origin": o}).Code; c != http.StatusForbidden {
			t.Errorf("origin %q: %d, want 403", o, c)
		}
	}
}

func TestRequestLogOmitsQueryString(t *testing.T) {
	h, buf := testHandler(t, false)
	do(h, "GET", "/healthz?token=SECRETVALUE&x=1", nil)
	line := buf.String()
	if line == "" {
		t.Fatal("no log line")
	}
	for _, bad := range []string{"SECRETVALUE", "token", "?", "x=1"} {
		if strings.Contains(line, bad) {
			t.Errorf("log line contains %q: %s", bad, line)
		}
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["path"] != "/healthz" || rec["method"] != "GET" || rec["status"] != float64(200) {
		t.Errorf("record %v", rec)
	}
}

func TestParseConfigDefaults(t *testing.T) {
	cfg, err := ParseConfig(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:8080" || cfg.Dev || len(cfg.AllowedOrigins) != 1 || cfg.AllowedOrigins[0] != prodOrigin || cfg.DataDir != "" {
		t.Errorf("%+v", cfg)
	}
}

func TestParseConfigFlagsAndEnv(t *testing.T) {
	dir := t.TempDir()
	env := map[string]string{"CUTTLE_ADDR": "127.0.0.1:9000", "CUTTLE_ALLOWED_ORIGINS": "https://a.example, https://b.example"}
	cfg, err := ParseConfig([]string{"-dev", "-data-dir", dir}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:9000" || !cfg.Dev || cfg.DataDir != dir || len(cfg.AllowedOrigins) != 2 {
		t.Errorf("%+v", cfg)
	}
	cfg, err = ParseConfig([]string{"-addr", "127.0.0.1:9100"}, func(k string) string { return env[k] })
	if err != nil || cfg.Addr != "127.0.0.1:9100" {
		t.Errorf("flag should beat env: %+v %v", cfg, err)
	}
}

func TestParseConfigRejects(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{
		"reserved port":      {"-addr", "127.0.0.1:8765"},
		"no port":            {"-addr", "127.0.0.1"},
		"garbage addr":       {"-addr", "::::"},
		"wildcard origin":    {"-origins", "*"},
		"wildcard subdomain": {"-origins", "https://*.example"},
		"path in origin":     {"-origins", "https://a.example/app"},
		"trailing slash":     {"-origins", "https://a.example/"},
		"bad scheme":         {"-origins", "ftp://a.example"},
		"empty origins":      {"-origins", ","},
		"missing data dir":   {"-data-dir", filepath.Join(t.TempDir(), "absent")},
		"data dir is file":   {"-data-dir", file},
		"stray argument":     {"extra"},
		"unknown flag":       {"-nope"},
	}
	for name, args := range cases {
		if _, err := ParseConfig(args, func(string) string { return "" }); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestRunGracefulShutdown(t *testing.T) {
	h, _ := testHandler(t, false)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := NewHTTPServer(Config{Addr: ln.Addr().String()}, h)
	if srv.ReadHeaderTimeout == 0 || srv.MaxHeaderBytes == 0 || srv.WriteTimeout == 0 || srv.IdleTimeout == 0 {
		t.Errorf("missing limits: %+v", srv)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, srv, ln, 2*time.Second, slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))) }()

	resp, err := http.Get("http://" + ln.Addr().String() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if _, err := http.Get("http://" + ln.Addr().String() + "/healthz"); err == nil {
		t.Error("server still accepting after shutdown")
	}
}
