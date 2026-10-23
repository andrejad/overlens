package store

// The company file (REQ_IMP_002-006): the types, parsing and the relative-date form. The loader itself
// is in transfer_import.go; transfer_export.go reads one roadmap into the same types for the CSV download.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"time"
)

const (
	FormatCompany = "e-roadmaps/company"

	DatesAbsolute = "absolute"
	DatesRelative = "relative"

	// MaxRelativeDays is the furthest a relative date may lie from the load day, either way (REQ_IMP_004).
	MaxRelativeDays   = 40000
	maxImportProblems = 20
)

// FileDate is a date in a file: an ISO string, or, in a "relative" file, an integer day offset.
// After resolveDates every FileDate holds its final ISO text.
type FileDate struct {
	Text     string
	Offset   int
	IsOffset bool
}

func (d *FileDate) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case string(b) == "null":
		return nil
	case len(b) > 0 && b[0] == '"':
		return json.Unmarshal(b, &d.Text)
	}
	n, err := strconv.Atoi(string(b))
	if err != nil {
		return &json.UnmarshalTypeError{Value: string(b), Type: reflect.TypeOf(0)}
	}
	d.Offset, d.IsOffset = n, true
	return nil
}

type TeamBlock struct {
	Name         string `json:"name"`
	Tag          string `json:"tag"`
	DefaultColor string `json:"default_color"`
}

type FileWorkstream struct {
	Name string `json:"name"`
}

type FileMembership struct {
	Name string `json:"name"`
	Row  int    `json:"row"`
}

type FileLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type FileDeliverable struct {
	Key         string           `json:"key"`
	Name        string           `json:"name"`
	Description string           `json:"description"` // HTML, cleaned on import like description_html
	Responsible string           `json:"responsible"`
	StartDate   FileDate         `json:"start_date"`
	EndDate     FileDate         `json:"end_date"`
	Status      string           `json:"status"`
	RiskNote    string           `json:"risk_note"`
	Color       *string          `json:"color"` // null: the team's default colour
	Workstreams []FileMembership `json:"workstreams"`
	Icons       []string         `json:"icons"`
	Links       []FileLink       `json:"links"`
}

type FileMilestone struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Date        FileDate `json:"date"`
	Workstream  string   `json:"workstream"`
	Row         int      `json:"row"`
	Description string   `json:"description"` // HTML, optional on import, cleaned like a deliverable's (REQ_IMP_024)
	// Version 3 (REQ_IMP_025), all optional on import: none given means planned, no owner, no risk note, no links.
	Responsible string     `json:"responsible"`
	Status      string     `json:"status"`
	RiskNote    string     `json:"risk_note"`
	Links       []FileLink `json:"links"`
}

// FileExternal names a deliverable (or, with Kind "milestone", a milestone) on another team's roadmap
// (REQ_IMP_003, REQ_IMP_023); a team has one roadmap (REQ_DAT_032), so the team names it.
type FileExternal struct {
	Team string `json:"team"`
	Name string `json:"name"`
	Kind string `json:"kind,omitempty"` // "" means deliverable
}

// FileEnd is one end of a dependency: a file-local deliverable key, {"milestone": "<key>"}, or
// {"external": {...}}.
type FileEnd struct {
	Key       string
	Milestone bool // Key is a milestone key
	External  *FileExternal
}

