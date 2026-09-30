package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// BuildInfo identifies the running binary; injected via -ldflags in main.
type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// Handler assembles the routes and middleware. New routes go on the mux
// here so CORS and logging wrap them.
func Handler(cfg Config, info BuildInfo, log *slog.Logger, rooms *Rooms) http.Handler {
	createRate, joinRate := cfg.CreatePerHour, cfg.JoinPerHour
	if createRate <= 0 {
		createRate = DefaultCreatePerHour
	}
	if joinRate <= 0 {
		joinRate = DefaultJoinPerHour
	}
	a := &api{
		rooms:   rooms,
		log:     log,
		create:  newLimiter(createRate, rooms.now),
		join:    newLimiter(joinRate, rooms.now),
		trusted: newTrustedSet(cfg.TrustedProxies),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz(info, rooms))
	mux.HandleFunc("POST /api/rooms", a.handleCreate)
	mux.HandleFunc("POST /api/rooms/{code}/join", a.handleJoin)
	return RequestLog(log, CORS(NewOriginPolicy(cfg.AllowedOrigins, cfg.Dev), mux))
}

// healthz reports the build and the stored room count; the count is also
// the database check. No room codes appear.
func healthz(info BuildInfo, rooms *Rooms) http.HandlerFunc {
	type reply struct {
		OK     bool   `json:"ok"`
		Status string `json:"status"`
		Rooms  int    `json:"rooms"`
		BuildInfo
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		n, err := rooms.Count(ctx)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, reply{OK: false, Status: "db", BuildInfo: info})
			return
		}
		writeJSON(w, http.StatusOK, reply{OK: true, Status: "ok", Rooms: n, BuildInfo: info})
	}
}

// statusRecorder captures the status and size for the request log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the real writer (WebSocket
// upgrades in later work items need this).
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// RequestLog logs one line per request: method, path, status, size and
// duration. The query string is never logged, so tokens passed there cannot
// reach the logs. No headers or bodies are logged either.
func RequestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"bytes", rec.bytes,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

// NewHTTPServer returns an http.Server with conservative limits.
func NewHTTPServer(cfg Config, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

// Run serves on ln until ctx is cancelled, then shuts down gracefully,
// waiting up to grace for in-flight requests.
func Run(ctx context.Context, srv *http.Server, ln net.Listener, grace time.Duration, log *slog.Logger) error {
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	log.Info("listening", "addr", ln.Addr().String())
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		_ = srv.Close()
		return err
	}
	<-errc
	log.Info("stopped")
	return nil
}
