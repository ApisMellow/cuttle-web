package server

// Room-level play (two-phone W6 + W7, SPEC §2.12.4–§2.12.5): the sockets
// bound to a room's seats, the fan-out after a move, presence and
// rematch. There is no counter hold (SPEC §2.12.5, issue #93): every saved
// move goes to both seats at once. Everything here runs under the room's mutex; a
// frame is only ever enqueued there (conn.enqueue never blocks) and
// written by the connection's own writer goroutine, outside every lock.

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"

	"github.com/ApisMellow/cuttle-web/internal/game"
)

// errDetached: the socket is no longer the one bound to its seat (it was
// replaced, or its room was dropped and reloaded).
var errDetached = errors.New("socket no longer bound to its seat")

// errShuttingDown: the server is closing its sockets.
var errShuttingDown = errors.New("server shutting down")

// liveRoom is a room's in-memory play state. Every field is guarded by the
// room's mutex. The zero value is a room with nobody connected.
type liveRoom struct {
	conns [2]*conn
	// rematch[s]: seat s asked for a rematch of game rematchGame. Memory
	// only (SPEC §2.12.8 question 2).
	rematch     [2]bool
	rematchGame int
}

func (lv *liveRoom) connected() bool { return lv.conns[0] != nil || lv.conns[1] != nil }

// closeLocked closes every socket: with frame f first (a terminal error)
// or, for nil, bare (retryable). r.mu must be held.
func (lv *liveRoom) closeLocked(f frame) {
	for s, c := range lv.conns {
		if c == nil {
			continue
		}
		if f != nil {
			c.terminal(f)
		} else {
			c.kill()
		}
		lv.conns[s] = nil
	}
}

// welcomeAllLocked re-sends welcome to every connected seat (the names or
// status changed: the join).
func (lv *liveRoom) welcomeAllLocked(r *room) {
	for s, c := range lv.conns {
		if c != nil {
			c.enqueue(newWelcomeFrame(r, game.Seat(s)))
		}
	}
}

// dealtLocked announces a freshly dealt game: rematch requests end, and
// every connected seat gets its state.
func (lv *liveRoom) dealtLocked(r *room) {
	lv.rematch, lv.rematchGame = [2]bool{}, 0
	for _, c := range lv.conns {
		if c != nil {
			sendStateLocked(r, c)
		}
	}
}

// pendingRematch reports the seat whose rematch request for the current
// game is waiting on the other.
func (lv *liveRoom) pendingRematch(r *room) (game.Seat, bool) {
	if lv.rematchGame != r.meta.Game {
		return game.NoSeat, false
	}
	for s, asked := range lv.rematch {
		if asked {
			return game.Seat(s), true
		}
	}
	return game.NoSeat, false
}

// sendStateLocked sends c its seat's current envelope.
func sendStateLocked(r *room, c *conn) {
	if r.sess == nil {
		return
	}
	env, err := r.sess.View(c.seat)
	if err != nil {
		c.enqueue(newErrorFrame(CodeInternal, nil))
		return
	}
	c.enqueue(newStateFrame(r, c.seat, env))
}

// resyncLocked is the "fresh state" after a resync error (SPEC §2.12.3).
func resyncLocked(r *room, c *conn) { sendStateLocked(r, c) }

// play is the WebSocket side of the server: the handler and the
// per-client failed-hello limiter.
type play struct {
	rooms   *Rooms
	log     *slog.Logger
	origins OriginPolicy
	trusted trustedSet
	failed  *limiter
	tune    playTuning
	// Socket caps (Config.MaxSockets, Config.MaxSocketsPerClient).
	maxSockets, maxSocketsPerClient int
	closed                          atomic.Bool
}

func newPlay(cfg Config, log *slog.Logger, rooms *Rooms) *play {
	tune := cfg.tune.withDefaults()
	maxSocks, perClient := cfg.MaxSockets, cfg.MaxSocketsPerClient
	if maxSocks <= 0 {
		maxSocks = DefaultMaxSockets
	}
	if perClient <= 0 {
		perClient = DefaultMaxSocketsPerClient
	}
	return &play{rooms: rooms, log: log, origins: NewOriginPolicy(cfg.AllowedOrigins, cfg.Dev),
		trusted: newTrustedSet(cfg.TrustedProxies), failed: newLimiter(tune.failedHelloPerHour, rooms.now),
		tune: tune, maxSockets: maxSocks, maxSocketsPerClient: perClient}
}

