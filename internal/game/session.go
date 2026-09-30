package game

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"

	"github.com/ApisMellow/cuttle/engine"
)

// The typed Go API (two-phone W2, docs/two-phone-plan.md §4). A server
// holds one *Session per live game and binds each connection to a Seat;
// the WASM Bridge (bridge.go) is a JSON wrapper over the same core
// (session data, applyMove, decodeSnapshot, buildEnvelope), so both front
// ends produce the same bytes.
//
// Output safety: Envelope is the only type meant for a client, and it is
// always one seat's redacted view (SPEC §3). ServerSnapshot holds the full
// game and refuses to be serialized (snapshot.go).

// Seat is a player position, 0 or 1 (engine.P1, engine.P2). A server binds
// a connection to one Seat and passes only that Seat to the Session.
type Seat int

const (
	Seat0 Seat = 0
	Seat1 Seat = 1
	// NoSeat is Status.Winner when nobody has won.
	NoSeat Seat = -1
)

// Valid reports whether s is 0 or 1.
func (s Seat) Valid() bool { return s == Seat0 || s == Seat1 }

// Other returns the opposing seat.
func (s Seat) Other() Seat { return 1 - s }

// ClientSafe marks the types that may be sent to a client. Only per-seat
// Envelopes satisfy it; a server's send path should take a ClientSafe, so
// passing a ServerSnapshot (or an engine.GameState) fails to compile.
type ClientSafe interface{ clientSafe() }

func (Envelope) clientSafe() {}

// Status is the public shape of the game: nothing in it is hidden from
// either seat.
type Status struct {
	// Seq is the history length; a move must name it (Session.Apply).
	Seq int
	// Actor is the only seat Session.Apply accepts: engine Active, which is
	// the player on turn, the responder at a counter window, the 4's
	// discarder and the 7's player while choosing (engine/apply.go:15-33
	// LegalMoves is always Active's; :337 flips Active for a counter
	// window; :653 hands the discard to the opponent; :834 endTurn).
	Actor Seat
	Phase engine.Phase
	Over  bool
	// Winner is NoSeat unless the game ended in a win.
	Winner    Seat
	Stalemate bool
	// Stuck is the §2.10 engine defect: not over, yet no legal move.
	Stuck bool
}

// Update is the result of a committed move: one redacted envelope per
// seat, rendered before the move was committed (§2.9).
//
// An Update holds both seats' envelopes, so it is never sent whole: each
// seat gets For(seat). The envelopes sit in a closure, out of reach of
// reflection (see ServerSnapshot), and an Update refuses encoding/json,
// encoding.TextMarshaler, encoding.BinaryMarshaler and so gob
// (ErrUpdateNotForClients) and prints only its public Seq and Mover.
type Update struct {
	Seq   int
	Mover Seat
	envs  func(Seat) Envelope
}

// ErrUpdateNotForClients is returned by any attempt to encode an Update.
var ErrUpdateNotForClients = errors.New("game: Update holds both seats' envelopes; send each seat Update.For(seat), never the Update")

// newUpdate takes ownership of envs.
func newUpdate(seq int, mover Seat, envs [2]Envelope) Update {
	return Update{Seq: seq, Mover: mover, envs: func(seat Seat) Envelope { return cloneEnvelope(envs[seat]) }}
}

// For returns a copy of seat's envelope, the only part of an Update that
// seat may receive. An invalid seat, or the zero Update, gets the zero
// Envelope.
func (u Update) For(seat Seat) Envelope {
	if !seat.Valid() || u.envs == nil {
		return Envelope{}
	}
	return u.envs(seat)
}

// MarshalJSON always fails: send For(seat) instead.
func (Update) MarshalJSON() ([]byte, error) { return nil, ErrUpdateNotForClients }

// MarshalText always fails, for the same reason.
func (Update) MarshalText() ([]byte, error) { return nil, ErrUpdateNotForClients }

// MarshalBinary always fails, for the same reason. gob uses it too;
// without it gob would silently send Seq and Mover.
func (Update) MarshalBinary() ([]byte, error) { return nil, ErrUpdateNotForClients }

