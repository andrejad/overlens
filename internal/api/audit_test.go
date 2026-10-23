package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type failingAudit struct{}

func (failingAudit) Record(context.Context, api.AuditEntry) error { return errors.New("disk full") }

// A failed audit write must not roll back the store change that already committed; it must only be
// made visible via an ERROR log line. This is an accepted risk, not a bug, and stays so after Phase 6:
// the audit write is deliberately not part of the change's transaction (REQ_AUD_018).
func Test_REQ_AUD_018_audit_write_failure_is_logged_not_rolled_back(t *testing.T) {
	env := testutil.NewEnv(t)
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	root := chi.NewRouter()
	root.Use(logging.Middleware)
	api.New(env.DB, failingAudit{}).Register(root)
	srv := httptest.NewServer(root)
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest("POST", srv.URL+"/api/teams", strings.NewReader(`{"name":"Auditless","tag":"AUD"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "session", Value: env.Session(env.Admin(testutil.AdminOpts{}))})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status %d, the store write must still succeed", resp.StatusCode)
	}
	var n int
	if err := env.DB.QueryRow(`SELECT COUNT(*) FROM teams WHERE tag='AUD'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Error("the team was not created despite the audit write failing")
	}
	if !strings.Contains(buf.String(), "audit write failed") || !strings.Contains(buf.String(), "level=ERROR") {
		t.Errorf("no ERROR log line for the failed audit write: %s", buf.String())
	}
}

// Test_REQ_AUD_002_deliverable_create_writes_exactly_one_entry: creating a deliverable is one entry
// (REQ_AUD_002's last sentence), not one per field the way a team PATCH is.
func Test_REQ_AUD_002_deliverable_create_writes_exactly_one_entry(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	n0 := g.auditCount()
	d := g.newDeliverable(rm, ws, 0, 5, map[string]any{
		"responsible_person": "Ann", "status": "at_risk", "risk_note": "slipping",
		"icons": []string{"rocket"}, "links": []map[string]string{{"label": "L", "url": "https://a.example"}}})
	if got := g.auditCount() - n0; got != 1 {
		t.Fatalf("deliverable create wrote %d audit entries, want exactly 1", got)
	}
	if e := g.lastAudit(); e.Action != "deliverable.create" || e.EntityID != d.ID {
		t.Errorf("entry %+v", e)
	}
}

// Test_REQ_AUD_001_entry_carries_action_type_id_roadmap_and_details: every field REQ_AUD_001 lists
// that the API layer can populate today (action, entity type/id, roadmap_id, and a details JSON) is
// actually present and correct on a representative write. "Who" and "when" are stamped by the real
// Auditor writing the audit_log row (ts, user_id, username columns); that is asserted in
// Test_REQ_AUD_020_entries_record_the_acting_admin_or_system (auth_test.go).
func Test_REQ_AUD_001_entry_carries_action_type_id_roadmap_and_details(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	d := g.newDeliverable(rm, ws[:1], 0, 5, nil)
	e := g.lastAudit()
	if e.Action != "deliverable.create" {
		t.Errorf("action = %q", e.Action)
	}
	if e.EntityType != "deliverable" || e.EntityID != d.ID {
		t.Errorf("entity type/id = %q/%d, want deliverable/%d", e.EntityType, e.EntityID, d.ID)
	}
	if e.RoadmapID != rm {
		t.Errorf("roadmap_id = %d, want %d", e.RoadmapID, rm)
	}
	if e.Details == nil || e.Details["deliverable"] != d.Name {
		t.Errorf("details %+v missing a readable deliverable name", e.Details)
	}

	t.Run("milestone audit entries named not ided", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		n0 := g.auditCount()
		m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "Launch", "date": g.Clock.Date(2), "workstream_id": ws[0]})
		if g.auditCount() != n0+1 {
			t.Fatalf("create: want 1 audit entry, got %d", g.auditCount()-n0)
		}
		ce := g.lastAudit()
		if ce.Action != "milestone.create" || ce.Details["milestone"] != "Launch" {
			t.Errorf("create entry %+v", ce)
		}
		if _, ok := ce.Details["roadmap"]; !ok {
			t.Error("create entry missing roadmap name")
		}
		if _, ok := ce.Details["team"]; !ok {
			t.Error("create entry missing team name")
		}

		n1 := g.auditCount()
		must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"workstream_id": ws[1]})
		if g.auditCount() != n1+1 {
			t.Fatalf("update: want 1 audit entry, got %d", g.auditCount()-n1)
		}
		ue := g.lastAudit()
		if ue.Action != "milestone.update" {
			t.Fatalf("update entry %+v", ue)
		}
		type change struct{ Field, From, To string }
		var changes []change
		raw, _ := json.Marshal(ue.Details["changes"])
		if err := json.Unmarshal(raw, &changes); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, c := range changes {
			if c.Field == "workstream" {
				found = true
				// names, not the bare ids ws[0]/ws[1]
				if c.From == "" || c.To == "" {
					t.Errorf("workstream change not named: %+v", c)
				}
			}
		}
		if !found {
			t.Errorf("no workstream change listed: %+v", changes)
		}

		n2 := g.auditCount()
		g.expect(204, "DELETE", "/api/milestones/"+id(m.ID), nil)
		if g.auditCount() != n2+1 {
			t.Fatalf("delete: want 1 audit entry, got %d", g.auditCount()-n2)
		}
		de := g.lastAudit()
		if de.Action != "milestone.delete" || de.Details["milestone"] != "Launch" {
			t.Errorf("delete entry %+v", de)
		}
	})
}