// registerLocked binds c to its seat in r and answers the hello: welcome,
// then state (or nothing while waiting), then a pending rematch. An older
// socket on the seat is replaced.
func (p *play) registerLocked(r *room, c *conn) error {
	if p.closed.Load() {
		return errShuttingDown
	}
	lv := &r.live
	old := lv.conns[c.seat]
	if old != nil {
		old.terminal(newErrorFrame(CodeReplaced, nil))
		p.log.Info("socket replaced", "code", r.code, "seat", int(c.seat))
	}
	lv.conns[c.seat] = c
	c.enqueue(newWelcomeFrame(r, c.seat))
	if r.sess != nil {
		resyncLocked(r, c)
	}
	if by, ok := lv.pendingRematch(r); ok {
		c.enqueue(newRematchFrame(by))
	}
	if oc := lv.conns[c.seat.Other()]; oc != nil && old == nil {
		oc.enqueue(newPresenceFrame(true))
	}
	p.log.Info("socket joined", "code", r.code, "seat", int(c.seat))
	return nil
}

// unregister unbinds c from its seat, if it is still bound, and tells the
// other seat.
func (p *play) unregister(c *conn) {
	if c.code == "" {
		return
	}
	r := p.rooms.cached(c.code)
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone || r.live.conns[c.seat] != c {
		return
	}
	r.live.conns[c.seat] = nil
	if oc := r.live.conns[c.seat.Other()]; oc != nil {
		oc.enqueue(newPresenceFrame(false))
	}
	p.log.Info("socket left", "code", r.code, "seat", int(c.seat))
}

// cached returns the in-memory room for a normalized code, or nil.
func (m *Rooms) cached(code string) *room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[code]
}

// closeAll closes every socket (bare, so phones reconnect to the next
// server). New hellos are refused from here on.
func (p *play) closeAll() {
	p.closed.Store(true)
	p.rooms.mu.Lock()
	rs := make([]*room, 0, len(p.rooms.rooms))
	for _, r := range p.rooms.rooms {
		rs = append(rs, r)
	}
	p.rooms.mu.Unlock()
	for _, r := range rs {
		r.mu.Lock()
		r.live.closeLocked(nil)
		r.mu.Unlock()
	}
	// Sockets not bound to a room yet (before or during hello) too.
	p.rooms.sockets.killAll()
}

// storeCtx bounds one frame's store work. It is not the socket's context:
// a socket dying mid-move must not abort the move's save half way.
func storeCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), requestTimeout)
}

// inRoom runs fn under c's room lock, provided c is still bound to its
// seat there. A socket found detached is closed; a vanished room is
// ROOM_GONE.
func (p *play) inRoom(c *conn, fn func(ctx context.Context, r *room)) {
	ctx, cancel := storeCtx()
	defer cancel()
	err := p.rooms.withRoom(ctx, c.code, func(r *room) error {
		if r.live.conns[c.seat] != c {
			return errDetached
		}
		fn(ctx, r)
		return nil
	})
	switch {
	case err == nil:
	case errors.Is(err, errDetached):
		c.kill()
	case errors.Is(err, ErrRoomGone):
		c.terminal(newErrorFrame(CodeRoomGone, nil))
	default:
		p.log.Error("loading a room for a socket failed", "code", c.code, "err", err)
		c.enqueue(newErrorFrame(CodeInternal, nil))
	}
}

