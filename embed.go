// Package erm exists only to embed schema.sql into the binary.
package erm

import _ "embed"

// Schema is the single definition of the database (REQ_DAT_001).
//
//go:embed schema.sql
var Schema string
