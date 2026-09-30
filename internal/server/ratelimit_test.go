package server

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientKey(t *testing.T) {
	trusted := newTrustedSet([]string{"127.0.0.1", "::1"})
	cases := []struct {
		name, remote, xff, want string
		trust                   trustedSet
	}{
		{"ipv4", "198.51.100.7:1234", "", "198.51.100.7", nil},
		{"xff ignored without trust", "127.0.0.1:1", "198.51.100.7", "127.0.0.1", nil},
		{"xff from trusted", "127.0.0.1:1", "198.51.100.7", "198.51.100.7", trusted},
		{"xff rightmost wins", "127.0.0.1:1", "10.0.0.1, 198.51.100.7", "198.51.100.7", trusted},
		{"xff spaces", "127.0.0.1:1", " 10.0.0.1 ,198.51.100.7 ", "198.51.100.7", trusted},
		{"xff from untrusted", "192.0.2.1:1", "198.51.100.7", "192.0.2.1", trusted},
		{"xff garbage falls back to proxy", "127.0.0.1:1", "not-an-ip", "127.0.0.1", trusted},
		{"xff empty falls back", "127.0.0.1:1", "", "127.0.0.1", trusted},
		{"trusted ipv6 proxy", "[::1]:1", "198.51.100.7", "198.51.100.7", trusted},
		{"ipv6 grouped by /64", "[2001:db8:1:2:aaaa::1]:1", "", "2001:db8:1:2::/64", nil},
		{"ipv6 same /64", "[2001:db8:1:2:ffff:1:2:3]:1", "", "2001:db8:1:2::/64", nil},
		{"ipv4-mapped ipv6", "[::ffff:198.51.100.7]:1", "", "198.51.100.7", nil},
		{"no port", "198.51.100.7", "", "198.51.100.7", nil},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/rooms", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientKey(r, c.trust); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestLimiterRefillAndBurst(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now) // 6/hour, burst 6, one token per 10 min
	for i := 0; i < 6; i++ {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("burst %d denied", i)
		}
	}
	ok, wait := l.allow("a")
	if ok || wait <= 0 || wait > 10*time.Minute {
		t.Fatalf("7th: ok %t wait %v", ok, wait)
	}
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("other key denied")
	}
	clk.Advance(10 * time.Minute)
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("no refill after 10 min")
	}
	if ok, _ := l.allow("a"); ok {
		t.Fatal("refilled more than one token")
	}
	// Refill caps at the burst.
	clk.Advance(100 * time.Hour)
	for i := 0; i < 6; i++ {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("after long idle, %d denied", i)
		}
	}
	if ok, _ := l.allow("a"); ok {
		t.Fatal("burst exceeded after long idle")
	}
}

func TestLimiterPrunesFullBuckets(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now)
	for i := 0; i < 50; i++ {
		l.allow(string(rune('a' + i)))
	}
	clk.Advance(2 * time.Hour)
	l.prune()
	if n := l.size(); n != 0 {
		t.Fatalf("%d buckets after prune", n)
	}
}

func TestLimiterFailsClosedWhenFull(t *testing.T) {
	clk := newClock()
	l := newLimiter(6, clk.Now)
	l.maxKeys = 3
	for _, k := range []string{"a", "b", "c"} {
		if ok, _ := l.allow(k); !ok {
			t.Fatal(k)
		}
	}
	if ok, _ := l.allow("d"); ok {
		t.Fatal("new key admitted past maxKeys")
	}
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("existing key denied")
	}
	clk.Advance(2 * time.Hour)
	if ok, _ := l.allow("d"); !ok {
		t.Fatal("new key denied after refilled buckets could be pruned")
	}
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