func (u Update) String() string {
	return fmt.Sprintf("game.Update(seq=%d, mover=%d, redacted)", u.Seq, int(u.Mover))
}
func (u Update) GoString() string { return u.String() }

// Format prints String for every verb.
func (u Update) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, u.String()) }

// LogValue keeps the envelopes out of slog output.
func (u Update) LogValue() slog.Value { return slog.StringValue(u.String()) }

// renderFunc builds one viewer's envelope. buildEnvelope in production; a
// test swaps it per instance to prove commit atomicity.
type renderFunc func(engine.GameState, []AppliedMove, engine.PlayerID) Envelope

// Session is one game, typed. Construct it with NewSession or
// RestoreSession.
//
// Concurrency: a Session is not safe for concurrent use; the server must
// serialize calls per room (a room mutex). Distinct Sessions share no
// mutable state, so many rooms may run in parallel.
//
// Every method recovers a panic into ErrInternal, and every error leaves
// the session unchanged.
type Session struct {
	g      *session
	render renderFunc
}

// session is the held game data. A committed *session is never mutated:
// each move builds a new one (engine.Apply clones, engine/apply.go:142).
type session struct {
	state   engine.GameState
	history []AppliedMove
	seed    uint64
	dealer  engine.PlayerID
}

// NewSession deals a new game from seed with the given dealer; the dealer's
// opponent acts first. The seed decides every card, so the server draws it
// from crypto/rand and never reveals it.
func NewSession(seed uint64, dealer Seat) (*Session, error) {
	return newSession(seed, dealer, nil)
}

// dealFunc deals a new game; dealNewGame in production, a test injects a
// panicking one.
type dealFunc func(seed uint64, dealer engine.PlayerID) engine.GameState

// newSession is NewSession with a replaceable deal (nil means dealNewGame).
// A panic in the deal is ErrInternal and its value goes to the hook.
func newSession(seed uint64, dealer Seat, deal dealFunc) (s *Session, err error) {
	defer recoverInternal(&err)
	if !dealer.Valid() {
		return nil, newError(ErrBadSeat, fmt.Sprintf("dealer must be 0 or 1, got %d", dealer), nil)
	}
	if deal == nil {
		deal = dealNewGame
	}
	d := engine.PlayerID(dealer)
	return &Session{g: &session{state: deal(seed, d), history: []AppliedMove{}, seed: seed, dealer: d}}, nil
}

// RestoreSession rebuilds a Session from ServerSnapshot.PersistBytes (or a
// v1/v2 SnapshotJson). Any malformed or inconsistent blob is
// ErrInvalidSnapshot. The checks are the Bridge's restore checks: the
// decode (decodeSnapshot, structure and shape, never game rules), then
// both seats' envelopes must render.
func RestoreSession(persisted []byte) (*Session, error) {
	return restoreSession(persisted, nil)
}

// restoreSession is RestoreSession with a per-instance renderer (nil means
// buildEnvelope); a test injects a failing one.
func restoreSession(persisted []byte, render renderFunc) (s *Session, err error) {
	defer recoverInternal(&err)
	g, e := decodeSnapshot(string(persisted))
	if e != nil {
		return nil, e
	}
	s = &Session{g: g, render: render}
	// Bridge.Restore's render-before-commit check (commit): a blob that
	// decodes but can't be shown to both seats is refused, not handed out.
	if e := s.renderBoth(); e != nil {
		return nil, newError(ErrInvalidSnapshot, "snapshot does not render", nil)
	}
	return s, nil
}

// renderBoth renders both seats' envelopes of the held game and reports a
// panic in either as an error. The panic value goes to the panic hook
// only: it can carry card state.
func (s *Session) renderBoth() (err error) {
	defer func() {
		if r := recover(); r != nil {
			reportPanic(r)
			err = errors.New("render panicked")
		}
	}()
	render := s.renderer()
	for _, viewer := range []Seat{Seat0, Seat1} {
		render(s.g.state, s.g.history, engine.PlayerID(viewer))
	}
	return nil
}