// move handles a move frame (SPEC §2.12.5): the game check, then Apply →
// Save → send, all under the room lock.
func (p *play) move(c *conn, gameNo, seq, index int) {
	p.inRoom(c, func(ctx context.Context, r *room) {
		if r.sess == nil {
			c.enqueue(newErrorFrame(CodeBadRequest, &seq))
			return
		}
		if gameNo != r.meta.Game {
			c.enqueue(newErrorFrame(CodeStale, &seq))
			resyncLocked(r, c)
			return
		}
		up, err := p.rooms.moveLocked(ctx, r, c.seat, seq, index)
		if err != nil {
			p.moveFailedLocked(r, c, seq, err)
			return
		}
		p.log.Info("move", "code", r.code, "seat", int(c.seat), "seq", up.Seq)
		p.afterMoveLocked(r, up)
	})
}

// moveFailedLocked maps a failed move to its §2.12.3 error and, where the
// table says so, a fresh state.
func (p *play) moveFailedLocked(r *room, c *conn, seq int, err error) {
	resync := true
	var code string
	switch {
	case errors.Is(err, game.ErrNotYourTurn):
		code = CodeNotYourTurn
	case errors.Is(err, game.ErrStale), errors.Is(err, ErrResync):
		code = CodeStale
	case errors.Is(err, game.ErrGameOver):
		code = CodeGameOver
	case errors.Is(err, game.ErrIllegalMove):
		code, resync = CodeIllegalMove, false
	case errors.Is(err, game.ErrNoLegalMoves):
		code, resync = CodeNoLegalMoves, false
	case errors.Is(err, game.ErrIndexOutOfRange):
		code, resync = CodeIndexOutOfRange, false
	case errors.Is(err, game.ErrBadSeat), errors.Is(err, ErrNotStarted):
		code, resync = CodeBadRequest, false
	case errors.Is(err, ErrRoomGone):
		if !r.gone {
			c.terminal(newErrorFrame(CodeRoomGone, nil))
		}
		return
	default:
		// A recovered panic or a failed save. If the reload failed too the
		// room was dropped and its sockets closed bare (SPEC §2.12.5).
		if r.gone {
			return
		}
		p.log.Error("move failed; room reloaded", "code", r.code, "seat", int(c.seat))
		code = CodeInternal
	}
	c.enqueue(newErrorFrame(code, &seq))
	if resync {
		resyncLocked(r, c)
	}
}

// afterMoveLocked fans a saved move out: each connected seat gets its own
// up.For(seat) at once (SPEC §2.12.5, no counter hold).
func (p *play) afterMoveLocked(r *room, up game.Update) {
	for s, c := range r.live.conns {
		if c != nil {
			c.enqueue(newStateFrame(r, game.Seat(s), up.For(game.Seat(s))))
		}
	}
}

// rematch handles a rematch frame (SPEC §2.12.4): the first request is
// announced to both seats, a repeat is re-sent to its asker, and the
// second seat's request deals the next game with the other dealer.
func (p *play) rematch(c *conn, gameNo int) {
	p.inRoom(c, func(ctx context.Context, r *room) {
		if r.sess == nil {
			c.enqueue(newErrorFrame(CodeBadRequest, nil))
			return
		}
		if gameNo != r.meta.Game {
			c.enqueue(newErrorFrame(CodeStale, nil))
			resyncLocked(r, c)
			return
		}
		st, err := r.sess.Status()
		if err != nil || !st.Over {
			c.enqueue(newErrorFrame(CodeBadRequest, nil))
			return
		}
		lv := &r.live
		if lv.rematchGame != r.meta.Game {
			lv.rematch, lv.rematchGame = [2]bool{}, r.meta.Game
		}
		switch {
		case lv.rematch[c.seat]:
			c.enqueue(newRematchFrame(c.seat))
		case lv.rematch[c.seat.Other()]:
			if err := p.rooms.dealLocked(ctx, r); err != nil {
				p.log.Error("rematch deal failed", "code", r.code, "err", err)
				c.enqueue(newErrorFrame(CodeInternal, nil))
				resyncLocked(r, c)
				return
			}
			p.log.Info("rematch dealt", "code", r.code, "game", r.meta.Game)
		default:
			lv.rematch[c.seat] = true
			for _, oc := range lv.conns {
				if oc != nil {
					oc.enqueue(newRematchFrame(c.seat))
				}
			}
		}
	})
}
