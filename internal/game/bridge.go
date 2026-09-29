// Package game holds the bridge's game logic: the held session, the §2.7
// envelope, the §3.2 view redaction, the deal, and snapshot/restore. It
// has no syscall/js dependency, so it builds and tests on the host and can
// be imported by more than one front end: the WASM shim in internal/wasm
// today, and the two-phone server later (docs/two-phone-plan.md §4).
package game

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// Bridge holds the one game the WASM module owns (SPEC §2.4: "Bridge owns
// the state"). Every exported method takes already-converted arguments and
// returns a JSON string, so the whole surface is host-testable; the shim in
// internal/wasm/main.go only adapts syscall/js values to these calls.
//
// Argument convention (set by the shim's argument conversion): a JS string
// arrives as string, a JS number as float64, undefined/null/missing as nil,
// a boolean as bool, and anything else as UnsupportedArg.
type Bridge struct {
	game   *session
	random func() (uint64, error)
}

// session is the held state: the engine state plus everything needed to
// rebuild envelopes and snapshots.
type session struct {
	state   engine.GameState
	history []AppliedMove
	seed    uint64
	dealer  engine.PlayerID
}

// UnsupportedArg stands in for a JS value the bridge never accepts
// (object, function, symbol, bigint).
type UnsupportedArg struct{ Kind string }

// NewBridge returns a Bridge with no game held; seeds and dealers left
// unspecified by NewGame are drawn from crypto/rand.
func NewBridge() *Bridge {
	return &Bridge{random: cryptoUint64}
}

func cryptoUint64() (uint64, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(buf[:]), nil
}

// ---------------------------------------------------------------------------
// __cuttleNewGame(optsJson)
// ---------------------------------------------------------------------------

type newGameOpts struct {
	Seed   *string  `json:"seed"`
	Dealer *int     `json:"dealer"`
	Names  []string `json:"names"`
}

func (b *Bridge) NewGame(arg any) string {
	return guard(func() string {
		raw, ok := arg.(string)
		if !ok {
			return errorJSON(codeBadRequest, "newGame expects a JSON string of NewGameOpts", nil)
		}
		var opts newGameOpts
		if err := decodeStrict(raw, &opts); err != nil {
			return errorJSON(codeBadRequest, "malformed NewGameOpts: "+err.Error(), nil)
		}
		if opts.Names != nil && len(opts.Names) != 2 {
			return errorJSON(codeBadRequest, "names must hold exactly two strings", nil)
		}
		var seed uint64
		if opts.Seed != nil {
			parsed, err := strconv.ParseUint(*opts.Seed, 10, 64)
			if err != nil {
				return errorJSON(codeBadRequest, fmt.Sprintf("seed %q is not a decimal uint64", *opts.Seed), nil)
			}
			seed = parsed
		}
		var dealer engine.PlayerID
		if opts.Dealer != nil {
			if *opts.Dealer != 0 && *opts.Dealer != 1 {
				return errorJSON(codeBadRequest, fmt.Sprintf("dealer must be 0 or 1, got %d", *opts.Dealer), nil)
			}
			dealer = engine.PlayerID(*opts.Dealer)
		}
		// Randomness only after validation, so a bad request consumes none.
		if opts.Seed == nil {
			r, err := b.random()
			if err != nil {
				return errorJSON(codeInternal, "no randomness for seed: "+err.Error(), nil)
			}
			seed = r
		}
		if opts.Dealer == nil {
			r, err := b.random()
			if err != nil {
				return errorJSON(codeInternal, "no randomness for dealer: "+err.Error(), nil)
			}
			dealer = engine.PlayerID(r & 1)
		}
		next := &session{state: dealNewGame(seed, dealer), history: []AppliedMove{}, seed: seed, dealer: dealer}
		// The first actor's view (SPEC §2.4, amended 2026-09-28). The
		// player who tapped "New game" need not be the first actor, so the
		// UI drops this envelope unread, raises an opening curtain to the
		// first actor (§4.2) and fetches their view after the reveal gate.
		return b.commit(next, next.state.Active)
	})
}

// ---------------------------------------------------------------------------
// __cuttleLegalMoves() / __cuttleDescribe()
// ---------------------------------------------------------------------------

