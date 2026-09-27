//go:build js && wasm

// Package main is the WASM bridge (SPEC §2). This file is only the
// syscall/js shim: it converts JS arguments, calls the host-testable Bridge
// in bridge.go, and returns the JSON string it produces. All contract logic
// (envelope, normalization, redaction, errors) lives in untagged files.
package main

import (
	"fmt"
	"syscall/js"
)

func main() {
	registerBridgeFunctions(newBridge())
	js.Global().Set("__cuttleReady", js.ValueOf(true))
	select {} // block forever — MUST be last (§2.3); returning kills every registered function
}

func registerBridgeFunctions(b *Bridge) {
	register("__cuttleNewGame", func(args []js.Value) string { return b.NewGame(argAt(args, 0)) })
	register("__cuttleLegalMoves", func([]js.Value) string { return b.LegalMoves() })
	register("__cuttleApply", func(args []js.Value) string { return b.Apply(argAt(args, 0)) })
	register("__cuttleDescribe", func([]js.Value) string { return b.Describe() })
	register("__cuttleView", func(args []js.Value) string { return b.View(argAt(args, 0)) })
	register("__cuttleSnapshot", func([]js.Value) string { return b.Snapshot() })
	register("__cuttleRestore", func(args []js.Value) string { return b.Restore(argAt(args, 0)) })
}

// register installs one global. The Bridge methods already recover panics;
// this outer recover also covers argument conversion, so nothing can throw
// across the WASM boundary (§2.9).
func register(name string, fn func(args []js.Value) string) {
	js.Global().Set(name, js.FuncOf(func(_ js.Value, args []js.Value) (result any) {
		defer func() {
			if r := recover(); r != nil {
				result = errorJSON(codeInternal, fmt.Sprintf("recovered panic in %s: %v", name, r), nil)
			}
		}()
		return fn(args)
	}))
}

// argAt converts the i-th JS argument to the Bridge argument convention
// documented on Bridge.
func argAt(args []js.Value, i int) any {
	if i >= len(args) {
		return nil
	}
	v := args[i]
	switch v.Type() {
	case js.TypeString:
		return v.String()
	case js.TypeNumber:
		return v.Float()
	case js.TypeBoolean:
		return v.Bool()
	case js.TypeUndefined, js.TypeNull:
		return nil
	default:
		return unsupportedArg{Kind: v.Type().String()}
	}
}
