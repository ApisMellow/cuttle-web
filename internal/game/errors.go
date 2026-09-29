package game

// Typed errors for the Go API (two-phone W2). The JSON Bridge renders the
// same conditions as §2.9 EngineError strings; a server maps Code to its
// wire error (docs/two-phone-plan.md §3).

// Code is a machine-readable error code. The values that the bridge also
// raises are the §2.9 strings; the rest are the server-side codes of
// docs/two-phone-plan.md §3 plus GAME_OVER and INVALID_SNAPSHOT.
type Code string

const (
	CodeIllegalMove     Code = "ILLEGAL_MOVE"
	CodeIndexOutOfRange Code = "INDEX_OUT_OF_RANGE"
	CodeNoLegalMoves    Code = "NO_LEGAL_MOVES"
	CodeBadRequest      Code = "BAD_REQUEST"
	CodeInternal        Code = "INTERNAL"
	// CodeNotYourTurn: the seat is not the one the engine is waiting on.
	CodeNotYourTurn Code = "NOT_YOUR_TURN"
	// CodeStale: the move names a seq other than the session's current one,
	// so its index refers to a legal-move list that no longer exists.
	CodeStale Code = "STALE"
	// CodeGameOver: a move arrived after the game ended.
	CodeGameOver Code = "GAME_OVER"
	// CodeInvalidSnapshot: RestoreSession refused a blob (the bridge
	// reports the same conditions as BAD_REQUEST).
	CodeInvalidSnapshot Code = "INVALID_SNAPSHOT"
)

// Error is every error the Session API returns. Match a kind with
// errors.Is against the sentinels below; read Code for the wire, Message
// for logs, and Detail for structured context. Message and Detail describe
// only what the calling seat may already see (ILLEGAL_MOVE names the
// caller's own move), so they may go back to that seat, never to the other.
type Error struct {
	Code    Code
	Message string
	Detail  map[string]any
	kind    *Error
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// Is matches the sentinel an error was made from, and nothing else, so
// ErrBadSeat and a BAD_REQUEST from elsewhere stay distinguishable.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	if !ok {
		return false
	}
	return t == e || (e.kind != nil && t == e.kind)
}

// Sentinels. Never returned as-is; each call returns a fresh *Error that
// errors.Is matches to one of these.
var (
	ErrNotYourTurn     = &Error{Code: CodeNotYourTurn, Message: "not your turn"}
	ErrStale           = &Error{Code: CodeStale, Message: "stale seq"}
	ErrIndexOutOfRange = &Error{Code: CodeIndexOutOfRange, Message: "move index out of range"}
	ErrIllegalMove     = &Error{Code: CodeIllegalMove, Message: "engine rejected an offered move"}
	ErrNoLegalMoves    = &Error{Code: CodeNoLegalMoves, Message: "engine offers no legal move"}
	ErrGameOver        = &Error{Code: CodeGameOver, Message: "the game is over"}
	ErrBadSeat         = &Error{Code: CodeBadRequest, Message: "seat must be 0 or 1"}
	ErrInvalidSnapshot = &Error{Code: CodeInvalidSnapshot, Message: "invalid snapshot"}
	ErrInternal        = &Error{Code: CodeInternal, Message: "internal error"}
)

func newError(kind *Error, message string, detail map[string]any) *Error {
	return &Error{Code: kind.Code, Message: message, Detail: detail, kind: kind}
}
