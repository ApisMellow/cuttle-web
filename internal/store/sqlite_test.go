package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Compile-time check that SQLite implements Store.
var _ Store = (*SQLite)(nil)

// fakeClock is a settable clock shared by a store and its test.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

var bg = context.Background()

// openFile opens a file-backed store in a fresh temp dir (removed by the
// testing package, so no DB files are left behind).
func openFile(t *testing.T, clk *fakeClock, opt Options) (*SQLite, string) {
	t.Helper()
	dir := t.TempDir()
	if clk != nil {
		opt.Now = clk.Now
	}
	s, err := OpenDir(dir, opt)
	if err != nil {
		t.Fatalf("OpenDir: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func mustCreate(t *testing.T, s Store, name string) Claim {
	t.Helper()
	c, err := s.Create(bg, name)
	if err != nil {
		t.Fatalf("Create(%q): %v", name, err)
	}
	return c
}

func mustJoin(t *testing.T, s Store, code, name string) Claim {
	t.Helper()
	c, err := s.Join(bg, code, name)
	if err != nil {
		t.Fatalf("Join(%q, %q): %v", code, name, err)
	}
	return c
}

func mustGet(t *testing.T, s Store, code string) Room {
	t.Helper()
	r, err := s.Get(bg, code)
	if err != nil {
		t.Fatalf("Get(%q): %v", code, err)
	}
	return r
}

// dealt returns a room with both seats taken and game 1 dealt by seat 1.
func dealt(t *testing.T, s Store) (Claim, Claim) {
	t.Helper()
	a := mustCreate(t, s, "Alice")
	b := mustJoin(t, s, a.Code, "Blake")
	err := s.Save(bg, a.Code, Save{
		PrevGame: 0, PrevSeq: 0, Game: 1, Seq: 0,
		Snapshot: []byte(`{"deal":1}`), Status: StatusActive, LastDealer: 1,
	})
	if err != nil {
		t.Fatalf("deal: %v", err)
	}
	return a, b
}

func TestRoundTrip(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	t0 := clk.Now()

	a := mustCreate(t, s, "Alice")
	if a.Seat != 0 || a.Token == "" {
		t.Fatalf("create claim = %+v", a)
	}
	if _, err := NormalizeCode(a.Code); err != nil {
		t.Fatalf("bad code %q", a.Code)
	}

	got := mustGet(t, s, a.Code)
	want := Room{
		Code: a.Code, CreatedAt: t0, UpdatedAt: t0, Status: StatusWaiting,
		Names: [2]string{"Alice", ""}, LastDealer: NoDealer,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after create:\n got %+v\nwant %+v", got, want)
	}
	if got.NextDealer() != NoDealer {
		t.Fatalf("NextDealer before deal = %d", got.NextDealer())
	}

	// Codes are case-insensitive.
	if lower := mustGet(t, s, strings.ToLower(a.Code)); !reflect.DeepEqual(lower, got) {
		t.Fatal("lower-case lookup differs")
	}

	clk.Advance(time.Minute)
	b := mustJoin(t, s, strings.ToLower(a.Code), "Blake")
	if b.Seat != 1 || b.Code != a.Code || b.Token == "" || b.Token == a.Token {
		t.Fatalf("join claim = %+v", b)
	}
	got = mustGet(t, s, a.Code)
	want.Status, want.Joined, want.Names[1], want.UpdatedAt = StatusActive, true, "Blake", clk.Now()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after join:\n got %+v\nwant %+v", got, want)
	}

	// Deal game 1, play a move, finish, then rematch.
	steps := []Save{
		{PrevGame: 0, PrevSeq: 0, Game: 1, Seq: 0, Snapshot: []byte(`{"s":0}`), Status: StatusActive, LastDealer: 1},
		{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1, Snapshot: []byte(`{"s":1}`), Status: StatusActive, LastDealer: 1},
		{PrevGame: 1, PrevSeq: 1, Game: 1, Seq: 2, Snapshot: []byte(`{"s":2}`), Status: StatusFinished, Tally: [2]int{1, 0}, LastDealer: 1},
		{PrevGame: 1, PrevSeq: 2, Game: 2, Seq: 0, Snapshot: []byte(`{"s":3}`), Status: StatusActive, Tally: [2]int{1, 0}, LastDealer: 0},
	}
	for i, sv := range steps {
		clk.Advance(time.Second)
		if err := s.Save(bg, a.Code, sv); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		got = mustGet(t, s, a.Code)
		want.Game, want.Seq, want.Snapshot, want.Status = sv.Game, sv.Seq, sv.Snapshot, sv.Status
		want.Tally, want.LastDealer, want.UpdatedAt = sv.Tally, sv.LastDealer, clk.Now()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("after step %d:\n got %+v\nwant %+v", i, got, want)
		}
	}
	if got.NextDealer() != 1 {
		t.Fatalf("NextDealer after seat 0 dealt = %d", got.NextDealer())
	}
	if n, err := s.Count(bg); err != nil || n != 1 {
		t.Fatalf("Count = %d, %v", n, err)
	}
}

