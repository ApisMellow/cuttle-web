package server

// Issue #93, engine v0.3.0 (counter rewind), server side: design §8 S1.
// A one-off resolves at once and the counter is the first move of the
// counterer's own turn, so there is no counter hold (SPEC §2.12.5): every
// saved move goes to both seats as state at once, no responding frame is
// ever sent, and nothing Alice receives depends on whether Blake holds a 2.
// The protocol is v2 (SPEC §2.12.7), and -respond-min-ms is a no-op kept
// for one release.

import (
	"strings"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/game"
	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// syncTo pumps frames until both seats hold the envelope at seq. The duo's
// absorb fails on any responding frame.
func (d *duo) syncTo(seq int) {
	d.t.Helper()
	for !d.bothSee(seq) {
		if !d.pump(3 * time.Second) {
			d.t.Fatalf("seats never both reached seq %d (have %v / %v)", seq, envSeq(d.env[0]), envSeq(d.env[1]))
		}
	}
}

func envSeq(e *game.Envelope) int {
	if e == nil {
		return -1
	}
	return e.Seq
}

// playDesc plays seat's move with description desc once both seats are
// current, and waits until both seats have the result.
func (d *duo) playDesc(seat game.Seat, desc string) {
	t := d.t
	t.Helper()
	seq := d.truth.Seq()
	d.syncTo(seq)
	if st := d.st(); st.Actor != seat || st.Over {
		t.Fatalf("seq %d: actor %d (over %v), want seat %d to play %q", seq, st.Actor, st.Over, seat, desc)
	}
	env := d.env[seat]
	idx := -1
	for i, s := range env.Descriptions {
		if s == desc {
			idx = i
		}
	}
	if idx < 0 {
		t.Fatalf("seq %d: seat %d is not offered %q: %q", seq, seat, desc, env.Descriptions)
	}
	d.move(seat, idx)
	d.syncTo(seq + 1)
}

// oneOffStart: Alice holds A♣ and 10♥ and moves first; Blake holds 7♣ and
// blakeLast.
func oneOffStart(blakeLast card.Card) engine.GameState {
	return engine.GameState{
		Players: [2]engine.PlayerState{
			{Hand: []card.Card{ck(card.Ace, card.Clubs), ck(card.Ten, card.Hearts)}},
			{Hand: []card.Card{ck(card.Seven, card.Clubs), blakeLast}},
		},
		Deck:   []card.Card{ck(card.Queen, card.Hearts), ck(card.Jack, card.Diamonds), ck(card.Three, card.Hearts)},
		Active: engine.P1,
	}
}

// S1: after a counterable move (a one-off, then the counter itself) both
// seats get state at once, with counterable set for both; the mover is not
// held even under a minute-long -respond-min-ms, which no longer does
// anything.
func TestWS_S1_CounterableMoveReachesBothSeatsAtOnce(t *testing.T) {
	e := newPlayEnv(t, playOpts{cfg: func(c *Config) { c.RespondMin = time.Minute }})
	d := newCraftedDuo(t, e, oneOffStart(ck(card.Two, card.Clubs)), nil)

	start := time.Now()
	d.playDesc(0, "play A♣ as one-off")
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("the one-off reached both seats after %v", el)
	}
	for s := range 2 {
		if !d.env[s].State.Counterable {
			t.Fatalf("seat %d: counterable false after the one-off", s)
		}
		if lm := d.env[s].LastMove; lm == nil || lm.Kind != engine.MoveOneOff {
			t.Fatalf("seat %d: lastMove %+v, want the one-off", s, lm)
		}
	}
	blake := d.env[1]
	if last := blake.Descriptions[len(blake.Descriptions)-1]; last != "counter with 2♣" {
		t.Fatalf("Blake's last option %q, want the counter", last)
	}

	// The counter is Blake's first move; he plays on, and both seats see it.
	start = time.Now()
	d.playDesc(1, "counter with 2♣")
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("the counter reached both seats after %v", el)
	}
	for s := range 2 {
		if st := d.env[s].State; st.Active != engine.P2 || st.Phase != engine.PhaseNormal {
			t.Fatalf("seat %d after the counter: active %d phase %d, want Blake in phase 0", s, st.Active, st.Phase)
		}
	}
	d.playDesc(1, "draw a card")
	d.settle()
	if d.cov.counter != 1 {
		t.Fatalf("counters seen %d", d.cov.counter)
	}
}

