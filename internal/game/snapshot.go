package game

import (
	"encoding/json"
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
// silent, a ServerSnapshot refuses encoding/json, encoding.TextMarshaler,
// encoding.BinaryMarshaler and so gob (ErrSnapshotNotForClients), prints as a
// fixed redacted string under every fmt verb and in slog, and is not
// ClientSafe. The bytes come out only through PersistBytes, whose name
// says where they may go.
//
// The bytes live inside a closure, not in a field. fmt and slog skip
// Format/String/LogValue on a value reached through an unexported field
// and print it by reflection instead; reflection can walk slices, arrays,
// maps and pointers, but it cannot see what a func captured. Nested at any
// depth, a ServerSnapshot prints as a func address.
type ServerSnapshot struct {
	blob func() []byte
}

// ErrSnapshotNotForClients is returned by any attempt to encode a
// ServerSnapshot.
var ErrSnapshotNotForClients = errors.New("game: ServerSnapshot is server-only; persist it with PersistBytes, never send it to a client")

const redactedSnapshot = "game.ServerSnapshot(redacted)"

// newServerSnapshot takes ownership of b.
func newServerSnapshot(b []byte) ServerSnapshot {
	return ServerSnapshot{blob: func() []byte { return append([]byte(nil), b...) }}
}

// PersistBytes returns a copy of the snapshot bytes, for the server's
// store only. Hand them back to RestoreSession; never write them to a
// socket, an HTTP response or a log.
func (s ServerSnapshot) PersistBytes() []byte {
	if s.blob == nil {
		return nil
	}
	return s.blob()
}

// MarshalJSON always fails: a snapshot must never be serialized as, or
// inside, a client message.
func (ServerSnapshot) MarshalJSON() ([]byte, error) { return nil, ErrSnapshotNotForClients }

// MarshalText always fails, for the same reason.
func (ServerSnapshot) MarshalText() ([]byte, error) { return nil, ErrSnapshotNotForClients }

// MarshalBinary always fails, for the same reason. gob uses it too, so gob
// refuses loudly instead of silently writing an empty value.
func (ServerSnapshot) MarshalBinary() ([]byte, error) { return nil, ErrSnapshotNotForClients }

func (ServerSnapshot) String() string   { return redactedSnapshot }
func (ServerSnapshot) GoString() string { return redactedSnapshot }

// Format prints the redacted marker for every verb, so %x or %+v can't
// dump the blob either.
func (ServerSnapshot) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, redactedSnapshot) }

// LogValue keeps the blob out of slog output.
func (ServerSnapshot) LogValue() slog.Value { return slog.StringValue(redactedSnapshot) }

// 2 since AppliedMove gained `drawn` (SPEC §2.7, §5.7, amended 2026-09-28);
// 3 since engine v0.3.0 changed the state layout (Owed, TurnEnd, LastTurn,
// ThisTurn; SPEC §5.7 v3, issue #93).
const snapshotVersion = 3

// v3StateKeys are the engine state keys a v3 save may hold and a v2 save
// cannot (engine/state.go:120-136).
var v3StateKeys = []string{"Owed", "TurnEnd", "LastTurn", "ThisTurn"}

// migrateSnapshotV2 upgrades a version-2 SnapshotJson to version 3 (SPEC
// §5.7 v3): the save is accepted unchanged and loads with no turn-end
// snapshot, no turn records and no debt, so no counter is offered at that
// turn start, and a legacy counter window or old-style discard finishes
// through the engine's frozen legacy path. Only `v` is rewritten. A v2
// state that already carries a v3 key is not a real v2 save and is
// rejected. Anything that is not a well-formed v2 object is returned
// unchanged for the strict decode and the version check to reject.
func migrateSnapshotV2(raw string) (string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		return raw, nil
	}
	if v, ok := top["v"]; !ok || string(v) != "2" {
		return raw, nil
	}
	if st, ok := top["state"]; ok && string(st) != "null" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(st, &fields); err != nil {
			return raw, nil
		}
		for _, k := range v3StateKeys {
			if _, has := fields[k]; has {
				return "", fmt.Errorf("v2 state already carries %s", k)
			}
		}
	}
	top["v"] = json.RawMessage("3")
	out, err := json.Marshal(top)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

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
	// SPEC §5.7 v3 (issue #93): a v2 save (or a v1 save just upgraded to
	// v2) is accepted unchanged.
	raw, err = migrateSnapshotV2(raw)
	if err != nil {
		return invalid("malformed v2 snapshot: " + err.Error())
	}
	var snap restoreWire
	if err := decodeStrict(raw, &snap); err != nil {
		return invalid("malformed snapshot: " + err.Error())
	}
	if snap.V == nil || *snap.V != snapshotVersion {
		return invalid(fmt.Sprintf("snapshot version must be 1, 2 or %d", snapshotVersion))
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
	if err := checkStateArrays(raw); err != nil {
		return invalid("invalid snapshot state: " + err.Error())
	}
	if err := validateState(*snap.State); err != nil {
		return invalid("invalid snapshot state: " + err.Error())
	}
	if err := validateHistory(snap.History); err != nil {
		return invalid("invalid snapshot history: " + err.Error())
	}
	return &session{state: *snap.State, history: snap.History, seed: seed, dealer: engine.PlayerID(*snap.Dealer)}, nil
}

// stateArrays are the engine state's fixed-length arrays
// (engine/state.go:111-137). encoding/json drops extra elements of a Go
// array and zero-fills missing ones, so a strict restore checks the
// lengths itself.
var stateArrays = []string{"Players", "Owed", "TurnEnd"}

// checkStateArrays requires every fixed-length array in the snapshot's
// state, and in each TurnEnd snapshot, to hold exactly two elements when
// present. The strict decode has already accepted raw.
func checkStateArrays(raw string) error {
	var top struct {
		State json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		return err
	}
	return checkArrays(top.State, "state", 1)
}

func checkArrays(st json.RawMessage, label string, depth int) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(st, &fields); err != nil || fields == nil {
		return nil // null or not an object: the typed decode rules on it
	}
	for _, key := range stateArrays {
		v, ok := fields[key]
		if !ok || string(v) == "null" {
			continue
		}
		var elems []json.RawMessage
		if err := json.Unmarshal(v, &elems); err != nil {
			return fmt.Errorf("%s.%s is not an array", label, key)
		}
		if len(elems) != 2 {
			return fmt.Errorf("%s.%s holds %d entries, want 2", label, key, len(elems))
		}
		if key == "TurnEnd" && depth > 0 {
			for i, e := range elems {
				if err := checkArrays(e, fmt.Sprintf("%s.TurnEnd[%d]", label, i), depth-1); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
