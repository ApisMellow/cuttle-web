package store

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
)

// TokenBytes is the size of a raw seat token before encoding.
const TokenBytes = 32

// NewToken returns a fresh raw seat token (32 bytes from r, base64url with no
// padding) and its hash. Only the hash is ever stored; the raw token goes to
// the client once.
func NewToken(r io.Reader) (string, [sha256.Size]byte, error) {
	var b [TokenBytes]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", [sha256.Size]byte{}, fmt.Errorf("store: drawing a seat token: %w", err)
	}
	raw := base64.RawURLEncoding.EncodeToString(b[:])
	return raw, HashToken(raw), nil
}

// HashToken is the stored form of a raw token: SHA-256 of its text. The
// token is 256 random bits, so a plain hash (no salt, no KDF) is enough.
func HashToken(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token))
}

// tokenMatches compares a presented token's hash with a stored hash in
// constant time. A nil stored hash (an empty seat) never matches.
func tokenMatches(presented [sha256.Size]byte, stored []byte) bool {
	if len(stored) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare(presented[:], stored) == 1
}