// Status reports whose move it is and whether the game is over. A panic
// (the stuck check asks the engine for legal moves) is ErrInternal with
// the zero Status.
func (s *Session) Status() (out Status, err error) {
	defer func() {
		if r := recover(); r != nil {
			reportPanic(r)
			out, err = Status{}, internalErr()
		}
	}()
	st := s.g.state
	out = Status{
		Seq:    len(s.g.history),
		Actor:  Seat(st.Active),
		Phase:  st.Phase,
		Over:   st.Phase == engine.PhaseGameOver,
		Winner: NoSeat,
		Stuck:  stuck(st),
	}
	if st.Winner != nil {
		out.Winner = Seat(*st.Winner)
	}
	out.Stalemate = out.Over && st.Winner == nil
	return out, nil
}

// Seq is the history length, the seq the next move must name.
func (s *Session) Seq() int { return len(s.g.history) }

// View returns seat's redacted envelope (SPEC §3). Legal moves are filled
// only when seat is the actor. It never raises NO_LEGAL_MOVES, so a stuck
// game can still be shown.
func (s *Session) View(seat Seat) (env Envelope, err error) {
	defer recoverInternal(&err)
	if !seat.Valid() {
		return Envelope{}, badSeat(seat)
	}
	return cloneEnvelope(buildEnvelope(s.g.state, s.g.history, engine.PlayerID(seat))), nil
}

// LegalMoves returns seat's legal moves and their descriptions, parallel
// slices. A seat that is not the actor, and anyone at game over, gets two
// empty slices. A stuck position is ErrNoLegalMoves.
func (s *Session) LegalMoves(seat Seat) (moves []MoveView, descriptions []string, err error) {
	defer recoverInternal(&err)
	if !seat.Valid() {
		return nil, nil, badSeat(seat)
	}
	st := s.g.state
	if st.Phase == engine.PhaseGameOver || engine.PlayerID(seat) != st.Active {
		return []MoveView{}, []string{}, nil
	}
	if stuck(st) {
		return nil, nil, s.g.noLegalMovesErr()
	}
	env := buildEnvelope(st, s.g.history, engine.PlayerID(seat))
	return env.LegalMoves, env.Descriptions, nil
}

// Apply plays legal move index for seat. seq must equal Status().Seq: the
// index points into the move list of that seq and means nothing at any
// other. Checks, in order: seat valid (ErrBadSeat), game not over
// (ErrGameOver), seq current (ErrStale), seat is the actor
// (ErrNotYourTurn), a move exists (ErrNoLegalMoves), index in range
// (ErrIndexOutOfRange), engine accepts (ErrIllegalMove).
//
// Both seats' envelopes are rendered before the move is committed; if
// either fails, nothing changes (§2.9).
func (s *Session) Apply(seat Seat, seq, index int) (up Update, err error) {
	defer recoverInternal(&err)
	if !seat.Valid() {
		return Update{}, badSeat(seat)
	}
	g := s.g
	cur := len(g.history)
	if g.state.Phase == engine.PhaseGameOver {
		return Update{}, newError(ErrGameOver, "the game is over", map[string]any{"seq": cur})
	}
	if seq != cur {
		return Update{}, newError(ErrStale, fmt.Sprintf("move names seq %d, the game is at seq %d", seq, cur), map[string]any{"seq": cur})
	}
	if engine.PlayerID(seat) != g.state.Active {
		return Update{}, newError(ErrNotYourTurn, fmt.Sprintf("seat %d cannot act; the game waits on seat %d", seat, g.state.Active),
			map[string]any{"seq": cur, "active": int(g.state.Active)})
	}
	moves := engine.LegalMoves(g.state)
	if len(moves) == 0 {
		return Update{}, g.noLegalMovesErr()
	}
	if index < 0 || index >= len(moves) {
		return Update{}, newError(ErrIndexOutOfRange, fmt.Sprintf("move index %d outside [0, %d)", index, len(moves)),
			map[string]any{"index": index, "count": len(moves)})
	}
	next, e := g.applyMove(moves, index)
	if e != nil {
		return Update{}, e
	}
	render := s.renderer()
	var envs [2]Envelope
	for _, viewer := range []Seat{Seat0, Seat1} {
		envs[viewer] = cloneEnvelope(render(next.state, next.history, engine.PlayerID(viewer)))
	}
	s.g = next
	return newUpdate(len(next.history), seat, envs), nil
}

