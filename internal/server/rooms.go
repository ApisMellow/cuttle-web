package server

// The room manager (two-phone W5, docs/two-phone-plan.md §4, §5): an
// in-memory registry of live rooms over the store. Each room has its own
// mutex; every game.Session call for a room, and the store write that
// persists it, happen under that mutex, so memory never runs ahead of disk.

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/store"
)

// Room manager errors. Handlers map them to wire codes (api.go).
var (
	// ErrRoomGone: unknown, malformed or expired code (ROOM_GONE).
	ErrRoomGone = errors.New("room gone")
	// ErrRoomFull: seat 1 already taken (ROOM_FULL).
	ErrRoomFull = errors.New("room full")
	// ErrServerFull: the live-room cap is reached (SERVER_FULL).
	ErrServerFull = errors.New("server full")
	// ErrNotStarted: the room is still waiting for its second player.
	ErrNotStarted = errors.New("game not started")
	// ErrResync: a persist lost an optimistic version race; the room was
	// reloaded from the store and the caller should resend state (STALE).
	ErrResync = errors.New("room changed; resync")
)

const (
	// DefaultMaxRooms is the live-room cap (plan §9).
	DefaultMaxRooms = 500
	// DefaultMemIdle is how long a loaded room stays in memory unused. It
	// reloads from the store on the next access.
	DefaultMemIdle = time.Hour
	// JanitorInterval is how often RunJanitor sweeps (plan §5).
	JanitorInterval = 10 * time.Minute
)

// RoomsOptions configures a Rooms. The zero value is valid.
type RoomsOptions struct {
	MaxRooms int              // 0 means DefaultMaxRooms
	MemIdle  time.Duration    // 0 means DefaultMemIdle
	Now      func() time.Time // nil means time.Now
	Rand     io.Reader        // seeds and dealers; nil means crypto/rand
	Log      *slog.Logger     // nil discards
}

// Rooms is the room manager. Safe for concurrent use.
type Rooms struct {
	st      store.Store
	max     int
	memIdle time.Duration
	now     func() time.Time
	rand    io.Reader
	log     *slog.Logger

	// createMu makes the room-cap check and the insert one step.
	createMu sync.Mutex

	// mu guards the map only. Lock order: a room's mu may be held while
	// taking Rooms.mu (drop), never the reverse.
	mu    sync.Mutex
	rooms map[string]*room
}

// room is one cached room. Every field is guarded by mu.
type room struct {
	mu   sync.Mutex
	code string
	// gone: removed from the map; a caller that raced the removal retries
	// the lookup.
	gone bool
	// loaded: meta (and sess, once dealt) reflect the store.
	loaded bool
	// meta is the stored row minus the snapshot, which lives in sess.
	meta     store.Room
	sess     *game.Session // nil while waiting for the second player
	lastUsed time.Time
}

// NewRooms builds a manager over st.
func NewRooms(st store.Store, opt RoomsOptions) *Rooms {
	m := &Rooms{st: st, max: opt.MaxRooms, memIdle: opt.MemIdle, now: opt.Now, rand: opt.Rand, log: opt.Log,
		rooms: map[string]*room{}}
	if m.max <= 0 {
		m.max = DefaultMaxRooms
	}
	if m.memIdle <= 0 {
		m.memIdle = DefaultMemIdle
	}
	if m.now == nil {
		m.now = time.Now
	}
	if m.rand == nil {
		m.rand = rand.Reader
	}
	if m.log == nil {
		m.log = slog.New(slog.DiscardHandler)
	}
	return m
}

// Create makes a waiting room; the caller holds seat 0. The cap counts
// stored rooms; when it is reached, expired rooms are swept first so a
// stale backlog can't lock creation out until the janitor runs.
func (m *Rooms) Create(ctx context.Context, name string) (store.Claim, error) {
	m.createMu.Lock()
	defer m.createMu.Unlock()
	n, err := m.st.Count(ctx)
	if err != nil {
		return store.Claim{}, err
	}
	if n >= m.max {
		if _, err := m.st.DeleteExpired(ctx); err != nil {
			return store.Claim{}, err
		}
		if n, err = m.st.Count(ctx); err != nil {
			return store.Claim{}, err
		}
		if n >= m.max {
			m.log.Warn("room cap reached", "rooms", n)
			return store.Claim{}, ErrServerFull
		}
	}
	c, err := m.st.Create(ctx, name)
	if err != nil {
		return store.Claim{}, err
	}
	m.log.Info("room created", "code", c.Code)
	return c, nil
}

