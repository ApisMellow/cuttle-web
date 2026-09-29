//go:build !(js && wasm)

// Host-only entry point. The real bridge entry point in main.go is built
// only for GOOS=js GOARCH=wasm. Without this stub the package has no Go
// file on the host, and `go build ./...` / `go vet ./...` would have to
// skip it. It does nothing on purpose: the bridge is never run on the
// host, and its logic is tested in internal/game.
package main

func main() {}