// LegalMoves returns the actor's envelope. On a §2.10 stuck position it
// raises NO_LEGAL_MOVES instead of an envelope that looks playable.
func (b *Bridge) LegalMoves() string {
	return guard(func() string {
		if b.game == nil {
			return noGame()
		}
		if stuck(b.game.state) {
			return noLegalMoves(b.game)
		}
		return encode(buildEnvelope(b.game.state, b.game.history, b.game.state.Active))
	})
}

// Describe is A2's read call; it carries the same envelope (descriptions
// parallel to legalMoves) and the same stuck-state behaviour as LegalMoves.
func (b *Bridge) Describe() string {
	return b.LegalMoves()
}

// ---------------------------------------------------------------------------
// __cuttleApply(moveIndex)
// ---------------------------------------------------------------------------

func (b *Bridge) Apply(arg any) string {
	return guard(func() string {
		if b.game == nil {
			return noGame()
		}
		f, ok := arg.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
			return errorJSON(codeBadRequest, "apply expects an integer move index", nil)
		}
		pre := b.game.state
		moves := engine.LegalMoves(pre)
		if pre.Phase != engine.PhaseGameOver && len(moves) == 0 {
			return noLegalMoves(b.game)
		}
		if f < 0 || f >= float64(len(moves)) {
			return errorJSON(codeIndexOutOfRange,
				fmt.Sprintf("move index %v outside [0, %d)", f, len(moves)),
				map[string]any{"index": f, "count": len(moves)})
		}
		index := int(f)
		move := moves[index]
		description := move.Describe(pre)
		targetCard := targetCardFor(pre, move)
		post, err := engine.Apply(pre, move)
		if err != nil {
			if errors.Is(err, engine.ErrIllegalMove) {
				return errorJSON(codeIllegalMove,
					fmt.Sprintf("engine rejected offered move %d (%q)", index, description),
					map[string]any{"index": index, "description": description, "seq": len(b.game.history), "phase": int(pre.Phase)})
			}
			return errorJSON(codeInternal, "engine.Apply: "+err.Error(), nil)
		}
		history := append(append([]AppliedMove{}, b.game.history...), AppliedMove{
			Index:       &index,
			By:          pre.Active,
			Kind:        move.Kind,
			SubKind:     subKindOf(move),
			Card:        cardOrNil(move.Card),
			TargetCard:  targetCard,
			Description: description,
			Seq:         len(b.game.history) + 1,
		})
		// SPEC §2.7 drawn: a 5 that resolved in this apply records its
		// count on this entry (append-only; see resolvedFiveDraw).
		if drawn, ok := resolvedFiveDraw(pre, move, post); ok {
			history[len(history)-1].Drawn = &drawn
		}
		// The mover's view, not the incoming actor's: a mutating call never
		// loads the hand of a player who is not holding the phone. The UI
		// fetches the new actor's envelope with view() after the reveal.
		return b.commit(&session{state: post, history: history, seed: b.game.seed, dealer: b.game.dealer}, pre.Active)
	})
}

// ---------------------------------------------------------------------------
// __cuttleView(viewerId)
// ---------------------------------------------------------------------------

// View returns the envelope for a named viewer. It never raises
// NO_LEGAL_MOVES: the stuck-state screen reads seq and history through it.
func (b *Bridge) View(arg any) string {
	return guard(func() string {
		if b.game == nil {
			return noGame()
		}
		f, ok := arg.(float64)
		if !ok || (f != 0 && f != 1) {
			return errorJSON(codeBadRequest, "view expects viewerId 0 or 1", nil)
		}
		return encode(buildEnvelope(b.game.state, b.game.history, engine.PlayerID(f)))
	})
}

// ---------------------------------------------------------------------------
// __cuttleSnapshot() / __cuttleRestore(snapshotJson)
// ---------------------------------------------------------------------------

// 2 since AppliedMove gained `drawn` (SPEC §2.7, §5.7, amended 2026-09-28).
const snapshotVersion = 2

// snapshotWire is the full, unredacted SnapshotJson (§2.4, §3.4). `state` is
// the raw engine.GameState in encoding/json form; it is opaque to TypeScript
// (§5.7) and exists only to be handed back to Restore verbatim.
type snapshotWire struct {
	OK      bool             `json:"ok"`
	V       int              `json:"v"`
	State   engine.GameState `json:"state"`
	History []AppliedMove    `json:"history"`
	Seed    string           `json:"seed"`
	Dealer  engine.PlayerID  `json:"dealer"`
}

