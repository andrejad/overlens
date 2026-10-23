package store

import (
	"errors"
	"fmt"
)

// Kind classifies a store error so the API layer can pick the HTTP status.
type Kind int

const (
	NotFound Kind = iota + 1 // 404
	Invalid                  // 422 validation_failed
	Conflict                 // 409, Code says which
)

// Error is a rule violation with a message a person can read.
type Error struct {
	Kind   Kind
	Code   string // for Conflict: duplicate_name, span_exceeded, ...
	Msg    string
	Fields map[string]string // for Invalid: field -> reason

	// Extra detail a dependency Conflict carries (REQ_DEP_003/004): the loop's names in order for
	// code cycle; the nearest allowed dates for code date_order.
	Path          []string
	TypedPath     []PathItem // code cycle when a milestone is on the loop (REQ_DEP_025); Path is then empty
	EarliestStart string
	LatestEnd     string
	// A milestone has one date, so its date_order conflict carries the allowed range as dates (REQ_DEP_024).
	EarliestDate string
	LatestDate   string
}

// PathItem is one item on a loop: a deliverable or a milestone, by name.
type PathItem struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// ErrRequired is the 422 for a missing required field.
func ErrRequired(field string) error { return invalid1(field, "required") }

func (e *Error) Error() string { return e.Msg }

func notFound(what string, id int64) error {
	return &Error{Kind: NotFound, Code: "not_found", Msg: fmt.Sprintf("%s %d not found", what, id)}
}

func invalid(msg string, fields map[string]string) error {
	return &Error{Kind: Invalid, Code: "validation_failed", Msg: msg, Fields: fields}
}

func invalid1(field, reason string) error {
	return invalid(field+": "+reason, map[string]string{field: reason})
}

func conflict(code, msg string) error { return &Error{Kind: Conflict, Code: code, Msg: msg} }

// isNotFound reports whether err is specifically a not-found store.Error — used where a handler must
// turn "no such thing" into a 422 validation error naming a bad field (e.g. move/workstream target
// ids) while letting any other, unexpected error (a DB or context problem) fall through to the
// normal 500 path instead of being silently folded into the same 422.
func isNotFound(err error) bool {
	var se *Error
	return errors.As(err, &se) && se.Kind == NotFound
}
