package server

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ApisMellow/cuttle-web/internal/store"
)

// fakeBackuper writes fixed bytes, or partial bytes and then an error.
type fakeBackuper struct {
	fail  bool
	calls atomic.Int32
}

func (f *fakeBackuper) Backup(_ context.Context, dest string) error {
	f.calls.Add(1)
	if err := os.WriteFile(dest, []byte("partial"), 0o644); err != nil {
		return err
	}
	if f.fail {
		return errors.New("injected backup failure")
	}
	return nil
}

var backupName = regexp.MustCompile(`^cuttle-\d{8}T\d{6}Z\.db$`)

func names(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestBackupOnce_WritesNamedPrivateFileAndNoTemp(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "backups") // created by BackupOnce
	now := time.Date(2026, 9, 29, 3, 4, 5, 0, time.UTC)
	name, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now)
	if err != nil {
		t.Fatal(err)
	}
	if name != "cuttle-20260929T030405Z.db" {
		t.Errorf("name = %q", name)
	}
	if got := names(t, dir); len(got) != 1 || got[0] != name {
		t.Errorf("dir = %v, want only %q (no temp file)", got, name)
	}
	fi, _ := os.Stat(filepath.Join(dir, name))
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %o, want 600 (backer wrote 644)", fi.Mode().Perm())
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %o, want 700", di.Mode().Perm())
	}
}