// Join claims seat 1 and deals game 1 under the room lock. If the deal
// can't be saved the seat is still claimed in the store, so the claim is
// returned anyway (the token exists only here); the room is left unloaded
// and the next access deals it (loadLocked).
func (m *Rooms) Join(ctx context.Context, rawCode, name string) (store.Claim, error) {
	var claim store.Claim
	err := m.withRoom(ctx, rawCode, func(r *room) error {
		c, err := m.st.Join(ctx, r.code, name)
		switch {
		case errors.Is(err, store.ErrNotFound):
			m.dropLocked(r)
			return ErrRoomGone
		case errors.Is(err, store.ErrRoomFull):
			return ErrRoomFull
		case err != nil:
			return err
		}
		claim = c
		m.log.Info("room joined", "code", r.code)
		r.meta.Names[1] = name
		r.meta.Joined = true
		r.meta.Status = store.StatusActive
		if err := m.dealLocked(ctx, r); err != nil {
			m.log.Error("deal after join failed; will deal on next load", "code", r.code, "err", err)
			r.loaded = false
		}
		return nil
	})
	return claim, err
}

// View returns seat's redacted envelope.
func (m *Rooms) View(ctx context.Context, code string, seat game.Seat) (game.Envelope, error) {
	var env game.Envelope
	err := m.withRoom(ctx, code, func(r *room) error {
		if r.sess == nil {
			return ErrNotStarted
		}
		var err error
		env, err = r.sess.View(seat)
		return err
	})
	return env, err
}

// Move applies legal move index for seat at seq and persists the result in
// the same critical section. Session errors (game.ErrStale,
// game.ErrNotYourTurn, ...) come back unchanged and save nothing. If the
// save fails the room is reloaded from the store, so memory never runs
// ahead of disk, and the Update is discarded: ErrRoomGone if the room
// vanished, ErrResync if its version moved, else the store error.
func (m *Rooms) Move(ctx context.Context, code string, seat game.Seat, seq, index int) (game.Update, error) {
	var up game.Update
	err := m.withRoom(ctx, code, func(r *room) error {
		if r.sess == nil {
			return ErrNotStarted
		}
		u, err := r.sess.Apply(seat, seq, index)
		if err != nil {
			return err
		}
		st, err := r.sess.Status()
		if err != nil {
			// The move is applied in memory but can't be described for
			// the save: put memory back to what the store holds.
			m.log.Error("status after move failed; reloading", "code", r.code)
			return m.reloadLocked(ctx, r, err)
		}
		sv := store.Save{
			PrevGame: r.meta.Game, PrevSeq: r.meta.Seq,
			Game: r.meta.Game, Seq: st.Seq,
			Status:     store.StatusActive,
			Tally:      r.meta.Tally,
			LastDealer: r.meta.LastDealer,
		}
		if st.Over {
			sv.Status = store.StatusFinished
			if st.Winner.Valid() {
				sv.Tally[st.Winner]++
			}
		}
		if err := m.persistLocked(ctx, r, sv); err != nil {
			m.log.Error("move not persisted; reloading", "code", r.code, "err", err)
			return m.reloadLocked(ctx, r, err)
		}
		up = u
		return nil
	})
	return up, err
}

// persistLocked snapshots r.sess and saves it as sv, then updates meta.
func (m *Rooms) persistLocked(ctx context.Context, r *room, sv store.Save) error {
	snap, err := r.sess.Snapshot()
	if err != nil {
		return err
	}
	sv.Snapshot = snap.PersistBytes()
	if err := m.st.Save(ctx, r.code, sv); err != nil {
		return err
	}
	r.meta.Game, r.meta.Seq = sv.Game, sv.Seq
	r.meta.Status, r.meta.Tally, r.meta.LastDealer = sv.Status, sv.Tally, sv.LastDealer
	return nil
}

// reloadLocked replaces r's memory with the store's copy after a failed
// save and returns the error the caller should see.
func (m *Rooms) reloadLocked(ctx context.Context, r *room, saveErr error) error {
	r.loaded, r.sess = false, nil
	if err := m.loadLocked(ctx, r); err != nil {
		m.dropLocked(r)
		if errors.Is(err, ErrRoomGone) {
			return ErrRoomGone
		}
		return err
	}
	switch {
	case errors.Is(saveErr, store.ErrNotFound):
		return ErrRoomGone
	case errors.Is(saveErr, store.ErrStale), errors.Is(saveErr, store.ErrNotJoined):
		return ErrResync
	}
	return saveErr
}

