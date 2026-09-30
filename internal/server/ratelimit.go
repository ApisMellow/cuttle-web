package server

import (
	"context"
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
	// groupFactor sizes the IPv6 /48 aggregate bucket: one /48 (a site)
	// gets this many clients' worth, however many /64s it cycles through.
	groupFactor = 4
	// overflowFactor sizes the shared overflow bucket that serves new
	// clients while a table is full.
	overflowFactor = 20
	// limiterMaxKeys bounds each table (clients, /48 groups).
	limiterMaxKeys = 50000
	// limiterPruneEvery is how often a background loop forgets refilled
	// buckets. Requests never prune, so their cost stays O(1).
	limiterPruneEvery = time.Minute
)

type rate struct {
	perSec float64
	burst  float64
}

func perHour(n int) rate { return rate{perSec: float64(n) / 3600, burst: float64(n)} }

type bucket struct {
	tokens float64
	at     time.Time
	rate   *rate
}

// clientID names a client for rate limiting (identify).
type clientID struct {
	// key is the client's own bucket: an IPv4 address or an IPv6 /64.
	key string
	// group is the IPv6 /48 the client sits in, "" for IPv4. See identify.
	group string
	// proxyNoXFF: the peer is a trusted proxy that sent no usable
	// X-Forwarded-For, so key is the proxy's own address.
	proxyNoXFF bool
}

// limiter is a set of token buckets. A request must find a token in its
// /48 group bucket (IPv6 only) and in its own bucket.
//
// Tables are bounded at maxKeys. When one is full a new client is served
// from a shared overflow bucket (generous but bounded) rather than
// refused or given a fresh bucket, so a flood of new identities can
// neither lock everyone out nor grow memory. The pruner (pruneLoop)
// frees room in the background.
type limiter struct {
	mu      sync.Mutex
	now     func() time.Time
	client  rate
	group   rate
	over    rate
	keys    map[string]*bucket
	groups  map[string]*bucket
	flow    *bucket // the overflow bucket
	maxKeys int
}

func newLimiter(n int, now func() time.Time) *limiter {
	if now == nil {
		now = time.Now
	}
	l := &limiter{now: now, client: perHour(n), group: perHour(n * groupFactor), over: perHour(n * overflowFactor),
		keys: map[string]*bucket{}, groups: map[string]*bucket{}, maxKeys: limiterMaxKeys}
	l.flow = &bucket{tokens: l.over.burst, at: now(), rate: &l.over}
	return l
}

// allow takes one token for c. When it can't, it reports how long until
// one is available. O(1): map lookups only.
func (l *limiter) allow(c clientID) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, wait, ok := l.takeLocked(c)
	return ok, wait
}

// reservation is a token taken by reserve, for refund to give back.
type reservation struct {
	own, group *bucket // group is nil for IPv4, or when it is own (overflow)
}

// reserve takes one token for c like allow, remembering where it came
// from so refund can return it. Taking before the outcome is known, and
// under the lock, is what caps concurrent attempts at the budget.
func (l *limiter) reserve(c clientID) (reservation, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	res, _, ok := l.takeLocked(c)
	return res, ok
}

// refund returns a reserve'd token (the attempt turned out not to count).
// A bucket pruned in between is simply forgotten: a new one starts full.
func (l *limiter) refund(res reservation) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, b := range []*bucket{res.own, res.group} {
		if b != nil {
			b.tokens = math.Min(b.rate.burst, b.tokens+1)
		}
	}
}

// takeLocked spends one token from c's group (IPv6) and own bucket, or
// reports the wait. l.mu must be held.
func (l *limiter) takeLocked(c clientID) (reservation, time.Duration, bool) {
	now := l.now()
	var g *bucket
	if c.group != "" {
		g = l.lookup(l.groups, c.group, &l.group, now)
		l.refill(g, now)
		// A throttled group creates no per-client bucket: cycling /64s
		// inside one /48 can't grow the client table.
		if g.tokens < 1 {
			return reservation{}, l.wait(g), false
		}
	}
	b := l.lookup(l.keys, c.key, &l.client, now)
	l.refill(b, now)
	if b.tokens < 1 {
		return reservation{}, l.wait(b), false
	}
	b.tokens--
	res := reservation{own: b}
	if g != nil && g != b {
		g.tokens--
		res.group = g
	}
	return res, 0, true
}