func TestBackupOnce_RefusesLooseExistingDirWithoutChmod(t *testing.T) {
	dir := privDir(t)
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fb := &fakeBackuper{}
	if _, _, err := BackupOnce(bg, fb, dir, 3, time.Now()); err == nil {
		t.Fatal("a group/other-readable existing dir was accepted")
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o755 {
		t.Errorf("existing dir was chmodded to %o", di.Mode().Perm())
	}
	if fb.calls.Load() != 0 {
		t.Error("backup ran into a loose directory")
	}
}

func TestBackupOnce_AcceptsStricterExistingDir(t *testing.T) {
	dir := privDir(t)
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestBackupOnce_StaleTempCleanupOnlyMatchesOwnTemps(t *testing.T) {
	dir := privDir(t)
	keepers := []string{".tmp-other", ".tmp-cuttle-notadate.db", ".tmp-cuttle-20260101T000000Z.db.bak"}
	for _, n := range keepers {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("mine"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	goners := []string{".tmp-cuttle-20260101T000000Z.db", ".tmp-cuttle-20260101T000000Z.db-journal"}
	for _, n := range goners {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("crash"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, n := range keepers {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("unrelated %s was deleted: %v", n, err)
		}
	}
	for _, n := range goners {
		if _, err := os.Stat(filepath.Join(dir, n)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("own stale temp %s survived: %v", n, err)
		}
	}
}

func TestBackupOnce_UnwritableDirErrorHasNoPath(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory modes")
	}
	st, err := store.OpenDir(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	dir := filepath.Join(t.TempDir(), "ro-backups")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	_, _, err = BackupOnce(bg, st, dir, 3, time.Now())
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), dir) || strings.Contains(err.Error(), "ro-backups") {
		t.Errorf("error leaks the path: %v", err)
	}
	// And through the run loop's log line.
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		RunBackups(ctx, st, BackupOptions{Dir: dir, Every: 10 * time.Millisecond, Log: newTestLog(logs)})
		close(done)
	}()
	deadline := time.After(5 * time.Second)
	for !strings.Contains(logs.String(), "backup failed") {
		select {
		case <-deadline:
			t.Fatalf("no failure log: %s", logs.String())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
	if strings.Contains(logs.String(), "ro-backups") {
		t.Errorf("log leaks the path: %s", logs.String())
	}
}

func TestRunBackups_FirstBackupRunsAtOnce(t *testing.T) {
	dir := privDir(t)
	fb := &fakeBackuper{}
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		RunBackups(ctx, fb, BackupOptions{Dir: dir, Every: time.Hour})
		close(done)
	}()
	deadline := time.After(2 * time.Second)
	for fb.calls.Load() < 1 {
		select {
		case <-deadline:
			t.Fatal("no backup within 2 s of start with an empty dir")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

func TestRunBackups_FutureDatedBackupCannotStallSchedule(t *testing.T) {
	dir := privDir(t)
	now := time.Date(2026, 9, 29, 3, 0, 0, 0, time.UTC)
	// A file dated a year ahead (clock jump, restored copy).
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now.AddDate(1, 0, 0)); err != nil {
		t.Fatal(err)
	}
	fb := &fakeBackuper{}
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		RunBackups(ctx, fb, BackupOptions{Dir: dir, Every: 30 * time.Millisecond, Now: func() time.Time { return now }})
		close(done)
	}()
	time.Sleep(500 * time.Millisecond)
	cancel()
	<-done
	if fb.calls.Load() == 0 {
		t.Error("a future-dated backup stalled the schedule")
	}
}

func TestParseConfig_BackupDirResolvesSymlinkIntoDataDir(t *testing.T) {
	data := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(data, link); err != nil {
		t.Fatal(err)
	}
	for name, dir := range map[string]string{"link to data": link, "under link": filepath.Join(link, "bk")} {
		if _, err := ParseConfig([]string{"-data-dir", data, "-backup-dir", dir}, func(string) string { return "" }); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	// And a data dir reached through a link, backup dir given directly.
	if _, err := ParseConfig([]string{"-data-dir", link, "-backup-dir", filepath.Join(data, "bk")}, func(string) string { return "" }); err == nil {
		t.Error("data dir via symlink: expected error")
	}
}

func TestBackupOnce_FailureLeavesNoPartialFile(t *testing.T) {
	dir := privDir(t)
	now := time.Date(2026, 9, 29, 3, 0, 0, 0, time.UTC)
	// One good backup first: a later failure must not disturb it.
	good, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = BackupOnce(bg, &fakeBackuper{fail: true}, dir, 3, now.Add(24*time.Hour))
	if err == nil {
		t.Fatal("expected an error")
	}
	if got := names(t, dir); len(got) != 1 || got[0] != good {
		t.Errorf("dir after failure = %v, want only %q", got, good)
	}
}

func TestBackupOnce_FailureDoesNotPrune(t *testing.T) {
	dir := privDir(t)
	now := time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now.Add(time.Duration(i)*24*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := BackupOnce(bg, &fakeBackuper{fail: true}, dir, 3, now.Add(72*time.Hour)); err == nil {
		t.Fatal("expected an error")
	}
	if got := names(t, dir); len(got) != 3 {
		t.Errorf("a failed run pruned good backups: %v", got)
	}
}

func TestBackupOnce_PrunesToKeepNewest(t *testing.T) {
	dir := privDir(t)
	base := time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC)
	var all []string
	for i := 0; i < 5; i++ {
		name, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, base.Add(time.Duration(i)*24*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, name)
	}
	got := names(t, dir)
	want := all[2:] // the three newest
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kept %v, want %v", got, want)
	}
}

func TestBackupOnce_PruneReportsCount(t *testing.T) {
	dir := privDir(t)
	base := time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC)
	var pruned int
	for i := 0; i < 4; i++ {
		_, p, err := BackupOnce(bg, &fakeBackuper{}, dir, 2, base.Add(time.Duration(i)*24*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		pruned += p
	}
	if pruned != 2 {
		t.Errorf("pruned = %d, want 2", pruned)
	}
}

func TestBackupOnce_PruneIgnoresOtherFilesAndClearsStaleTemps(t *testing.T) {
	dir := privDir(t)
	other := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(other, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, backupTempPrefix+"cuttle-20260101T000000Z.db")
	if err := os.WriteFile(stale, []byte("crash"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("an unrelated file was touched: %v", err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("stale temp from a crashed run not cleared: %v", err)
	}
}

func TestBackupOnce_SameSecondDoesNotOverwrite(t *testing.T) {
	dir := privDir(t)
	now := time.Date(2026, 9, 29, 3, 0, 0, 0, time.UTC)
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now); err == nil {
		t.Fatal("second backup in the same second replaced the first")
	}
}

func TestBackupOnce_RealStoreBackupIsOpenable(t *testing.T) {
	clk := newClock()
	st, err := store.OpenDir(t.TempDir(), store.Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	c, err := st.Create(bg, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "bk")
	name, _, err := BackupOnce(bg, st, dir, 3, clk.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !backupName.MatchString(name) {
		t.Errorf("name %q", name)
	}
	// The backup directory holds a database only; open a copy as a store.
	copyDir := t.TempDir()
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copyDir, store.FileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	restored, err := store.OpenDir(copyDir, store.Options{Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if got, err := restored.Get(bg, c.Code); err != nil || got.Names[0] != "Alice" {
		t.Fatalf("restored room = %+v, %v", got, err)
	}
}

func TestRunBackups_DisabledWhenDirEmpty(t *testing.T) {
	fb := &fakeBackuper{}
	done := make(chan struct{})
	go func() {
		RunBackups(bg, fb, BackupOptions{Dir: "", Every: time.Millisecond})
		close(done)
	}()
	select {
	case <-done: // returns at once
	case <-time.After(2 * time.Second):
		t.Fatal("RunBackups with no dir should return immediately")
	}
	if fb.calls.Load() != 0 {
		t.Errorf("backup ran while disabled: %d calls", fb.calls.Load())
	}
}

func TestRunBackups_RunsThenStopsOnCancel(t *testing.T) {
	dir := privDir(t)
	fb := &fakeBackuper{}
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	clk := newClock()
	go func() {
		RunBackups(ctx, fb, BackupOptions{
			Dir: dir, Keep: 2, Every: 10 * time.Millisecond, Log: newTestLog(logs),
			// Each tick advances a fake day so file names never collide.
			Now: func() time.Time { clk.Advance(24 * time.Hour); return clk.Now() },
		})
		close(done)
	}()
	deadline := time.After(5 * time.Second)
	for {
		if len(names(t, dir)) == 2 && fb.calls.Load() >= 3 { // ran repeatedly and pruned
			break
		}
		select {
		case <-deadline:
			t.Fatalf("no repeated backups: calls=%d files=%v", fb.calls.Load(), names(t, dir))
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunBackups did not stop on cancel")
	}
	if !strings.Contains(logs.String(), "backup written") {
		t.Errorf("no success log: %s", logs.String())
	}
}

func TestRunBackups_SkipsWhenRecentBackupExists(t *testing.T) {
	dir := privDir(t)
	now := time.Date(2026, 9, 29, 3, 0, 0, 0, time.UTC)
	if _, _, err := BackupOnce(bg, &fakeBackuper{}, dir, 3, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	fb := &fakeBackuper{}
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		RunBackups(ctx, fb, BackupOptions{Dir: dir, Every: 24 * time.Hour, Now: func() time.Time { return now }})
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if fb.calls.Load() != 0 {
		t.Errorf("restart within a day re-ran the backup (%d calls)", fb.calls.Load())
	}
}

func TestRunBackups_FailureIsLoggedWithoutContents(t *testing.T) {
	dir := privDir(t)
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(bg)
	done := make(chan struct{})
	go func() {
		RunBackups(ctx, &fakeBackuper{fail: true}, BackupOptions{Dir: dir, Every: 10 * time.Millisecond, Log: newTestLog(logs)})
		close(done)
	}()
	deadline := time.After(5 * time.Second)
	for !strings.Contains(logs.String(), "backup failed") {
		select {
		case <-deadline:
			t.Fatalf("no failure log: %s", logs.String())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
	if strings.Contains(logs.String(), "partial") {
		t.Errorf("file contents leaked into the log: %s", logs.String())
	}
	if strings.Contains(logs.String(), dir) {
		t.Errorf("backup path logged: %s", logs.String())
	}
	if got := names(t, dir); len(got) != 0 {
		t.Errorf("files after failed runs: %v", got)
	}
}

// ---- config ----

func TestParseConfig_BackupDefaultsOff(t *testing.T) {
	cfg, err := ParseConfig(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackupDir != "" || cfg.BackupKeep != DefaultBackupKeep || DefaultBackupKeep != 3 {
		t.Errorf("%+v (default keep %d)", cfg, DefaultBackupKeep)
	}
}

func TestParseConfig_BackupFlagEnvAndPrecedence(t *testing.T) {
	envDir := filepath.Join(t.TempDir(), "envbk")
	flagDir := filepath.Join(t.TempDir(), "flagbk")
	env := map[string]string{"CUTTLE_BACKUP_DIR": envDir, "CUTTLE_BACKUP_KEEP": "5"}
	getenv := func(k string) string { return env[k] }
	cfg, err := ParseConfig(nil, getenv)
	if err != nil || cfg.BackupDir != envDir || cfg.BackupKeep != 5 {
		t.Fatalf("env: %+v %v", cfg, err)
	}
	cfg, err = ParseConfig([]string{"-backup-dir", flagDir, "-backup-keep", "9"}, getenv)
	if err != nil || cfg.BackupDir != flagDir || cfg.BackupKeep != 9 {
		t.Fatalf("flag should beat env: %+v %v", cfg, err)
	}
}

func TestParseConfig_BackupRejects(t *testing.T) {
	data := t.TempDir()
	cases := map[string][]string{
		"keep zero":      {"-backup-dir", "/var/backups/x", "-backup-keep", "0"},
		"keep negative":  {"-backup-dir", "/var/backups/x", "-backup-keep", "-1"},
		"relative dir":   {"-backup-dir", "backups"},
		"nul in path":    {"-backup-dir", "/var/backups/\x00x"},
		"dir is data":    {"-data-dir", data, "-backup-dir", data},
		"dir in data":    {"-data-dir", data, "-backup-dir", filepath.Join(data, "bk")},
		"dir has dotdot": {"-backup-dir", "/var/backups/../x"},
	}
	for name, args := range cases {
		if _, err := ParseConfig(args, func(string) string { return "" }); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	env := map[string]string{"CUTTLE_BACKUP_KEEP": "many"}
	if _, err := ParseConfig(nil, func(k string) string { return env[k] }); err == nil {
		t.Error("non-integer CUTTLE_BACKUP_KEEP accepted")
	}
}

func newTestLog(w *syncBuffer) *slog.Logger { return slog.New(slog.NewJSONHandler(w, nil)) }

// privDir is a temp dir at 0700, the mode BackupOnce insists on for an
// existing backup directory.
func privDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPreflightBackupDir(t *testing.T) {
	if err := PreflightBackupDir(""); err != nil {
		t.Errorf("disabled backups must pass: %v", err)
	}
	// Missing: created 0700, so a bad path fails at startup, not at 03:00.
	fresh := filepath.Join(t.TempDir(), "a", "bk")
	if err := PreflightBackupDir(fresh); err != nil {
		t.Fatal(err)
	}
	if di, err := os.Stat(fresh); err != nil || di.Mode().Perm() != 0o700 {
		t.Errorf("created dir: %v %v", di, err)
	}
	// Loose existing dir: refused, not chmodded.
	loose := t.TempDir()
	if err := os.Chmod(loose, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := PreflightBackupDir(loose); err == nil {
		t.Error("loose dir accepted")
	}
	if di, _ := os.Stat(loose); di.Mode().Perm() != 0o755 {
		t.Errorf("preflight chmodded an existing dir: %o", di.Mode().Perm())
	}
	// Uncreatable: the parent is a regular file.
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := PreflightBackupDir(filepath.Join(file, "bk"))
	if err == nil {
		t.Fatal("uncreatable dir accepted")
	}
	if strings.Contains(err.Error(), file) {
		t.Errorf("error leaks the path: %v", err)
	}
}
