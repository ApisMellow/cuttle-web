package server

// Room manager tests (two-phone W5, docs/two-phone-plan.md §4, §5).

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle-web/internal/store"
)

func TestRooms_CreateJoinDealsAndBothSeatsAuthenticate(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, c1 := e.createJoin(t)
	if c0.Seat != 0 || c1.Seat != 1 || c0.Code != c1.Code || c0.Token == "" || c1.Token == "" || c0.Token == c1.Token {
		t.Fatalf("claims %v/%v %v/%v", c0.Code, c0.Seat, c1.Code, c1.Seat)
	}
	for want, tok := range []string{c0.Token, c1.Token} {
		seat, err := e.st.Authenticate(bg, c0.Code, tok)
		if err != nil || int(seat) != want {
			t.Fatalf("seat %d authenticate: %v %v", want, seat, err)
		}
	}
	r, err := e.st.Get(bg, c0.Code)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != store.StatusActive || r.Game != 1 || r.Seq != 0 || r.Snapshot == nil ||
		(r.LastDealer != 0 && r.LastDealer != 1) || r.Names != [2]string{"Alice", "Blake"} {
		t.Fatalf("stored room after join: status %s game %d seq %d dealer %d names %v snapshot %t",
			r.Status, r.Game, r.Seq, r.LastDealer, r.Names, r.Snapshot != nil)
	}
	for _, seat := range []game.Seat{0, 1} {
		env, err := e.rooms.View(bg, c0.Code, seat)
		if err != nil {
			t.Fatalf("view %d: %v", seat, err)
		}
		if env.Seq != 0 || int(env.State.Viewer) != int(seat) {
			t.Fatalf("seat %d envelope seq %d viewer %d", seat, env.Seq, env.State.Viewer)
		}
		// The dealer's opponent acts first.
		if int(env.State.Active) != 1-r.LastDealer {
			t.Fatalf("active %d with dealer %d", env.State.Active, r.LastDealer)
		}
	}
}

func TestRooms_DealIsRandom(t *testing.T) {
	// Seeds and dealers come from crypto/rand: ten rooms don't all get the
	// same opening hand, and both dealers turn up.
	e := newEnv(t, RoomsOptions{})
	hands := map[string]bool{}
	dealers := map[int]bool{}
	for i := 0; i < 10; i++ {
		c0, _ := e.createJoin(t)
		env, err := e.rooms.View(bg, c0.Code, 0)
		if err != nil {
			t.Fatal(err)
		}
		hands[jsonString(t, env.State.You.Hand)] = true
		r, _ := e.st.Get(bg, c0.Code)
		dealers[r.LastDealer] = true
	}
	if len(hands) < 2 || len(dealers) < 2 {
		t.Fatalf("deals are not random: %d hands, dealers %v", len(hands), dealers)
	}
}

func TestRooms_WaitingRoomHasNoGame(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, err := e.rooms.Create(bg, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.rooms.View(bg, c0.Code, 0); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("view of a waiting room: %v", err)
	}
	if _, err := e.rooms.Move(bg, c0.Code, 0, 0, 0); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("move in a waiting room: %v", err)
	}
}

func TestRooms_UnknownMalformedAndExpiredAreGone(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	for _, code := range []string{"ZZZZ", "", "abc", "ABCDE", "U!!!"} {
		if _, err := e.rooms.Join(bg, code, "Blake"); !errors.Is(err, ErrRoomGone) {
			t.Errorf("join %q: %v", code, err)
		}
		if _, err := e.rooms.View(bg, code, 0); !errors.Is(err, ErrRoomGone) {
			t.Errorf("view %q: %v", code, err)
		}
		if e.cached(code) {
			t.Errorf("%q left in memory", code)
		}
	}

	waiting, _ := e.rooms.Create(bg, "Alice")
	active, _ := e.createJoin(t)
	env, err := e.rooms.View(bg, active.Code, 0)
	if err != nil {
		t.Fatal(err)
	}
	actor := game.Seat(env.State.Active)
	e.clk.Advance(store.DefaultIdleTTL + time.Millisecond)
	if _, err := e.rooms.Join(bg, waiting.Code, "Blake"); !errors.Is(err, ErrRoomGone) {
		t.Errorf("join expired: %v", err)
	}
	if e.cached(waiting.Code) {
		t.Error("expired waiting room left in memory")
	}
	// The active room is still cached, but its save finds no row and the
	// reload finds nothing: gone, and dropped from memory at once.
	if _, err := e.rooms.Move(bg, active.Code, actor, 0, 0); !errors.Is(err, ErrRoomGone) {
		t.Errorf("move on expired: %v", err)
	}
	if e.cached(active.Code) {
		t.Error("expired active room left in memory")
	}
	if _, err := e.rooms.View(bg, active.Code, 0); !errors.Is(err, ErrRoomGone) {
		t.Errorf("view after expiry: %v", err)
	}
}

