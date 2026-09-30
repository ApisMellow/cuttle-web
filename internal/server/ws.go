package server

// The WebSocket endpoint, GET /api/play (two-phone W6, SPEC §2.12.2,
// §2.12.5, §2.12.6).
//
// Goroutines per socket: the net/http handler goroutine runs the reader
// loop (hello, then frames) and one writer goroutine drains the
// connection's buffered queue. Room code never writes to a socket: it
// enqueues under the room lock (never blocking; a full queue drops the
// connection) and the writer writes outside every lock. Hold timers are
// time.AfterFunc callbacks that take the room lock and enqueue.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/store"
)

// maxFrameBytes caps an inbound frame (SPEC §2.12.6); over it the library
// closes with 1009.
const maxFrameBytes = 1 << 10

// playTuning is the socket timing and limits. The zero value of each
// field means SPEC §2.12.6's value (withDefaults).
type playTuning struct {
	helloTimeout time.Duration // hello must arrive within this of the upgrade
	idleTimeout  time.Duration // a socket silent this long is closed
	writeTimeout time.Duration // one frame's write
	frameRate    float64       // inbound frames per second, sustained
	frameBurst   int           // inbound burst
	// limitedClose: over the frame limit this long without a second's
	// break closes the socket.
	limitedClose       time.Duration
	sendBuffer         int // queued outbound frames before a slow consumer is dropped
	failedHelloPerHour int
}

func (t playTuning) withDefaults() playTuning {
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&t.helloTimeout, 10*time.Second)
	def(&t.idleTimeout, 45*time.Second)
	def(&t.writeTimeout, 10*time.Second)
	def(&t.limitedClose, 5*time.Second)
	if t.frameRate <= 0 {
		t.frameRate = 10
	}
	if t.frameBurst <= 0 {
		t.frameBurst = 20
	}
	if t.sendBuffer <= 0 {
		t.sendBuffer = 32
	}
	if t.failedHelloPerHour <= 0 {
		t.failedHelloPerHour = 30
	}
	return t
}

// wsWriter is the part of *websocket.Conn the writer uses (a test fakes a
// stuck one).
type wsWriter interface {
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Close(code websocket.StatusCode, reason string) error
	CloseNow() error
}

type outItem struct {
	f frame
	// closeAfter: a terminal frame; close the socket once it is written.
	closeAfter bool
}

// conn is one socket. code and seat are set once, at hello, by the reader
// goroutine before the conn is registered in a room; after that they are
// read-only.
type conn struct {
	ws   wsWriter
	code string
	seat game.Seat
	tune playTuning
	log  *slog.Logger

	out chan outItem
	// dead is closed by kill; ctx is cancelled with it, which aborts the
	// reader's and writer's in-flight socket calls.
	dead       chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	killOnce   sync.Once
	closing    atomic.Bool // a terminal frame is queued; nothing more is sent
	writerDone chan struct{}
}

func newConn(ws wsWriter, code string, seat game.Seat, tune playTuning, log *slog.Logger) *conn {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{ws: ws, code: code, seat: seat, tune: tune, log: log,
		out: make(chan outItem, tune.sendBuffer), dead: make(chan struct{}),
		ctx: ctx, cancel: cancel, writerDone: make(chan struct{})}
}

// enqueue queues f for the writer without ever blocking. A full queue
// means a slow consumer: the connection is dropped. It reports whether f
// was queued.
func (c *conn) enqueue(f frame) bool {
	if c.closing.Load() {
		return false
	}
	select {
	case <-c.dead:
		return false
	default:
	}
	select {
	case c.out <- outItem{f: f}:
		return true
	default:
		c.log.Warn("slow consumer dropped", "code", c.code, "seat", int(c.seat))
		c.kill()
		return false
	}
}

// terminal queues f as the socket's last frame, then a close.
func (c *conn) terminal(f frame) {
	if !c.closing.CompareAndSwap(false, true) {
		return
	}
	select {
	case <-c.dead:
	case c.out <- outItem{f: f, closeAfter: true}:
	default:
		c.kill()
	}
}

// kill drops the connection at once (a bare close). Never blocks.
func (c *conn) kill() {
	c.killOnce.Do(func() {
		close(c.dead)
		c.cancel()
	})
}

// writeLoop writes queued frames until the connection dies.
func (c *conn) writeLoop() {
	defer close(c.writerDone)
	defer func() {
		if v := recover(); v != nil {
			c.log.Error("socket writer panic recovered", "type", fmt.Sprintf("%T", v))
		}
		c.kill()
		_ = c.ws.CloseNow()
	}()
	for {
		select {
		case <-c.dead:
			return
		case it := <-c.out:
			b, err := json.Marshal(it.f)
			if err != nil {
				c.log.Error("frame encoding failed", "type", fmt.Sprintf("%T", it.f))
				return
			}
			ctx, cancel := context.WithTimeout(c.ctx, c.tune.writeTimeout)
			err = c.ws.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				return
			}
			if it.closeAfter {
				_ = c.ws.Close(websocket.StatusNormalClosure, "")
				return
			}
		}
	}
}

