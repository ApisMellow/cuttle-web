//go:build !(js && wasm)

// Host-only entry point. The real bridge entry point in main.go is built
// only for GOOS=js GOARCH=wasm. Without this stub, `go build ./...` on the
// host compiles deal.go/view.go/bridge.go as a main package with no main()
// and fails. It does nothing on purpose: the bridge is never run on the
// host, but `go test ./...` still exercises every untagged file here.
package main

func main() {}