func TestRooms_JoinFullRoom(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	if _, err := e.rooms.Join(bg, c0.Code, "Casey"); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("third join: %v", err)
	}
	// Lower-case and Crockford aliases reach the same room.
	if _, err := e.rooms.Join(bg, strings.ToLower(c0.Code), "Casey"); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("lower-case join: %v", err)
	}
}

func TestRooms_JoinRace(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, err := e.rooms.Create(bg, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	const n = 16
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.rooms.Join(bg, c0.Code, "Blake")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	ok, full := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrRoomFull):
			full++
		default:
			t.Errorf("unexpected %v", err)
		}
	}
	if ok != 1 || full != n-1 {
		t.Fatalf("ok %d full %d", ok, full)
	}
	if got := e.fs.saves.Load(); got != 1 {
		t.Fatalf("dealt %d times", got)
	}
}

func TestRooms_CrashBetweenJoinAndDeal(t *testing.T) {
	t.Run("seat claimed outside the manager", func(t *testing.T) {
		// A process that died after store.Join and before the deal leaves an
		// active room with no snapshot; the next load deals it.
		e := newEnv(t, RoomsOptions{})
		c0, err := e.st.Create(bg, "Alice")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.st.Join(bg, c0.Code, "Blake"); err != nil {
			t.Fatal(err)
		}
		if r, _ := e.st.Get(bg, c0.Code); r.Snapshot != nil || r.Status != store.StatusActive {
			t.Fatal("setup: expected an undealt active room")
		}
		env, err := e.rooms.View(bg, c0.Code, 1)
		if err != nil {
			t.Fatalf("view: %v", err)
		}
		r, _ := e.st.Get(bg, c0.Code)
		if r.Snapshot == nil || r.Game != 1 || r.Seq != 0 || env.Seq != 0 {
			t.Fatalf("not dealt on load: game %d seq %d", r.Game, r.Seq)
		}
	})
	t.Run("deal save fails during join", func(t *testing.T) {
		e := newEnv(t, RoomsOptions{})
		c0, err := e.rooms.Create(bg, "Alice")
		if err != nil {
			t.Fatal(err)
		}
		e.fs.failSaves.Store(1)
		c1, err := e.rooms.Join(bg, c0.Code, "Blake")
		if err != nil || c1.Token == "" {
			// The seat is claimed in the store; the token must still reach
			// the joiner or seat 1 is lost for good.
			t.Fatalf("join with a failed deal: %v", err)
		}
		if r, _ := e.st.Get(bg, c0.Code); r.Snapshot != nil {
			t.Fatal("a snapshot was stored although the save failed")
		}
		if _, err := e.rooms.View(bg, c0.Code, 0); err != nil {
			t.Fatalf("view after failed deal: %v", err)
		}
		if r, _ := e.st.Get(bg, c0.Code); r.Snapshot == nil || r.Game != 1 {
			t.Fatal("room not dealt on the next access")
		}
	})
	t.Run("deal on load fails", func(t *testing.T) {
		e := newEnv(t, RoomsOptions{})
		c0, _ := e.st.Create(bg, "Alice")
		_, _ = e.st.Join(bg, c0.Code, "Blake")
		e.fs.failSaves.Store(1)
		if _, err := e.rooms.View(bg, c0.Code, 0); err == nil || errors.Is(err, ErrRoomGone) {
			t.Fatalf("view with a failing deal: %v", err)
		}
		if _, err := e.rooms.View(bg, c0.Code, 0); err != nil {
			t.Fatalf("retry: %v", err)
		}
	})
}