// scriptedStart is the engine's pending-win position (engine
// pending_win_test.go pwBase, via internal/game's pendingWinStart): Alice
// has 10♥ + 4♥ = 14 and her 7♥ sits under Blake's J♠, so her 2♠ popping
// the Jack makes 21 on a counterable turn. Alice also holds two 4s; Blake
// holds 10♠ and two 2s.
func scriptedStart() engine.GameState {
	return engine.GameState{
		Players: [2]engine.PlayerState{
			{
				Hand: []card.Card{ck(card.Two, card.Spades), ck(card.Ten, card.Diamonds), ck(card.Four, card.Diamonds), ck(card.Four, card.Clubs)},
				Points: []engine.PointEntry{{Card: ck(card.Ten, card.Hearts), Owner: engine.P1},
					{Card: ck(card.Four, card.Hearts), Owner: engine.P1}},
			},
			{
				Hand: []card.Card{ck(card.Ten, card.Spades), ck(card.Two, card.Clubs), ck(card.Two, card.Diamonds)},
				Points: []engine.PointEntry{
					{Card: ck(card.Seven, card.Hearts), Owner: engine.P1, JackStack: []card.Card{ck(card.Jack, card.Spades)}, JackOwners: []engine.PlayerID{engine.P2}},
					{Card: ck(card.Five, card.Diamonds), Owner: engine.P2},
				},
			},
		},
		Deck:   []card.Card{ck(card.Queen, card.Hearts), ck(card.Seven, card.Diamonds), ck(card.Three, card.Hearts)},
		Scrap:  []card.Card{ck(card.Four, card.Spades)},
		Active: engine.P2,
	}
}

// S1: no responding frame across a scripted game with a one-off, a
// counter, a 4 and its owed discard, and a pending win settled by "Let it
// happen". Every move reaches both seats as state (the duo checks each
// against that seat's own view at that seq).
func TestWS_S1_NoRespondingInAScriptedGame(t *testing.T) {
	e := newPlayEnv(t, playOpts{})
	frames := map[string]int{}
	d := newCraftedDuo(t, e, scriptedStart(), func(_ *duo, _ game.Seat, f frameIn) { frames[f.T]++ })

	d.playDesc(1, "draw a card")
	d.playDesc(0, "play 4♦ as one-off")
	if st := d.env[1].State; st.Phase != engine.PhaseAwaitingDiscard || st.Pending != nil || st.OwedDiscards.You != 2 || !st.Counterable {
		t.Fatalf("Blake after the 4: phase %d pending %v owed %+v counterable %v", st.Phase, st.Pending, st.OwedDiscards, st.Counterable)
	}
	// Blake counters the 4 from the owed-discard step: the debt is undone.
	d.playDesc(1, "counter with 2♦")
	if st := d.env[1].State; st.Phase != engine.PhaseNormal || st.OwedDiscards.You != 0 {
		t.Fatalf("Blake after the counter: phase %d owed %+v", st.Phase, st.OwedDiscards)
	}
	d.playDesc(1, "draw a card")
	// Alice passes on her counter-back and plays the other 4; Blake pays.
	d.playDesc(0, "play 4♣ as one-off")
	d.playDesc(1, "discard hand[2] and hand[3]")
	if st := d.env[1].State; st.Phase != engine.PhaseNormal || st.Active != engine.P2 || st.OwedDiscards.You != 0 || st.Counterable {
		t.Fatalf("Blake after paying: phase %d active %d owed %+v counterable %v", st.Phase, st.Active, st.OwedDiscards, st.Counterable)
	}
	d.playDesc(1, "draw a card")
	// Alice's 2♠ pops the J♠: 21 on a counterable turn, and Blake holds 2♣.
	d.playDesc(0, "play 2♠ as one-off") // the only target: the J♠ on her 7♥
	for s := range 2 {
		if st := d.env[s].State; st.Phase != engine.PhasePendingWin || st.Active != engine.P2 || st.Winner != nil {
			t.Fatalf("seat %d after the pop: phase %d active %d winner %v, want phase 5", s, st.Phase, st.Active, st.Winner)
		}
	}
	if got := strings.Join(d.env[1].Descriptions, "|"); got != "counter with 2♣|Let it happen" {
		t.Fatalf("Blake's phase-5 options %q", got)
	}
	d.playDesc(1, "Let it happen")
	for s := range 2 {
		if st := d.env[s].State; st.Phase != engine.PhaseGameOver || st.Winner == nil || *st.Winner != engine.P1 {
			t.Fatalf("seat %d at the end: phase %d winner %v", s, st.Phase, st.Winner)
		}
	}
	d.settle()

	c := d.cov
	if c.counter != 1 || c.owedDiscard != 1 || c.pendingWin != 1 || c.letItHappen != 1 {
		t.Fatalf("the script missed a case: %+v", c)
	}
	if frames["responding"] != 0 {
		t.Fatalf("%d responding frames", frames["responding"])
	}
	// 9 moves: each seat got exactly one state per move, plus its opening one.
	if frames["state"] != 2*(d.truth.Seq()+1) {
		t.Fatalf("%d state frames for %d moves: %v", frames["state"], d.truth.Seq(), frames)
	}
}

