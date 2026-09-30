// Package server holds the cuttle-server HTTP plumbing: configuration, CORS,
// request logging, handlers and the run loop. main stays a thin wrapper.
package server

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultAddr is the listen address. TLS ends at the reverse proxy, so the
	// server binds loopback only.
	DefaultAddr = "127.0.0.1:8080"
	// DefaultOrigin is the deployed web app's origin.
	DefaultOrigin = "https://apismellow.github.io"
	// ReservedPort belongs to an unrelated local project and is never used.
	ReservedPort = "8765"
	// DefaultRespondMin is the counter hold's minimum (SPEC §2.12.5,
	// CUTTLE_RESPOND_MIN_MS).
	DefaultRespondMin = 1500 * time.Millisecond
	// DefaultMaxSockets and DefaultMaxSocketsPerClient cap open play
	// sockets server-wide and per client key.
	DefaultMaxSockets          = 500
	DefaultMaxSocketsPerClient = 8
	// maxRespondMin bounds the configurable hold.
	maxRespondMin = time.Minute
)

// Config is the validated server configuration.
type Config struct {
	Addr           string   // listen address, host:port
	AllowedOrigins []string // exact origins, e.g. https://apismellow.github.io
	Dev            bool     // also allow http://127.0.0.1:* and http://localhost:*
	DataDir        string   // data directory holding the SQLite file; "" = unset
	// TrustedProxies are the reverse-proxy addresses (Caddy on 127.0.0.1)
	// whose X-Forwarded-For is believed. Empty: always use the peer address.
	TrustedProxies []string
	CreatePerHour  int // per-client create limit; 0 in a literal = default
	JoinPerHour    int // per-client join limit; 0 in a literal = default
	MaxRooms       int // live-room cap; 0 in a literal = default
	// RespondMin is the least time the mover of a counterable move waits
	// for its next state (SPEC §2.12.5). 0 in a literal = default.
	RespondMin time.Duration
	// MaxSockets caps open play sockets server-wide, MaxSocketsPerClient
	// per client key (identify). 0 in a literal = default.
	MaxSockets          int
	MaxSocketsPerClient int

	// tune holds the socket timings and limits; the zero value is SPEC
	// §2.12.6. Tests shorten them.
	tune playTuning
}