// firstMove plays legal move 0 for whoever is to act.
func firstMove(t *testing.T, e *env, code string) (game.Seat, game.Update) {
	t.Helper()
	for _, seat := range []game.Seat{0, 1} {
		env, err := e.rooms.View(bg, code, seat)
		if err != nil {
			t.Fatal(err)
		}
		if len(env.LegalMoves) > 0 {
			up, err := e.rooms.Move(bg, code, seat, env.Seq, 0)
			if err != nil {
				t.Fatalf("move: %v", err)
			}
			return seat, up
		}
	}
	t.Fatal("nobody can move")
	return 0, game.Update{}
}

func TestRooms_MovePersistsInTheSameCriticalSection(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	seat, up := firstMove(t, e, c0.Code)
	if up.Seq != 1 || up.Mover != seat {
		t.Fatalf("update %v", up)
	}
	r, _ := e.st.Get(bg, c0.Code)
	if r.Game != 1 || r.Seq != 1 {
		t.Fatalf("stored game %d seq %d", r.Game, r.Seq)
	}
	// A restore from the stored snapshot matches memory.
	s, err := game.RestoreSession(r.Snapshot)
	if err != nil || s.Seq() != 1 {
		t.Fatalf("restore: %v", err)
	}
	// Stale and out-of-turn moves are the Session's errors, nothing saved.
	if _, err := e.rooms.Move(bg, c0.Code, seat, 0, 0); !errors.Is(err, game.ErrStale) {
		t.Fatalf("stale: %v", err)
	}
	if got := e.fs.saves.Load(); got != 2 {
		t.Fatalf("saves %d, want 2 (deal + move)", got)
	}
}

func TestRooms_PersistFailureReloadsFromStore(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	before, _ := e.rooms.View(bg, c0.Code, 0)
	actor := game.Seat(before.State.Active)

	e.fs.failSaves.Store(1)
	if _, err := e.rooms.Move(bg, c0.Code, actor, 0, 0); err == nil {
		t.Fatal("move with a failing save returned no error")
	}
	// Memory never runs ahead of disk: still seq 0, same hand.
	after, err := e.rooms.View(bg, c0.Code, 0)
	if err != nil {
		t.Fatal(err)
	}
	if after.Seq != 0 || jsonString(t, after) != jsonString(t, before) {
		t.Fatalf("memory ran ahead of the store: seq %d", after.Seq)
	}
	if r, _ := e.st.Get(bg, c0.Code); r.Seq != 0 {
		t.Fatalf("stored seq %d", r.Seq)
	}
	// The same move now succeeds.
	if up, err := e.rooms.Move(bg, c0.Code, actor, 0, 0); err != nil || up.Seq != 1 {
		t.Fatalf("retry: %v", err)
	}
}

func TestRooms_RoomCap(t *testing.T) {
	e := newEnv(t, RoomsOptions{MaxRooms: 3})
	for i := 0; i < 3; i++ {
		if _, err := e.rooms.Create(bg, "Alice"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.rooms.Create(bg, "Alice"); !errors.Is(err, ErrServerFull) {
		t.Fatalf("fourth create: %v", err)
	}
	// Expired rooms stop counting even before the janitor runs.
	e.clk.Advance(store.DefaultIdleTTL + time.Millisecond)
	if _, err := e.rooms.Create(bg, "Alice"); err != nil {
		t.Fatalf("create after expiry: %v", err)
	}
}

func TestRooms_RoomCapUnderConcurrentCreates(t *testing.T) {
	e := newEnv(t, RoomsOptions{MaxRooms: 5})
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := e.rooms.Create(bg, "Alice"); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			} else if !errors.Is(err, ErrServerFull) {
				t.Errorf("create: %v", err)
			}
		}()
	}
	wg.Wait()
	if n, _ := e.st.Count(bg); ok != 5 || n != 5 {
		t.Fatalf("created %d, stored %d, want 5", ok, n)
	}
}

