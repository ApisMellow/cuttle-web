package store

import (
	"bytes"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

func TestCodeAlphabetIsCrockford(t *testing.T) {
	if len(CodeAlphabet) != 32 {
		t.Fatalf("alphabet has %d characters, want 32", len(CodeAlphabet))
	}
	for _, bad := range "ILOU" {
		if strings.ContainsRune(CodeAlphabet, bad) {
			t.Errorf("alphabet contains confusable %q", bad)
		}
	}
	seen := map[rune]bool{}
	for _, c := range CodeAlphabet {
		if seen[c] {
			t.Errorf("duplicate %q", c)
		}
		seen[c] = true
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z') {
			t.Errorf("unexpected character %q", c)
		}
	}
}

func TestNewCodeFormat(t *testing.T) {
	seen := map[rune]int{}
	for i := 0; i < 2000; i++ {
		code, err := NewCode(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != CodeLen {
			t.Fatalf("code %q has length %d", code, len(code))
		}
		for _, c := range code {
			if !strings.ContainsRune(CodeAlphabet, c) {
				t.Fatalf("code %q has %q outside the alphabet", code, c)
			}
			seen[c]++
		}
		if n, err := NormalizeCode(code); err != nil || n != code {
			t.Fatalf("NormalizeCode(%q) = %q, %v; want identity", code, n, err)
		}
	}
	if len(seen) != 32 {
		t.Errorf("2000 codes used %d of 32 characters", len(seen))
	}
}

// Every byte value maps to exactly one character and each character gets the
// same share, so the draw is unbiased.
func TestNewCodeUnbiased(t *testing.T) {
	all := make([]byte, 256)
	for i := range all {
		all[i] = byte(i)
	}
	r := bytes.NewReader(all)
	count := map[rune]int{}
	for i := 0; i < 256/CodeLen; i++ {
		code, err := NewCode(r)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range code {
			count[c]++
		}
	}
	for _, c := range CodeAlphabet {
		if count[c] != 8 {
			t.Errorf("%q drawn %d times from 256 byte values, want 8", c, count[c])
		}
	}
}

func TestNewCodeReaderError(t *testing.T) {
	if _, err := NewCode(bytes.NewReader([]byte{1, 2})); err == nil {
		t.Fatal("short reader: want error")
	}
}

func TestNormalizeCode(t *testing.T) {
	ok := map[string]string{
		"K7QX":   "K7QX",
		"k7qx":   "K7QX",
		" k7qx ": "K7QX",
		"o0il":   "0011", // Crockford decoding: O→0, I and L→1
		"OILZ":   "011Z",
	}
	for in, want := range ok {
		got, err := NormalizeCode(in)
		if err != nil || got != want {
			t.Errorf("NormalizeCode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "K7Q", "K7QXZ", "K7QU", "K7Q!", "K7-Q", "K7QÉ"} {
		if got, err := NormalizeCode(in); !errors.Is(err, ErrInvalid) {
			t.Errorf("NormalizeCode(%q) = %q, %v; want ErrInvalid", in, got, err)
		}
	}
}
