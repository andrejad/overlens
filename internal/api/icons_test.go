package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

// Test_REQ_FE_080_get_icons_returns_20_with_defaults: GET /api/icons is anonymous and answers
// exactly the 20 fixed icons, each with its hardcoded default label (no icon_labels row exists yet,
// so nothing is overridden).
func Test_REQ_FE_080_get_icons_returns_20_with_defaults(t *testing.T) {
	g := newRig(t)
	got := must[struct {
		Items []store.Icon
		Total int
	}](g, 200, "GET", "/api/icons", nil)
	if got.Total != 20 || len(got.Items) != 20 {
		t.Fatalf("want 20 icons, got total=%d items=%d", got.Total, len(got.Items))
	}
	byKey := map[string]string{}
	for _, ic := range got.Items {
		if _, dup := byKey[ic.Key]; dup {
			t.Errorf("duplicate icon key %q", ic.Key)
		}
		if ic.Label == "" {
			t.Errorf("icon %q has an empty label", ic.Key)
		}
		byKey[ic.Key] = ic.Label
	}
	// spot-check a couple of the fixed defaults
	if byKey["star"] != "High priority" {
		t.Errorf("star default label: %q", byKey["star"])
	}
	if byKey["pause"] != "On hold" {
		t.Errorf("pause default label: %q", byKey["pause"])
	}
}

// Test_REQ_FE_080_icon_relabel_updates_for_everyone_and_audits: PUT /api/icons/{key} is admin-only
// (behind requireAdmin; the 401 half is in authz_test.go), changes the label for everyone (a later GET /api/icons
// reflects it), writes exactly one icon.relabel audit entry naming the icon key and the from/to
// labels, refuses an unknown key with 404, and a same-label PUT is a no-op that writes nothing.
func Test_REQ_FE_080_icon_relabel_updates_for_everyone_and_audits(t *testing.T) {
	g := newRig(t)
	n0 := g.auditCount()
	updated := must[store.Icon](g, 200, "PUT", "/api/icons/star", map[string]any{"label": "Top pick"})
	if updated.Key != "star" || updated.Label != "Top pick" {
		t.Fatalf("relabel response %+v", updated)
	}
	if g.auditCount() != n0+1 {
		t.Fatalf("want 1 audit entry, got %d", g.auditCount()-n0)
	}
	e := g.lastAudit()
	if e.Action != "icon.relabel" || e.Details["icon"] != "star" || e.Details["from"] != "High priority" || e.Details["to"] != "Top pick" {
		t.Errorf("entry %+v", e)
	}
	// the change is visible to everyone through GET /api/icons
	got := must[struct {
		Items []store.Icon
		Total int
	}](g, 200, "GET", "/api/icons", nil)
	found := false
	for _, ic := range got.Items {
		if ic.Key == "star" {
			found = true
			if ic.Label != "Top pick" {
				t.Errorf("GET /api/icons still shows the old label: %q", ic.Label)
			}
		}
	}
	if !found {
		t.Fatal("star missing from GET /api/icons")
	}

	// unknown key -> 404
	if c := g.expect(404, "PUT", "/api/icons/not-a-real-icon", map[string]any{"label": "X"}); c != "not_found" {
		t.Errorf("unknown key code %q", c)
	}
	// required, length-limited label -> 422
	if c := g.expect(422, "PUT", "/api/icons/star", map[string]any{"label": ""}); c != "validation_failed" {
		t.Errorf("blank label code %q", c)
	}

	// a same-label PUT is a no-op: no audit entry
	n1 := g.auditCount()
	must[store.Icon](g, 200, "PUT", "/api/icons/star", map[string]any{"label": "Top pick"})
	if g.auditCount() != n1 {
		t.Errorf("no-op relabel wrote %d entries", g.auditCount()-n1)
	}
}

// extends the deliverable icon validation loop (internal/store/deliverables.go) to also reject a
// syntactically valid key that isn't one of the fixed 20 (REQ_FE_080: "exactly the 20 fixed icons
// from the spec").
func Test_REQ_FE_080_deliverable_icon_key_must_be_one_of_20(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	// a real fixed-set key is accepted
	d := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"icons": []string{"star", "rocket"}})
	if len(d.Icons) != 2 {
		t.Fatalf("valid icons refused: %+v", d)
	}
	// syntactically valid (matches the [a-z0-9_-]{1,40} shape) but not one of the 20 -> 422 field icons
	if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", map[string]any{
		"name": "x", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(5),
		"workstream_ids": ws[:1], "icons": []string{"not-a-real-icon"},
	}); c != "validation_failed" {
		t.Errorf("code %q", c)
	}
	// same check applies on PATCH
	if c := g.expect(422, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"icons": []string{"also-fake"}}); c != "validation_failed" {
		t.Errorf("patch code %q", c)
	}
}
