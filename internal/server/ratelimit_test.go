package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"
)

// k is a client with no /48 group (an IPv4 client, say).
func k(key string) clientID { return clientID{key: key} }

func TestClientKey(t *testing.T) {
	trusted := newTrustedSet([]string{"127.0.0.1", "::1"})
	cases := []struct {
		name, remote, xff, want, group string
		noXFF                          bool
		trust                          trustedSet
	}{
		{"ipv4", "198.51.100.7:1234", "", "198.51.100.7", "", false, nil},
		{"xff ignored without trust", "127.0.0.1:1", "198.51.100.7", "127.0.0.1", "", false, nil},
		{"xff from trusted", "127.0.0.1:1", "198.51.100.7", "198.51.100.7", "", false, trusted},
		{"xff rightmost wins", "127.0.0.1:1", "10.0.0.1, 198.51.100.7", "198.51.100.7", "", false, trusted},
		{"xff spaces", "127.0.0.1:1", " 10.0.0.1 ,198.51.100.7 ", "198.51.100.7", "", false, trusted},
		{"xff from untrusted", "192.0.2.1:1", "198.51.100.7", "192.0.2.1", "", false, trusted},
		{"xff garbage falls back to proxy", "127.0.0.1:1", "not-an-ip", "127.0.0.1", "", true, trusted},
		{"xff empty falls back", "127.0.0.1:1", "", "127.0.0.1", "", true, trusted},
		{"trusted ipv6 proxy", "[::1]:1", "198.51.100.7", "198.51.100.7", "", false, trusted},
		{"ipv6 grouped by /64", "[2001:db8:1:2:aaaa::1]:1", "", "2001:db8:1:2::/64", "2001:db8:1::/48", false, nil},
		{"ipv6 same /64", "[2001:db8:1:2:ffff:1:2:3]:1", "", "2001:db8:1:2::/64", "2001:db8:1::/48", false, nil},
		{"ipv6 via proxy", "127.0.0.1:1", "2001:db8:9:8:7::1", "2001:db8:9:8::/64", "2001:db8:9::/48", false, trusted},
		{"ipv4-mapped ipv6", "[::ffff:198.51.100.7]:1", "", "198.51.100.7", "", false, nil},
		{"no port", "198.51.100.7", "", "198.51.100.7", "", false, nil},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/rooms", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		got := identify(r, c.trust)
		if got.key != c.want || got.group != c.group || got.proxyNoXFF != c.noXFF {
			t.Errorf("%s: got %+v, want key %q group %q noXFF %t", c.name, got, c.want, c.group, c.noXFF)
		}
	}
}

func TestLimiterRefillAndBurst(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now) // 6/hour, burst 6, one token per 10 min
	for i := 0; i < 6; i++ {
		if ok, _ := l.allow(k("a")); !ok {
			t.Fatalf("burst %d denied", i)
		}
	}
	ok, wait := l.allow(k("a"))
	if ok || wait <= 0 || wait > 10*time.Minute {
		t.Fatalf("7th: ok %t wait %v", ok, wait)
	}
	if ok, _ := l.allow(k("b")); !ok {
		t.Fatal("other key denied")
	}
	clk.Advance(10 * time.Minute)
	if ok, _ := l.allow(k("a")); !ok {
		t.Fatal("no refill after 10 min")
	}
	if ok, _ := l.allow(k("a")); ok {
		t.Fatal("refilled more than one token")
	}
	// Refill caps at the burst.
	clk.Advance(100 * time.Hour)
	for i := 0; i < 6; i++ {
		if ok, _ := l.allow(k("a")); !ok {
			t.Fatalf("after long idle, %d denied", i)
		}
	}
	if ok, _ := l.allow(k("a")); ok {
		t.Fatal("burst exceeded after long idle")
	}
}

func TestLimiterPrunesFullBuckets(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now)
	for i := 0; i < 50; i++ {
		l.allow(clientID{key: fmt.Sprint("k", i), group: fmt.Sprint("g", i%5)})
	}
	if l.size() != 50 || l.groupSize() != 5 {
		t.Fatalf("before prune: %d keys, %d groups", l.size(), l.groupSize())
	}
	clk.Advance(2 * time.Hour)
	l.prune()
	if n, g := l.size(), l.groupSize(); n != 0 || g != 0 {
		t.Fatalf("%d keys, %d groups after prune", n, g)
	}
}

