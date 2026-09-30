package store

import (
	"context"
	"errors"
	"fmt"
	"os"

	"modernc.org/sqlite"
)

// backupAfterCreate is a test seam, called between creating the destination
// and running VACUUM. It is nil in production.
var backupAfterCreate func(dest string)

// unwrapPath drops the file path from an *fs.PathError: the text of such an
// error names the full path, which logs must not carry. An error with
// nothing to unwrap is returned as is.
func unwrapPath(err error) error {
	if u := errors.Unwrap(err); u != nil {
		return u
	}
	return err
}

// Backup writes a consistent, compacted copy of the database to dest with
// SQLite's VACUUM INTO. The copy holds every hidden card and every token
// hash, so dest is created here with mode 0600 (SQLite itself would use the
// process umask) and removed again if the copy fails, so a failed call never
// leaves a partial file. dest must not already exist.
//
// The copy runs on the writer connection: writes wait for it, readers do
// not. Callers that want a crash-safe result write to a temporary name and
// rename it afterwards (see server.BackupOnce).
func (s *SQLite) Backup(ctx context.Context, dest string) (err error) {
	if dest == "" {
		return fmt.Errorf("%w: empty backup path", ErrInvalid)
	}
	// O_EXCL both refuses to clobber an existing file and lets us set the
	// mode before any data lands. SQLite accepts an existing empty file.
	f, err := os.OpenFile(dest, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		// The *PathError text carries the full path; keep only the OS reason.
		return fmt.Errorf("store: backup: creating file: %w", unwrapPath(err))
	}
	f.Close()
	defer func() {
		if err != nil {
			os.Remove(dest)
		}
	}()
	if backupAfterCreate != nil {
		backupAfterCreate(dest)
	}
	if _, err = s.w.ExecContext(ctx, `VACUUM INTO ?`, dest); err != nil {
		// SQLite's messages embed the destination path. Keep the code only;
		// a context error carries no path and stays matchable.
		var se *sqlite.Error
		if errors.As(err, &se) {
			return fmt.Errorf("store: backup: sqlite error code %d", se.Code())
		}
		return fmt.Errorf("store: backup: %w", err)
	}
	// Belt and braces: the mode must be 0600 whatever SQLite did.
	if err = os.Chmod(dest, 0o600); err != nil {
		return fmt.Errorf("store: backup: chmod: %w", unwrapPath(err))
	}
	return nil
}
