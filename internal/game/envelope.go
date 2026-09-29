package game

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// Wire types for the §2.7 envelope, plus the pure normalization and error
// helpers. Nothing here touches syscall/js, so `go test` covers it on the host.

// MoveView is engine.Move normalized per §2.8(e): a Rank-0 card becomes null.
// Field names stay PascalCase to match the §2.7 Move interface.
type MoveView struct {
	Kind       engine.MoveKind `json:"Kind"`
	Card       *card.Card      `json:"Card"`
	HandIndex  int             `json:"HandIndex"`
	Target     *engine.Target  `json:"Target"`
	JackTarget *engine.Target  `json:"JackTarget"`
	ScrapIndex int             `json:"ScrapIndex"`
	DiscardA   int             `json:"DiscardA"`
	DiscardB   int             `json:"DiscardB"`
	SubMove    *MoveView       `json:"SubMove"`
}

// AppliedMove is one history entry. Its description is computed against the
// PRE-state at apply time and never regenerated (§2.7).
//
// Index is held for every entry but emitted only to the entry's mover: for
// anyone else it is omitted (absent, not null), because the position in the
// mover's legal-move list encodes hidden information (a pending 3's
// ScrapIndex; the size of the option list, which depends on the hidden
// hand). See redactHistory.
//
// SubKind is the SubMove's kind (MoveSevenPick only), or null (the recap
// formatter and the curtain machine read it to spot a one-off played
// through a 7).
//
// TargetCard is the card the move targeted, read from the PRE-state
// (§2.7, amended 2026-09-27): Scuttle's Target, a Jack's JackTarget, a
// targeted OneOff's Target (2-as-scrap, 9), and the same for a SevenPick's
// SubMove, recursively. Nil for every untargeted move, including a
// dead-end SevenPick. Always a card that was on the board, so public to
// both viewers — never redacted, unlike Index. The key is always emitted
// (never omitted), which UnmarshalJSON below enforces on the restore path.
//
// Drawn is how many cards a 5 drew, on the entry whose apply resolved the
// 5: the 5's own entry when nobody could counter, else the Decline or
// Counter that closed its chain (history is append-only). The one who drew
// is the 5's player. Null everywhere else, including a cancelled 5 (§2.7,
// amended 2026-09-28). A count only, public to both viewers; the key is
// always emitted.
type AppliedMove struct {
	Index       *int             `json:"index,omitempty"`
	By          engine.PlayerID  `json:"by"`
	Kind        engine.MoveKind  `json:"kind"`
	SubKind     *engine.MoveKind `json:"subKind"`
	Card        *card.Card       `json:"card"`
	TargetCard  *card.Card       `json:"targetCard"`
	Drawn       *int             `json:"drawn"`
	Description string           `json:"description"`
	Seq         int              `json:"seq"`
}

// UnmarshalJSON enforces that "targetCard" is always present as a JSON key
// — a Card object or null, never an omitted key. A restored snapshot that
// lacks the key (stale format, hand-edited, or truncated) is rejected
// rather than silently treated as an untargeted move, which would let a
// tampered or pre-this-change snapshot masquerade as a well-formed one
// (§2.7's "always emit the key" contract, enforced on the way back in).
// The default `*card.Card` unmarshal already rejects a wrong-typed value
// (e.g. a string) as a type error; only "missing entirely" needs the extra
// probe below, since a missing key and an explicit `null` both decode to a
// nil pointer otherwise and must not be conflated.
func (m *AppliedMove) UnmarshalJSON(data []byte) error {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	if _, ok := probe["targetCard"]; !ok {
		return errors.New(`missing required key "targetCard"`)
	}
	// Same rule for drawn (SPEC §2.7, amended 2026-09-28): a count or null,
	// never an omitted key.
	if _, ok := probe["drawn"]; !ok {
		return errors.New(`missing required key "drawn"`)
	}
	type alias AppliedMove
	var a alias
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return err
	}
	*m = AppliedMove(a)
	return nil
}

// redactHistory copies history for one viewer, dropping Index from every
// entry that viewer did not make.
func redactHistory(history []AppliedMove, viewer engine.PlayerID) []AppliedMove {
	out := make([]AppliedMove, 0, len(history))
	for _, h := range history {
		if h.By != viewer {
			h.Index = nil
		} else if h.Index != nil {
			idx := *h.Index
			h.Index = &idx
		}
		if h.Drawn != nil {
			n := *h.Drawn
			h.Drawn = &n
		}
		out = append(out, h)
	}
	return out
}

// subKindOf returns the SubMove's kind, or nil when there is no SubMove.
func subKindOf(m engine.Move) *engine.MoveKind {
	if m.SubMove == nil {
		return nil
	}
	k := m.SubMove.Kind
	return &k
}

