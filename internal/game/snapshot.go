package game

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"

	"github.com/ApisMellow/cuttle/engine"
)

// ServerSnapshot is the full, unredacted game: the engine state with both
// hands and the deck order, the unredacted history, the seed and the
// dealer. It is the snapshotWire JSON, byte for byte what Bridge.Snapshot
// returns, and exists for one purpose: persisting a Session on the server
// (docs/two-phone-plan.md §4, the rooms.snapshot column) and reloading it
// with RestoreSession.
//
// NEVER SEND IT TO A CLIENT. Anyone holding it knows every hidden card and
// the whole draw order. Per-seat Envelopes (Session.View, Update.For) are
// the only client-safe output. To make an accident loud rather than
// silent, a ServerSnapshot refuses encoding/json and encoding.TextMarshaler
// (ErrSnapshotNotForClients), prints as a fixed redacted string under every
// fmt verb and in slog, and is not ClientSafe. The bytes come out only
// through PersistBytes, whose name says where they may go.
type ServerSnapshot struct {
	blob []byte
}

// ErrSnapshotNotForClients is returned by any attempt to JSON- or
// text-encode a ServerSnapshot.
var ErrSnapshotNotForClients = errors.New("game: ServerSnapshot is server-only; persist it with PersistBytes, never send it to a client")

const redactedSnapshot = "game.ServerSnapshot(redacted)"

// PersistBytes returns a copy of the snapshot bytes, for the server's
// store only. Hand them back to RestoreSession; never write them to a
// socket, an HTTP response or a log.
func (s ServerSnapshot) PersistBytes() []byte {
	if s.blob == nil {
		return nil
	}
	return append([]byte(nil), s.blob...)
}

// MarshalJSON always fails: a snapshot must never be serialized as, or
// inside, a client message.
func (ServerSnapshot) MarshalJSON() ([]byte, error) { return nil, ErrSnapshotNotForClients }

// MarshalText always fails, for the same reason.
func (ServerSnapshot) MarshalText() ([]byte, error) { return nil, ErrSnapshotNotForClients }

func (ServerSnapshot) String() string   { return redactedSnapshot }
func (ServerSnapshot) GoString() string { return redactedSnapshot }

// Format prints the redacted marker for every verb, so %x or %+v can't
// dump the blob either.
func (ServerSnapshot) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, redactedSnapshot) }

// LogValue keeps the blob out of slog output.
func (ServerSnapshot) LogValue() slog.Value { return slog.StringValue(redactedSnapshot) }

// 2 since AppliedMove gained `drawn` (SPEC §2.7, §5.7, amended 2026-09-28).
const snapshotVersion = 2

// snapshotWire is the full, unredacted SnapshotJson (§2.4, §3.4). `state` is
// the raw engine.GameState in encoding/json form; it is opaque to TypeScript
// (§5.7) and exists only to be handed back to Restore verbatim.
type snapshotWire struct {
	OK      bool             `json:"ok"`
	V       int              `json:"v"`
	State   engine.GameState `json:"state"`
	History []AppliedMove    `json:"history"`
	Seed    string           `json:"seed"`
	Dealer  engine.PlayerID  `json:"dealer"`
}

// restoreWire mirrors snapshotWire with pointers so missing fields are
// detectable.
type restoreWire struct {
	OK      *bool             `json:"ok"`
	V       *int              `json:"v"`
	State   *engine.GameState `json:"state"`
	History []AppliedMove     `json:"history"`
	Seed    *string           `json:"seed"`
	Dealer  *int              `json:"dealer"`
}

// wire is the snapshot form of a held game.
func (g *session) wire() snapshotWire {
	return snapshotWire{
		OK:      true,
		V:       snapshotVersion,
		State:   g.state,
		History: append([]AppliedMove{}, g.history...),
		Seed:    strconv.FormatUint(g.seed, 10),
		Dealer:  g.dealer,
	}
}

// decodeSnapshot is the one restore path, shared by Bridge.Restore (which
// reports failures as BAD_REQUEST with these exact messages) and
// RestoreSession (ErrInvalidSnapshot). It upgrades a v1 save, decodes
// strictly and validates shape; it checks structure, never game rules.
func decodeSnapshot(raw string) (*session, *Error) {
	invalid := func(msg string) (*session, *Error) { return nil, newError(ErrInvalidSnapshot, msg, nil) }
	// SPEC §5.7 (ruling 2026-09-28): a v1 save is upgraded, not discarded.
	raw, err := migrateSnapshotV1(raw)
	if err != nil {
		return invalid("malformed v1 snapshot: " + err.Error())
	}
	var snap restoreWire
	if err := decodeStrict(raw, &snap); err != nil {
		return invalid("malformed snapshot: " + err.Error())
	}
	if snap.V == nil || *snap.V != snapshotVersion {
		return invalid(fmt.Sprintf("snapshot version must be 1 or %d", snapshotVersion))
	}
	if snap.State == nil || snap.History == nil || snap.Seed == nil || snap.Dealer == nil {
		return invalid("snapshot requires state, history, seed and dealer")
	}
	seed, err := strconv.ParseUint(*snap.Seed, 10, 64)
	if err != nil {
		return invalid(fmt.Sprintf("snapshot seed %q is not a decimal uint64", *snap.Seed))
	}
	if *snap.Dealer != 0 && *snap.Dealer != 1 {
		return invalid("snapshot dealer must be 0 or 1")
	}
	if err := validateState(*snap.State); err != nil {
		return invalid("invalid snapshot state: " + err.Error())
	}
	if err := validateHistory(snap.History); err != nil {
		return invalid("invalid snapshot history: " + err.Error())
	}
	return &session{state: *snap.State, history: snap.History, seed: seed, dealer: engine.PlayerID(*snap.Dealer)}, nil
}
