package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/store"
)

var bg = context.Background()

// fakeClock is a settable clock shared by the store, the room manager and
// the rate limiters in a test.
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

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// flakyStore wraps a real store and fails Save while failSaves > 0.
type flakyStore struct {
	store.Store
	failSaves atomic.Int32
	saves     atomic.Int32
}

var errInjected = errors.New("injected save failure")

func (f *flakyStore) Save(ctx context.Context, code string, s store.Save) error {
	f.saves.Add(1)
	if f.failSaves.Load() > 0 {
		f.failSaves.Add(-1)
		return errInjected
	}
	return f.Store.Save(ctx, code, s)
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type env struct {
	clk   *fakeClock
	st    *store.SQLite
	fs    *flakyStore
	rooms *Rooms
	logs  *syncBuffer
	log   *slog.Logger
}

// newEnv opens an in-memory store behind a flakyStore and a room manager
// on a fake clock.
func newEnv(t *testing.T, opt RoomsOptions) *env {
	t.Helper()
	clk := newClock()
	st, err := store.OpenMemory(store.Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	logs := &syncBuffer{}
	log := slog.New(slog.NewJSONHandler(logs, nil))
	fs := &flakyStore{Store: st}
	if opt.Now == nil {
		opt.Now = clk.Now
	}
	if opt.Log == nil {
		opt.Log = log
	}
	return &env{clk: clk, st: st, fs: fs, rooms: NewRooms(fs, opt), logs: logs, log: log}
}

// cached reports whether code is in the manager's memory.
func (e *env) cached(code string) bool {
	e.rooms.mu.Lock()
	defer e.rooms.mu.Unlock()
	_, ok := e.rooms.rooms[code]
	return ok
}

func (e *env) createJoin(t *testing.T) (store.Claim, store.Claim) {
	t.Helper()
	c0, err := e.rooms.Create(bg, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	c1, err := e.rooms.Join(bg, c0.Code, "Blake")
	if err != nil {
		t.Fatal(err)
	}
	return c0, c1
}

func jsonString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