// Snapshot returns the full game for server persistence. See
// ServerSnapshot: it must never reach a client.
func (s *Session) Snapshot() (snap ServerSnapshot, err error) {
	defer recoverInternal(&err)
	out, e := json.Marshal(s.g.wire())
	if e != nil {
		return ServerSnapshot{}, internalError(e)
	}
	return newServerSnapshot(out), nil
}

func (s *Session) renderer() renderFunc {
	if s.render != nil {
		return s.render
	}
	return buildEnvelope
}

func badSeat(seat Seat) *Error {
	return newError(ErrBadSeat, fmt.Sprintf("seat must be 0 or 1, got %d", seat), nil)
}

// recoverInternal turns a panic in a Session method into ErrInternal. The
// method's state change is always its last statement, so a panic leaves
// the session unchanged. The Message is fixed: the panic value can carry
// card state, so it goes to the panic hook only (W2 review nit).
func recoverInternal(err *error) {
	if r := recover(); r != nil {
		reportPanic(r)
		*err = internalErr()
	}
}

// internalMessage is the Message of every ErrInternal. It is fixed: an
// engine or encoder error text, like a panic value, can describe hidden
// cards, and an Error's Message may reach a client.
const internalMessage = "internal error"

func internalErr() *Error { return newError(ErrInternal, internalMessage, nil) }

// internalError reports cause to the panic hook (server-side only) and
// returns an ErrInternal with the fixed message.
func internalError(cause error) *Error {
	reportPanic(cause)
	return internalErr()
}

// panicHook receives recovered panic values (SetPanicHook).
var panicHook atomic.Pointer[func(any)]

// SetPanicHook installs h to receive the value of every panic a Session
// method, NewSession or RestoreSession recovers, and the cause of every
// other ErrInternal; nil removes it. The value can hold
// card state, so it goes only to h (server side), never into an Error.
// Safe to call concurrently with running sessions.
func SetPanicHook(h func(any)) {
	if h == nil {
		panicHook.Store(nil)
		return
	}
	panicHook.Store(&h)
}

func reportPanic(v any) {
	if h := panicHook.Load(); h != nil {
		(*h)(v)
	}
}

// ---------------------------------------------------------------------------
// Core shared with Bridge.
// ---------------------------------------------------------------------------

func newGameData(seed uint64, dealer engine.PlayerID) *session {
	return &session{state: dealNewGame(seed, dealer), history: []AppliedMove{}, seed: seed, dealer: dealer}
}

func (g *session) noLegalMovesErr() *Error {
	return newError(ErrNoLegalMoves,
		fmt.Sprintf("engine offers no legal move in phase %d (SPEC §2.10)", g.state.Phase),
		map[string]any{"phase": int(g.state.Phase), "active": int(g.state.Active), "seq": len(g.history)})
}

