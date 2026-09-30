// Command cuttle-server is the two-phone online-play server. Thin wrapper:
// all behaviour lives in internal/server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/server"
	"github.com/ApisMellow/cuttle-web/internal/store"
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
			log.Info("flags: -addr, -origins, -dev, -data-dir, -trusted-proxy, -create-per-hour, -join-per-hour, -max-rooms, -backup-dir, -backup-keep; " +
				"env: CUTTLE_ADDR, CUTTLE_ALLOWED_ORIGINS, CUTTLE_DATA_DIR, CUTTLE_TRUSTED_PROXY, " +
				"CUTTLE_CREATE_PER_HOUR, CUTTLE_JOIN_PER_HOUR, CUTTLE_MAX_ROOMS, CUTTLE_BACKUP_DIR, CUTTLE_BACKUP_KEEP")
			return
		}
		log.Error("invalid configuration", "err", err)
		os.Exit(2)
	}

	if err := server.PreflightBackupDir(cfg.BackupDir); err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(2)
	}

	if cfg.DataDir == "" {
		log.Error("invalid configuration", "err", "a data directory is required (-data-dir or CUTTLE_DATA_DIR)")
		os.Exit(2)
	}
	st, err := store.OpenDir(cfg.DataDir, store.Options{})
	if err != nil {
		log.Error("opening the room store failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	// A recovered engine panic can carry card state: log only its type.
	game.SetPanicHook(func(v any) {
		log.Error("game session panic recovered", "type", fmt.Sprintf("%T", v))
	})

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Error("listen failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Info("starting", "version", version, "commit", commit, "dev", cfg.Dev,
		"trusted_proxies", len(cfg.TrustedProxies), "max_rooms", cfg.MaxRooms,
		"backups", cfg.BackupDir != "", "backup_keep", cfg.BackupKeep)
	rooms := server.NewRooms(st, server.RoomsOptions{MaxRooms: cfg.MaxRooms, Log: log})
	var janitor sync.WaitGroup
	janitor.Add(2)
	go func() {
		defer janitor.Done()
		rooms.RunJanitor(ctx, server.JanitorInterval)
	}()
	// The nightly backup returns at once when no backup directory is set.
	go func() {
		defer janitor.Done()
		server.RunBackups(ctx, st, server.BackupOptions{Dir: cfg.BackupDir, Keep: cfg.BackupKeep, Log: log})
	}()

	h := server.Handler(ctx, cfg, server.BuildInfo{Version: version, Commit: commit}, log, rooms)
	runErr := server.Run(ctx, server.NewHTTPServer(cfg, h, log), ln, 10*time.Second, log)
	stop()
	janitor.Wait()
	if runErr != nil {
		log.Error("server error", "err", runErr)
		st.Close()
		os.Exit(1)
	}
}
