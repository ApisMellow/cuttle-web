package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

const (
	// DefaultBackupKeep is how many backups are kept (plan §11: 3 copies).
	DefaultBackupKeep = 3
	// BackupInterval is how often RunBackups writes a backup.
	BackupInterval = 24 * time.Hour

	backupPrefix     = "cuttle-"
	backupSuffix     = ".db"
	backupTimeLayout = "20060102T150405Z"
	// backupTempPrefix marks a backup still being written. A crashed run can
	// leave one behind; the next run removes it.
	backupTempPrefix = ".tmp-"
)

// backupFile matches a finished backup's file name, and nothing else in the
// directory is ever listed for pruning.
var backupFile = regexp.MustCompile(`^cuttle-(\d{8}T\d{6}Z)\.db$`)

// staleTemp matches only this package's own temp names (and a SQLite journal
// beside one), so an unrelated dot-file in the directory survives.
var staleTemp = regexp.MustCompile(`^\.tmp-cuttle-\d{8}T\d{6}Z\.db(-journal)?$`)

// Backuper writes a consistent copy of the database to a new file at dest.
// *store.SQLite implements it.
type Backuper interface {
	Backup(ctx context.Context, dest string) error
}

// BackupOptions configures RunBackups.
type BackupOptions struct {
	Dir   string           // backup directory; "" disables backups
	Keep  int              // backups to keep; <= 0 means DefaultBackupKeep
	Every time.Duration    // 0 means BackupInterval
	Now   func() time.Time // nil means time.Now
	Log   *slog.Logger     // nil discards
}

// BackupOnce writes one backup into dir and prunes to the keep newest. The
// copy goes to a temporary name in dir and is renamed into place only when
// complete, so the final name never holds a partial file; on any error the
// temporary file is removed and nothing is pruned. A missing dir is
// created 0700; an existing one that group or others can access is refused,
// never chmodded. Files are 0600. It returns
// the new file's name and how many old backups were removed.
func BackupOnce(ctx context.Context, b Backuper, dir string, keep int, now time.Time) (name string, pruned int, err error) {
	if keep <= 0 {
		keep = DefaultBackupKeep
	}
	if err := prepareBackupDir(dir); err != nil {
		return "", 0, err
	}
	removeStaleTemps(dir)

	name = backupPrefix + now.UTC().Format(backupTimeLayout) + backupSuffix
	final := filepath.Join(dir, name)
	if _, err := os.Lstat(final); err == nil {
		return "", 0, fmt.Errorf("backup %s already exists", name)
	}
	tmp := filepath.Join(dir, backupTempPrefix+name)
	// The backer creates tmp itself, so a leftover with this exact name
	// (never expected after removeStaleTemps) is an error, not overwritten.
	defer func() {
		if err != nil {
			os.Remove(tmp)
		}
	}()
	if err = b.Backup(ctx, tmp); err != nil {
		return "", 0, fmt.Errorf("copy: %w", err)
	}
	// Force the mode even if the backer wrote something looser.
	if err = os.Chmod(tmp, 0o600); err != nil {
		return "", 0, fmt.Errorf("chmod: %w", unwrapPath(err))
	}
	if err = os.Rename(tmp, final); err != nil {
		return "", 0, fmt.Errorf("rename: %w", unwrapPath(err))
	}
	return name, pruneBackups(dir, keep), nil
}

// prepareBackupDir makes sure dir exists as a private directory. A missing
// dir is created and set to 0700. An existing dir is used as it is, but one
// that group or others can access is refused, not chmodded: the server did
// not create it and must not silently change someone else's directory.
func prepareBackupDir(dir string) error {
	st, err := os.Stat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("backup dir: %w", unwrapPath(err))
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("backup dir: %w", unwrapPath(err))
		}
		return nil
	case err != nil:
		return fmt.Errorf("backup dir: %w", unwrapPath(err))
	case !st.IsDir():
		return errors.New("backup dir: not a directory")
	case st.Mode().Perm()&0o077 != 0:
		return errors.New("backup dir: existing directory is accessible to group or others; use mode 0700")
	}
	return nil
}

// removeStaleTemps deletes temp files a crashed run left behind.
func removeStaleTemps(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() && staleTemp.MatchString(e.Name()) {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// pruneBackups removes all but the keep newest finished backups (the file
// name carries a UTC timestamp, so name order is age order) and returns how
// many it removed. Files that don't match the backup name are never touched.
func pruneBackups(dir string, keep int) int {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var found []string
	for _, e := range ents {
		if !e.IsDir() && backupFile.MatchString(e.Name()) {
			found = append(found, e.Name())
		}
	}
	sort.Strings(found)
	pruned := 0
	for len(found) > keep {
		if os.Remove(filepath.Join(dir, found[0])) == nil {
			pruned++
		}
		found = found[1:]
	}
	return pruned
}

// newestBackup is the time in the newest finished backup's name.
func newestBackup(dir string) (time.Time, bool) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return time.Time{}, false
	}
	var newest time.Time
	for _, e := range ents {
		m := backupFile.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		if t, err := time.Parse(backupTimeLayout, m[1]); err == nil && t.After(newest) {
			newest = t
		}
	}
	return newest, !newest.IsZero()
}

// unwrapPath drops the file path from an *fs.PathError (or similar): logs
// carry the failing operation and the OS reason, not the deployment layout.
func unwrapPath(err error) error {
	if u := errors.Unwrap(err); u != nil {
		return u
	}
	return err
}

// RunBackups writes a backup every opt.Every (default daily) until ctx is
// done. It returns at once when opt.Dir is empty (backups off). The first
// backup happens immediately unless the newest one in the directory is less
// than an interval old, so restarts and deploys neither skip a day nor pile
// up extra copies. Failures are logged and retried at the next tick. Logs
// carry the file name, size and counts, never a path or any row content.
func RunBackups(ctx context.Context, b Backuper, opt BackupOptions) {
	if opt.Dir == "" {
		return
	}
	every := opt.Every
	if every <= 0 {
		every = BackupInterval
	}
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	log := opt.Log
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}

	run := func() {
		name, pruned, err := BackupOnce(ctx, b, opt.Dir, opt.Keep, now())
		switch {
		case err != nil && ctx.Err() != nil:
			// Shutting down mid-copy: the temp file is already gone.
		case err != nil:
			log.Error("backup failed", "err", err)
		default:
			var size int64
			if st, serr := os.Stat(filepath.Join(opt.Dir, name)); serr == nil {
				size = st.Size()
			}
			log.Info("backup written", "file", name, "bytes", size, "pruned", pruned)
		}
	}

	delay := time.Duration(0)
	if last, ok := newestBackup(opt.Dir); ok {
		if wait := last.Add(every).Sub(now()); wait > 0 {
			// Clamp: a future-dated file (clock jump, restored copy) must
			// not push the schedule out by more than one interval.
			delay = min(wait, every)
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			run()
			timer.Reset(every)
		}
	}
}

// PreflightBackupDir is the startup check for -backup-dir: "" (backups off)
// passes; a missing directory is created 0700 (so an uncreatable path fails
// now, not at the first nightly run); an existing one that group or others
// can access is refused. main calls it before listening and exits 2 on error.
func PreflightBackupDir(dir string) error {
	if dir == "" {
		return nil
	}
	return prepareBackupDir(dir)
}
