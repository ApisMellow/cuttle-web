package game

// W2 review nit (fixed in two-phone W5): a recovered panic value can carry
// card state, so it must never reach an Error's Message (which a server may
// send to a client). It goes only to the server-side PanicHook.

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/ApisMellow/cuttle/engine"
)

const panicSecret = "SECRET-Q-of-hearts-in-deck"

// capturePanics installs a hook for the test and returns what it saw.
func capturePanics(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	SetPanicHook(func(v any) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, fmt.Sprint(v))
	})
	t.Cleanup(func() { SetPanicHook(nil) })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

func sawSecret(seen []string) bool {
	for _, s := range seen {
		if strings.Contains(s, panicSecret) {
			return true
		}
	}
	return false
}

func TestW5_RestorePanicValueNotInError(t *testing.T) {
	seen := capturePanics(t)
	good := []byte(persisted(t, mustSession(t, 9, Seat0)))
	_, err := restoreSession(good, func(engine.GameState, []AppliedMove, engine.PlayerID) Envelope {
		panic(panicSecret)
	})
	wantErr(t, "restore", err, ErrInvalidSnapshot, CodeInvalidSnapshot)
	if strings.Contains(err.Error(), panicSecret) {
		t.Fatalf("panic value leaked into the error: %q", err.Error())
	}
	if !sawSecret(seen()) {
		t.Fatal("panic value never reached the hook")
	}
}

func TestW5_ApplyPanicValueNotInError(t *testing.T) {
	seen := capturePanics(t)
	s := mustSession(t, 3, Seat0)
	st := s.Status()
	s.render = func(engine.GameState, []AppliedMove, engine.PlayerID) Envelope { panic(panicSecret) }
	_, err := s.Apply(st.Actor, st.Seq, 0)
	wantErr(t, "apply", err, ErrInternal, CodeInternal)
	if strings.Contains(err.Error(), panicSecret) {
		t.Fatalf("panic value leaked into the error: %q", err.Error())
	}
	if !sawSecret(seen()) {
		t.Fatal("panic value never reached the hook")
	}
}

func TestW5_NilPanicHookIsSafe(t *testing.T) {
	SetPanicHook(nil)
	s := mustSession(t, 3, Seat0)
	st := s.Status()
	s.render = func(engine.GameState, []AppliedMove, engine.PlayerID) Envelope { panic(panicSecret) }
	if _, err := s.Apply(st.Actor, st.Seq, 0); err == nil || strings.Contains(err.Error(), panicSecret) {
		t.Fatalf("err %v", err)
	}
}