// lookup returns key's bucket in m, making it if the table has room, or
// the overflow bucket if not.
func (l *limiter) lookup(m map[string]*bucket, key string, r *rate, now time.Time) *bucket {
	if b := m[key]; b != nil {
		return b
	}
	if len(m) >= l.maxKeys {
		return l.flow
	}
	b := &bucket{tokens: r.burst, at: now, rate: r}
	m[key] = b
	return b
}

func (l *limiter) wait(b *bucket) time.Duration {
	return time.Duration(math.Ceil((1-b.tokens)/b.rate.perSec)) * time.Second
}

func (l *limiter) refill(b *bucket, now time.Time) {
	if el := now.Sub(b.at).Seconds(); el > 0 {
		b.tokens = math.Min(b.rate.burst, b.tokens+el*b.rate.perSec)
	}
	b.at = now
}

// prune forgets buckets that have refilled completely: forgetting one is
// the same as keeping it. It walks both tables under the lock, so it runs
// on the pruner's ticker, never per request.
func (l *limiter) prune() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for _, m := range []map[string]*bucket{l.keys, l.groups} {
		for k, b := range m {
			l.refill(b, now)
			if b.tokens >= b.rate.burst {
				delete(m, k)
			}
		}
	}
}

func (l *limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.keys)
}

func (l *limiter) groupSize() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.groups)
}

// pruneLoop prunes ls on every tick until ctx is done.
func pruneLoop(ctx context.Context, ticks <-chan time.Time, ls ...*limiter) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			for _, l := range ls {
				l.prune()
			}
		}
	}
}

// startPruner runs pruneLoop on a limiterPruneEvery ticker until ctx is
// done.
func startPruner(ctx context.Context, ls ...*limiter) {
	t := time.NewTicker(limiterPruneEvery)
	done := pruneLoopDone
	go func() {
		defer t.Stop()
		if done != nil {
			defer done()
		}
		pruneLoop(ctx, t.C, ls...)
	}()
}

// pruneLoopDone, if set, runs when a pruner started by startPruner stops
// (tests). It is read when the pruner starts.
var pruneLoopDone func()

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

// identify names the client for rate limiting. The address is the peer's,
// unless the peer is a trusted proxy, in which case it is the rightmost
// X-Forwarded-For entry (the address the proxy itself saw; entries to its
// left are client-supplied).
//
// IPv6 clients are keyed by /64, the usual size of one household's
// allocation, and grouped by /48, the usual size of one site's: a single
// site holds 65,536 /64s, so without the group bucket it could mint that
// many fresh identities.
//
// IPv4 gets no /24 group. An IPv4 attacker can't mint addresses the way
// a /48 mints /64s (a /24 is at most 256 keys, already bounded by the
// per-address buckets), while a /24 often spans unrelated users behind a
// carrier's shared range, so a /24 bucket would throttle strangers
// together for no gain.
func identify(r *http.Request, trusted trustedSet) clientID {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return clientID{key: host}
	}
	addr = addr.Unmap()
	var c clientID
	if trusted[addr] {
		c.proxyNoXFF = true
		if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
			parts := strings.Split(xff[len(xff)-1], ",")
			if a, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				addr, c.proxyNoXFF = a.Unmap(), false
			}
		}
	}
	if addr.Is6() {
		addr = addr.WithZone("")
		p64, _ := addr.Prefix(64)
		p48, _ := addr.Prefix(48)
		c.key, c.group = p64.String(), p48.String()
		return c
	}
	c.key = addr.String()
	return c
}
