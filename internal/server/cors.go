package server

import (
	"net/http"
	"net/url"
	"strings"
)

// OriginPolicy decides which web origins may call the API.
type OriginPolicy struct {
	exact map[string]bool
	dev   bool
}

// NewOriginPolicy builds a policy from exact origins; dev additionally admits
// http://127.0.0.1:* and http://localhost:*.
func NewOriginPolicy(origins []string, dev bool) OriginPolicy {
	p := OriginPolicy{exact: make(map[string]bool, len(origins)), dev: dev}
	for _, o := range origins {
		p.exact[o] = true
	}
	return p
}

// Allowed reports whether origin may be echoed back.
func (p OriginPolicy) Allowed(origin string) bool {
	if origin == "" {
		return false
	}
	if p.exact[origin] {
		return true
	}
	if !p.dev {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Path != "" || u.RawQuery != "" || u.User != nil {
		return false
	}
	h := u.Hostname()
	return h == "127.0.0.1" || h == "localhost"
}

// CORS wraps next. Requests with no Origin header (non-browser clients, same
// origin) pass through untouched. A request from a disallowed origin gets 403
// with the JSON error body {code: "FORBIDDEN", message}.
// An allowed origin is echoed exactly, never "*", with Vary: Origin. Preflight
// requests are answered here with 204.
func CORS(p OriginPolicy, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Origin")
		if !p.Allowed(origin) {
			writeError(w, http.StatusForbidden, CodeForbidden, "origin not allowed")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h := w.Header()
			h.Add("Vary", "Access-Control-Request-Method")
			h.Add("Vary", "Access-Control-Request-Headers")
			h.Set("Access-Control-Allow-Methods", strings.Join([]string{"GET", "POST", "OPTIONS"}, ", "))
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