// frameBucket is the per-socket inbound rate limit (SPEC §2.12.6). Only
// the reader goroutine touches it.
type frameBucket struct {
	rate, burst, tokens float64
	at                  time.Time
	// limitedSince starts a run of denials; a second with no denial ends it.
	limitedSince, lastDenied, lastNotice time.Time
}

func newFrameBucket(t playTuning, now time.Time) *frameBucket {
	return &frameBucket{rate: t.frameRate, burst: float64(t.frameBurst), tokens: float64(t.frameBurst), at: now}
}

// take spends a token. When it can't, notify says whether to send
// RATE_LIMITED (at most once a second) and over whether the socket has
// been over the limit for limit straight.
func (b *frameBucket) take(now time.Time, limit time.Duration) (ok, notify, over bool) {
	if el := now.Sub(b.at).Seconds(); el > 0 {
		b.tokens = math.Min(b.burst, b.tokens+el*b.rate)
	}
	b.at = now
	if b.tokens >= 1 {
		b.tokens--
		return true, false, false
	}
	if b.limitedSince.IsZero() || now.Sub(b.lastDenied) > time.Second {
		b.limitedSince = now
	}
	b.lastDenied = now
	if now.Sub(b.lastNotice) >= time.Second {
		b.lastNotice, notify = now, true
	}
	return false, notify, now.Sub(b.limitedSince) >= limit
}

// socketTracker counts the play handlers that are running (each one owns
// a hijacked connection net/http no longer tracks), per client key and in
// total, for the socket caps and for shutdown. The zero value is ready.
type socketTracker struct {
	mu     sync.Mutex
	n      int
	perKey map[string]int
	conns  map[*conn]struct{}
	idle   []chan struct{}
}

// acquire claims a slot for key unless the total or key's count is at its
// cap.
func (t *socketTracker) acquire(key string, max, maxPerKey int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.n >= max || t.perKey[key] >= maxPerKey {
		return false
	}
	if t.perKey == nil {
		t.perKey = map[string]int{}
	}
	t.n++
	t.perKey[key]++
	return true
}

// track records c so killAll can reach it before it is bound to a room.
func (t *socketTracker) track(c *conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conns == nil {
		t.conns = map[*conn]struct{}{}
	}
	t.conns[c] = struct{}{}
}

// release frees key's slot (and c's entry, if tracked) once its handler
// is done with the socket.
func (t *socketTracker) release(key string, c *conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.n--
	if t.perKey[key]--; t.perKey[key] <= 0 {
		delete(t.perKey, key)
	}
	if c != nil {
		delete(t.conns, c)
	}
	if t.n == 0 {
		for _, ch := range t.idle {
			close(ch)
		}
		t.idle = nil
	}
}

// killAll drops every tracked socket (bare close), bound or not.
func (t *socketTracker) killAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for c := range t.conns {
		c.kill()
	}
}

// wait blocks until no handler is running or timeout passes, and reports
// whether none is.
func (t *socketTracker) wait(timeout time.Duration) bool {
	t.mu.Lock()
	if t.n == 0 {
		t.mu.Unlock()
		return true
	}
	ch := make(chan struct{})
	t.idle = append(t.idle, ch)
	t.mu.Unlock()
	tm := time.NewTimer(timeout)
	defer tm.Stop()
	select {
	case <-ch:
		return true
	case <-tm.C:
		return false
	}
}

// handle upgrades GET /api/play. The Origin must be allowed (CORS has
// already refused a foreign one; a missing Origin is refused here, since
// every browser sends one on a WebSocket upgrade).
func (p *play) handle(w http.ResponseWriter, r *http.Request) {
	if !p.origins.Allowed(r.Header.Get("Origin")) {
		writeError(w, http.StatusForbidden, CodeForbidden, "origin not allowed")
		return
	}
	if p.closed.Load() {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, CodeInternal, "the server is restarting")
		return
	}
	client := identify(r, p.trusted)
	// Socket caps: over either one the upgrade is refused before any
	// goroutine or socket exists. The client key is not logged.
	socks := &p.rooms.sockets
	if !socks.acquire(client.key, p.maxSockets, p.maxSocketsPerClient) {
		p.log.Warn("socket cap reached; upgrade refused")
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusServiceUnavailable, CodeServerFull, "too many connections; try again later")
		return
	}
	var c *conn
	defer func() { socks.release(client.key, c) }()
	// The Origin was checked above against the exact policy, so the
	// library's own same-host check is skipped.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true,
		CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return // Accept has answered the request
	}
	ws.SetReadLimit(maxFrameBytes)
	c = newConn(ws, "", 0, p.tune, p.log)
	socks.track(c)
	// closeAll sets closed before it kills the tracked sockets, so a
	// socket tracked after that sweep sees closed here.
	if p.closed.Load() {
		c.kill()
	}
	go c.writeLoop()
	p.serve(c, ws, client)
}

