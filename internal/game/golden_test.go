package game

// Byte-level golden transcript of the bridge's JSON surface. It was
// captured from the bridge before the two-phone W1 move out of
// internal/wasm, so it pins every envelope, view, redacted history,
// snapshot, restore and error string across that refactor and any later
// one that claims to change no behaviour.
//
// Each seed plays one deterministic game through every read and mutating
// call and hashes the ordered "call -> output" lines. The golden file holds
// one SHA-256 per seed. Regenerate only for an intended wire change:
//
//	go test ./internal/game/ -run TestGoldenBridgeTranscript -update-golden
//
// CUTTLE_GOLDEN_DUMP=<file> also writes the full transcript text, for a
// byte-for-byte diff between two trees.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/engine"
)

var updateGolden = flag.Bool("update-golden", false, "rewrite testdata/golden/bridge-transcript.json")

const goldenTranscriptPath = "testdata/golden/bridge-transcript.json"

const goldenSeeds = 64

type goldenFile struct {
	Seeds map[string]string `json:"seeds"`
	Calls map[string]int    `json:"calls"`
}

type transcript struct {
	lines []string
}

func (tr *transcript) add(call, out string) {
	tr.lines = append(tr.lines, call+" -> "+out)
}

func (tr *transcript) text() string { return strings.Join(tr.lines, "\n") + "\n" }

// goldenGame drives one seeded game and records every call and its output.
func goldenGame(t *testing.T, seed uint64, v1Snapshot string) *transcript {
	t.Helper()
	tr := &transcript{}

	// Calls before any game exists, and malformed arguments.
	empty := NewBridge()
	tr.add("empty.LegalMoves()", empty.LegalMoves())
	tr.add("empty.Describe()", empty.Describe())
	tr.add("empty.Apply(0)", empty.Apply(0.0))
	tr.add("empty.View(0)", empty.View(0.0))
	tr.add("empty.Snapshot()", empty.Snapshot())
	tr.add("empty.NewGame(bad seed)", empty.NewGame(`{"seed":"x","dealer":0}`))
	tr.add("empty.NewGame(bad dealer)", empty.NewGame(`{"seed":"1","dealer":2}`))
	tr.add("empty.NewGame(bad names)", empty.NewGame(`{"seed":"1","dealer":0,"names":["Alice"]}`))
	tr.add("empty.NewGame(unknown field)", empty.NewGame(`{"seed":"1","dealer":0,"x":1}`))
	tr.add("empty.NewGame(non-string)", empty.NewGame(1.0))
	tr.add("empty.Restore(bad json)", empty.Restore(`{`, 0.0))
	tr.add("empty.Restore(bad viewer)", empty.Restore(`{}`, 2.0))

	b := NewBridge()
	dealer := seed & 1
	if seed%3 == 0 {
		dealer ^= 1
	}
	opts := fmt.Sprintf(`{"seed":"%d","dealer":%d,"names":["Alice","Blake"]}`, seed, dealer)
	wire := b.NewGame(opts)
	tr.add("NewGame("+opts+")", wire)

	if v1Snapshot != "" && seed%8 == 1 {
		v1 := NewBridge()
		tr.add("v1.Restore(fixture, 0)", v1.Restore(v1Snapshot, 0.0))
		tr.add("v1.Restore(fixture, 1)", v1.Restore(v1Snapshot, 1.0))
		tr.add("v1.Snapshot()", v1.Snapshot())
	}

	rng := xorshift32(uint32(seed*2654435761 + 7))
	for step := 0; step < 3000; step++ {
		var env Envelope
		if err := json.Unmarshal([]byte(wire), &env); err != nil || !env.OK {
			t.Fatalf("seed %d step %d: not an envelope: %s", seed, step, wire)
		}
		prefix := "s" + strconv.Itoa(step) + "."
		tr.add(prefix+"LegalMoves()", b.LegalMoves())
		tr.add(prefix+"Describe()", b.Describe())
		tr.add(prefix+"View(0)", b.View(0.0))
		tr.add(prefix+"View(1)", b.View(1.0))
		snap := b.Snapshot()
		tr.add(prefix+"Snapshot()", snap)
		if step%5 == 0 {
			r := NewBridge()
			tr.add(prefix+"restored.Restore(snap, 0)", r.Restore(snap, 0.0))
			tr.add(prefix+"restored.Restore(snap, 1)", r.Restore(snap, 1.0))
			tr.add(prefix+"restored.LegalMoves()", r.LegalMoves())
		}
		if step%11 == 0 {
			tr.add(prefix+"Apply(-1)", b.Apply(-1.0))
			tr.add(prefix+"Apply(9999)", b.Apply(9999.0))
			tr.add(prefix+"Apply(0.5)", b.Apply(0.5))
			tr.add(prefix+"Apply(string)", b.Apply("0"))
			tr.add(prefix+"View(2)", b.View(2.0))
		}
		if env.State.Phase == engine.PhaseGameOver {
			tr.add(prefix+"Apply(0) at game over", b.Apply(0.0))
			return tr
		}
		n := len(env.LegalMoves)
		if n == 0 {
			// The first envelope and each View are the actor's, so an empty
			// list here means a stuck position; record it and stop.
			return tr
		}
		idx := int(rng() % uint32(n))
		applied := b.Apply(float64(idx))
		tr.add(prefix+"Apply("+strconv.Itoa(idx)+")", applied)
		var a Envelope
		if err := json.Unmarshal([]byte(applied), &a); err != nil || !a.OK {
			t.Fatalf("seed %d step %d: apply failed: %s", seed, step, applied)
		}
		wire = b.View(float64(a.State.Active))
		tr.add(prefix+"View(actor)", wire)
	}
	t.Fatalf("seed %d did not terminate", seed)
	return nil
}

func TestGoldenBridgeTranscript(t *testing.T) {
	v1, err := os.ReadFile("testdata/snapshot-v1-bce9fb2.json")
	if err != nil {
		t.Fatal(err)
	}
	got := goldenFile{Seeds: map[string]string{}, Calls: map[string]int{}}
	var dump strings.Builder
	for seed := uint64(1); seed <= goldenSeeds; seed++ {
		tr := goldenGame(t, seed, string(v1))
		sum := sha256.Sum256([]byte(tr.text()))
		key := strconv.FormatUint(seed, 10)
		got.Seeds[key] = hex.EncodeToString(sum[:])
		got.Calls[key] = len(tr.lines)
		dump.WriteString("# seed " + key + "\n")
		dump.WriteString(tr.text())
	}
	if path := os.Getenv("CUTTLE_GOLDEN_DUMP"); path != "" {
		if err := os.WriteFile(path, []byte(dump.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if *updateGolden {
		out, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(goldenTranscriptPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenTranscriptPath, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(goldenTranscriptPath)
	if err != nil {
		t.Fatalf("golden transcript missing (%v); capture it from a trusted tree with -update-golden", err)
	}
	var want goldenFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Seeds) != goldenSeeds {
		t.Fatalf("golden file holds %d seeds, want %d", len(want.Seeds), goldenSeeds)
	}
	total := 0
	for key, sum := range want.Seeds {
		if got.Seeds[key] != sum || got.Calls[key] != want.Calls[key] {
			t.Errorf("seed %s: transcript %s (%d calls), golden %s (%d calls)", key, got.Seeds[key], got.Calls[key], sum, want.Calls[key])
		}
		total += got.Calls[key]
	}
	if !t.Failed() {
		t.Logf("%d seeds, %d recorded calls, all match the golden transcript", len(want.Seeds), total)
	}
}