// Envelope is the ok:true result of every bridge call except snapshot.
type Envelope struct {
	OK           bool          `json:"ok"`
	State        PlayerView    `json:"state"`
	LegalMoves   []MoveView    `json:"legalMoves"`
	Descriptions []string      `json:"descriptions"`
	LastMove     *AppliedMove  `json:"lastMove"`
	History      []AppliedMove `json:"history"`
	Seq          int           `json:"seq"`
}

// Error codes, §2.9.
const (
	codeIllegalMove     = "ILLEGAL_MOVE"
	codeIndexOutOfRange = "INDEX_OUT_OF_RANGE"
	codeBadRequest      = "BAD_REQUEST"
	codeNoGame          = "NO_GAME"
	codeNoLegalMoves    = "NO_LEGAL_MOVES"
	codeInternal        = "INTERNAL"
)

// EngineError is the ok:false result (§2.7, §2.9).
type EngineError struct {
	OK      bool           `json:"ok"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Detail  map[string]any `json:"detail,omitempty"`
}

func cardOrNil(cd card.Card) *card.Card {
	if cd.Rank == 0 {
		return nil
	}
	out := cd
	return &out
}

// normalizeMove converts an engine move to its wire form (§2.8e). SubMove
// nesting is single-level in practice; the recursion handles it generally.
func normalizeMove(m engine.Move) MoveView {
	mv := MoveView{
		Kind:       m.Kind,
		Card:       cardOrNil(m.Card),
		HandIndex:  m.HandIndex,
		Target:     copyTarget(m.Target),
		JackTarget: copyTarget(m.JackTarget),
		ScrapIndex: m.ScrapIndex,
		DiscardA:   m.DiscardA,
		DiscardB:   m.DiscardB,
	}
	if m.SubMove != nil {
		sub := normalizeMove(*m.SubMove)
		mv.SubMove = &sub
	}
	return mv
}

func copyTarget(t *engine.Target) *engine.Target {
	if t == nil {
		return nil
	}
	out := *t
	return &out
}

// stuck reports the §2.10 defect condition: a non-game-over position in
// which the engine offers no move.
func stuck(state engine.GameState) bool {
	return state.Phase != engine.PhaseGameOver && len(engine.LegalMoves(state)) == 0
}

// buildEnvelope renders the envelope for one viewer. Legal moves and their
// descriptions go only to the actor; everyone else, and everyone at game
// over, gets [] (§2.7).
func buildEnvelope(state engine.GameState, history []AppliedMove, viewer engine.PlayerID) Envelope {
	env := Envelope{
		OK:           true,
		State:        viewFor(state, viewer),
		LegalMoves:   []MoveView{},
		Descriptions: []string{},
		History:      redactHistory(history, viewer),
		Seq:          len(history),
	}
	if len(env.History) > 0 {
		last := env.History[len(env.History)-1]
		env.LastMove = &last
	}
	if viewer == state.Active && state.Phase != engine.PhaseGameOver {
		for _, m := range engine.LegalMoves(state) {
			env.LegalMoves = append(env.LegalMoves, normalizeMove(m))
			env.Descriptions = append(env.Descriptions, m.Describe(state))
		}
	}
	return env
}

// errorJSON renders an EngineError. It cannot fail: every value it marshals
// is a string or a JSON-safe detail map built by this package.
func errorJSON(code, message string, detail map[string]any) string {
	out, err := json.Marshal(EngineError{OK: false, Code: code, Message: message, Detail: detail})
	if err != nil {
		out, _ = json.Marshal(EngineError{OK: false, Code: codeInternal, Message: "error encoding failed: " + err.Error()})
	}
	return string(out)
}

// InternalErrorJSON renders an INTERNAL EngineError (§2.9). A front end
// uses it for failures outside a Bridge method, such as a panic while
// converting arguments at the WASM boundary.
func InternalErrorJSON(message string) string {
	return errorJSON(codeInternal, message, nil)
}

// encode marshals a success value, converting a marshal failure to INTERNAL.
func encode(v any) string {
	out, err := json.Marshal(v)
	if err != nil {
		return errorJSON(codeInternal, "encoding failed: "+err.Error(), nil)
	}
	return string(out)
}

// guard runs one exported bridge body and converts a panic into INTERNAL.
// A Go panic in WASM kills the runtime, so no body may escape it (§2.9).
func guard(fn func() string) (out string) {
	defer func() {
		if r := recover(); r != nil {
			out = errorJSON(codeInternal, fmt.Sprintf("recovered panic: %v", r), nil)
		}
	}()
	return fn()
}