// craftedScript is a fixed game from a hand-built position: the S1 test
// below and the W9 sweep (ws_privacy_sweep_test.go) both play these, so
// the rare counter-rewind shapes are covered by construction, not by luck.
type craftedScript struct {
	name  string
	start func() engine.GameState
	steps []twinStep
	// want lists the coverage kinds the script must reach.
	want []string
}

var craftedScripts = []craftedScript{
	{
		name:  "a 4 countered at the owed discard, a 4 paid, a pending win, Let it happen",
		start: scriptedStart,
		steps: []twinStep{
			{1, "draw a card"}, {0, "play 4♦ as one-off"}, {1, "counter with 2♦"}, {1, "draw a card"},
			{0, "play 4♣ as one-off"}, {1, "discard hand[2] and hand[3]"}, {1, "draw a card"},
			{0, "play 2♠ as one-off"}, {1, "Let it happen"},
		},
		want: []string{"counter", "owedDiscard", "fourDiscard", "pendingWin", "letItHappen", "gameOver"},
	},
	{
		// Alice's 7 reveals two Jacks with no point card to steal: a dead
		// end, scrap one. Blake counters the 7's turn.
		name: "a dead-end 7, countered",
		start: func() engine.GameState {
			return engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{ck(card.Seven, card.Clubs), ck(card.Ten, card.Hearts)}},
					{Hand: []card.Card{ck(card.Nine, card.Diamonds), ck(card.Eight, card.Spades), ck(card.Two, card.Clubs)}},
				},
				Deck:   []card.Card{ck(card.Jack, card.Diamonds), ck(card.Jack, card.Hearts), ck(card.Queen, card.Hearts), ck(card.Three, card.Hearts)},
				Active: engine.P1,
			}
		},
		steps: []twinStep{
			{0, "play 7♣ as one-off"}, {0, "7: no legal play — scrap J♦"},
			{1, "counter with 2♣"}, {1, "draw a card"},
		},
		want: []string{"sevenReveal", "deadSeven", "counter", "counteredSeven"},
	},
	{
		// Blake counters Alice's 5; Alice counters back.
		name: "a countered 5 and a counter-back",
		start: func() engine.GameState {
			return engine.GameState{
				Players: [2]engine.PlayerState{
					{Hand: []card.Card{ck(card.Five, card.Clubs), ck(card.Two, card.Spades), ck(card.Ten, card.Hearts)}},
					{Hand: []card.Card{ck(card.Nine, card.Diamonds), ck(card.Eight, card.Spades), ck(card.Two, card.Clubs)}},
				},
				Deck: []card.Card{ck(card.Queen, card.Hearts), ck(card.Jack, card.Diamonds), ck(card.Three, card.Hearts),
					ck(card.Four, card.Hearts), ck(card.Six, card.Hearts)},
				Scrap:  []card.Card{ck(card.Four, card.Spades)},
				Active: engine.P1,
			}
		},
		steps: []twinStep{
			{0, "play 5♣ as one-off"}, {1, "counter with 2♣"}, {1, "draw a card"},
			{0, "counter with 2♠"}, {0, "draw a card"},
		},
		want: []string{"fiveDraw", "counter", "counteredFive", "counterChain2"},
	},
}

