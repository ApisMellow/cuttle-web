package store

import (
	"fmt"
	"io"
	"strings"
)

// CodeAlphabet is Crockford base32: digits and uppercase letters without
// the confusable I, L, O and U.
const CodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// CodeLen is the number of characters in a room code (32^4 ≈ 1M codes).
const CodeLen = 4

// NewCode draws a random room code from r (crypto/rand in production).
// Each character takes the low 5 bits of one byte; 256 is a multiple of 32,
// so the draw is unbiased.
func NewCode(r io.Reader) (string, error) {
	var b [CodeLen]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", fmt.Errorf("store: drawing a room code: %w", err)
	}
	for i := range b {
		b[i] = CodeAlphabet[b[i]&31]
	}
	return string(b[:]), nil
}

// NormalizeCode returns the canonical form of a user-typed code: surrounding
// space trimmed, upper-cased, and Crockford's decoding aliases applied
// (O→0, I and L→1). Anything else outside the alphabet, or the wrong length,
// is ErrInvalid.
func NormalizeCode(s string) (string, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != CodeLen {
		return "", fmt.Errorf("%w: room code must be %d characters", ErrInvalid, CodeLen)
	}
	out := []byte(s)
	for i, c := range out {
		switch c {
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		if strings.IndexByte(CodeAlphabet, c) < 0 {
			return "", fmt.Errorf("%w: room code has a character outside the alphabet", ErrInvalid)
		}
		out[i] = c
	}
	return string(out), nil
}
