// Command cuttle-server is the two-phone online-play server. Thin wrapper:
// all behaviour lives in internal/server.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/server"
)

// Injected with -ldflags "-X main.version=... -X main.commit=...".
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	cfg, err := server.ParseConfig(os.Args[1:], os.Getenv)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			log.Info("flags: -addr, -origins, -dev, -data-dir; env: CUTTLE_ADDR, CUTTLE_ALLOWED_ORIGINS, CUTTLE_DATA_DIR")
			return
		}
		log.Error("invalid configuration", "err", err)
		os.Exit(2)
	}

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Error("listen failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Info("starting", "version", version, "commit", commit, "dev", cfg.Dev)
	h := server.Handler(cfg, server.BuildInfo{Version: version, Commit: commit}, log)
	if err := server.Run(ctx, server.NewHTTPServer(cfg, h), ln, 10*time.Second, log); err != nil {
		log.Error("server error", "err", err)
		os.Exit(1)
	}
}
