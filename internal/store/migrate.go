package store

import (
	"context"
	"database/sql"
	"fmt"
)

// migrations[i] moves the schema from user_version i to i+1. Append only:
// never edit or reorder a shipped entry.
var migrations = []string{
	// v1: one row per room (two-phone plan §4). Codes are stored upper-case
	// only, so the primary key is case-insensitive in effect; NormalizeCode
	// maps any user input onto that form. Times are Unix milliseconds.
	// Seat 1 columns are NULL until someone joins. The snapshot is the
	// engine's JSON, opaque here, NULL until the first deal.
	`CREATE TABLE rooms (
		code        TEXT    NOT NULL PRIMARY KEY
		                    CHECK (length(code) = 4 AND code = upper(code)),
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL,
		status      TEXT    NOT NULL CHECK (status IN ('waiting', 'active', 'finished')),
		name0       TEXT    NOT NULL,
		name1       TEXT,
		token0_hash BLOB    NOT NULL CHECK (length(token0_hash) = 32),
		token1_hash BLOB    CHECK (token1_hash IS NULL OR length(token1_hash) = 32),
		game_no     INTEGER NOT NULL DEFAULT 0 CHECK (game_no >= 0),
		seq         INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
		tally0      INTEGER NOT NULL DEFAULT 0 CHECK (tally0 >= 0),
		tally1      INTEGER NOT NULL DEFAULT 0 CHECK (tally1 >= 0),
		last_dealer INTEGER CHECK (last_dealer IS NULL OR last_dealer IN (0, 1)),
		snapshot    BLOB,
		CHECK ((name1 IS NULL) = (token1_hash IS NULL)),
		CHECK ((status = 'waiting') = (token1_hash IS NULL))
	) STRICT;
	CREATE INDEX rooms_by_updated_at ON rooms (updated_at);`,
}

// schemaVersion is the user_version a fully migrated database carries.
var schemaVersion = len(migrations)

// migrate brings db up to schemaVersion in one transaction. It is a no-op on
// an up-to-date database and refuses one written by a newer binary.
func migrate(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: migrate: %w", err)
	}
	defer tx.Rollback()

	var v int
	if err := tx.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&v); err != nil {
		return fmt.Errorf("store: migrate: reading user_version: %w", err)
	}
	if v > schemaVersion {
		return fmt.Errorf("store: database schema v%d is newer than this binary (v%d)", v, schemaVersion)
	}
	for i := v; i < schemaVersion; i++ {
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			return fmt.Errorf("store: migration to v%d: %w", i+1, err)
		}
	}
	// PRAGMA takes no bind parameters; schemaVersion is a package constant.
	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)); err != nil {
		return fmt.Errorf("store: migrate: setting user_version: %w", err)
	}
	return tx.Commit()
}
