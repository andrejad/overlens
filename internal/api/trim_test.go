package api_test

// Phase 8 review fixes: trimming of tags and labels (REQ_DAT_028).

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// REQ_DAT_028: the team tag, icon labels and link labels are trimmed by the server with TrimName.
func Test_REQ_DAT_028_tag_icon_label_and_link_label_are_trimmed(t *testing.T) {
	g := newRig(t)
	tm := must[store.Team](g, 201, "POST", "/api/teams", m{"name": "Trim", "tag": "\u00a0TRM\u200b"})
	if tm.Tag != "TRM" {
		t.Errorf("tag %q", tm.Tag)
	}
	upd := must[struct{ Team store.Team }](g, 200, "PATCH", "/api/teams/"+id(tm.ID), m{"tag": " \tTRX\u3000"})
	if upd.Team.Tag != "TRX" {
		if got := must[store.Team](g, 200, "GET", "/api/teams/"+id(tm.ID), nil); got.Tag != "TRX" {
			t.Errorf("updated tag %q", got.Tag)
		}
	}
	icon := must[store.Icon](g, 200, "PUT", "/api/icons/star", m{"label": "\u200b\u00a0Top pick\ufeff"})
	if icon.Label != "Top pick" {
		t.Errorf("icon label %q", icon.Label)
	}
	rm := g.Roadmap(testutil.Team{ID: tm.ID, Name: tm.Name, Tag: tm.Tag}, testutil.RoadmapOpts{})
	d := g.newDeliverable(rm.ID, []int64{g.firstWorkstreamOf(rm.ID)}, 0, 5, map[string]any{
		"links": []m{{"label": "\u00a0Spec\u200b", "url": " https://example.com/x "}}})
	if len(d.Links) != 1 || d.Links[0].Label != "Spec" || d.Links[0].URL != "https://example.com/x" {
		t.Errorf("link %+v", d.Links)
	}
}
