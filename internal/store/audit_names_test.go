package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_AUD_003_workstream_create_names_come_from_inside_the_transaction proves that the
// team/roadmap names a store write hands back for its caller's audit entry are read inside that
// write's own transaction, not by a second, separate query afterwards. The database is opened with
// exactly one connection (store.Open sets MaxOpenConns(1), see internal/store/store.go); this test
// exploits that to force a deterministic race: it reserves the connection itself, starts the
// workstream create (which then has to queue for it), waits — via the pool's own wait counter, no
// sleeping and guessing — until the create is actually queued, then releases the connection. With
// exactly one goroutine queued, the pool hands it straight to the create, synchronously, before this
// goroutine's Close() call even returns; only then is the rename started, so it can only ever queue
// behind the create, never run inside it or before it. If a future change went back to reading the
// name with a second query after the store write's own transaction had already committed, that
// second query would itself have to re-acquire the connection — and could lose it to the
// already-queued rename, showing the post-rename name instead. Reading inside the transaction, as
// this test requires, closes that window entirely.
func Test_REQ_AUD_003_workstream_create_names_come_from_inside_the_transaction(t *testing.T) {
	e := testutil.NewEnv(t)
	team := e.Team(testutil.TeamOpts{Name: "Alpha"})
	rm := e.Roadmap(team, testutil.RoadmapOpts{})
	ctx := context.Background()

	conn, err := e.DB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}

	type createResult struct {
		title, team string
		err         error
	}
	createDone := make(chan createResult, 1)
	base := e.DB.Stats().WaitCount
	go func() {
		_, title, team, err := store.WorkstreamCreate(ctx, e.DB, rm.ID, "Launch")
		createDone <- createResult{title, team, err}
	}()

	deadline := time.Now().Add(5 * time.Second)
	for e.DB.Stats().WaitCount < base+1 {
		if time.Now().After(deadline) {
			t.Fatal("workstream create never queued for the reserved connection")
		}
		time.Sleep(time.Millisecond)
	}

	// Hand the connection to the (only) queued waiter — the create — before this goroutine's Close()
	// returns, and only then start the rename, so it can never get there first.
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	renameDone := make(chan error, 1)
	go func() {
		beta := "Beta"
		_, _, err := store.TeamUpdate(ctx, e.DB, team.ID, store.TeamInput{Name: &beta})
		renameDone <- err
	}()

	res := <-createDone
	if res.err != nil {
		t.Fatal(res.err)
	}
	if err := <-renameDone; err != nil {
		t.Fatal(err)
	}

	if res.team != "Alpha" {
		t.Errorf("workstream create's audited team name = %q, want %q (the pre-rename value, read inside its own "+
			"transaction, even though the rename was queued for the connection immediately after)", res.team, "Alpha")
	}
	if res.title != rm.Title {
		t.Errorf("workstream create's audited roadmap title = %q, want %q", res.title, rm.Title)
	}

	// The rename really did land straight after: this isn't just luck of ordering — the team is
	// genuinely "Beta" now, so a name query made after the fact (the pattern being guarded against)
	// really would have shown the wrong value.
	after, err := store.TeamGet(ctx, e.DB, team.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Name != "Beta" {
		t.Fatalf("rename did not take effect, team name = %q", after.Name)
	}
}