// serve runs the socket: hello, then frames until it closes.
func (p *play) serve(c *conn, ws *websocket.Conn, client clientID) {
	defer p.finish(c)
	defer func() {
		if v := recover(); v != nil {
			p.log.Error("socket panic recovered", "type", fmt.Sprintf("%T", v))
		}
	}()
	ctx, cancel := context.WithTimeout(c.ctx, p.tune.helloTimeout)
	typ, data, err := ws.Read(ctx)
	cancel()
	if err != nil {
		return // deadline, oversize or gone: bare close
	}
	if !p.hello(c, typ, data, client) {
		return
	}
	bucket := newFrameBucket(p.tune, time.Now())
	for !c.closing.Load() {
		ctx, cancel := context.WithTimeout(c.ctx, p.tune.idleTimeout)
		typ, data, err := ws.Read(ctx)
		cancel()
		if err != nil {
			return // idle, oversize, closed or killed
		}
		ok, notify, over := bucket.take(time.Now(), p.tune.limitedClose)
		if over {
			p.log.Warn("socket over the frame limit; closing", "code", c.code, "seat", int(c.seat))
			return
		}
		if !ok {
			if notify {
				c.enqueue(newErrorFrame(CodeRateLimited, nil))
			}
			continue
		}
		p.frame(c, typ, data)
	}
}

// finish tears a socket down: a queued terminal frame gets its chance to
// be written, then the writer stops and the seat is unbound.
func (p *play) finish(c *conn) {
	if c.closing.Load() {
		select {
		case <-c.writerDone:
		case <-time.After(c.tune.writeTimeout + 6*time.Second):
		}
	}
	c.kill()
	<-c.writerDone
	p.unregister(c)
}

// decodeIn decodes one client frame.
func decodeIn(typ websocket.MessageType, data []byte) (inFrame, bool) {
	var f inFrame
	if typ != websocket.MessageText || json.Unmarshal(data, &f) != nil {
		return inFrame{}, false
	}
	return f, true
}

// hello authenticates the first frame and binds the socket to its seat.
// Every refusal is an error frame, then a close. Only UNAUTHORIZED and
// ROOM_GONE count toward the failed-hello limit (SPEC §2.12.6).
func (p *play) hello(c *conn, typ websocket.MessageType, data []byte, client clientID) bool {
	refuse := func(code, reason string) bool {
		p.log.Info("hello refused", "reason", reason)
		c.terminal(newErrorFrame(code, nil))
		return false
	}
	f, ok := decodeIn(typ, data)
	if !ok || f.T != "hello" || f.V == nil || f.Code == nil || f.Token == nil {
		return refuse(CodeBadRequest, "malformed")
	}
	if *f.V != protocolVersion {
		return refuse(CodeUpgradeRequired, "version")
	}
	// A token is reserved before the lookup and refunded unless the hello
	// fails as a guess, so parallel guesses can't all slip past one check.
	// The token is always looked at: an exhausted budget refuses only the
	// guesses (with no verdict), never a seat's real token.
	res, reserved := p.failed.reserve(client)
	ctx, cancel := storeCtx()
	defer cancel()
	seat, err := p.rooms.st.Authenticate(ctx, *f.Code, *f.Token)
	guess := errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrUnauthorized)
	if reserved && !guess {
		p.failed.refund(res)
	}
	switch {
	case guess && !reserved:
		return refuse(CodeRateLimited, "failed-hello limit")
	case errors.Is(err, store.ErrNotFound):
		return refuse(CodeRoomGone, "room gone")
	case errors.Is(err, store.ErrUnauthorized):
		return refuse(CodeUnauthorized, "bad token")
	case err != nil:
		p.log.Error("hello: authenticate failed", "err", err)
		return refuse(CodeInternal, "store")
	}
	code, err := store.NormalizeCode(*f.Code)
	if err != nil {
		return refuse(CodeRoomGone, "room gone")
	}
	c.code, c.seat = code, game.Seat(seat)
	err = p.rooms.withRoom(ctx, code, func(r *room) error { return p.registerLocked(r, c) })
	switch {
	case err == nil:
		return true
	case errors.Is(err, errShuttingDown):
		c.kill()
	case errors.Is(err, ErrRoomGone):
		// The token matched a moment ago: an expiry race, not a guess.
		c.terminal(newErrorFrame(CodeRoomGone, nil))
	default:
		p.log.Error("hello: loading the room failed", "code", code, "err", err)
		c.terminal(newErrorFrame(CodeInternal, nil))
	}
	c.code = "" // never bound
	return false
}

// frame handles one frame after the hello.
func (p *play) frame(c *conn, typ websocket.MessageType, data []byte) {
	f, ok := decodeIn(typ, data)
	if !ok {
		c.enqueue(newErrorFrame(CodeBadRequest, nil))
		return
	}
	switch f.T {
	case "ping":
		c.enqueue(newPongFrame())
	case "move":
		if f.Game == nil || f.Seq == nil || f.Index == nil {
			c.enqueue(newErrorFrame(CodeBadRequest, f.Seq))
			return
		}
		p.move(c, *f.Game, *f.Seq, *f.Index)
	case "rematch":
		if f.Game == nil {
			c.enqueue(newErrorFrame(CodeBadRequest, nil))
			return
		}
		p.rematch(c, *f.Game)
	default:
		c.enqueue(newErrorFrame(CodeBadRequest, nil))
	}
}
