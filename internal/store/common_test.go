package store

// In-package test: needs direct access to the unexported inTx helper, so this file cannot import
// testutil (that would import this package back and cycle). It builds its own throwaway database
// instead.

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Test_inTx_panic_rolls_back_and_frees_the_connection: plumbing test with no requirement of its own. A panic
// mid-transaction must never leave a half-written change behind (the one-transaction writes such as the
// moves of REQ_API_052 rely on it) and, since the pool has exactly one connection, must not leak it either
// — a leaked connection would hang every later request forever. (It was tagged REQ_OVR_011 before; that
// requirement - nothing is deleted or overwritten without an explicit request - has its own test in
// internal/api/no_silent_change_test.go.)
func Test_inTx_panic_rolls_back_and_frees_the_connection(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "panic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema, err := os.ReadFile(filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Converge(db, string(schema)); err != nil {
		t.Fatal(err)
	}

	func() {
		defer func() { recover() }() // the panic must reach the caller: inTx must not swallow it
		inTx(context.Background(), db, func(tx *sql.Tx) error {
			// The insert's own error, if any, doesn't matter: this panics unconditionally right after,
			// to prove a panic mid-transaction rolls back whatever it did manage to do.
			_, _ = tx.ExecContext(context.Background(), `INSERT INTO teams(name, tag, default_color) VALUES ('X','XX','#123456')`)
			panic("boom")
		})
		t.Fatal("inTx swallowed the panic")
	}()

	// With MaxOpenConns(1), a transaction left open by the panic would hang every later request.
	done := make(chan error, 1)
	go func() {
		done <- inTx(context.Background(), db, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(context.Background(), `INSERT INTO teams(name, tag, default_color) VALUES ('Y','YY','#123456')`)
			return err
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a later transaction hung after a panic mid-transaction: the connection was leaked")
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM teams WHERE tag='XX'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("the panicking transaction was not rolled back: %d row(s) survived", n)
	}
}