// v6 is the client for the i-th /64 inside 2001:db8:aaaa::/48.
func v6(t *testing.T, prefix48 string, i int) clientID {
	t.Helper()
	p := netip.MustParsePrefix(prefix48).Addr().As16()
	p[6], p[7] = byte(i>>8), byte(i)
	p[15] = 1
	r := httptest.NewRequest("POST", "/api/rooms", nil)
	r.RemoteAddr = netip.AddrPortFrom(netip.AddrFrom16(p), 443).String()
	return identify(r, nil)
}

// A single /48 holds 65,536 /64s. Minting a fresh /64 per request must not
// buy a fresh bucket each time: the /48 aggregate throttles them, the
// per-/64 table stays small, and clients elsewhere are unaffected.
func TestLimiterIPv6SlashFortyEightAggregate(t *testing.T) {
	clk := newClock()
	l := newLimiter(DefaultCreatePerHour, clk.Now)
	allowed := 0
	for i := 0; i < 60000; i++ {
		if ok, _ := l.allow(v6(t, "2001:db8:aaaa::/48", i%65536)); ok {
			allowed++
		}
	}
	if want := DefaultCreatePerHour * groupFactor; allowed != want {
		t.Fatalf("one /48 got %d creates through, want the aggregate burst %d", allowed, want)
	}
	if n := l.size(); n > DefaultCreatePerHour*groupFactor {
		t.Fatalf("the flood grew the per-/64 table to %d keys", n)
	}
	if ok, _ := l.allow(v6(t, "2001:db8:bbbb::/48", 1)); !ok {
		t.Fatal("a client in another /48 was throttled by the flood")
	}
	if ok, _ := l.allow(k("198.51.100.7")); !ok {
		t.Fatal("an IPv4 client was throttled by the flood")
	}
	// One /64 inside the flooded /48 still has its own per-/64 limit once
	// the aggregate refills.
	clk.Advance(time.Hour)
	for i := 0; i < DefaultCreatePerHour; i++ {
		if ok, _ := l.allow(v6(t, "2001:db8:aaaa::/48", 7)); !ok {
			t.Fatalf("after refill, request %d denied", i)
		}
	}
	if ok, _ := l.allow(v6(t, "2001:db8:aaaa::/48", 7)); ok {
		t.Fatal("per-/64 limit not applied inside the /48")
	}
}

// When the table is full, a new client is served from the shared overflow
// bucket instead of being refused, and no inline prune runs.
func TestLimiterOverflowWhenFull(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now)
	l.maxKeys = 3
	for _, key := range []string{"a", "b", "c"} {
		if ok, _ := l.allow(k(key)); !ok {
			t.Fatal(key)
		}
	}
	// Every existing bucket is fully refilled and prunable, but allow must
	// not scan the table: the new client goes to overflow.
	clk.Advance(2 * time.Hour)
	if ok, _ := l.allow(k("d")); !ok {
		t.Fatal("new key refused while the table is full")
	}
	if n := l.size(); n != 3 {
		t.Fatalf("allow pruned or grew the table inline: %d keys", n)
	}
	// Overflow is shared and bounded.
	served := 1
	for i := 0; i < 1000; i++ {
		if ok, _ := l.allow(k(fmt.Sprint("new", i))); ok {
			served++
		}
	}
	if want := 6 * overflowFactor; served != want {
		t.Fatalf("overflow served %d, want its burst %d", served, want)
	}
	ok, wait := l.allow(k("e"))
	if ok || wait <= 0 {
		t.Fatalf("overflow exhausted: ok %t wait %v", ok, wait)
	}
	// Existing clients keep their own buckets.
	if ok, _ := l.allow(k("a")); !ok {
		t.Fatal("existing key denied")
	}
	// After a prune there is room again.
	l.prune()
	if ok, _ := l.allow(k("e")); !ok {
		t.Fatal("new key denied after prune freed room")
	}
	if n := l.size(); n == 0 {
		t.Fatal("the new key did not get its own bucket after prune")
	}
}

