package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// FileName is the database file inside the data directory.
const FileName = "cuttle.db"

// busyTimeoutMS bounds how long a connection waits on a lock held by another
// connection (a reader during a checkpoint, an operator's sqlite3 shell, the
// janitor's VACUUM INTO) before failing with SQLITE_BUSY.
const busyTimeoutMS = 5000

// readerConns caps the read pool. WAL lets readers run beside the writer.
const readerConns = 4

// defaultMaxDraw is how many codes Create tries before ErrCodeSpace. With
// 32^4 codes and at most a few hundred live rooms, one draw almost always
// succeeds.
const defaultMaxDraw = 32

// Options configures a SQLite store. The zero value is valid.
type Options struct {
	// IdleTTL is how long a room may go without activity before
	// DeleteExpired removes it. 0 means DefaultIdleTTL.
	IdleTTL time.Duration
	// Now is the clock. nil means time.Now. Times are stored to the
	// millisecond.
	Now func() time.Time
}

// SQLite is the SQLite-backed Store.
//
// Concurrency: the store holds two database/sql pools on one file. The
// writer pool has exactly one connection, so every write is serialized in
// Go by the pool: a goroutine waits for the connection instead of racing
// another writer inside SQLite, and SQLITE_BUSY between our own writers
// can't happen. Each guarded write (Join's seat claim, Save's version
// check) is a single conditional UPDATE, atomic on its own, so correctness
// doesn't depend on that serialization. Transactions (the migration) start
// with BEGIN IMMEDIATE, so
// an outside writer (a sqlite3 shell, a backup) is met by busy_timeout
// rather than a mid-transaction upgrade failure. The reader pool has a few
// query_only connections; in WAL mode they read the last committed state
// without blocking, or being blocked by, the writer. An in-memory store
// uses one connection for both roles.
type SQLite struct {
	w, r *sql.DB
	ttl  time.Duration
	now  func() time.Time

	// rand and maxDraw are fixed in production (crypto/rand, defaultMaxDraw);
	// tests in this package script them to force code collisions.
	rand    io.Reader
	maxDraw int

	closeMu sync.Mutex
	closed  bool
}

// OpenDir opens FileName inside dir, which must exist.
func OpenDir(dir string, opt Options) (*SQLite, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("store: data directory: %w", err)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("store: data directory %q is not a directory", dir)
	}
	return Open(filepath.Join(dir, FileName), opt)
}

