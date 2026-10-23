package store

import (
	"log/slog"

	"github.com/microcosm-cc/bluemonday"
)

// allowedFontFamilies / allowedFontSizes are the exact values the editor's font controls write
// (REQ_FE_124).
var allowedFontFamilies = []string{
	"Georgia, serif",
	"ui-monospace, monospace",
	"Arial, sans-serif",
	"Verdana, sans-serif",
	`"Times New Roman", serif`,
}

var allowedFontSizes = []string{"12px", "14px", "16px", "18px", "20px", "24px"}

// descriptionPolicy is the allow-list for deliverables.description_html (REQ_API_030): only the
// tags and attributes the rich-text editor produces survive — paragraphs, headings, bold/strong,
// italic/em, underline, strikethrough, lists, br, links whose href is http(s), and span with a
// font-family / font-size style from the fixed lists. Everything else (scripts, event handler
// attributes, classes, other styles, javascript: links, ...) is stripped, regardless of which client sent it.
var descriptionPolicy = newDescriptionPolicy()

func newDescriptionPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements("p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "span")
	// span may carry a style with only font-family / font-size, exact values from the editor's fixed
	// lists (REQ_FE_124). Anything else in the style is dropped; a span left with no style stays as a bare <span>.
	p.AllowStyles("font-family").MatchingEnum(allowedFontFamilies...).OnElements("span")
	p.AllowStyles("font-size").MatchingEnum(allowedFontSizes...).OnElements("span")
	p.AllowAttrs("href").OnElements("a")
	p.AllowElements("a")
	p.AllowURLSchemes("http", "https")
	p.RequireNoFollowOnLinks(true)
	return p
}

// sanitizeDescription cleans a deliverable's description_html on save (REQ_API_030). Called for
// every create and every PATCH that sends description_html — never trusts a client, including our
// own frontend, to have already cleaned it.
func sanitizeDescription(html string) string {
	out := descriptionPolicy.Sanitize(html)
	if out != html {
		// Lengths only — never the description content.
		slog.Debug("store: description sanitized", "in_bytes", len(html), "out_bytes", len(out))
	}
	return out
}