// ParseConfig reads flags from args, falling back to environment values from
// getenv (CUTTLE_ADDR, CUTTLE_ALLOWED_ORIGINS comma-separated, CUTTLE_DATA_DIR,
// CUTTLE_TRUSTED_PROXY comma-separated, CUTTLE_CREATE_PER_HOUR,
// CUTTLE_JOIN_PER_HOUR, CUTTLE_MAX_ROOMS, CUTTLE_RESPOND_MIN_MS,
// CUTTLE_MAX_SOCKETS, CUTTLE_MAX_SOCKETS_PER_CLIENT), then to defaults. Flags win over the environment.
func ParseConfig(args []string, getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	envOr := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}

	fs := flag.NewFlagSet("cuttle-server", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", envOr("CUTTLE_ADDR", DefaultAddr), "listen address")
	origins := fs.String("origins", envOr("CUTTLE_ALLOWED_ORIGINS", DefaultOrigin), "comma-separated allowed web origins")
	dev := fs.Bool("dev", false, "also allow http://127.0.0.1:* and http://localhost:* origins")
	dataDir := fs.String("data-dir", getenv("CUTTLE_DATA_DIR"), "data directory (must exist)")
	proxies := fs.String("trusted-proxy", getenv("CUTTLE_TRUSTED_PROXY"), "comma-separated proxy IPs whose X-Forwarded-For is trusted")
	envInt := func(key string, def int) (int, error) {
		v := getenv(key)
		if v == "" {
			return def, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %q is not an integer", key, v)
		}
		return n, nil
	}
	createDef, err := envInt("CUTTLE_CREATE_PER_HOUR", DefaultCreatePerHour)
	if err != nil {
		return Config{}, err
	}
	joinDef, err := envInt("CUTTLE_JOIN_PER_HOUR", DefaultJoinPerHour)
	if err != nil {
		return Config{}, err
	}
	maxDef, err := envInt("CUTTLE_MAX_ROOMS", DefaultMaxRooms)
	if err != nil {
		return Config{}, err
	}
	respondDef, err := envInt("CUTTLE_RESPOND_MIN_MS", int(DefaultRespondMin/time.Millisecond))
	if err != nil {
		return Config{}, err
	}
	socksDef, err := envInt("CUTTLE_MAX_SOCKETS", DefaultMaxSockets)
	if err != nil {
		return Config{}, err
	}
	perClientDef, err := envInt("CUTTLE_MAX_SOCKETS_PER_CLIENT", DefaultMaxSocketsPerClient)
	if err != nil {
		return Config{}, err
	}
	maxSockets := fs.Int("max-sockets", socksDef, "most open play sockets")
	maxSocketsPerClient := fs.Int("max-sockets-per-client", perClientDef, "most open play sockets per client address")
	respondMS := fs.Int("respond-min-ms", respondDef, "least milliseconds a counterable move's mover waits for its next state")
	createRate := fs.Int("create-per-hour", createDef, "room creates per client per hour")
	joinRate := fs.Int("join-per-hour", joinDef, "room joins per client per hour")
	maxRooms := fs.Int("max-rooms", maxDef, "most live rooms")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() > 0 {
		return Config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	cfg := Config{Addr: *addr, Dev: *dev, DataDir: *dataDir,
		CreatePerHour: *createRate, JoinPerHour: *joinRate, MaxRooms: *maxRooms,
		RespondMin: time.Duration(*respondMS) * time.Millisecond,
		MaxSockets: *maxSockets, MaxSocketsPerClient: *maxSocketsPerClient}
	for _, p := range strings.Split(*proxies, ",") {
		if p = strings.TrimSpace(p); p != "" {
			cfg.TrustedProxies = append(cfg.TrustedProxies, p)
		}
	}
	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
		}
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate checks every field.
func (c Config) Validate() error {
	host, port, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", c.Addr, err)
	}
	_ = host
	if port == ReservedPort {
		return fmt.Errorf("port %s is reserved for another project", ReservedPort)
	}
	if port == "" {
		return fmt.Errorf("listen address %q has no port", c.Addr)
	}
	if len(c.AllowedOrigins) == 0 {
		return fmt.Errorf("at least one allowed origin is required")
	}
	for _, o := range c.AllowedOrigins {
		if err := validateOrigin(o); err != nil {
			return err
		}
	}
	for _, p := range c.TrustedProxies {
		if _, err := netip.ParseAddr(p); err != nil {
			return fmt.Errorf("trusted proxy %q must be a bare IP address", p)
		}
	}
	if c.CreatePerHour < 1 || c.JoinPerHour < 1 {
		return fmt.Errorf("rate limits must be at least 1 per hour")
	}
	if c.MaxRooms < 1 {
		return fmt.Errorf("max rooms must be at least 1")
	}
	if c.MaxSockets < 1 || c.MaxSocketsPerClient < 1 {
		return fmt.Errorf("socket caps must be at least 1")
	}
	if c.RespondMin < time.Millisecond || c.RespondMin > maxRespondMin {
		return fmt.Errorf("respond-min-ms must be between 1 and %d", maxRespondMin.Milliseconds())
	}
	if c.DataDir != "" {
		st, err := os.Stat(c.DataDir)
		if err != nil {
			return fmt.Errorf("data directory: %w", err)
		}
		if !st.IsDir() {
			return fmt.Errorf("data directory %q is not a directory", c.DataDir)
		}
	}
	return nil
}

// validateOrigin requires a bare scheme://host[:port] with no wildcard.
func validateOrigin(o string) error {
	if strings.Contains(o, "*") {
		return fmt.Errorf("origin %q: wildcards are not allowed", o)
	}
	u, err := url.Parse(o)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("origin %q must look like https://host[:port]", o)
	}
	if u.Path == "/" {
		return fmt.Errorf("origin %q must not end with a slash", o)
	}
	return nil
}
