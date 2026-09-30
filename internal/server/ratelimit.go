package server

import (
	"math"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Rate limits (plan §9): per-client token buckets on create and join.

const (
	// DefaultCreatePerHour and DefaultJoinPerHour are plan §9's family-scale
	// limits. Each bucket holds an hour's worth, so a burst is allowed.
	DefaultCreatePerHour = 10
	DefaultJoinPerHour   = 30
	// limiterMaxKeys bounds limiter memory. When full, fully refilled
	// buckets are pruned; if none can go, a new client is refused rather
	// than an old bucket reset (fail closed).
	limiterMaxKeys = 50000
)

type bucket struct {
	tokens float64
	at     time.Time
}

// limiter is a set of token buckets keyed by client.
type limiter struct {
	mu      sync.Mutex
	perSec  float64
	burst   float64
	now     func() time.Time
	buckets map[string]*bucket
	maxKeys int
}

func newLimiter(perHour int, now func() time.Time) *limiter {
	if now == nil {
		now = time.Now
	}
	return &limiter{perSec: float64(perHour) / 3600, burst: float64(perHour), now: now,
		buckets: map[string]*bucket{}, maxKeys: limiterMaxKeys}
}

// allow takes one token from key's bucket. When it can't, it reports how
// long until one is available.
func (l *limiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= l.maxKeys {
			l.pruneLocked(now)
			if len(l.buckets) >= l.maxKeys {
				return false, time.Minute
			}
		}
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	}
	l.refill(b, now)
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration(math.Ceil((1-b.tokens)/l.perSec)) * time.Second
	return false, wait
}

func (l *limiter) refill(b *bucket, now time.Time) {
	if el := now.Sub(b.at).Seconds(); el > 0 {
		b.tokens = math.Min(l.burst, b.tokens+el*l.perSec)
	}
	b.at = now
}

// prune forgets buckets that have refilled completely: forgetting one is
// the same as keeping it.
func (l *limiter) prune() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked(l.now())
}

func (l *limiter) pruneLocked(now time.Time) {
	for k, b := range l.buckets {
		l.refill(b, now)
		if b.tokens >= l.burst {
			delete(l.buckets, k)
		}
	}
}

func (l *limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// trustedSet holds the proxy addresses whose X-Forwarded-For is believed.
type trustedSet map[netip.Addr]bool

func newTrustedSet(ips []string) trustedSet {
	t := trustedSet{}
	for _, s := range ips {
		if a, err := netip.ParseAddr(strings.TrimSpace(s)); err == nil {
			t[a.Unmap()] = true
		}
	}
	return t
}

// clientKey names the client for rate limiting. It is the peer address,
// unless the peer is a trusted proxy, in which case it is the rightmost
// X-Forwarded-For entry (the address the proxy itself saw; entries to its
// left are client-supplied). IPv6 clients are grouped by /64, the usual
// size of one household's allocation.
func clientKey(r *http.Request, trusted trustedSet) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	if trusted[addr] {
		if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
			parts := strings.Split(xff[len(xff)-1], ",")
			if a, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				addr = a.Unmap()
			}
		}
	}
	if addr.Is6() {
		p, _ := addr.WithZone("").Prefix(64)
		return p.String()
	}
	return addr.String()
}
