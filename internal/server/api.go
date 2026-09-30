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
	"time"
	"unicode"
	"unicode/utf8"

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
	ok, wait := l.allow(clientKey(r, a.trusted))
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

// cleanName strips control characters and bidirectional-override
// characters (which can make a name display as something else), then
// trims surrounding space. The result must be 1..MaxNameRunes runes. Other
// format characters, such as the zero-width joiner inside emoji, stay.
func cleanName(s string) (string, bool) {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) || isBidiControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	n := utf8.RuneCountInString(out)
	return out, n >= 1 && n <= MaxNameRunes
}

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
