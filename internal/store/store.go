// Package store persists online rooms (two-phone plan §4, §5): room codes,
// seat names, seat-token hashes, the opaque engine snapshot, seq, status,
// the rematch tally and the last dealer.
//
// The store never holds a raw seat token. A token is generated here, handed
// back exactly once (from Create or Join), and only its SHA-256 is written.
// The engine snapshot is an opaque blob: the store never parses it, and it
// must never leave the server.
package store

import (
	"context"
	"errors"
	"time"
)

// Errors returned by Store methods. Callers match them with errors.Is.
var (
	// ErrNotFound: no room has that code (never created, expired or deleted).
	ErrNotFound = errors.New("store: room not found")
	// ErrRoomFull: Join on a room whose second seat is already taken.
	ErrRoomFull = errors.New("store: room full")
	// ErrUnauthorized: the token matches neither seat of the room.
	ErrUnauthorized = errors.New("store: unauthorized")
	// ErrStale: Save's expected (game, seq) no longer matches the stored row.
	// Nothing was written.
	ErrStale = errors.New("store: stale seq")
	// ErrNotJoined: Save on a room whose second seat is still empty.
	ErrNotJoined = errors.New("store: room not joined")
	// ErrInvalid: the arguments break a store invariant (bad code, empty
	// snapshot, non-increasing version, bad status or dealer).
	ErrInvalid = errors.New("store: invalid argument")
	// ErrCodeSpace: Create could not find a free code after many draws.
	ErrCodeSpace = errors.New("store: no free room code")
)

// Seat is 0 (the creator) or 1 (the joiner).
type Seat int

// Status is a room's lifecycle state.
type Status string

const (
	// StatusWaiting: created, seat 1 empty.
	StatusWaiting Status = "waiting"
	// StatusActive: both seats taken, a game is (or is about to be) in play.
	StatusActive Status = "active"
	// StatusFinished: the current game is over; a rematch moves it back to active.
	StatusFinished Status = "finished"
)

// NoDealer is Room.LastDealer before the first deal.
const NoDealer = -1

// DefaultIdleTTL is how long a room may go without activity before
// DeleteExpired removes it (PRD §10 A-7: one day).
const DefaultIdleTTL = 24 * time.Hour

// Room is one stored room. It carries no token material.
type Room struct {
	Code      string
	CreatedAt time.Time
	UpdatedAt time.Time // last create, join, save or touch
	Status    Status
	Names     [2]string // Names[1] is "" until someone joins
	Joined    bool      // seat 1 is taken
	Game      int       // games dealt in this room: 0 before the first deal
	Seq       int       // history length of the current game
	Tally     [2]int    // games won per seat
	// LastDealer is the seat that dealt the current game, or NoDealer.
	LastDealer int
	// Snapshot is the engine snapshot JSON, nil before the first deal.
	Snapshot []byte
}

// NextDealer is the seat that deals the next game (the other dealer, R1/R3).
// Before the first deal it is NoDealer: the caller picks one at random.
func (r Room) NextDealer() int {
	if r.LastDealer == NoDealer {
		return NoDealer
	}
	return 1 - r.LastDealer
}

// Claim is what Create and Join return: the only time the raw token exists
// outside the client.
type Claim struct {
	Code  string
	Seat  Seat
	Token string // raw seat token, base64url; never stored
}

// Save is a snapshot write guarded by an optimistic version check. The
// version is the pair (Game, Seq): a move advances Seq, a deal or rematch
// advances Game and restarts Seq.
type Save struct {
	PrevGame, PrevSeq int // must equal the stored values, else ErrStale
	Game, Seq         int // new values; (Game, Seq) must exceed (PrevGame, PrevSeq)
	Snapshot          []byte
	Status            Status // StatusActive or StatusFinished
	Tally             [2]int
	LastDealer        int // 0 or 1
}

// Store is the room persistence layer. Implementations are safe for
// concurrent use by many goroutines.
type Store interface {
	// Create makes a room with a fresh code; the creator holds seat 0.
	Create(ctx context.Context, name string) (Claim, error)
	// Join atomically claims seat 1. Of any number of concurrent joins on one
	// room exactly one succeeds; the rest get ErrRoomFull.
	Join(ctx context.Context, code, name string) (Claim, error)
	// Get loads a room. Codes are case-insensitive.
	Get(ctx context.Context, code string) (Room, error)
	// Authenticate returns the seat whose token matches, or ErrUnauthorized.
	// ErrNotFound means the room itself is gone.
	Authenticate(ctx context.Context, code, token string) (Seat, error)
	// Save writes a new snapshot if the stored (game, seq) equals
	// (PrevGame, PrevSeq); otherwise ErrStale and nothing is written.
	Save(ctx context.Context, code string, s Save) error
	// Touch stamps activity without changing anything else.
	Touch(ctx context.Context, code string) error
	// DeleteExpired removes rooms idle for longer than the idle TTL and
	// returns how many it removed.
	DeleteExpired(ctx context.Context) (int, error)
	// Count returns the number of stored rooms.
	Count(ctx context.Context) (int, error)
	// Close releases the database.
	Close() error
}
