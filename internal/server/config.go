// Package server holds the cuttle-server HTTP plumbing: configuration, CORS,
// request logging, handlers and the run loop. main stays a thin wrapper.
package server

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
)

const (
	// DefaultAddr is the listen address. TLS ends at the reverse proxy, so the
	// server binds loopback only.
	DefaultAddr = "127.0.0.1:8080"
	// DefaultOrigin is the deployed web app's origin.
	DefaultOrigin = "https://apismellow.github.io"
	// ReservedPort belongs to an unrelated local project and is never used.
	ReservedPort = "8765"
)

// Config is the validated server configuration.
type Config struct {
	Addr           string   // listen address, host:port
	AllowedOrigins []string // exact origins, e.g. https://apismellow.github.io
	Dev            bool     // also allow http://127.0.0.1:* and http://localhost:*
	DataDir        string   // data directory (unused until the store lands); "" = unset
}

// ParseConfig reads flags from args, falling back to environment values from
// getenv (CUTTLE_ADDR, CUTTLE_ALLOWED_ORIGINS comma-separated, CUTTLE_DATA_DIR),
// then to defaults. Flags win over the environment.
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
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() > 0 {
		return Config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	cfg := Config{Addr: *addr, Dev: *dev, DataDir: *dataDir}
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