// Open opens (creating if needed) the database file at path, applies any
// pending migrations and returns a store ready for concurrent use. A new
// file is created with mode 0600: the snapshots hold every hidden card.
func Open(path string, opt Options) (*SQLite, error) {
	if path == "" || strings.ContainsAny(path, "?#") || strings.HasPrefix(path, "file:") || path == ":memory:" {
		return nil, fmt.Errorf("%w: database path %q", ErrInvalid, path)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: creating database file: %w", err)
	}
	f.Close()

	pragmas := "_pragma=busy_timeout(" + fmt.Sprint(busyTimeoutMS) + ")" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(1)"

	w, err := sql.Open("sqlite", path+"?"+pragmas+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("store: open writer: %w", err)
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxLifetime(0)
	w.SetConnMaxIdleTime(0)

	s := newSQLite(w, nil, opt)
	if err := migrate(context.Background(), w); err != nil {
		w.Close()
		return nil, err
	}

	r, err := sql.Open("sqlite", path+"?"+pragmas+"&_pragma=query_only(1)")
	if err != nil {
		w.Close()
		return nil, fmt.Errorf("store: open reader: %w", err)
	}
	r.SetMaxOpenConns(readerConns)
	r.SetMaxIdleConns(readerConns)
	if err := r.Ping(); err != nil {
		r.Close()
		w.Close()
		return nil, fmt.Errorf("store: open reader: %w", err)
	}
	s.r = r
	return s, nil
}

// OpenMemory opens a private in-memory database, for tests. Nothing touches
// the disk and each call gets its own database. One connection serves reads
// and writes (an in-memory database lives and dies with its connection).
func OpenMemory(opt Options) (*SQLite, error) {
	db, err := sql.Open("sqlite", ":memory:?_pragma=busy_timeout("+fmt.Sprint(busyTimeoutMS)+")&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, fmt.Errorf("store: open memory: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	if err := migrate(context.Background(), db); err != nil {
		db.Close()
		return nil, err
	}
	return newSQLite(db, db, opt), nil
}

func newSQLite(w, r *sql.DB, opt Options) *SQLite {
	s := &SQLite{w: w, r: r, ttl: opt.IdleTTL, now: opt.Now, rand: rand.Reader, maxDraw: defaultMaxDraw}
	if s.ttl <= 0 {
		s.ttl = DefaultIdleTTL
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s
}

func (s *SQLite) nowMS() int64 { return s.now().UnixMilli() }

func fromMS(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func isPrimaryKeyViolation(err error) bool {
	var se *sqlite.Error
	return errors.As(err, &se) && se.Code() == sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY
}

// Create makes a waiting room under a fresh code, redrawing on a collision
// with any stored room.
func (s *SQLite) Create(ctx context.Context, name string) (Claim, error) {
	if name == "" {
		return Claim{}, fmt.Errorf("%w: empty name", ErrInvalid)
	}
	token, hash, err := NewToken(s.rand)
	if err != nil {
		return Claim{}, err
	}
	for i := 0; i < s.maxDraw; i++ {
		code, err := NewCode(s.rand)
		if err != nil {
			return Claim{}, err
		}
		now := s.nowMS()
		_, err = s.w.ExecContext(ctx,
			`INSERT INTO rooms (code, created_at, updated_at, status, name0, token0_hash)
			 VALUES (?, ?, ?, 'waiting', ?, ?)`,
			code, now, now, name, hash[:])
		if isPrimaryKeyViolation(err) {
			continue
		}
		if err != nil {
			return Claim{}, fmt.Errorf("store: create: %w", err)
		}
		return Claim{Code: code, Seat: 0, Token: token}, nil
	}
	return Claim{}, ErrCodeSpace
}

// Join claims seat 1 with a single conditional UPDATE: the row changes only
// while token1_hash is NULL, so of any set of concurrent joins exactly one
// sees a changed row.
func (s *SQLite) Join(ctx context.Context, code, name string) (Claim, error) {
	if name == "" {
		return Claim{}, fmt.Errorf("%w: empty name", ErrInvalid)
	}
	code, err := NormalizeCode(code)
	if err != nil {
		return Claim{}, ErrNotFound
	}
	token, hash, err := NewToken(s.rand)
	if err != nil {
		return Claim{}, err
	}
	res, err := s.w.ExecContext(ctx,
		`UPDATE rooms SET name1 = ?, token1_hash = ?, status = 'active', updated_at = ?
		 WHERE code = ? AND token1_hash IS NULL`,
		name, hash[:], s.nowMS(), code)
	if err != nil {
		return Claim{}, fmt.Errorf("store: join: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return Claim{}, fmt.Errorf("store: join: %w", err)
	} else if n == 1 {
		return Claim{Code: code, Seat: 1, Token: token}, nil
	}
	var one int
	switch err := s.w.QueryRowContext(ctx, `SELECT 1 FROM rooms WHERE code = ?`, code).Scan(&one); {
	case errors.Is(err, sql.ErrNoRows):
		return Claim{}, ErrNotFound
	case err != nil:
		return Claim{}, fmt.Errorf("store: join: %w", err)
	}
	return Claim{}, ErrRoomFull
}

// Get loads a room. A malformed code is ErrNotFound: no room can have it.
func (s *SQLite) Get(ctx context.Context, code string) (Room, error) {
	code, err := NormalizeCode(code)
	if err != nil {
		return Room{}, ErrNotFound
	}
	var (
		room       Room
		created    int64
		updated    int64
		status     string
		name1      sql.NullString
		lastDealer sql.NullInt64
	)
	err = s.r.QueryRowContext(ctx,
		`SELECT code, created_at, updated_at, status, name0, name1,
		        token1_hash IS NOT NULL, game_no, seq, tally0, tally1, last_dealer, snapshot
		 FROM rooms WHERE code = ?`, code).Scan(
		&room.Code, &created, &updated, &status, &room.Names[0], &name1,
		&room.Joined, &room.Game, &room.Seq, &room.Tally[0], &room.Tally[1], &lastDealer, &room.Snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return Room{}, ErrNotFound
	}
	if err != nil {
		return Room{}, fmt.Errorf("store: get: %w", err)
	}
	room.CreatedAt, room.UpdatedAt = fromMS(created), fromMS(updated)
	room.Status = Status(status)
	room.Names[1] = name1.String
	room.LastDealer = NoDealer
	if lastDealer.Valid {
		room.LastDealer = int(lastDealer.Int64)
	}
	if len(room.Snapshot) == 0 {
		room.Snapshot = nil
	}
	return room, nil
}

// Authenticate hashes the presented token and compares it with both stored
// hashes in constant time. Both comparisons always run.
func (s *SQLite) Authenticate(ctx context.Context, code, token string) (Seat, error) {
	code, err := NormalizeCode(code)
	if err != nil {
		return 0, ErrNotFound
	}
	var h0, h1 []byte
	err = s.r.QueryRowContext(ctx,
		`SELECT token0_hash, token1_hash FROM rooms WHERE code = ?`, code).Scan(&h0, &h1)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("store: authenticate: %w", err)
	}
	presented := HashToken(token)
	m0 := tokenMatches(presented, h0)
	m1 := tokenMatches(presented, h1)
	switch {
	case token == "":
		return 0, ErrUnauthorized
	case m0:
		return 0, nil
	case m1:
		return 1, nil
	}
	return 0, ErrUnauthorized
}

func validSave(sv Save) error {
	switch {
	case sv.PrevGame < 0 || sv.PrevSeq < 0 || sv.Game < 0 || sv.Seq < 0:
		return fmt.Errorf("%w: negative game or seq", ErrInvalid)
	case sv.Game < sv.PrevGame || (sv.Game == sv.PrevGame && sv.Seq <= sv.PrevSeq):
		return fmt.Errorf("%w: (game, seq) must increase", ErrInvalid)
	case len(sv.Snapshot) == 0:
		return fmt.Errorf("%w: empty snapshot", ErrInvalid)
	case sv.Status != StatusActive && sv.Status != StatusFinished:
		return fmt.Errorf("%w: status %q", ErrInvalid, sv.Status)
	case sv.LastDealer != 0 && sv.LastDealer != 1:
		return fmt.Errorf("%w: dealer %d", ErrInvalid, sv.LastDealer)
	case sv.Tally[0] < 0 || sv.Tally[1] < 0:
		return fmt.Errorf("%w: negative tally", ErrInvalid)
	}
	return nil
}

// Save is one conditional UPDATE: the row changes only if it exists, seat 1
// is taken and the stored (game, seq) equals (PrevGame, PrevSeq). A single
// statement is atomic, so the check and the write can't be split by another
// writer. Only when no row changed does a second read work out which error
// to return; that read can't cause a write.
func (s *SQLite) Save(ctx context.Context, code string, sv Save) error {
	if err := validSave(sv); err != nil {
		return err
	}
	code, err := NormalizeCode(code)
	if err != nil {
		return ErrNotFound
	}
	res, err := s.w.ExecContext(ctx,
		`UPDATE rooms SET game_no = ?, seq = ?, snapshot = ?, status = ?,
		        tally0 = ?, tally1 = ?, last_dealer = ?, updated_at = ?
		 WHERE code = ? AND token1_hash IS NOT NULL AND game_no = ? AND seq = ?`,
		sv.Game, sv.Seq, sv.Snapshot, string(sv.Status),
		sv.Tally[0], sv.Tally[1], sv.LastDealer, s.nowMS(),
		code, sv.PrevGame, sv.PrevSeq)
	if err != nil {
		return fmt.Errorf("store: save: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return fmt.Errorf("store: save: %w", err)
	} else if n == 1 {
		return nil
	}
	var joined bool
	err = s.w.QueryRowContext(ctx,
		`SELECT token1_hash IS NOT NULL FROM rooms WHERE code = ?`, code).Scan(&joined)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return fmt.Errorf("store: save: %w", err)
	case !joined:
		return ErrNotJoined
	}
	return ErrStale
}

// Touch stamps updated_at.
func (s *SQLite) Touch(ctx context.Context, code string) error {
	code, err := NormalizeCode(code)
	if err != nil {
		return ErrNotFound
	}
	res, err := s.w.ExecContext(ctx, `UPDATE rooms SET updated_at = ? WHERE code = ?`, s.nowMS(), code)
	if err != nil {
		return fmt.Errorf("store: touch: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return fmt.Errorf("store: touch: %w", err)
	} else if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteExpired removes rooms idle for longer than the TTL: updated_at
// strictly before now − TTL. A room idle for exactly the TTL survives.
func (s *SQLite) DeleteExpired(ctx context.Context) (int, error) {
	cutoff := s.nowMS() - s.ttl.Milliseconds()
	res, err := s.w.ExecContext(ctx, `DELETE FROM rooms WHERE updated_at < ?`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: delete expired: %w", err)
	}
	return int(n), nil
}

// Count returns the number of stored rooms, expired-but-unswept included.
func (s *SQLite) Count(ctx context.Context) (int, error) {
	var n int
	if err := s.r.QueryRowContext(ctx, `SELECT count(*) FROM rooms`).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: count: %w", err)
	}
	return n, nil
}

// Close closes both pools; the writer closes last so SQLite checkpoints the
// WAL into the main file. A second Close is a no-op.
func (s *SQLite) Close() error {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var errR error
	if s.r != nil && s.r != s.w {
		errR = s.r.Close()
	}
	return errors.Join(errR, s.w.Close())
}
