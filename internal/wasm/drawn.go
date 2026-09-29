package main

import (
	"encoding/json"
	"fmt"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

// resolvedFiveDraw reports whether a 5 one-off resolved during the apply of
// `move` (pre -> post), and if so how many cards it drew (SPEC §2.7 `drawn`,
// amended 2026-09-28). The count goes on the entry for `move` — history is
// append-only, so a 5 that waited on a counter window gets its count on the
// Decline or Counter that closed the chain, not on its own earlier entry.
// The one who drew is always the 5's player (the chain origin's `by`).
//
// A 5 resolves:
//   - in its own apply, when the opponent holds no counter (MoveOneOff, or a
//     MoveSevenPick whose SubMove is the 5);
//   - in the apply of the Decline or Counter that closes its counter chain
//     with an even chain (engine/apply.go resolvePending: odd cancels).
//
// The count is read from the deck, which only the 5's own draw shrinks
// during these applies (engine/apply.go resolveOneOffWith, case Five). A
// SevenPick first returns its unchosen reveals to the deck top
// (engine/apply.go MoveSevenPick), so those are added back before the
// difference is taken.
func resolvedFiveDraw(pre engine.GameState, move engine.Move, post engine.GameState) (drawn int, ok bool) {
	if post.Phase == engine.PhaseAwaitingCounter {
		return 0, false // a counter window is open: nothing has resolved
	}
	switch move.Kind {
	case engine.MoveOneOff:
		if move.Card.Rank != card.Five {
			return 0, false
		}
		return len(pre.Deck) - len(post.Deck), true
	case engine.MoveSevenPick:
		if move.SubMove == nil || move.SubMove.Kind != engine.MoveOneOff || move.Card.Rank != card.Five || pre.Pending == nil {
			return 0, false
		}
		returned := len(pre.Pending.Revealed) - 1
		return len(pre.Deck) + returned - len(post.Deck), true
	case engine.MoveDecline, engine.MoveCounter:
		p := pre.Pending
		if p == nil || p.Card.Rank != card.Five {
			return 0, false
		}
		chain := len(p.CounterChain)
		if move.Kind == engine.MoveCounter {
			chain++
		}
		if chain%2 == 1 {
			return 0, false // cancelled: the 5 never resolves
		}
		return len(pre.Deck) - len(post.Deck), true
	}
	return 0, false
}

// isOneOffEntry: a OneOff, or a SevenPick whose SubMove was a OneOff.
func isOneOffEntry(h AppliedMove) bool {
	return h.Kind == engine.MoveOneOff || (h.Kind == engine.MoveSevenPick && h.SubKind != nil && *h.SubKind == engine.MoveOneOff)
}

// chainOrigin returns the index of the one-off entry a Decline or Counter at
// history[i] answers (walking back over Counters), or -1.
func chainOrigin(history []AppliedMove, i int) int {
	for j := i - 1; j >= 0; j-- {
		h := history[j]
		if h.Kind == engine.MoveCounter {
			continue
		}
		if isOneOffEntry(h) {
			return j
		}
		return -1
	}
	return -1
}

// isFiveEntry: a one-off entry whose played card is a 5.
func isFiveEntry(h AppliedMove) bool {
	return isOneOffEntry(h) && h.Card != nil && h.Card.Rank == card.Five
}

// migrateSnapshotV1 upgrades a version-1 SnapshotJson to version 2 (SPEC
// §5.7, orchestrator ruling 2026-09-28): the engine state layout is
// unchanged, and v2 differs only in AppliedMove gaining `drawn`, so every v1
// history entry gets "drawn": null — a v1 save predates the count, and null
// is exactly what a v2 entry holds when no 5 resolved on it. Anything that
// is not a well-formed v1 object is returned unchanged for the strict decode
// and the version check to reject as before. A v1 entry that already
// carries `drawn` is not a real v1 save and is rejected.
func migrateSnapshotV1(raw string) (string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		return raw, nil
	}
	if v, ok := top["v"]; !ok || string(v) != "1" {
		return raw, nil
	}
	var history []json.RawMessage
	if h, ok := top["history"]; ok && string(h) != "null" {
		if err := json.Unmarshal(h, &history); err != nil {
			return raw, nil
		}
		for i, entry := range history {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(entry, &fields); err != nil {
				return raw, nil
			}
			if _, has := fields["drawn"]; has {
				return "", fmt.Errorf("v1 history[%d] already carries drawn", i)
			}
			fields["drawn"] = json.RawMessage("null")
			out, err := json.Marshal(fields)
			if err != nil {
				return "", err
			}
			history[i] = out
		}
		out, err := json.Marshal(history)
		if err != nil {
			return "", err
		}
		top["history"] = out
	}
	top["v"] = json.RawMessage("2")
	out, err := json.Marshal(top)
	if err != nil {
		return "", err
	}
	return string(out), nil
}
