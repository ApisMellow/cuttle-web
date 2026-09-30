package store

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBackup_ValidDatabaseWithSameRows(t *testing.T) {
	clk := newClock()
	s, _ := openFile(t, clk, Options{})
	a, _ := dealt(t, s)
	waiting := mustCreate(t, s, "Casey")

	dest := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Backup(bg, dest); err != nil {
		t.Fatalf("Backup: %v", err)
	}

	// Integrity check on a read-only handle, so the backup file is untouched.
	ro, err := sql.Open("sqlite", dest+"?_pragma=query_only(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()
	var verdict string
	if err := ro.QueryRow(`PRAGMA integrity_check`).Scan(&verdict); err != nil || verdict != "ok" {
		t.Fatalf("integrity_check = %q, %v", verdict, err)
	}
	var n int
	if err := ro.QueryRow(`SELECT count(*) FROM rooms`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("rooms in backup = %d, %v", n, err)
	}

	// Open a copy through the store itself: same rows, tokens still valid.
	copyPath := filepath.Join(t.TempDir(), FileName)
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(copyPath, Options{Now: clk.Now})
	if err != nil {
		t.Fatalf("open backup as a store: %v", err)
	}
	defer restored.Close()
	for _, code := range []string{a.Code, waiting.Code} {
		if got, want := mustGet(t, restored, code), mustGet(t, s, code); !reflect.DeepEqual(got, want) {
			t.Errorf("room %s differs:\n got %+v\nwant %+v", code, got, want)
		}
	}
	if seat, err := restored.Authenticate(bg, a.Code, a.Token); err != nil || seat != 0 {
		t.Errorf("token hash lost in backup: %v %v", seat, err)
	}
}

func TestBackup_IncludesUncheckpointedWALRows(t *testing.T) {
	s, dir := openFile(t, newClock(), Options{})
	c := mustCreate(t, s, "Alice")
	// The row may still sit in the -wal file; the backup must carry it.
	if _, err := os.Stat(filepath.Join(dir, FileName+"-wal")); err != nil {
		t.Skipf("no wal file to exercise: %v", err)
	}
	dest := filepath.Join(t.TempDir(), "b.db")
	if err := s.Backup(bg, dest); err != nil {
		t.Fatal(err)
	}
	ro, err := sql.Open("sqlite", dest+"?_pragma=query_only(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()
	var got string
	if err := ro.QueryRow(`SELECT code FROM rooms`).Scan(&got); err != nil || got != c.Code {
		t.Fatalf("backup row = %q, %v; want %q", got, err, c.Code)
	}
}

func TestBackup_FileIsPrivate(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	mustCreate(t, s, "Alice")
	dest := filepath.Join(t.TempDir(), "b.db")
	if err := s.Backup(bg, dest); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("backup mode = %o, want 600", st.Mode().Perm())
	}
}

func TestBackup_RefusesExistingFileAndLeavesItAlone(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	mustCreate(t, s, "Alice")
	dest := filepath.Join(t.TempDir(), "b.db")
	if err := os.WriteFile(dest, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Backup(bg, dest); err == nil {
		t.Fatal("Backup over an existing file succeeded")
	}
	if b, _ := os.ReadFile(dest); string(b) != "precious" {
		t.Errorf("existing file was modified: %q", b)
	}
}

func TestBackup_ErrorLeavesNoPartialFile(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	mustCreate(t, s, "Alice")
	// Closing the store makes the VACUUM fail after Backup has claimed the
	// destination name; the claimed file must not survive.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := s.Backup(bg, filepath.Join(dir, "b.db")); err == nil {
		t.Fatal("expected an error from a closed store")
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Errorf("files left after a failed backup: %v", ents)
	}
	// A destination directory that does not exist is an error too.
	if err := s.Backup(bg, filepath.Join(dir, "nope", "b.db")); err == nil {
		t.Fatal("expected an error for a missing directory")
	}
}

func TestBackup_EmptyPathRejected(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	if err := s.Backup(bg, ""); err == nil {
		t.Fatal("empty path accepted")
	}
}

func TestBackup_PreCreateStepGuardsTheDestination(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	mustCreate(t, s, "Alice")
	// A directory at dest: the O_EXCL create must be what refuses it. Without
	// the pre-create, the error would come from SQLite instead.
	dest := filepath.Join(t.TempDir(), "b.db")
	if err := os.Mkdir(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	err := s.Backup(bg, dest)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "creating file") {
		t.Errorf("error did not come from the create step: %v", err)
	}
}

func TestBackup_CreateErrorHasNoPath(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	dir := t.TempDir()
	err := s.Backup(bg, filepath.Join(dir, "missing-dir-name", "b.db"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "missing-dir-name") || strings.Contains(err.Error(), dir) {
		t.Errorf("error leaks the path: %v", err)
	}
}

func TestBackup_SQLiteErrorHasNoPath(t *testing.T) {
	s, _ := openFile(t, newClock(), Options{})
	mustCreate(t, s, "Alice")
	dest := filepath.Join(t.TempDir(), "sqlite-secret-name.db")
	// Between the create and the VACUUM, swap the file for a directory so
	// SQLite itself fails to open the destination.
	backupAfterCreate = func(d string) {
		os.Remove(d)
		os.Mkdir(d, 0o700)
	}
	defer func() { backupAfterCreate = nil }()
	err := s.Backup(bg, dest)
	if err == nil {
		t.Fatal("expected a SQLite error")
	}
	if strings.Contains(err.Error(), "sqlite-secret-name") || strings.Contains(err.Error(), filepath.Dir(dest)) {
		t.Errorf("SQLite error leaks the path: %v", err)
	}
	if !strings.Contains(err.Error(), "sqlite error code") {
		t.Errorf("error should carry the SQLite code: %v", err)
	}
}

func TestUnwrapPathNilGuard(t *testing.T) {
	plain := errors.New("plain")
	if got := unwrapPath(plain); got != plain {
		t.Errorf("unwrapPath(plain) = %v", got)
	}
}