// A full /48 table also overflows rather than refusing.
func TestLimiterGroupTableOverflow(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now)
	l.maxKeys = 2
	for i := 0; i < 2; i++ {
		if ok, _ := l.allow(clientID{key: fmt.Sprint("k", i), group: fmt.Sprint("g", i)}); !ok {
			t.Fatal(i)
		}
	}
	if ok, _ := l.allow(clientID{key: "k9", group: "g9"}); !ok {
		t.Fatal("new group refused while the group table is full")
	}
	if g := l.groupSize(); g != 2 {
		t.Fatalf("group table grew past its bound: %d", g)
	}
}

func TestLimiterPruneRunsOnTicker(t *testing.T) {
	clk := newClock()
	a, b := newLimiter(6, clk.Now), newLimiter(6, clk.Now)
	for i := 0; i < 10; i++ {
		a.allow(k(fmt.Sprint(i)))
		b.allow(k(fmt.Sprint(i)))
	}
	clk.Advance(2 * time.Hour)
	ticks := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		pruneLoop(ctx, ticks, a, b)
		close(done)
	}()
	if a.size() != 10 || b.size() != 10 {
		t.Fatal("pruned before any tick")
	}
	ticks <- clk.Now()
	// The loop takes the next tick only after finishing this prune, so a
	// second send proves the first prune completed.
	ticks <- clk.Now()
	if a.size() != 0 || b.size() != 0 {
		t.Fatalf("after a tick: %d, %d keys", a.size(), b.size())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("prune loop did not stop on cancel")
	}
}

func TestHandlerStopsPrunerOnCancel(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	prev := pruneLoopDone
	pruneLoopDone = func() { close(stopped) }
	t.Cleanup(func() { pruneLoopDone = prev })
	Handler(ctx, Config{AllowedOrigins: []string{prodOrigin}}, BuildInfo{}, e.log, e.rooms)
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("limiter pruner still running after cancel")
	}
}

func TestLimiterConcurrent(t *testing.T) {
	clk := newClock()
	l := newLimiter(1000, clk.Now)
	l.maxKeys = 50
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	go pruneLoop(ctx, ticks, l)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				l.allow(clientID{key: fmt.Sprint(g, "-", i), group: fmt.Sprint("g", i%7)})
				if i%100 == 0 {
					clk.Advance(time.Minute)
				}
			}
		}(g)
	}
	for i := 0; i < 20; i++ {
		ticks <- clk.Now()
	}
	wg.Wait()
}

func TestParseConfigW5Flags(t *testing.T) {
	cfg, err := ParseConfig(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CreatePerHour != DefaultCreatePerHour || cfg.JoinPerHour != DefaultJoinPerHour ||
		cfg.MaxRooms != DefaultMaxRooms || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("defaults %+v", cfg)
	}
	env := map[string]string{
		"CUTTLE_TRUSTED_PROXY":   "127.0.0.1",
		"CUTTLE_CREATE_PER_HOUR": "4",
		"CUTTLE_JOIN_PER_HOUR":   "8",
		"CUTTLE_MAX_ROOMS":       "50",
	}
	cfg, err = ParseConfig(nil, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CreatePerHour != 4 || cfg.JoinPerHour != 8 || cfg.MaxRooms != 50 ||
		len(cfg.TrustedProxies) != 1 || cfg.TrustedProxies[0] != "127.0.0.1" {
		t.Fatalf("env %+v", cfg)
	}
	cfg, err = ParseConfig([]string{"-trusted-proxy", "127.0.0.1, ::1", "-create-per-hour", "2", "-join-per-hour", "3", "-max-rooms", "7"},
		func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CreatePerHour != 2 || cfg.JoinPerHour != 3 || cfg.MaxRooms != 7 || len(cfg.TrustedProxies) != 2 {
		t.Fatalf("flags %+v", cfg)
	}
	for name, args := range map[string][]string{
		"proxy not an ip":  {"-trusted-proxy", "caddy.local"},
		"proxy with port":  {"-trusted-proxy", "127.0.0.1:443"},
		"proxy cidr":       {"-trusted-proxy", "0.0.0.0/0"},
		"zero create rate": {"-create-per-hour", "0"},
		"negative join":    {"-join-per-hour", "-1"},
		"zero max rooms":   {"-max-rooms", "0"},
	} {
		if _, err := ParseConfig(args, func(string) string { return "" }); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := ParseConfig(nil, func(k string) string {
		return map[string]string{"CUTTLE_MAX_ROOMS": "lots"}[k]
	}); err == nil {
		t.Error("bad env integer accepted")
	}
}