func TestOpenMemoryRoundTrip(t *testing.T) {
	s, err := OpenMemory(Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := mustCreate(t, s, "Alice")
	b := mustJoin(t, s, a.Code, "Blake")
	if seat, err := s.Authenticate(bg, a.Code, b.Token); err != nil || seat != 1 {
		t.Fatalf("auth = %d, %v", seat, err)
	}
	// Two in-memory stores are independent.
	s2, err := OpenMemory(Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if _, err := s2.Get(bg, a.Code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second memory store sees the first's room: %v", err)
	}
}

func TestGetUnknown(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	for _, code := range []string{"ZZZZ", "", "K7Q", "K7QU!"} {
		if _, err := s.Get(bg, code); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) = %v, want ErrNotFound", code, err)
		}
	}
}

func TestCreateRejectsEmptyName(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	if _, err := s.Create(bg, ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Create(\"\") = %v, want ErrInvalid", err)
	}
	a := mustCreate(t, s, "Alice")
	if _, err := s.Join(bg, a.Code, ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Join with empty name = %v, want ErrInvalid", err)
	}
	if r := mustGet(t, s, a.Code); r.Joined {
		t.Fatal("empty-name join took the seat")
	}
}

func TestJoinErrors(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	if _, err := s.Join(bg, "ZZZZ", "Blake"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("join unknown = %v, want ErrNotFound", err)
	}
	a := mustCreate(t, s, "Alice")
	mustJoin(t, s, a.Code, "Blake")
	before := mustGet(t, s, a.Code)
	if _, err := s.Join(bg, a.Code, "Carol"); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("second join = %v, want ErrRoomFull", err)
	}
	if after := mustGet(t, s, a.Code); !reflect.DeepEqual(before, after) {
		t.Fatal("a failed join changed the room")
	}
}

// Run with -race. Many goroutines join the same room at once: exactly one
// takes seat 1, and only its token authenticates.
func TestConcurrentJoinRace(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	const rooms, joiners = 8, 24
	for r := 0; r < rooms; r++ {
		a := mustCreate(t, s, "Alice")
		var (
			start   = make(chan struct{})
			wg      sync.WaitGroup
			claims  = make([]Claim, joiners)
			errs    = make([]error, joiners)
			names   = make([]string, joiners)
			winners int
		)
		for i := 0; i < joiners; i++ {
			names[i] = "Blake" + string(rune('A'+i))
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				claims[i], errs[i] = s.Join(bg, a.Code, names[i])
			}(i)
		}
		close(start)
		wg.Wait()

		win := -1
		for i, err := range errs {
			switch {
			case err == nil:
				winners++
				win = i
			case errors.Is(err, ErrRoomFull):
			default:
				t.Fatalf("joiner %d: unexpected error %v", i, err)
			}
		}
		if winners != 1 {
			t.Fatalf("room %d: %d winners, want exactly 1", r, winners)
		}
		room := mustGet(t, s, a.Code)
		if room.Names[1] != names[win] || !room.Joined {
			t.Fatalf("stored joiner %q, winner %q", room.Names[1], names[win])
		}
		if seat, err := s.Authenticate(bg, a.Code, claims[win].Token); err != nil || seat != 1 {
			t.Fatalf("winner auth = %d, %v", seat, err)
		}
	}
}