func TestRooms_SweepDeletesExpiredAndDropsIdle(t *testing.T) {
	e := newEnv(t, RoomsOptions{MemIdle: time.Hour})
	old, _ := e.createJoin(t)
	if _, err := e.rooms.View(bg, old.Code, 0); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(2 * time.Hour)
	fresh, _ := e.createJoin(t)
	if _, err := e.rooms.View(bg, fresh.Code, 0); err != nil {
		t.Fatal(err)
	}
	// old is idle in memory (2h > 1h) but alive in the store.
	deleted, dropped, err := e.rooms.Sweep(bg)
	if err != nil || deleted != 0 || dropped != 1 {
		t.Fatalf("sweep 1: deleted %d dropped %d err %v", deleted, dropped, err)
	}
	if e.cached(old.Code) || !e.cached(fresh.Code) {
		t.Fatal("idle room not dropped, or fresh room dropped")
	}
	// Reloading an idle-dropped room works.
	if _, err := e.rooms.View(bg, old.Code, 0); err != nil {
		t.Fatalf("reload: %v", err)
	}
	e.clk.Advance(store.DefaultIdleTTL + time.Minute)
	deleted, _, err = e.rooms.Sweep(bg)
	if err != nil || deleted != 2 {
		t.Fatalf("sweep 2: deleted %d err %v", deleted, err)
	}
	if e.cached(old.Code) || e.cached(fresh.Code) {
		t.Fatal("expired rooms left in memory")
	}
	if n, _ := e.st.Count(bg); n != 0 {
		t.Fatalf("%d rooms left in the store", n)
	}
}

func TestRooms_SweepDropsStoreExpiredEvenIfRecentlyUsed(t *testing.T) {
	// A room touched in memory (a View) but with no store write for a day is
	// expired: the store is the authority.
	e := newEnv(t, RoomsOptions{MemIdle: 48 * time.Hour})
	c0, _ := e.createJoin(t)
	e.clk.Advance(store.DefaultIdleTTL - time.Minute)
	if _, err := e.rooms.View(bg, c0.Code, 0); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(2 * time.Minute)
	if _, _, err := e.rooms.Sweep(bg); err != nil {
		t.Fatal(err)
	}
	if e.cached(c0.Code) {
		t.Fatal("expired room kept in memory")
	}
}

func TestRooms_JanitorRunsAndStops(t *testing.T) {
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	e.clk.Advance(store.DefaultIdleTTL + time.Minute)
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		e.rooms.RunJanitor(ctx, 5*time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if n, _ := e.st.Count(bg); n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("janitor never deleted the expired room")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("janitor did not stop on cancel")
	}
	if e.cached(c0.Code) {
		t.Fatal("expired room left in memory")
	}
}

func TestRooms_ConcurrentMovesAreSerialized(t *testing.T) {
	// Many goroutines race to play move 0 at seq 0: exactly one lands, the
	// rest are stale or out of turn, and the store agrees with memory.
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	landed := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(seat game.Seat) {
			defer wg.Done()
			_, err := e.rooms.Move(bg, c0.Code, seat, 0, 0)
			if err == nil {
				mu.Lock()
				landed++
				mu.Unlock()
			}
			_, _ = e.rooms.View(bg, c0.Code, seat)
		}(game.Seat(i & 1))
	}
	wg.Wait()
	r, _ := e.st.Get(bg, c0.Code)
	env, _ := e.rooms.View(bg, c0.Code, 0)
	if landed != 1 || r.Seq != 1 || env.Seq != 1 {
		t.Fatalf("landed %d, stored seq %d, memory seq %d", landed, r.Seq, env.Seq)
	}
}

func TestRooms_GameOverUpdatesStatusAndTally(t *testing.T) {
	// Play move 0 until the game ends (bounded); the stored status becomes
	// finished and the winner's tally is 1.
	e := newEnv(t, RoomsOptions{})
	c0, _ := e.createJoin(t)
	for i := 0; i < 2000; i++ {
		env0, err := e.rooms.View(bg, c0.Code, 0)
		if err != nil {
			t.Fatal(err)
		}
		r, _ := e.st.Get(bg, c0.Code)
		if r.Status == store.StatusFinished {
			if env0.State.Winner != nil {
				w := int(*env0.State.Winner)
				if r.Tally[w] != 1 || r.Tally[1-w] != 0 {
					t.Fatalf("tally %v winner %d", r.Tally, w)
				}
			} else if r.Tally != [2]int{} {
				t.Fatalf("stalemate tally %v", r.Tally)
			}
			return
		}
		seat := game.Seat(env0.State.Active)
		env, _ := e.rooms.View(bg, c0.Code, seat)
		if len(env.LegalMoves) == 0 {
			t.Skip("stuck position (SPEC §2.10); not this test's concern")
		}
		if _, err := e.rooms.Move(bg, c0.Code, seat, env.Seq, 0); err != nil {
			t.Fatalf("move %d: %v", i, err)
		}
	}
	t.Fatal("game did not end in 2000 moves")
}
