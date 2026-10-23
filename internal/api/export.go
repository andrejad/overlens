package api

import (
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/andrejad/overlens/internal/store"
)

// The CSV download (REQ_API_023, docs/API.md "Export"). A read: public, no audit entry.

var (
	slugRe     = regexp.MustCompile(`[^a-z0-9]+`)
	blockEndRe = regexp.MustCompile(`(?i)<br\s*/?>|</(p|li|h[1-6])>`)
	tagRe      = regexp.MustCompile(`<[^>]*>`)
	blankRe    = regexp.MustCompile(`\n{3,}`)
)

// exportName is roadmap-<team tag>-<title slug>-<YYYY-MM-DD>.<ext>; ASCII only, so the header is safe.
func exportName(f *store.RoadmapFile, now time.Time, ext string) string {
	slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(f.Title), "-"), "-")
	if len(slug) > 60 {
		slug = strings.Trim(slug[:60], "-")
	}
	if slug == "" {
		slug = "roadmap"
	}
	return fmt.Sprintf("roadmap-%s-%s-%s.%s", strings.ToLower(f.Team.Tag), slug, now.Format("2006-01-02"), ext)
}

func (a *API) exportFile(w http.ResponseWriter, r *http.Request) (*store.RoadmapFile, time.Time, bool) {
	id, ok := pathID(w, r)
	if !ok {
		return nil, time.Time{}, false
	}
	now := time.Now()
	f, err := store.ExportRoadmap(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return nil, time.Time{}, false
	}
	return f, now, true
}

// csvChunk is how many bytes of a roadmap CSV are written between two deadline extensions.
const csvChunk = 64 << 10

// writeDeadline is how long one page or chunk of a CSV download may take to write (REQ_OVR_013): the
// server-wide WriteTimeout would otherwise cut a long download short.
const writeDeadline = 60 * time.Second

// extendWriteDeadline moves this response's write deadline forward; an unsupported writer is logged, not fatal.
func extendWriteDeadline(w http.ResponseWriter, r *http.Request) {
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(writeDeadline)); err != nil {
		slog.DebugContext(r.Context(), "api: write deadline not extended", "err", err)
	}
}

func (a *API) exportCSV(w http.ResponseWriter, r *http.Request) {
	f, now, ok := a.exportFile(w, r)
	if !ok {
		return
	}
	body := roadmapCSV(f)
	name := exportName(f, now, "csv")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	for rest := []byte(body); len(rest) > 0; { // chunked, so a big file on a slow link keeps its own deadline
		n := min(len(rest), csvChunk)
		extendWriteDeadline(w, r)
		if _, err := w.Write(rest[:n]); err != nil {
			slog.ErrorContext(r.Context(), "api: roadmap csv write failed", "err", err)
			return
		}
		rest = rest[n:]
	}
	slog.InfoContext(r.Context(), "api: roadmap exported as csv", "file", name, "rows", len(f.Deliverables)+len(f.Milestones), "bytes", len(body))
}

var csvHeader = []string{"team", "roadmap", "workstreams", "name", "start_date", "end_date", "status", "risk_note",
	"responsible", "color", "description", "links", "prerequisites", "kind"}

// roadmapCSV renders one row per roadmap item, deliverables then milestones (REQ_API_023), with the kind last: UTF-8 with a BOM, CRLF line ends, a field quoted when it
// holds a comma, a quote or a line break, and a leading ' on a cell whose first non-space character is = + - @, a tab or a carriage return so a
// spreadsheet does not run it as a formula (csvSafe).
func roadmapCSV(f *store.RoadmapFile) string {
	var sb strings.Builder
	sb.WriteString("\xEF\xBB\xBF") // UTF-8 byte-order mark, so Excel reads it as UTF-8
	writeRow := func(cells []string) {
		for i, c := range cells {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(csvQuote(c))
		}
		sb.WriteString("\r\n")
	}
	writeRow(csvHeader)
	names := map[string]string{} // key -> deliverable name
	for _, d := range f.Deliverables {
		names[d.Key] = d.Name
	}
	prereq := map[string][]string{} // "d:<key>" or "m:<key>" -> names of its prerequisites
	msNames := map[string]string{}  // key -> milestone name
	for _, m := range f.Milestones {
		msNames[m.Key] = m.Name
	}
	for _, dep := range f.Dependencies {
		if dep.To.External != nil { // a dependent in another roadmap has no row here
			continue
		}
		to := "d:" + dep.To.Key
		if dep.To.Milestone {
			to = "m:" + dep.To.Key
		}
		switch {
		case dep.From.External != nil:
			prereq[to] = append(prereq[to], dep.From.External.Name)
		case dep.From.Milestone: // REQ_IMP_023: a milestone prerequisite is listed like a deliverable one
			prereq[to] = append(prereq[to], msNames[dep.From.Key])
		default:
			prereq[to] = append(prereq[to], names[dep.From.Key])
		}
	}
	linkText := func(ls []store.FileLink) string {
		var out []string
		for _, l := range ls {
			if l.Label == "" {
				out = append(out, l.URL)
			} else {
				out = append(out, l.Label+" ("+l.URL+")")
			}
		}
		return strings.Join(out, "; ")
	}
	for _, d := range f.Deliverables {
		var ws []string
		for _, m := range d.Workstreams {
			ws = append(ws, m.Name)
		}
		color := ""
		if d.Color != nil {
			color = *d.Color
		}
		writeRow([]string{f.Team.Name, f.Title, strings.Join(ws, "; "), d.Name, d.StartDate.Text, d.EndDate.Text,
			d.Status, d.RiskNote, d.Responsible, color, plainText(d.Description), linkText(d.Links),
			strings.Join(prereq["d:"+d.Key], "; "), "deliverable"})
	}
	for _, m := range f.Milestones { // its date is both start and end, and it has no color
		writeRow([]string{f.Team.Name, f.Title, m.Workstream, m.Name, m.Date.Text, m.Date.Text,
			m.Status, m.RiskNote, m.Responsible, "", plainText(m.Description), linkText(m.Links),
			strings.Join(prereq["m:"+m.Key], "; "), "milestone"})
	}
	return sb.String()
}

// csvSafe defuses spreadsheet formula injection: a cell whose first non-space character is = + - @ (or a
// tab or carriage return) gets a leading single quote. Both CSV downloads (roadmap and audit) use it.
func csvSafe(s string) string {
	if t := strings.TrimLeft(s, " "); t != "" && strings.ContainsRune("=+-@\t\r", rune(t[0])) {
		slog.Debug("api: csv cell defused", "first", t[:1])
		return "'" + s
	}
	return s
}

// csvQuote makes a cell safe for a spreadsheet and quotes it when it holds a comma, a quote or a line break.
func csvQuote(s string) string {
	s = csvSafe(s)
	if strings.ContainsAny(s, ",\"\r\n") {
		s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// plainText turns a description's (already cleaned) HTML into text, one line per paragraph or item.
func plainText(h string) string {
	h = blockEndRe.ReplaceAllString(h, "\n")
	h = html.UnescapeString(tagRe.ReplaceAllString(h, ""))
	h = blankRe.ReplaceAllString(strings.ReplaceAll(h, "\r\n", "\n"), "\n\n")
	return strings.TrimSpace(h)
}