// S1: no responding frame in any crafted script; each move reaches both
// seats as exactly one state each, and each script reaches its cases.
func TestWS_S1_CraftedScriptsSendNoResponding(t *testing.T) {
	for _, sc := range craftedScripts {
		t.Run(sc.name, func(t *testing.T) {
			e := newPlayEnv(t, playOpts{})
			frames := map[string]int{}
			d := newCraftedDuo(t, e, sc.start(), func(_ *duo, _ game.Seat, f frameIn) { frames[f.T]++ })
			for _, st := range sc.steps {
				d.playDesc(st.by, st.desc)
			}
			if d.st().Over {
				d.cov.gameOver++
			}
			d.settle()
			if frames["responding"] != 0 || frames["state"] != 2*(len(sc.steps)+1) {
				t.Fatalf("frames %v for %d moves", frames, len(sc.steps))
			}
			missing := map[string]bool{}
			for _, k := range d.cov.missing() {
				missing[k] = true
			}
			for _, k := range sc.want {
				if missing[k] {
					t.Errorf("the script never reached %s: %+v", k, d.cov)
				}
			}
		})
	}
}

// twinStep is one scripted move in the twin rooms.
type twinStep struct {
	by   game.Seat
	desc string
}

type twinGame struct {
	name        string
	alice       []card.Card
	blakeCommon []card.Card
	active      engine.PlayerID
	steps       []twinStep
}

// start is the game's position with Blake's last card last.
func (g twinGame) start(last card.Card) engine.GameState {
	blake := append(append([]card.Card{}, g.blakeCommon...), last)
	return engine.GameState{
		Players: [2]engine.PlayerState{{Hand: append([]card.Card{}, g.alice...)}, {Hand: blake}},
		Deck: []card.Card{ck(card.Queen, card.Hearts), ck(card.Jack, card.Diamonds), ck(card.Three, card.Hearts),
			ck(card.Ten, card.Spades), ck(card.Nine, card.Spades), ck(card.Eight, card.Diamonds), ck(card.Seven, card.Hearts)},
		Active: g.active,
	}
}

// S1: two rooms whose positions differ only in Blake's last card, a 2 in
// one and a K in the other (same hand size). After every move, none of
// them winning, Alice's frames so far are byte-identical in both rooms:
// whether Blake could counter never reaches her, not even as timing or a
// frame type. The games mirror internal/game's B1 twins.
func TestWS_S1_TwinRoomsLookIdenticalToAlice(t *testing.T) {
	games := []twinGame{
		{
			name:        "ace and six one-offs",
			alice:       []card.Card{ck(card.Ace, card.Clubs), ck(card.Six, card.Spades), ck(card.Ten, card.Hearts), ck(card.Five, card.Diamonds)},
			blakeCommon: []card.Card{ck(card.Seven, card.Clubs), ck(card.Eight, card.Spades), ck(card.Nine, card.Diamonds)},
			active:      engine.P1,
			steps: []twinStep{
				{0, "play 10♥ as point card"},
				{1, "draw a card"},
				{0, "play A♣ as one-off"},
				{1, "play 7♣ as point card"},
				{0, "play 6♠ as one-off"},
				{1, "draw a card"},
				{0, "draw a card"},
			},
		},
		{
			name:        "a four and the owed discard",
			alice:       []card.Card{ck(card.Four, card.Diamonds), ck(card.Ten, card.Hearts), ck(card.Five, card.Diamonds)},
			blakeCommon: []card.Card{ck(card.Seven, card.Clubs), ck(card.Eight, card.Spades), ck(card.Nine, card.Diamonds)},
			active:      engine.P1,
			steps: []twinStep{
				{0, "play 4♦ as one-off"},
				{1, "discard hand[0] and hand[1]"},
				{1, "draw a card"},
				{0, "play 10♥ as point card"},
				{1, "play 9♦ as point card"},
			},
		},
	}
	for _, g := range games {
		t.Run(g.name, func(t *testing.T) {
			e := newPlayEnv(t, playOpts{})
			var alice [2][]string
			var twins [2]*duo
			for i, last := range []card.Card{ck(card.King, card.Clubs), ck(card.Two, card.Clubs)} {
				twins[i] = newCraftedDuo(t, e, g.start(last), func(_ *duo, seat game.Seat, f frameIn) {
					if seat == 0 {
						alice[i] = append(alice[i], string(f.raw))
					}
				})
			}
			same := func(when string) {
				t.Helper()
				if len(alice[0]) != len(alice[1]) {
					t.Fatalf("%s: Alice got %d frames in one twin, %d in the other", when, len(alice[0]), len(alice[1]))
				}
				for k := range alice[0] {
					if alice[0][k] != alice[1][k] {
						t.Fatalf("%s: Alice's frame %d differs:\n%s\n%s", when, k, alice[0][k], alice[1][k])
					}
				}
			}
			same("opening")
			counterOffered := false
			for n, s := range g.steps {
				for i, d := range twins {
					d.playDesc(s.by, s.desc)
					if st := d.st(); st.Over || st.Phase == engine.PhasePendingWin {
						t.Fatalf("twin %d step %d: the twin games must not reach a win", i, n)
					}
				}
				same(s.desc)
				if twins[1].env[0].State.Counterable && twins[1].st().Actor == 1 {
					// Only the 2 twin offers Blake the counter.
					has := func(d *duo) bool {
						for _, m := range d.env[1].LegalMoves {
							if m.Kind == engine.MoveCounter {
								return true
							}
						}
						return false
					}
					if has(twins[0]) || !has(twins[1]) {
						t.Fatalf("step %d: the counter must be offered in the 2 twin only", n)
					}
					counterOffered = true
				}
			}
			for _, d := range twins {
				d.settle()
			}
			same("the end")
			if !counterOffered {
				t.Fatal("the game never offered Blake a counter")
			}
		})
	}
}