// restoreWire mirrors snapshotWire with pointers so missing fields are
// detectable.
type restoreWire struct {
	OK      *bool             `json:"ok"`
	V       *int              `json:"v"`
	State   *engine.GameState `json:"state"`
	History []AppliedMove     `json:"history"`
	Seed    *string           `json:"seed"`
	Dealer  *int              `json:"dealer"`
}

func (b *Bridge) Snapshot() string {
	return guard(func() string {
		if b.game == nil {
			return noGame()
		}
		return encode(snapshotWire{
			OK:      true,
			V:       snapshotVersion,
			State:   b.game.state,
			History: append([]AppliedMove{}, b.game.history...),
			Seed:    strconv.FormatUint(b.game.seed, 10),
			Dealer:  b.game.dealer,
		})
	})
}

// Restore replaces the held game and returns the envelope for viewerId,
// which TS supplies from its persisted Snapshot.viewer (ApisMellow, 2026-09-26).
// The UI re-raises any persisted curtain before rendering it (R4.2).
func (b *Bridge) Restore(arg, viewerArg any) string {
	return guard(func() string {
		raw, ok := arg.(string)
		if !ok {
			return errorJSON(codeBadRequest, "restore expects a SnapshotJson string", nil)
		}
		v, ok := viewerArg.(float64)
		if !ok || (v != 0 && v != 1) {
			return errorJSON(codeBadRequest, "restore expects viewerId 0 or 1", nil)
		}
		viewer := engine.PlayerID(v)
		// SPEC §5.7 (ruling 2026-09-28): a v1 save is upgraded, not discarded.
		raw, err := migrateSnapshotV1(raw)
		if err != nil {
			return errorJSON(codeBadRequest, "malformed v1 snapshot: "+err.Error(), nil)
		}
		var snap restoreWire
		if err := decodeStrict(raw, &snap); err != nil {
			return errorJSON(codeBadRequest, "malformed snapshot: "+err.Error(), nil)
		}
		if snap.V == nil || *snap.V != snapshotVersion {
			return errorJSON(codeBadRequest, fmt.Sprintf("snapshot version must be 1 or %d", snapshotVersion), nil)
		}
		if snap.State == nil || snap.History == nil || snap.Seed == nil || snap.Dealer == nil {
			return errorJSON(codeBadRequest, "snapshot requires state, history, seed and dealer", nil)
		}
		seed, err := strconv.ParseUint(*snap.Seed, 10, 64)
		if err != nil {
			return errorJSON(codeBadRequest, fmt.Sprintf("snapshot seed %q is not a decimal uint64", *snap.Seed), nil)
		}
		if *snap.Dealer != 0 && *snap.Dealer != 1 {
			return errorJSON(codeBadRequest, "snapshot dealer must be 0 or 1", nil)
		}
		if err := validateState(*snap.State); err != nil {
			return errorJSON(codeBadRequest, "invalid snapshot state: "+err.Error(), nil)
		}
		if err := validateHistory(snap.History); err != nil {
			return errorJSON(codeBadRequest, "invalid snapshot history: "+err.Error(), nil)
		}
		return b.commit(&session{state: *snap.State, history: snap.History, seed: seed, dealer: engine.PlayerID(*snap.Dealer)}, viewer)
	})
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

// commit builds the given viewer's envelope for a candidate session and only then
// makes it the held state, so a failure while rendering leaves the previous
// state untouched (§2.9: on ok:false the held state is unchanged).
//
// A mutating call that lands in a §2.10 stuck position still commits and
// returns the truthful envelope (legalMoves: []); the move is real and its
// history must not be lost. LegalMoves/Describe/Apply then raise
// NO_LEGAL_MOVES for that position.
//
// When the returned viewer is not the actor, the actor's envelope (what
// LegalMoves/Describe will serve) is rendered too, so the state commits only
// if both render.
func (b *Bridge) commit(next *session, viewer engine.PlayerID) string {
	out, err := json.Marshal(renderEnvelope(next.state, next.history, viewer))
	if err != nil {
		return errorJSON(codeInternal, "encoding failed: "+err.Error(), nil)
	}
	if actor := next.state.Active; viewer != actor {
		if _, err := json.Marshal(renderEnvelope(next.state, next.history, actor)); err != nil {
			return errorJSON(codeInternal, "actor envelope encoding failed: "+err.Error(), nil)
		}
	}
	b.game = next
	return string(out)
}

// renderEnvelope is the envelope builder commit uses. It is a variable only
// so a test can prove commit refuses to assign state when the actor's
// envelope fails to render; production never reassigns it.
var renderEnvelope = buildEnvelope

func noGame() string {
	return errorJSON(codeNoGame, "no game: call newGame or restore first", nil)
}

func noLegalMoves(g *session) string {
	return errorJSON(codeNoLegalMoves,
		fmt.Sprintf("engine offers no legal move in phase %d (SPEC §2.10)", g.state.Phase),
		map[string]any{"phase": int(g.state.Phase), "active": int(g.state.Active), "seq": len(g.history)})
}

// decodeStrict decodes exactly one JSON object with no unknown fields and
// no trailing data.
func decodeStrict(raw string, v any) error {
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("trailing data after JSON value")
	}
	return nil
}

