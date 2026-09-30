package store

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestNewToken(t *testing.T) {
	raw, hash, err := NewToken(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		t.Fatalf("token %q is not raw base64url: %v", raw, err)
	}
	if len(b) != TokenBytes {
		t.Fatalf("token decodes to %d bytes, want %d", len(b), TokenBytes)
	}
	if hash != sha256.Sum256([]byte(raw)) {
		t.Fatal("hash is not SHA-256 of the raw token")
	}
	if HashToken(raw) != hash {
		t.Fatal("HashToken disagrees with NewToken")
	}
	raw2, _, err := NewToken(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if raw2 == raw {
		t.Fatal("two tokens are equal")
	}
}

func TestNewTokenReaderError(t *testing.T) {
	if _, _, err := NewToken(bytes.NewReader(make([]byte, TokenBytes-1))); err == nil {
		t.Fatal("short reader: want error")
	}
}
