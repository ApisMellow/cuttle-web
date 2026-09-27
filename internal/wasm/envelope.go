package main

import (
	"encoding/json"
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
type AppliedMove struct {
	Index       int             `json:"index"`
	By          engine.PlayerID `json:"by"`
	Kind        engine.MoveKind `json:"kind"`
	Card        *card.Card      `json:"card"`
	Description string          `json:"description"`
	Seq         int             `json:"seq"`
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
		History:      append([]AppliedMove{}, history...),
		Seq:          len(history),
	}
	if len(history) > 0 {
		last := history[len(history)-1]
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
