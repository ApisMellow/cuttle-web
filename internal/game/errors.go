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
//
// Each call returns a fresh *Error; editing one changes nothing else.
type Error struct {
	Code    Code
	Message string
	Detail  map[string]any
	kind    errKind
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// Is matches the sentinel an error was made from, and nothing else, so
// ErrBadSeat and a BAD_REQUEST from elsewhere stay distinguishable.
func (e *Error) Is(target error) bool {
	k, ok := target.(errKind)
	return ok && e.kind == k
}

// errKind is a sentinel: a string constant of an unexported type. A
// constant can't be reassigned, a string has no fields to write, and no
// code outside this package can build one, so errors.Is(err, ErrStale)
// can't be spoofed or broken by a caller.
type errKind string

// Sentinels. Never returned as-is; each call returns a fresh *Error that
// errors.Is matches to exactly one of these. The value is the kind's
// default message.
const (
	ErrNotYourTurn     errKind = "not your turn"
	ErrStale           errKind = "stale seq"
	ErrIndexOutOfRange errKind = "move index out of range"
	ErrIllegalMove     errKind = "engine rejected an offered move"
	ErrNoLegalMoves    errKind = "engine offers no legal move"
	ErrGameOver        errKind = "the game is over"
	ErrBadSeat         errKind = "seat must be 0 or 1"
	ErrInvalidSnapshot errKind = "invalid snapshot"
	ErrInternal        errKind = "internal error"
)

// code is the wire code an error of this kind carries.
func (k errKind) code() Code {
	switch k {
	case ErrNotYourTurn:
		return CodeNotYourTurn
	case ErrStale:
		return CodeStale
	case ErrIndexOutOfRange:
		return CodeIndexOutOfRange
	case ErrIllegalMove:
		return CodeIllegalMove
	case ErrNoLegalMoves:
		return CodeNoLegalMoves
	case ErrGameOver:
		return CodeGameOver
	case ErrBadSeat:
		return CodeBadRequest
	case ErrInvalidSnapshot:
		return CodeInvalidSnapshot
	}
	return CodeInternal
}

func (k errKind) Error() string { return string(k.code()) + ": " + string(k) }

func newError(kind errKind, message string, detail map[string]any) *Error {
	return &Error{Code: kind.code(), Message: message, Detail: detail, kind: kind}
}
