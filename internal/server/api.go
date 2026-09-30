package server

// HTTP room API (two-phone W5, docs/two-phone-plan.md §3, §9):
//
//	POST /api/rooms              {name} -> 201 {code, seat: 0, token}
//	POST /api/rooms/{code}/join  {name} -> 200 {code, seat: 1, token}
//
// Errors are {code, message} with the plan §3 wire codes. The raw seat
// token appears only in a success body (Cache-Control: no-store), never in
// a log line or an error.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/ApisMellow/cuttle-web/internal/store"
)

// Wire error codes added by the server (plan §3). SERVER_FULL is new in W5
// (the live-room cap); the plan's table doesn't name one yet.
const (
	CodeBadRequest  = "BAD_REQUEST"
	CodeForbidden   = "FORBIDDEN"
	CodeInternal    = "INTERNAL"
	CodeRoomGone    = "ROOM_GONE"
	CodeRoomFull    = "ROOM_FULL"
	CodeRateLimited = "RATE_LIMITED"
	CodeServerFull  = "SERVER_FULL"
)

const (
	// MaxBodyBytes caps a room request body.
	MaxBodyBytes = 1 << 10
	// MaxNameRunes is the longest player name, after cleaning (plan §9).
	MaxNameRunes = 20
	// requestTimeout bounds the store work of one request.
	requestTimeout = 10 * time.Second
)

type api struct {
	rooms   *Rooms
	log     *slog.Logger
	create  *limiter
	join    *limiter
	trusted trustedSet
	now     func() time.Time
	// lastXFFWarn is the unix-nano time of the last "proxy sent no
	// X-Forwarded-For" warning (warnNoXFF).
	lastXFFWarn atomic.Int64
}

type nameBody struct {
	Name *string `json:"name"`
}

type claimReply struct {
	Code  string `json:"code"`
	Seat  int    `json:"seat"`
	Token string `json:"token"`
}

type errorReply struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (a *api) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !a.limit(w, r, a.create) {
		return
	}
	name, ok := a.readName(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	c, err := a.rooms.Create(ctx, name)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeClaim(w, http.StatusCreated, c)
}

func (a *api) handleJoin(w http.ResponseWriter, r *http.Request) {
	if !a.limit(w, r, a.join) {
		return
	}
	name, ok := a.readName(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	c, err := a.rooms.Join(ctx, r.PathValue("code"), name)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeClaim(w, http.StatusOK, c)
}

// limit spends one token from l for this client, or answers 429.
func (a *api) limit(w http.ResponseWriter, r *http.Request, l *limiter) bool {
	c := identify(r, a.trusted)
	if c.proxyNoXFF {
		a.warnNoXFF()
	}
	ok, wait := l.allow(c)
	if ok {
		return true
	}
	secs := int(wait / time.Second)
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeError(w, http.StatusTooManyRequests, CodeRateLimited, "too many tries; wait a minute")
	return false
}

// warnNoXFF logs, at most once a minute, that a trusted proxy sent a
// request with no usable X-Forwarded-For. Every such request is keyed by
// the proxy's own address, so all its clients share one bucket: usually
// the proxy isn't configured to set the header.
func (a *api) warnNoXFF() {
	now := a.now().UnixNano()
	last := a.lastXFFWarn.Load()
	if last != 0 && now-last < int64(time.Minute) {
		return
	}
	if a.lastXFFWarn.CompareAndSwap(last, now) {
		a.log.Warn("trusted proxy sent no usable X-Forwarded-For; its clients share one rate-limit bucket")
	}
}

// readName decodes {"name": "..."} strictly: JSON content type, at most
// MaxBodyBytes, exactly one object, no unknown fields, and a name that is
// 1..MaxNameRunes after cleanName.
func (a *api) readName(w http.ResponseWriter, r *http.Request) (string, bool) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusBadRequest, CodeBadRequest, "body must be application/json")
		return "", false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusBadRequest, CodeBadRequest, fmt.Sprintf("body over %d bytes", MaxBodyBytes))
		} else {
			writeError(w, http.StatusBadRequest, CodeBadRequest, "could not read body")
		}
		return "", false
	}
	var body nameBody
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, CodeBadRequest, "body must be {\"name\": string}")
		return "", false
	}
	if _, err := dec.Token(); err != io.EOF {
		writeError(w, http.StatusBadRequest, CodeBadRequest, "body must be a single JSON object")
		return "", false
	}
	if body.Name == nil {
		writeError(w, http.StatusBadRequest, CodeBadRequest, "name is required")
		return "", false
	}
	name, ok := cleanName(*body.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, CodeBadRequest, fmt.Sprintf("name must be 1 to %d characters", MaxNameRunes))
		return "", false
	}
	return name, true
}