// validateState is structural validation of a restored state: every enum in
// range and every card a real card, so a hand-edited snapshot cannot drive
// the engine or view code into an index panic. It checks shape, never game
// rules.
func validateState(s engine.GameState) error {
	if s.Active > engine.P2 {
		return fmt.Errorf("Active %d out of range", s.Active)
	}
	if s.Phase > engine.PhaseGameOver {
		return fmt.Errorf("Phase %d out of range", s.Phase)
	}
	if s.Winner != nil && *s.Winner > engine.P2 {
		return fmt.Errorf("Winner %d out of range", *s.Winner)
	}
	needsPending := s.Phase == engine.PhaseAwaitingCounter || s.Phase == engine.PhaseSevenChoosing || s.Phase == engine.PhaseAwaitingDiscard
	if needsPending != (s.Pending != nil) {
		return fmt.Errorf("Pending must be present exactly in phases 1-3 (phase %d, pending present %v)", s.Phase, s.Pending != nil)
	}
	if s.PassesInARow < 0 {
		return fmt.Errorf("PassesInARow %d negative", s.PassesInARow)
	}
	if err := validCards("Deck", s.Deck); err != nil {
		return err
	}
	if err := validCards("Scrap", s.Scrap); err != nil {
		return err
	}
	for i, p := range s.Players {
		label := fmt.Sprintf("Players[%d]", i)
		if err := validCards(label+".Hand", p.Hand); err != nil {
			return err
		}
		if err := validCards(label+".Permanents", p.Permanents); err != nil {
			return err
		}
		for j, pe := range p.Points {
			entry := fmt.Sprintf("%s.Points[%d]", label, j)
			if err := validCards(entry+".Card", []card.Card{pe.Card}); err != nil {
				return err
			}
			if pe.Owner > engine.P2 {
				return fmt.Errorf("%s.Owner %d out of range", entry, pe.Owner)
			}
			if err := validCards(entry+".JackStack", pe.JackStack); err != nil {
				return err
			}
			if len(pe.JackOwners) != len(pe.JackStack) {
				return fmt.Errorf("%s JackOwners/JackStack length mismatch", entry)
			}
			for _, o := range pe.JackOwners {
				if o > engine.P2 {
					return fmt.Errorf("%s.JackOwners holds %d", entry, o)
				}
			}
		}
	}
	if pd := s.Pending; pd != nil {
		if pd.PlayedBy > engine.P2 {
			return fmt.Errorf("Pending.PlayedBy %d out of range", pd.PlayedBy)
		}
		if err := validCards("Pending.Card", []card.Card{pd.Card}); err != nil {
			return err
		}
		if err := validCards("Pending.Revealed", pd.Revealed); err != nil {
			return err
		}
		if err := validCards("Pending.CounterChain", pd.CounterChain); err != nil {
			return err
		}
		if t := pd.Target; t != nil && (t.Owner > engine.P2 || t.Zone > engine.ZonePermanents) {
			return fmt.Errorf("Pending.Target %+v out of range", *t)
		}
	}
	return nil
}