// SPEC §2.12.7: the server speaks only v2. A v1 hello (the web client and
// the iPhone app before engine v0.3.0) is UPGRADE_REQUIRED and a close; a
// v2 hello is welcomed.
func TestWS_HelloV1UpgradeRequiredV2Welcome(t *testing.T) {
	if protocolVersion != 2 {
		t.Fatalf("protocolVersion %d, want 2", protocolVersion)
	}
	e := newPlayEnv(t, playOpts{})
	c0 := e.create(t, "Alice")
	old, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	old.send(map[string]any{"t": "hello", "v": 1, "code": c0.Code, "token": c0.Token, "lastSeq": 0})
	if er := expectError(t, old, CodeUpgradeRequired); er.Seq != nil {
		t.Fatalf("UPGRADE_REQUIRED echoes seq %d", *er.Seq)
	}
	old.closed(3 * time.Second)

	w, _, err := e.dial(t, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	w.send(map[string]any{"t": "hello", "v": 2, "code": c0.Code, "token": c0.Token, "lastSeq": 0})
	if wl := decodeFrame[welcomeIn](t, w.expect("welcome")); wl.Seat != 0 || wl.Status != statusWaiting {
		t.Fatalf("v2 welcome %+v", wl)
	}
}

// -respond-min-ms / CUTTLE_RESPOND_MIN_MS still parse and validate (so a
// deployed configuration keeps working) but change nothing: nothing in the
// play side reads Config.RespondMin, and a minute-long value delays no
// frame (TestWS_S1_CounterableMoveReachesBothSeatsAtOnce).
func TestParseConfigRespondMinIsAcceptedNoOp(t *testing.T) {
	cfg, err := ParseConfig(nil, func(string) string { return "" })
	if err != nil || cfg.RespondMin != DefaultRespondMin {
		t.Fatalf("default: %v %v", cfg.RespondMin, err)
	}
	env := map[string]string{"CUTTLE_RESPOND_MIN_MS": "2500"}
	cfg, err = ParseConfig(nil, func(k string) string { return env[k] })
	if err != nil || cfg.RespondMin != 2500*time.Millisecond {
		t.Fatalf("env: %v %v", cfg.RespondMin, err)
	}
	cfg, err = ParseConfig([]string{"-respond-min-ms", "40000"}, func(k string) string { return env[k] })
	if err != nil || cfg.RespondMin != 40*time.Second {
		t.Fatalf("flag: %v %v", cfg.RespondMin, err)
	}
	for _, args := range [][]string{{"-respond-min-ms", "0"}, {"-respond-min-ms", "60001"}} {
		if _, err := ParseConfig(args, func(string) string { return "" }); err == nil {
			t.Errorf("%v accepted", args)
		}
	}
}
