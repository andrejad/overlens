package api

// In-package test: needs direct access to the unexported audit method, so this file cannot import
// testutil (that would import this package back and cycle, same reasoning as
// internal/store/common_test.go).

import (
	"context"
	"net/http/httptest"
	"testing"
)

type ctxCapturingAudit struct{ ctx context.Context }

func (c *ctxCapturingAudit) Record(ctx context.Context, e AuditEntry) error {
	c.ctx = ctx
	return nil
}

// Test_REQ_AUD_001_audit_write_survives_client_disconnect: the audit write must not be skipped just
// because the client's request context was already cancelled (e.g. the connection dropped right
// after the response was written) — "every change is recorded" (REQ_AUD_001) even then, since the
// store change it describes already committed.
func Test_REQ_AUD_001_audit_write_survives_client_disconnect(t *testing.T) {
	rec := &ctxCapturingAudit{}
	a := &API{Audit: rec}

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/api/teams", nil).WithContext(ctx)
	cancel() // simulate the client already having gone away

	a.audit(req, AuditEntry{Action: "test.action"})

	if rec.ctx == nil {
		t.Fatal("Record was not called")
	}
	if err := rec.ctx.Err(); err != nil {
		t.Errorf("audit context was still cancelled: %v (context.WithoutCancel not used?)", err)
	}
}