func validCards(label string, cards []card.Card) error {
	for i, cd := range cards {
		if cd.Rank < card.Ace || cd.Rank > card.King || cd.Suit > card.Spades {
			return fmt.Errorf("%s[%d] = {Rank:%d Suit:%d} is not a card", label, i, cd.Rank, cd.Suit)
		}
	}
	return nil
}

func validateHistory(history []AppliedMove) error {
	for i, h := range history {
		if h.Seq != i+1 {
			return fmt.Errorf("history[%d].seq = %d, want %d", i, h.Seq, i+1)
		}
		if h.Index == nil || *h.Index < 0 {
			return fmt.Errorf("history[%d].index missing or negative (snapshots hold unredacted history)", i)
		}
		if h.By > engine.P2 || h.Kind > engine.MovePass || (h.SubKind != nil && *h.SubKind > engine.MovePass) {
			return fmt.Errorf("history[%d] has out-of-range fields", i)
		}
		// subKind only on SevenPick. A SevenPick may still have a null
		// subKind: the engine's dead-end fallback (legalSevenPickMoves)
		// emits SevenPick with no SubMove ("7: no legal play — scrap X").
		if h.SubKind != nil && h.Kind != engine.MoveSevenPick {
			return fmt.Errorf("history[%d].subKind is set on a non-SevenPick move", i)
		}
		if h.Card != nil {
			if err := validCards(fmt.Sprintf("history[%d].card", i), []card.Card{*h.Card}); err != nil {
				return err
			}
		}
		// TargetCard's key-presence is enforced by AppliedMove.UnmarshalJSON
		// (envelope.go); here only its shape, when non-nil, is checked —
		// same as Card above.
		if h.TargetCard != nil {
			if err := validCards(fmt.Sprintf("history[%d].targetCard", i), []card.Card{*h.TargetCard}); err != nil {
				return err
			}
		}
		// Cheap kind/targetCard consistency (shape only — not a pre-state
		// board replay, which would need the engine state this snapshot is
		// restoring, not yet held). targetCard may be non-null only for the
		// four kinds targetCardFor ever sets it for, and MUST be non-null
		// for Scuttle and for a Jack steal (§2.7: "Always a card on the
		// board" — never null for those two shapes). OneOff and SevenPick
		// legitimately go either way (untargeted ranks, and a dead-end
		// SevenPick, are null).
		// drawn (SPEC §2.7): only on the entry that resolved a 5 — the 5's
		// own one-off entry, or a Decline/Counter answering a chain that a 5
		// opened — and 0..2, the most a 5 draws (engine/apply.go
		// resolveOneOffWith, case Five).
		if h.Drawn != nil {
			resolvesFive := isFiveEntry(h)
			if h.Kind == engine.MoveDecline || h.Kind == engine.MoveCounter {
				o := chainOrigin(history, i)
				resolvesFive = o >= 0 && isFiveEntry(history[o])
			}
			if !resolvesFive {
				return fmt.Errorf("history[%d].drawn is set on an entry that did not resolve a 5", i)
			}
			if *h.Drawn < 0 || *h.Drawn > 2 {
				return fmt.Errorf("history[%d].drawn = %d, want 0..2", i, *h.Drawn)
			}
		}
		switch h.Kind {
		case engine.MoveScuttle:
			if h.TargetCard == nil {
				return fmt.Errorf("history[%d].targetCard must be set for a Scuttle", i)
			}
		case engine.MovePlayPermanent:
			isJackSteal := h.Card != nil && h.Card.Rank == card.Jack
			if isJackSteal && h.TargetCard == nil {
				return fmt.Errorf("history[%d].targetCard must be set for a Jack steal", i)
			}
			if !isJackSteal && h.TargetCard != nil {
				return fmt.Errorf("history[%d].targetCard must be null for a non-Jack PlayPermanent", i)
			}
		case engine.MoveOneOff, engine.MoveSevenPick:
			// Either null (untargeted rank, or a dead-end SevenPick) or
			// non-null (a targeted rank, or a targeted SubMove) is valid.
		default:
			if h.TargetCard != nil {
				return fmt.Errorf("history[%d].targetCard must be null for kind %d", i, h.Kind)
			}
		}
	}
	return nil
}
