package main

import (
	"strings"
	"testing"

	"github.com/ApisMellow/cuttle/card"
	"github.com/ApisMellow/cuttle/engine"
)

func TestSPEC2_8_Rank0CardIsNull(t *testing.T) {
	for _, kind := range []engine.MoveKind{engine.MoveDraw, engine.MovePass, engine.MoveDecline, engine.MoveDiscardPair} {
		mv := normalizeMove(engine.Move{Kind: kind, DiscardA: 0, DiscardB: -1})
		if mv.Card != nil {
			t.Fatalf("kind %d: Card = %v, want nil", kind, mv.Card)
		}
		wire := mustJSON(t, mv)
		if !strings.Contains(wire, `"Card":null`) || strings.Contains(wire, `"Rank":0`) {
			t.Fatalf("kind %d: Rank 0 must serialize as null: %s", kind, wire)
		}
	}
	played := normalizeMove(engine.Move{Kind: engine.MovePlayPoint, Card: c(card.Two, card.Hearts), HandIndex: 1})
	if played.Card == nil || *played.Card != c(card.Two, card.Hearts) {
		t.Fatalf("real card lost: %+v", played)
	}
}

func TestSPEC2_7_MoveWireShape(t *testing.T) {
	sub := engine.Move{Kind: engine.MoveScuttle, Card: c(card.Nine, card.Clubs),
		Target: &engine.Target{Owner: engine.P2, Zone: engine.ZonePoints, Index: 3}}
	mv := normalizeMove(engine.Move{Kind: engine.MoveSevenPick, Card: c(card.Nine, card.Clubs), SubMove: &sub})
	wire := mustJSON(t, mv)
	m := decodeGeneric(t, wire)
	assertKeys(t, "Move", m, "Kind", "Card", "HandIndex", "Target", "JackTarget", "ScrapIndex", "DiscardA", "DiscardB", "SubMove")
	inner := m["SubMove"].(map[string]any)
	assertKeys(t, "SubMove", inner, "Kind", "Card", "HandIndex", "Target", "JackTarget", "ScrapIndex", "DiscardA", "DiscardB", "SubMove")
	if inner["SubMove"] != nil || m["Target"] != nil || m["JackTarget"] != nil {
		t.Fatalf("absent pointers must be null: %s", wire)
	}
	if !strings.Contains(wire, `"Target":{"Owner":1,"Zone":0,"Index":3}`) {
		t.Fatalf("Target must be {Owner,Zone,Index} with numeric enums: %s", wire)
	}

	// A SubMove with a zero card is normalized too (defensive; single-level nesting).
	zeroSub := engine.Move{Kind: engine.MoveDraw}
	if got := normalizeMove(engine.Move{Kind: engine.MoveSevenPick, Card: c(card.Five, card.Hearts), SubMove: &zeroSub}); got.SubMove.Card != nil {
		t.Fatalf("SubMove Rank 0 must be null, got %v", got.SubMove.Card)
	}
}

func TestSPEC2_9_ErrorShape(t *testing.T) {
	m := decodeGeneric(t, errorJSON(codeBadRequest, "nope", nil))
	assertKeys(t, "EngineError", m, "ok", "code", "message")
	if m["ok"] != false || m["code"] != "BAD_REQUEST" || m["message"] != "nope" {
		t.Fatalf("error = %v", m)
	}
	m = decodeGeneric(t, errorJSON(codeIndexOutOfRange, "x", map[string]any{"index": 9}))
	if m["detail"].(map[string]any)["index"].(float64) != 9 {
		t.Fatalf("detail not carried: %v", m)
	}
}

func TestSPEC2_9_InternalOnPanic(t *testing.T) {
	out := guard(func() string { panic("boom") })
	m := decodeGeneric(t, out)
	if m["ok"] != false || m["code"] != "INTERNAL" || !strings.Contains(m["message"].(string), "boom") {
		t.Fatalf("recovered panic must become INTERNAL, got %s", out)
	}
	if got := guard(func() string { return "fine" }); got != "fine" {
		t.Fatalf("guard altered a normal result: %q", got)
	}
}

func TestSPEC2_6_DealStreamIsPinned(t *testing.T) {
	if uint64(dealStream) != 0x9E3779B97F4A7C15 {
		t.Fatalf("dealStream changed to %#x; scenario reproducibility depends on it", uint64(dealStream))
	}
}
