package server

// Frames of the two-phone wire protocol, v1 (SPEC §2.12.2). Every server
// frame is one of the types below; the send path (conn.enqueue) takes only
// the sealed frame interface. The one field that carries game data is
// stateFrame.Envelope, typed game.ClientSafe, which only a per-seat
// game.Envelope satisfies: a ServerSnapshot or an Update can't be put in a
// frame. TestWS_FramesCarryOnlyClientSafeData pins the field types.

import (
	"github.com/ApisMellow/cuttle-web/internal/game"
)

// protocolVersion is the only hello.v this server speaks (SPEC §2.12.7).
const protocolVersion = 1

// Socket error codes beyond the HTTP ones in api.go (SPEC §2.12.3).
const (
	CodeUnauthorized    = "UNAUTHORIZED"
	CodeUpgradeRequired = "UPGRADE_REQUIRED"
	CodeReplaced        = "REPLACED"
	CodeNotYourTurn     = "NOT_YOUR_TURN"
	CodeStale           = "STALE"
	CodeGameOver        = "GAME_OVER"
	CodeIllegalMove     = "ILLEGAL_MOVE"
	CodeNoLegalMoves    = "NO_LEGAL_MOVES"
	CodeIndexOutOfRange = "INDEX_OUT_OF_RANGE"
)

// errorMessages are the fixed human strings of socket errors. A message
// never carries a token, an err text or card data.
var errorMessages = map[string]string{
	CodeBadRequest:      "malformed or unexpected frame",
	CodeInternal:        "internal error",
	CodeRoomGone:        "this game has ended or the code is wrong",
	CodeRateLimited:     "too many messages; slow down",
	CodeUnauthorized:    "this seat's key is not valid for that game",
	CodeUpgradeRequired: "this app is out of date; refresh to update",
	CodeReplaced:        "this game was opened somewhere else",
	CodeNotYourTurn:     "it is not your move",
	CodeStale:           "that move is out of date",
	CodeGameOver:        "the game is over",
	CodeIllegalMove:     "the engine rejected that move",
	CodeNoLegalMoves:    "the engine offers no move here",
	CodeIndexOutOfRange: "no such move",
}

// frame is a server-to-client frame. Sealed: only this file's types
// implement it.
type frame interface{ isFrame() }

type welcomeFrame struct {
	T      string     `json:"t"`
	Seat   int        `json:"seat"`
	Names  [2]*string `json:"names"`
	Status string     `json:"status"`
}

type stateFrame struct {
	T              string          `json:"t"`
	Game           int             `json:"game"`
	Envelope       game.ClientSafe `json:"envelope"`
	OpponentOnline bool            `json:"opponentOnline"`
	Tally          [2]int          `json:"tally"`
}

type respondingFrame struct {
	T  string `json:"t"`
	By int    `json:"by"`
}

type presenceFrame struct {
	T              string `json:"t"`
	OpponentOnline bool   `json:"opponentOnline"`
}

type rematchFrame struct {
	T           string `json:"t"`
	RequestedBy int    `json:"requestedBy"`
}

type errorFrame struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Seq     *int   `json:"seq,omitempty"`
}

type pongFrame struct {
	T string `json:"t"`
}

func (welcomeFrame) isFrame()    {}
func (stateFrame) isFrame()      {}
func (respondingFrame) isFrame() {}
func (presenceFrame) isFrame()   {}
func (rematchFrame) isFrame()    {}
func (errorFrame) isFrame()      {}
func (pongFrame) isFrame()       {}

// allFrameTypes lists one zero value of every frame type (tests).
func allFrameTypes() []frame {
	return []frame{welcomeFrame{}, stateFrame{}, respondingFrame{}, presenceFrame{}, rematchFrame{}, errorFrame{}, pongFrame{}}
}

// Room status as welcome reports it.
const (
	statusWaiting = "waiting"
	statusPlaying = "playing"
	statusOver    = "over"
)

// newWelcomeFrame describes r to seat. r.mu must be held.
func newWelcomeFrame(r *room, seat game.Seat) welcomeFrame {
	f := welcomeFrame{T: "welcome", Seat: int(seat), Status: roomStatusLocked(r, seat)}
	n0 := r.meta.Names[0]
	f.Names[0] = &n0
	if r.meta.Joined {
		n1 := r.meta.Names[1]
		f.Names[1] = &n1
	}
	return f
}

// roomStatusLocked is welcome's status for seat: waiting before the join,
// over while a finished game waits for a rematch, else playing. A seat
// that is the mover under a hold is told playing: over would reveal the
// withheld outcome (SPEC §2.12.5).
func roomStatusLocked(r *room, seat game.Seat) string {
	switch {
	case !r.meta.Joined:
		return statusWaiting
	case r.live.holds[seat].active:
		return statusPlaying
	case r.sess != nil:
		if st, err := r.sess.Status(); err == nil && st.Over {
			return statusOver
		}
	}
	return statusPlaying
}

// newStateFrame wraps seat's envelope with the room's metadata. r.mu must
// be held.
func newStateFrame(r *room, seat game.Seat, env game.ClientSafe) stateFrame {
	return stateFrame{T: "state", Game: r.meta.Game, Envelope: env,
		OpponentOnline: r.live.conns[seat.Other()] != nil, Tally: r.meta.Tally}
}

func newRespondingFrame(by game.Seat) respondingFrame {
	return respondingFrame{T: "responding", By: int(by)}
}

func newPresenceFrame(online bool) presenceFrame {
	return presenceFrame{T: "presence", OpponentOnline: online}
}

func newRematchFrame(by game.Seat) rematchFrame {
	return rematchFrame{T: "rematch", RequestedBy: int(by)}
}

// newErrorFrame builds an error with the code's fixed message. seq, when
// non-nil, echoes the rejected move's seq.
func newErrorFrame(code string, seq *int) errorFrame {
	msg, ok := errorMessages[code]
	if !ok {
		code, msg = CodeInternal, errorMessages[CodeInternal]
	}
	f := errorFrame{T: "error", Code: code, Message: msg}
	if seq != nil {
		s := *seq
		f.Seq = &s
	}
	return f
}

func newPongFrame() pongFrame { return pongFrame{T: "pong"} }

// inFrame is every client frame's fields (SPEC §2.12.2). Unknown fields
// are ignored; a field of the wrong JSON type fails the decode
// (BAD_REQUEST). No field names a seat: the seat comes from the token.
type inFrame struct {
	T       string  `json:"t"`
	V       *int    `json:"v"`
	Code    *string `json:"code"`
	Token   *string `json:"token"`
	LastSeq *int    `json:"lastSeq"`
	Game    *int    `json:"game"`
	Seq     *int    `json:"seq"`
	Index   *int    `json:"index"`
}