// dealLocked deals the room's next game with a crypto/rand seed. The
// first dealer is random; later games alternate (R1, R3). On error r.sess
// and meta are unchanged.
func (m *Rooms) dealLocked(ctx context.Context, r *room) error {
	var b [9]byte
	if _, err := io.ReadFull(m.rand, b[:]); err != nil {
		return fmt.Errorf("drawing a seed: %w", err)
	}
	seed := binary.LittleEndian.Uint64(b[:8])
	dealer := r.meta.NextDealer()
	if dealer == store.NoDealer {
		dealer = int(b[8] & 1)
	}
	sess, err := game.NewSession(seed, game.Seat(dealer))
	if err != nil {
		return err
	}
	prev := r.sess
	r.sess = sess
	err = m.persistLocked(ctx, r, store.Save{
		PrevGame: r.meta.Game, PrevSeq: r.meta.Seq,
		Game: r.meta.Game + 1, Seq: 0,
		Status: store.StatusActive, Tally: r.meta.Tally, LastDealer: dealer,
	})
	if err != nil {
		r.sess = prev
		return err
	}
	m.log.Info("game dealt", "code", r.code, "game", r.meta.Game)
	return nil
}

// loadLocked reads r from the store. A joined room with no snapshot (the
// process died between join and deal) is dealt now.
func (m *Rooms) loadLocked(ctx context.Context, r *room) error {
	row, err := m.st.Get(ctx, r.code)
	if errors.Is(err, store.ErrNotFound) {
		return ErrRoomGone
	}
	if err != nil {
		return err
	}
	snapshot := row.Snapshot
	row.Snapshot = nil
	r.meta, r.sess = row, nil
	switch {
	case snapshot != nil:
		sess, err := game.RestoreSession(snapshot)
		if err != nil {
			return fmt.Errorf("room %s: %w", r.code, err)
		}
		r.sess = sess
	case row.Joined:
		m.log.Warn("joined room has no game; dealing", "code", r.code)
		if err := m.dealLocked(ctx, r); err != nil {
			return err
		}
	}
	r.loaded = true
	return nil
}

// withRoom runs fn with r locked and loaded. A code that doesn't
// normalize, or a room the store doesn't have, is ErrRoomGone and leaves
// nothing in memory.
func (m *Rooms) withRoom(ctx context.Context, rawCode string, fn func(*room) error) error {
	code, err := store.NormalizeCode(rawCode)
	if err != nil {
		return ErrRoomGone
	}
	for {
		m.mu.Lock()
		r := m.rooms[code]
		if r == nil {
			r = &room{code: code}
			m.rooms[code] = r
		}
		m.mu.Unlock()

		r.mu.Lock()
		if r.gone {
			r.mu.Unlock()
			continue
		}
		if !r.loaded {
			if err := m.loadLocked(ctx, r); err != nil {
				// Keep nothing half-loaded; the next call starts fresh.
				m.dropLocked(r)
				r.mu.Unlock()
				return err
			}
		}
		r.lastUsed = m.now()
		err := fn(r)
		r.mu.Unlock()
		return err
	}
}

// dropLocked removes r from the map. r.mu must be held.
func (m *Rooms) dropLocked(r *room) {
	r.gone, r.loaded, r.sess = true, false, nil
	m.mu.Lock()
	if m.rooms[r.code] == r {
		delete(m.rooms, r.code)
	}
	m.mu.Unlock()
}

// Count is the number of stored rooms; it doubles as the health check's
// database query.
func (m *Rooms) Count(ctx context.Context) (int, error) { return m.st.Count(ctx) }

// Sweep deletes expired rooms from the store, then drops from memory every
// cached room that is gone from the store or unused for MemIdle. It
// returns how many rows were deleted and how many rooms were dropped.
func (m *Rooms) Sweep(ctx context.Context) (deleted, dropped int, err error) {
	deleted, err = m.st.DeleteExpired(ctx)
	if err != nil {
		return 0, 0, err
	}
	m.mu.Lock()
	cached := make([]*room, 0, len(m.rooms))
	for _, r := range m.rooms {
		cached = append(cached, r)
	}
	m.mu.Unlock()

	now := m.now()
	for _, r := range cached {
		if ctx.Err() != nil {
			return deleted, dropped, ctx.Err()
		}
		r.mu.Lock()
		if !r.gone {
			drop := now.Sub(r.lastUsed) > m.memIdle
			if !drop {
				_, gerr := m.st.Get(ctx, r.code)
				drop = errors.Is(gerr, store.ErrNotFound)
			}
			if drop {
				m.dropLocked(r)
				dropped++
			}
		}
		r.mu.Unlock()
	}
	return deleted, dropped, nil
}

// RunJanitor sweeps every interval until ctx is done. The nightly backup
// is a separate loop (RunBackups), so a slow copy never delays a sweep.
func (m *Rooms) RunJanitor(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			deleted, dropped, err := m.Sweep(ctx)
			if err != nil && ctx.Err() == nil {
				m.log.Error("janitor sweep failed", "err", err)
				continue
			}
			if deleted > 0 || dropped > 0 {
				m.log.Info("janitor sweep", "deleted", deleted, "dropped", dropped)
			}
		}
	}
}