// cleanName normalizes to NFC, then strips control characters,
// bidirectional-override characters (which can make a name display as
// something else) and invisible format characters (Unicode Cf: zero-width
// space, word joiner, BOM, soft hyphen, tag characters, ...), then trims
// surrounding space. The one format character kept is the zero-width
// joiner inside an emoji sequence (keepZWJ). The result must be
// 1..MaxNameRunes runes, so a name of only invisible characters is
// refused.
func cleanName(s string) (string, bool) {
	rs := []rune(norm.NFC.String(s))
	var b strings.Builder
	for i, r := range rs {
		switch {
		case unicode.IsControl(r), isBidiControl(r):
			continue
		case r == zwj:
			if !keepZWJ(rs, i) {
				continue
			}
		case unicode.Is(unicode.Cf, r):
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	n := utf8.RuneCountInString(out)
	return out, n >= 1 && n <= MaxNameRunes
}

const zwj = '\u200d'

// keepZWJ reports whether the ZWJ at rs[i] joins two emoji: the rune
// after it is a pictograph, and the rune before it is a pictograph or
// an emoji modifier or variation selector that follows one.
func keepZWJ(rs []rune, i int) bool {
	if i == 0 || i+1 >= len(rs) || !isPictograph(rs[i+1]) {
		return false
	}
	prev := rs[i-1]
	if (unicode.Is(unicode.Variation_Selector, prev) || isEmojiModifier(prev)) && i >= 2 {
		prev = rs[i-2]
	}
	return isPictograph(prev)
}

// isPictograph approximates Extended_Pictographic (Go's unicode tables
// don't carry emoji properties): the symbol blocks emoji live in.
func isPictograph(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FAFF: // cards, emoji, symbols and pictographs
		return true
	case r >= 0x2600 && r <= 0x27BF: // misc symbols, dingbats (♀ ♂ ⚕ ❤)
		return true
	case r >= 0x2B00 && r <= 0x2BFF: // arrows, ⬛ ⭐
		return true
	case r >= 0x2190 && r <= 0x21FF, r >= 0x2300 && r <= 0x23FF: // arrows, technical (⌚ ⏰)
		return true
	case r == 0x00A9, r == 0x00AE, r == 0x203C, r == 0x2049, r == 0x2122, r == 0x2139, r == 0x3030, r == 0x303D:
		return true
	}
	return false
}

func isEmojiModifier(r rune) bool { return r >= 0x1F3FB && r <= 0x1F3FF }

func isBidiControl(r rune) bool {
	switch {
	case r == '؜', r == '‎', r == '‏':
		return true
	case r >= '‪' && r <= '‮':
		return true
	case r >= '⁦' && r <= '⁩':
		return true
	}
	return false
}

// fail maps a room-manager or store error to its wire error. Unexpected
// errors are logged (they never carry a token) and answered INTERNAL.
func (a *api) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrRoomGone), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, CodeRoomGone, "this game has ended or the code is wrong")
	case errors.Is(err, ErrRoomFull), errors.Is(err, store.ErrRoomFull):
		writeError(w, http.StatusConflict, CodeRoomFull, "that game already has two players")
	case errors.Is(err, ErrServerFull), errors.Is(err, store.ErrCodeSpace):
		w.Header().Set("Retry-After", "600")
		writeError(w, http.StatusServiceUnavailable, CodeServerFull, "the server has too many games; try again later")
	default:
		a.log.Error("room request failed", "err", err)
		writeError(w, http.StatusInternalServerError, CodeInternal, "internal error")
	}
}

func writeClaim(w http.ResponseWriter, status int, c store.Claim) {
	writeJSON(w, status, claimReply{Code: c.Code, Seat: int(c.Seat), Token: c.Token})
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorReply{Code: code, Message: message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status, body = http.StatusInternalServerError, []byte(`{"code":"INTERNAL","message":"internal error"}`)
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