// applyMove applies moves[index], where moves is engine.LegalMoves(g.state)
// and index is in range, and returns the next game without touching g.
func (g *session) applyMove(moves []engine.Move, index int) (*session, *Error) {
	pre := g.state
	move := moves[index]
	description := move.Describe(pre)
	targetCard := targetCardFor(pre, move)
	post, err := engine.Apply(pre, move)
	if err != nil {
		if errors.Is(err, engine.ErrIllegalMove) {
			return nil, newError(ErrIllegalMove,
				fmt.Sprintf("engine rejected offered move %d (%q)", index, description),
				map[string]any{"index": index, "description": description, "seq": len(g.history), "phase": int(pre.Phase)})
		}
		return nil, internalError(err)
	}
	idx := index
	history := append(append([]AppliedMove{}, g.history...), AppliedMove{
		Index:       &idx,
		By:          pre.Active,
		Kind:        move.Kind,
		SubKind:     subKindOf(move),
		Card:        cardOrNil(move.Card),
		TargetCard:  targetCard,
		Description: description,
		Seq:         len(g.history) + 1,
	})
	// SPEC §2.7 drawn: a 5 that resolved in this apply records its count on
	// this entry (append-only; see resolvedFiveDraw).
	if drawn, ok := resolvedFiveDraw(pre, move, post); ok {
		history[len(history)-1].Drawn = &drawn
	}
	return &session{state: post, history: history, seed: g.seed, dealer: g.dealer}, nil
}

// ---------------------------------------------------------------------------
// Deep copies, so an envelope handed to a caller shares no memory with the
// session (the server may edit or hold one while the game moves on).
// ---------------------------------------------------------------------------

func cloneEnvelope(e Envelope) Envelope {
	e.State = clonePlayerView(e.State)
	e.LegalMoves = cloneMoveViews(e.LegalMoves)
	e.Descriptions = cloneSlice(e.Descriptions)
	if e.History != nil {
		h := make([]AppliedMove, len(e.History))
		for i, m := range e.History {
			h[i] = cloneApplied(m)
		}
		e.History = h
	}
	if e.LastMove != nil {
		l := cloneApplied(*e.LastMove)
		e.LastMove = &l
	}
	return e
}

func clonePlayerView(v PlayerView) PlayerView {
	v.Winner = clonePtr(v.Winner)
	v.You.Hand = cloneSlice(v.You.Hand)
	v.You.FrozenHandIndices = cloneSlice(v.You.FrozenHandIndices)
	v.You.Points = clonePoints(v.You.Points)
	v.You.Permanents = cloneSlice(v.You.Permanents)
	if v.Opponent.Hand != nil {
		h := cloneSlice(*v.Opponent.Hand)
		v.Opponent.Hand = &h
	}
	v.Opponent.Points = clonePoints(v.Opponent.Points)
	v.Opponent.Permanents = cloneSlice(v.Opponent.Permanents)
	v.Scrap = cloneSlice(v.Scrap)
	v.SevenRevealed = cloneSlice(v.SevenRevealed)
	if v.Pending != nil {
		p := *v.Pending
		p.Target = clonePtr(p.Target)
		p.CounterChain = cloneSlice(p.CounterChain)
		v.Pending = &p
	}
	return v
}

func clonePoints(points []PointEntryView) []PointEntryView {
	if points == nil {
		return nil
	}
	out := make([]PointEntryView, len(points))
	for i, pe := range points {
		pe.JackStack = cloneSlice(pe.JackStack)
		pe.JackOwners = cloneSlice(pe.JackOwners)
		out[i] = pe
	}
	return out
}

func cloneMoveViews(moves []MoveView) []MoveView {
	if moves == nil {
		return nil
	}
	out := make([]MoveView, len(moves))
	for i, m := range moves {
		out[i] = cloneMoveView(m)
	}
	return out
}

func cloneMoveView(m MoveView) MoveView {
	m.Card = clonePtr(m.Card)
	m.Target = clonePtr(m.Target)
	m.JackTarget = clonePtr(m.JackTarget)
	if m.SubMove != nil {
		sub := cloneMoveView(*m.SubMove)
		m.SubMove = &sub
	}
	return m
}

func cloneApplied(m AppliedMove) AppliedMove {
	m.Index = clonePtr(m.Index)
	m.SubKind = clonePtr(m.SubKind)
	m.Card = clonePtr(m.Card)
	m.TargetCard = clonePtr(m.TargetCard)
	m.Drawn = clonePtr(m.Drawn)
	return m
}

// cloneSlice copies s, keeping nil as nil ([] and null differ on the wire).
func cloneSlice[T any](s []T) []T {
	if s == nil {
		return nil
	}
	return append(make([]T, 0, len(s)), s...)
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
