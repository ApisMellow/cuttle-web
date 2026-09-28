package main

import (
	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// targetCardFor computes AppliedMove.TargetCard (SPEC §2.7, amended
// 2026-09-27): the card a move targeted, read from the PRE-state (the state
// before this move was applied). Only four shapes ever carry a target —
// Scuttle, a Jack steal (PlayPermanent's JackTarget), a targeted OneOff
// (ranks 2 and 9), and a SevenPick's SubMove, recursively, using the same
// rules. Every other move is untargeted and returns nil, including a
// dead-end SevenPick (no SubMove).
func targetCardFor(pre engine.GameState, m engine.Move) *card.Card {
	switch m.Kind {
	case engine.MoveScuttle:
		// engine/apply.go:251-265: Target.Zone is always ZonePoints, and the
		// scrapped card is the point card itself (target.Card), never a Jack
		// that might be layered on it.
		return cardAtTarget(pre, m.Target, false)

	case engine.MovePlayPermanent:
		if m.Card.Rank != card.Jack || m.JackTarget == nil {
			return nil
		}
		// engine/apply.go:205-220: JackTarget.Zone is always ZonePoints, and
		// the stolen card is the point card itself.
		return cardAtTarget(pre, m.JackTarget, false)

	case engine.MoveOneOff:
		if m.Target == nil {
			// Ace, Three, Four, Five, Six, Seven never carry a Target.
			return nil
		}
		// Rank 2 (engine/apply.go:683-719): ZonePermanents scraps the named
		// permanent directly, but ZonePoints pops the TOP JACK off the
		// stack — the point card underneath is untouched and stays on the
		// board. Rank 9 (engine/apply.go:733-760) acts on the named slot
		// directly in both zones (the point card itself, or the permanent).
		rank2OnPoints := m.Card.Rank == card.Two
		return cardAtTarget(pre, m.Target, rank2OnPoints)

	case engine.MoveSevenPick:
		if m.SubMove == nil {
			// Dead-end scrap (engine/apply.go:419-443): no inner move, so
			// nothing was targeted.
			return nil
		}
		// The board (Points/Permanents for both players) is unchanged
		// between the 7's reveal and the pick — only Deck/Hand move — so
		// the SubMove's Target/JackTarget indices still refer to `pre`.
		return targetCardFor(pre, *m.SubMove)

	default:
		return nil
	}
}

// cardAtTarget reads the card a Target names in the pre-state.
// jackStackTop selects the rank-2-on-a-Jack-stack special case: the target
// is the top Jack of the PointEntry's JackStack, not the point card
// (pe.Card) it sits on.
func cardAtTarget(pre engine.GameState, t *engine.Target, jackStackTop bool) *card.Card {
	if t == nil {
		return nil
	}
	if t.Owner > engine.P2 {
		return nil // defensive: never index with an out-of-range owner
	}
	p := pre.Players[t.Owner]
	switch t.Zone {
	case engine.ZonePermanents:
		if t.Index < 0 || t.Index >= len(p.Permanents) {
			return nil
		}
		out := p.Permanents[t.Index]
		return &out
	case engine.ZonePoints:
		if t.Index < 0 || t.Index >= len(p.Points) {
			return nil
		}
		pe := p.Points[t.Index]
		if jackStackTop {
			if len(pe.JackStack) == 0 {
				return nil
			}
			out := pe.JackStack[len(pe.JackStack)-1]
			return &out
		}
		out := pe.Card
		return &out
	default:
		return nil
	}
}