// Run with -race. Concurrent saves from one version: exactly one lands.
func TestConcurrentSaveOneWinner(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	a, _ := dealt(t, s)
	const n = 16
	var (
		start = make(chan struct{})
		wg    sync.WaitGroup
		errs  = make([]error, n)
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = s.Save(bg, a.Code, Save{
				PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1,
				Snapshot: []byte{'{', '"', 'w', '"', ':', byte('a' + i), '}'},
				Status:   StatusActive, LastDealer: 1,
			})
		}(i)
	}
	close(start)
	wg.Wait()
	win := -1
	for i, err := range errs {
		switch {
		case err == nil:
			if win != -1 {
				t.Fatalf("two saves won: %d and %d", win, i)
			}
			win = i
		case errors.Is(err, ErrStale):
		default:
			t.Fatalf("save %d: %v", i, err)
		}
	}
	if win == -1 {
		t.Fatal("no save won")
	}
	room := mustGet(t, s, a.Code)
	if room.Seq != 1 || room.Snapshot[5] != byte('a'+win) {
		t.Fatalf("stored seq %d snapshot %s; winner was %d", room.Seq, room.Snapshot, win)
	}
}

func TestSaveStaleWritesNothing(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	a, _ := dealt(t, s)
	if err := s.Save(bg, a.Code, Save{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1,
		Snapshot: []byte(`{"s":1}`), Status: StatusActive, LastDealer: 1}); err != nil {
		t.Fatal(err)
	}
	before := mustGet(t, s, a.Code)
	clk.Advance(time.Hour) // a write would move UpdatedAt

	stale := []Save{
		{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1}, // replay of the last move
		{PrevGame: 1, PrevSeq: 2, Game: 1, Seq: 3}, // from the future
		{PrevGame: 0, PrevSeq: 1, Game: 1, Seq: 0}, // wrong game
		{PrevGame: 2, PrevSeq: 1, Game: 2, Seq: 2}, // wrong game
	}
	for i, sv := range stale {
		sv.Snapshot, sv.Status, sv.LastDealer, sv.Tally = []byte(`{"stale":true}`), StatusFinished, 0, [2]int{5, 5}
		if err := s.Save(bg, a.Code, sv); !errors.Is(err, ErrStale) {
			t.Fatalf("stale save %d = %v, want ErrStale", i, err)
		}
		if after := mustGet(t, s, a.Code); !reflect.DeepEqual(before, after) {
			t.Fatalf("stale save %d wrote:\nbefore %+v\n after %+v", i, before, after)
		}
	}
}