func (e *FileEnd) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		return json.Unmarshal(b, &e.Key)
	}
	var o struct {
		External  *FileExternal `json:"external"`
		Milestone *string       `json:"milestone"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	e.External = o.External
	if o.Milestone != nil && o.External == nil {
		e.Milestone, e.Key = true, *o.Milestone
	}
	return nil
}

type FileDependency struct {
	From FileEnd `json:"from"`
	To   FileEnd `json:"to"`
}

// RoadmapBody is a team's roadmap in a company file: its title and content (REQ_IMP_002).
type RoadmapBody struct {
	Title        string            `json:"title"`
	Workstreams  []FileWorkstream  `json:"workstreams"`
	Deliverables []FileDeliverable `json:"deliverables"`
	Milestones   []FileMilestone   `json:"milestones"`
	Dependencies []FileDependency  `json:"dependencies"`
}

// RoadmapFile is one roadmap read for the CSV download (ExportRoadmap).
type RoadmapFile struct {
	Team TeamBlock `json:"team"`
	RoadmapBody
}

// CompanyTeamFile is one team with its one roadmap (REQ_IMP_006, REQ_DAT_032).
type CompanyTeamFile struct {
	Team    TeamBlock   `json:"team"`
	Roadmap RoadmapBody `json:"roadmap"`
}

// CompanyFile is the sample / development data file (REQ_IMP_006); never exposed over HTTP.
type CompanyFile struct {
	Format          string            `json:"format"`
	Dates           string            `json:"dates,omitempty"`
	Anchor          string            `json:"anchor,omitempty"`
	TeamOrder       []string          `json:"team_order"`
	WorkstreamOrder []string          `json:"workstream_order"`
	Teams           []CompanyTeamFile `json:"teams"`
}

// ImportProblem is one thing wrong with a file; Path points into it (teams[0].roadmap.deliverables[3].end_date).
type ImportProblem struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// problems collects the first maxImportProblems problems.
type problems struct {
	list []ImportProblem
	more int
}

func (p *problems) add(path, format string, a ...any) {
	for _, o := range p.list {
		if o.Path == path { // one problem per place is enough
			return
		}
	}
	if len(p.list) < maxImportProblems {
		p.list = append(p.list, ImportProblem{Path: path, Message: fmt.Sprintf(format, a...)})
	} else {
		p.more++
	}
}

func (p *problems) any() bool { return len(p.list) > 0 }

func (p *problems) err() error {
	msg := fmt.Sprintf("The file has %d problem(s); first: %s: %s", len(p.list)+p.more, p.list[0].Path, p.list[0].Message)
	return invalid(msg, nil)
}

func importInvalid(path, format string, a ...any) error {
	var p problems
	p.add(path, format, a...)
	return p.err()
}

var indexRe = regexp.MustCompile(`\.(\d+)`)

// decodeFile unmarshals data into v. A value of the wrong type is refused with its path in the file.
func decodeFile(data []byte, v any) error {
	if err := json.Unmarshal(data, v); err != nil {
		var te *json.UnmarshalTypeError
		var se *json.SyntaxError
		switch {
		case errors.As(err, &te):
			path := indexRe.ReplaceAllString(te.Field, "[$1]") // deliverables.0.name -> deliverables[0].name
			if path == "" {
				path = "(file)"
			}
			return importInvalid(path, "has the wrong type")
		case errors.As(err, &se):
			return invalid("The file is not valid JSON: "+err.Error(), nil)
		}
		return invalid("The file could not be read: "+err.Error(), nil)
	}
	return nil
}

func checkFormat(format string) error {
	if format != FormatCompany {
		return importInvalid("format", "must be %q", FormatCompany)
	}
	return nil
}

// ParseCompanyFile reads a company file (REQ_IMP_006). Unknown fields are ignored; an unknown format is refused.
func ParseCompanyFile(data []byte) (*CompanyFile, error) {
	var f CompanyFile
	if err := decodeFile(data, &f); err != nil {
		return nil, err
	}
	if err := checkFormat(f.Format); err != nil {
		return nil, err
	}
	return &f, nil
}

// resolveDates turns the file's dates into ISO text (REQ_IMP_004). In an absolute file every date
// must be an ISO string; in a relative one every date must be an integer, and the real date is the
// day of the import plus that offset. The anchor (the file author's day 0) is required and must be a
// valid date, but it does not shift anything: offsets count from the day of the load.
func (b *RoadmapBody) resolveDates(prefix, mode string, today time.Time, p *problems) {
	fix := func(path string, d *FileDate) {
		switch {
		case mode == DatesRelative && !d.IsOffset:
			if d.Text == "" {
				p.add(path, "required")
			} else {
				p.add(path, "must be a whole number of days in a relative file")
			}
		case mode != DatesRelative && d.IsOffset:
			p.add(path, "must be a date like 2026-09-21")
		case mode == DatesRelative && (d.Offset > MaxRelativeDays || d.Offset < -MaxRelativeDays):
			p.add(path, "must be within %d days of the import day", MaxRelativeDays)
		case mode == DatesRelative:
			d.Text = today.AddDate(0, 0, d.Offset).Format(dateLayout)
			d.IsOffset = false
		}
	}
	for i := range b.Deliverables {
		d := &b.Deliverables[i]
		fix(fmt.Sprintf("%sdeliverables[%d].start_date", prefix, i), &d.StartDate)
		fix(fmt.Sprintf("%sdeliverables[%d].end_date", prefix, i), &d.EndDate)
	}
	for i := range b.Milestones {
		fix(fmt.Sprintf("%smilestones[%d].date", prefix, i), &b.Milestones[i].Date)
	}
}

// checkDatesMode validates the file-level "dates" and "anchor" fields.
func checkDatesMode(mode, anchor string, p *problems) string {
	switch mode {
	case "", DatesAbsolute:
		return DatesAbsolute
	case DatesRelative:
		if !validDate(anchor) {
			p.add("anchor", "a relative file needs an anchor date like 2026-01-05")
		}
		return DatesRelative
	}
	p.add("dates", "must be \"absolute\" or \"relative\"")
	return DatesAbsolute
}
