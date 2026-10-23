package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
)

// iconDefaults is the fixed set of 20 icon keys and their default labels — must match
// web/src/lib/icons.ts's ICONS table key-for-key (the DB/API key is an app-owned string,
// independent of which lucide-react component the frontend renders it with).
var iconDefaults = map[string]string{
	"star":     "High priority",
	"coins":    "Budget impact",
	"clock":    "Time sensitive",
	"rocket":   "Launch / GA",
	"flag":     "Key deliverable",
	"flask":    "Experiment",
	"warning":  "Warning",
	"wrench":   "Tech debt",
	"flame":    "Escalated",
	"bug":      "Quality focus",
	"lock":     "Blocked",
	"cloud":    "Infrastructure",
	"link":     "Has dependency",
	"database": "Data migration",
	"users":    "Cross-team",
	"globe":    "Customer facing",
	"shield":   "Security",
	"bulb":     "Innovation",
	"scale":    "Regulatory",
	"pause":    "On hold",
}

// iconOrder is iconDefaults' 20 keys in a fixed order, so GET /api/icons returns a stable order
// instead of Go's randomized map iteration.
var iconOrder = []string{
	"star", "coins", "clock", "rocket", "flag", "flask", "warning", "wrench", "flame", "bug",
	"lock", "cloud", "link", "database", "users", "globe", "shield", "bulb", "scale", "pause",
}

type Icon struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// IconsList returns the 20 fixed icons with their effective label: an icon_labels row's value if
// one exists, else the hardcoded default (no seeding — REQ_FE_080 — a PUT only ever writes a row
// when someone actually overrides one).
func IconsList(ctx context.Context, q querier) ([]Icon, error) {
	overrides := map[string]string{}
	if err := collect(ctx, q, `SELECT icon_key, label FROM icon_labels`, nil, func(s scanner) error {
		var k, l string
		if err := s.Scan(&k, &l); err != nil {
			return err
		}
		overrides[k] = l
		return nil
	}); err != nil {
		return nil, err
	}
	out := make([]Icon, len(iconOrder))
	for i, k := range iconOrder {
		label, ok := overrides[k]
		if !ok {
			label = iconDefaults[k]
		}
		out[i] = Icon{Key: k, Label: label}
	}
	return out, nil
}

// IconLabelSet upserts the icon's label override and also returns the effective label it had
// before (for the caller's audit `from`/`to`). An unknown key is 404 not_found; a label equal to
// the current effective one is a no-op (changed=false, nothing written).
func IconLabelSet(ctx context.Context, db *sql.DB, key, label string) (icon Icon, before string, changed bool, err error) {
	if _, ok := iconDefaults[key]; !ok {
		slog.InfoContext(ctx, "store: icon relabel refused, unknown key", "icon_key", key)
		err = &Error{Kind: NotFound, Code: "not_found", Msg: fmt.Sprintf("icon %q not found", key)}
		return
	}
	label, err = cleanName("label", label)
	if err != nil {
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var current string
		has := true
		if scanErr := tx.QueryRowContext(ctx, `SELECT label FROM icon_labels WHERE icon_key=?`, key).Scan(&current); errors.Is(scanErr, sql.ErrNoRows) {
			has, current = false, iconDefaults[key]
		} else if scanErr != nil {
			return scanErr
		}
		before = current
		if current == label {
			slog.InfoContext(ctx, "store: icon relabel is a no-op, label unchanged", "icon_key", key)
			icon = Icon{Key: key, Label: current}
			return nil
		}
		changed = true
		var execErr error
		if has {
			_, execErr = tx.ExecContext(ctx, `UPDATE icon_labels SET label=? WHERE icon_key=?`, label, key)
		} else {
			_, execErr = tx.ExecContext(ctx, `INSERT INTO icon_labels(icon_key, label) VALUES (?,?)`, key, label)
		}
		if execErr != nil {
			return execErr
		}
		icon = Icon{Key: key, Label: label}
		return nil
	})
	if err == nil && changed {
		slog.InfoContext(ctx, "store: icon relabeled", "icon_key", key, "from", before, "to", label)
	}
	return
}