func TestSaveInvalidWritesNothing(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	a, _ := dealt(t, s)
	before := mustGet(t, s, a.Code)
	clk.Advance(time.Hour)
	good := Save{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1,
		Snapshot: []byte(`{}`), Status: StatusActive, LastDealer: 1}
	bad := map[string]func(*Save){
		"same version":   func(v *Save) { v.Seq = 0 },
		"older version":  func(v *Save) { v.Game = 0; v.Seq = 5 },
		"negative seq":   func(v *Save) { v.PrevSeq = -1 },
		"empty snapshot": func(v *Save) { v.Snapshot = nil },
		"waiting status": func(v *Save) { v.Status = StatusWaiting },
		"junk status":    func(v *Save) { v.Status = "paused" },
		"dealer 2":       func(v *Save) { v.LastDealer = 2 },
		"no dealer":      func(v *Save) { v.LastDealer = NoDealer },
		"negative tally": func(v *Save) { v.Tally[0] = -1 },
	}
	for name, mut := range bad {
		sv := good
		mut(&sv)
		if err := s.Save(bg, a.Code, sv); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	if after := mustGet(t, s, a.Code); !reflect.DeepEqual(before, after) {
		t.Fatal("an invalid save wrote")
	}
	if err := s.Save(bg, "ZZZZ", good); !errors.Is(err, ErrNotFound) {
		t.Fatalf("save unknown = %v, want ErrNotFound", err)
	}
}

func TestSaveBeforeJoin(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	a := mustCreate(t, s, "Alice")
	before := mustGet(t, s, a.Code)
	err := s.Save(bg, a.Code, Save{Game: 1, Snapshot: []byte(`{}`), Status: StatusActive, LastDealer: 0})
	if !errors.Is(err, ErrNotJoined) {
		t.Fatalf("save before join = %v, want ErrNotJoined", err)
	}
	if after := mustGet(t, s, a.Code); !reflect.DeepEqual(before, after) {
		t.Fatal("save before join wrote")
	}
}

func TestAuthenticate(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	a := mustCreate(t, s, "Alice")

	// Before anyone joins, an empty or unknown token must not match the empty seat.
	for _, tok := range []string{"", "x", a.Token + "x"} {
		if _, err := s.Authenticate(bg, a.Code, tok); !errors.Is(err, ErrUnauthorized) {
			t.Errorf("token %q before join = %v, want ErrUnauthorized", tok, err)
		}
	}

	b := mustJoin(t, s, a.Code, "Blake")
	other := mustCreate(t, s, "Alice")

	cases := []struct {
		code, token string
		seat        Seat
		err         error
	}{
		{a.Code, a.Token, 0, nil},
		{strings.ToLower(a.Code), a.Token, 0, nil},
		{a.Code, b.Token, 1, nil},
		{a.Code, "", 0, ErrUnauthorized},
		{a.Code, "not-a-token", 0, ErrUnauthorized},
		{a.Code, a.Token[:len(a.Token)-1], 0, ErrUnauthorized},
		{a.Code, other.Token, 0, ErrUnauthorized}, // another room's seat
		{other.Code, a.Token, 0, ErrUnauthorized},
		{"ZZZZ", a.Token, 0, ErrNotFound},
	}
	for i, c := range cases {
		seat, err := s.Authenticate(bg, c.code, c.token)
		if c.err != nil {
			if !errors.Is(err, c.err) {
				t.Errorf("case %d: err %v, want %v", i, err, c.err)
			}
			continue
		}
		if err != nil || seat != c.seat {
			t.Errorf("case %d: seat %d err %v, want seat %d", i, seat, err, c.seat)
		}
	}
}

// The raw token must not appear anywhere on disk; its hash must.
func TestRawTokensNeverStored(t *testing.T) {
	s, dir := openFile(t, nil, Options{})
	a, b := dealt(t, s)

	// Read while open (WAL may hold the rows) and again after Close.
	scan := func(when string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		var all []byte
		for _, e := range entries {
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			all = append(all, data...)
		}
		for _, tok := range []string{a.Token, b.Token} {
			raw, err := base64.RawURLEncoding.DecodeString(tok)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(all, []byte(tok)) {
				t.Fatalf("%s: raw token string found on disk", when)
			}
			if bytes.Contains(all, raw) {
				t.Fatalf("%s: raw token bytes found on disk", when)
			}
			h := HashToken(tok)
			if !bytes.Contains(all, h[:]) {
				t.Fatalf("%s: token hash not found on disk; the scan is looking in the wrong place", when)
			}
		}
	}
	scan("open")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	scan("closed")
}

func TestDBFileIsPrivate(t *testing.T) {
	s, dir := openFile(t, nil, Options{})
	mustCreate(t, s, "Alice") // a write, so the WAL and shm exist
	for _, suffix := range []string{"", "-wal", "-shm"} {
		st, err := os.Stat(filepath.Join(dir, FileName+suffix))
		if err != nil {
			t.Fatalf("stat %q: %v", FileName+suffix, err)
		}
		if perm := st.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s mode %v, want 0600", FileName+suffix, perm)
		}
	}
}

func TestOpenTightensLooseFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	// Leave a database plus sidecars behind, as a crashed process would.
	s, err := OpenDir(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	mustCreate(t, s, "Alice")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(path+suffix, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil { // WriteFile keeps an existing mode subject to umask
		t.Fatal(err)
	}
	s2, err := OpenDir(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s2.Close() })
	mustCreate(t, s2, "Blake")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		st, err := os.Stat(path + suffix)
		if err != nil {
			t.Fatalf("stat %q: %v", FileName+suffix, err)
		}
		if perm := st.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s mode %v after Open, want 0600", FileName+suffix, perm)
		}
	}
}

// expiryFixture returns a store with a 1h TTL and a joined, dealt room
// last touched at the returned time.
func expiryFixture(t *testing.T) (*SQLite, *fakeClock, Claim, Claim) {
	t.Helper()
	clk := newClock()
	s, _ := openFile(t, clk, Options{IdleTTL: time.Hour})
	a, b := dealt(t, s)
	return s, clk, a, b
}

func TestExpiredRoomIsGoneBeforeSweep(t *testing.T) {
	sv := Save{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1, Snapshot: []byte(`{}`), Status: StatusActive, LastDealer: 1}
	ops := map[string]func(s *SQLite, a, b Claim) error{
		"Get":          func(s *SQLite, a, b Claim) error { _, err := s.Get(bg, a.Code); return err },
		"Join":         func(s *SQLite, a, b Claim) error { _, err := s.Join(bg, a.Code, "Cy"); return err },
		"Authenticate": func(s *SQLite, a, b Claim) error { _, err := s.Authenticate(bg, a.Code, a.Token); return err },
		"Save":         func(s *SQLite, a, b Claim) error { return s.Save(bg, a.Code, sv) },
		"Touch":        func(s *SQLite, a, b Claim) error { return s.Touch(bg, a.Code) },
	}
	for name, op := range ops {
		t.Run(name+"/boundary", func(t *testing.T) {
			s, clk, a, b := expiryFixture(t)
			clk.Advance(time.Hour) // idle exactly the TTL: still alive
			err := op(s, a, b)
			if errors.Is(err, ErrNotFound) {
				t.Fatalf("%s at exactly the TTL = ErrNotFound; the boundary is kept", name)
			}
		})
		t.Run(name+"/expired", func(t *testing.T) {
			s, clk, a, b := expiryFixture(t)
			clk.Advance(time.Hour + time.Millisecond)
			if err := op(s, a, b); !errors.Is(err, ErrNotFound) {
				t.Fatalf("%s 1ms past the TTL = %v, want ErrNotFound", name, err)
			}
			// Nothing was written to the expired row.
			if n, err := s.Count(bg); err != nil || n != 1 {
				t.Fatalf("Count = %d, %v; want the unswept row still stored", n, err)
			}
			var seq int
			if err := s.w.QueryRow(`SELECT seq FROM rooms WHERE code = ?`, a.Code).Scan(&seq); err != nil || seq != 0 {
				t.Fatalf("expired row seq = %d, %v; want untouched 0", seq, err)
			}
		})
	}
}

func TestExpiredWaitingRoomCannotBeJoined(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{IdleTTL: time.Hour})
	a := mustCreate(t, s, "Alice")
	clk.Advance(time.Hour + time.Millisecond)
	if _, err := s.Join(bg, a.Code, "Blake"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("join of an expired room = %v, want ErrNotFound", err)
	}
}

func TestTouch(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	a, _ := dealt(t, s)
	before := mustGet(t, s, a.Code)
	clk.Advance(3 * time.Hour)
	if err := s.Touch(bg, strings.ToLower(a.Code)); err != nil {
		t.Fatal(err)
	}
	after := mustGet(t, s, a.Code)
	want := before
	want.UpdatedAt = clk.Now()
	if !reflect.DeepEqual(after, want) {
		t.Fatalf("touch:\n got %+v\nwant %+v", after, want)
	}
	if err := s.Touch(bg, "ZZZZ"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("touch unknown = %v, want ErrNotFound", err)
	}
}

