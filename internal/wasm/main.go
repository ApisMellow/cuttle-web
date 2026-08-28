//go:build js && wasm

// Package main is the WASM bridge (SPEC §2). The full function surface —
// newGame / legalMoves / apply / describe returning the §2.7 envelope —
// lands with the envelope milestone; this entry point establishes the
// build target and readiness lifecycle.
package main

import "syscall/js"

func main() {
	// Bridge registration goes here. Block so the Go runtime stays alive;
	// wasm_exec.js resolves the Go module's readiness promise on return.
	js.Global().Set("__cuttleReady", js.Global().Get("Promise").Call("resolve", true))
	select {}
}