func TestDeleteExpiredOnlyIdle(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	t0 := clk.Now()

	idle := mustCreate(t, s, "Alice")    // untouched since t0
	idleJoined, _ := dealt(t, s)         // joined and dealt at t0, then idle
	idle2 := mustCreate(t, s, "Alice")   // untouched since t0
	touched := mustCreate(t, s, "Alice") // touched at t0+23h
	clk.Advance(time.Millisecond)        //
	late := mustCreate(t, s, "Alice")    // created at t0+1ms: idle exactly TTL at the second sweep
	playing, _ := dealt(t, s)            // a move at t0+20h

	clk.Advance(20 * time.Hour)
	if err := s.Save(bg, playing.Code, Save{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1,
		Snapshot: []byte(`{}`), Status: StatusActive, LastDealer: 1}); err != nil {
		t.Fatal(err)
	}
	clk.Advance(3 * time.Hour)
	if err := s.Touch(bg, touched.Code); err != nil {
		t.Fatal(err)
	}

	// Sweep at exactly t0+TTL: nothing is idle for LONGER than the TTL yet.
	clk.Set(t0.Add(DefaultIdleTTL))
	if n, err := s.DeleteExpired(bg); err != nil || n != 0 {
		t.Fatalf("sweep at the boundary deleted %d, %v; want 0", n, err)
	}

	// One millisecond later the three t0 rooms are over the TTL.
	clk.Advance(time.Millisecond)
	n, err := s.DeleteExpired(bg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("deleted %d rooms, want 3", n)
	}
	for _, c := range []Claim{idle, idleJoined, idle2} {
		if _, err := s.Get(bg, c.Code); !errors.Is(err, ErrNotFound) {
			t.Errorf("idle room %s survived: %v", c.Code, err)
		}
		if _, err := s.Authenticate(bg, c.Code, c.Token); !errors.Is(err, ErrNotFound) {
			t.Errorf("idle room %s still authenticates: %v", c.Code, err)
		}
	}
	for _, c := range []Claim{touched, late, playing} {
		if _, err := s.Get(bg, c.Code); err != nil {
			t.Errorf("active room %s deleted: %v", c.Code, err)
		}
	}
	if n, err := s.DeleteExpired(bg); err != nil || n != 0 {
		t.Fatalf("second sweep deleted %d, %v; want 0", n, err)
	}
	if n, err := s.Count(bg); err != nil || n != 3 {
		t.Fatalf("Count = %d, %v; want 3", n, err)
	}
}

func TestDeleteExpiredCustomTTL(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{IdleTTL: time.Hour})
	old := mustCreate(t, s, "Alice")
	clk.Advance(30 * time.Minute)
	fresh := mustCreate(t, s, "Alice")
	clk.Advance(31 * time.Minute)
	if n, err := s.DeleteExpired(bg); err != nil || n != 1 {
		t.Fatalf("deleted %d, %v; want 1", n, err)
	}
	if _, err := s.Get(bg, old.Code); !errors.Is(err, ErrNotFound) {
		t.Fatal("old room survived a 1h TTL")
	}
	if _, err := s.Get(bg, fresh.Code); err != nil {
		t.Fatal("fresh room deleted")
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	s, err := OpenDir(dir, Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	a, b := dealt(t, s)
	before := mustGet(t, s, a.Code)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := OpenDir(dir, Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if after := mustGet(t, s2, a.Code); !reflect.DeepEqual(before, after) {
		t.Fatalf("after reopen:\nbefore %+v\n after %+v", before, after)
	}
	for seat, tok := range []string{a.Token, b.Token} {
		if got, err := s2.Authenticate(bg, a.Code, tok); err != nil || int(got) != seat {
			t.Fatalf("seat %d auth after reopen = %d, %v", seat, got, err)
		}
	}
	if err := s2.Save(bg, a.Code, Save{PrevGame: 1, PrevSeq: 0, Game: 1, Seq: 1,
		Snapshot: []byte(`{}`), Status: StatusActive, LastDealer: 1}); err != nil {
		t.Fatalf("save after reopen: %v", err)
	}
}

func TestMigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	var code string
	var objects []string
	for i := 0; i < 3; i++ {
		s, err := OpenDir(dir, Options{})
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		var v int
		if err := s.r.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		if v != schemaVersion {
			t.Fatalf("open %d: user_version %d, want %d", i, v, schemaVersion)
		}
		got := schemaObjects(t, s)
		if i == 0 {
			objects = got
			code = mustCreate(t, s, "Alice").Code
		} else {
			if !reflect.DeepEqual(got, objects) {
				t.Fatalf("open %d: schema changed:\n%v\n%v", i, objects, got)
			}
			mustGet(t, s, code)
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func schemaObjects(t *testing.T, s *SQLite) []string {
	t.Helper()
	rows, err := s.r.Query(`SELECT type || ' ' || name FROM sqlite_schema ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var x string
		if err := rows.Scan(&x); err != nil {
			t.Fatal(err)
		}
		out = append(out, x)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOpenRefusesNewerSchema(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenDir(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.w.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if s2, err := OpenDir(dir, Options{}); err == nil {
		s2.Close()
		t.Fatal("opened a database from a newer schema")
	}
}

func TestPragmas(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	check := func(pool string, q string, want string) {
		t.Helper()
		db := s.w
		if pool == "reader" {
			db = s.r
		}
		var got string
		if err := db.QueryRow(q).Scan(&got); err != nil {
			t.Fatalf("%s %s: %v", pool, q, err)
		}
		if got != want {
			t.Errorf("%s %s = %q, want %q", pool, q, got, want)
		}
	}
	for _, pool := range []string{"writer", "reader"} {
		check(pool, `PRAGMA journal_mode`, "wal")
		check(pool, `PRAGMA foreign_keys`, "1")
		check(pool, `PRAGMA busy_timeout`, "5000")
	}
	check("writer", `PRAGMA secure_delete`, "1")
	check("reader", `PRAGMA query_only`, "1")
	check("writer", `PRAGMA query_only`, "0")
	if max := s.w.Stats().MaxOpenConnections; max != 1 {
		t.Errorf("writer pool allows %d connections, want 1", max)
	}
}

func TestCreateRetriesOnCollision(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	tok := func(b byte) []byte { return bytes.Repeat([]byte{b}, TokenBytes) }
	code := func(b byte) []byte { return bytes.Repeat([]byte{b}, CodeLen) }
	var script []byte
	script = append(script, tok(1)...)
	script = append(script, code(10)...) // "AAAA"
	script = append(script, tok(2)...)
	script = append(script, code(10)...) // collides
	script = append(script, code(11)...) // "BBBB"
	s.rand = bytes.NewReader(script)

	if c := mustCreate(t, s, "Alice"); c.Code != "AAAA" {
		t.Fatalf("first code %q, want AAAA", c.Code)
	}
	if c := mustCreate(t, s, "Alice"); c.Code != "BBBB" {
		t.Fatalf("second code %q, want BBBB after a collision", c.Code)
	}

	// Every draw collides: give up with ErrCodeSpace, nothing written.
	s.maxDraw = 3
	script = append(tok(3), bytes.Repeat(code(10), 3)...)
	s.rand = bytes.NewReader(script)
	if _, err := s.Create(bg, "Alice"); !errors.Is(err, ErrCodeSpace) {
		t.Fatalf("exhausted draws = %v, want ErrCodeSpace", err)
	}
	if n, _ := s.Count(bg); n != 2 {
		t.Fatalf("Count = %d after failed create, want 2", n)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	s, _ := openFile(t, nil, Options{})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}
