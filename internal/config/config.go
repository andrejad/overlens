// Package config loads roadmap.conf (spec section 9): `key: value` lines, `#` comments, environment
// overrides, and fail-fast validation that reports every problem at once.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// Config holds every setting. BootstrapAdminPassword must never be logged.
type Config struct {
	Port                   int
	DBPath                 string
	LogDir                 string
	LogLevel               string
	AuditRetentionDays     int
	BackupEnabled          bool
	BackupDir              string
	BackupTime             string
	BackupKeepDays         int
	SessionTTLDays         int
	BootstrapAdminUser     string
	BootstrapAdminPassword string
	// Environment is "production" (default) or "development"; `roadmap -dev-data` only runs in development.
	Environment string
	// SampleData: create the sample company on the first start of an empty database (REQ_DEMO_005).
	SampleData bool
	// CookieSecure is "auto" (Secure only on a TLS connection) or "true" (always Secure, for a TLS-ending proxy).
	CookieSecure string
	// MCPEnabled switches the AI connection at /mcp on (REQ_CFG_013); off by default.
	MCPEnabled bool
}

var defaults = map[string]string{
	"port":                 "8080",
	"db_path":              "./data/roadmap-database.db",
	"log_dir":              "./logs",
	"log_level":            "INFO",
	"audit_retention_days": "365",
	"backup_enabled":       "true",
	"backup_dir":           "./backups",
	"backup_time":          "04:00",
	"backup_keep_days":     "10",
	"session_ttl_days":     "365",
	"environment":          "production",
	"sample_data":          "true",
	"cookie_secure":        "auto",
	"mcp_enabled":          "false",
}

var required = []string{"bootstrap_admin_user", "bootstrap_admin_password"}

var timeRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// EnvName is the environment variable that overrides a key, e.g. port -> ROADMAP_PORT.
func EnvName(key string) string { return "ROADMAP_" + strings.ToUpper(key) }

// Load reads and validates the file at path. On failure the error lists every problem, and the
// returned Config is nil. getenv is os.Getenv in production. Values of secrets are never put in errors.
func Load(path string, getenv func(string) string) (*Config, error) {
	vals, problems := map[string]string{}, []string{}
	f, err := os.Open(path)
	var noFile string
	switch {
	case errors.Is(err, fs.ErrNotExist):
		// REQ_DEPLOY_011: a missing file is fine when the ROADMAP_* variables carry the settings (the
		// container has no file). If the settings then turn out to be incomplete, it is reported below.
		noFile = fmt.Sprintf("config file %q missing or unreadable", path)
		slog.Debug("config: no config file, using ROADMAP_* variables and defaults", "path", path)
	case err != nil:
		problems = append(problems, fmt.Sprintf("config file %q missing or unreadable", path))
	default:
		defer f.Close()
		sc := bufio.NewScanner(f)
		for n := 1; sc.Scan(); n++ {
			text := sc.Text()
			if n == 1 {
				text = strings.TrimPrefix(text, "\ufeff") // editors on Windows add a UTF-8 BOM
			}
			line := strings.TrimSpace(text) // also drops the \r of CRLF line endings
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(line, ":")
			k = strings.ToLower(strings.TrimSpace(k))
			if !ok || k == "" {
				problems = append(problems, fmt.Sprintf("line %d is not `key: value`", n))
				continue
			}
			if _, known := defaults[k]; !known && k != required[0] && k != required[1] {
				problems = append(problems, fmt.Sprintf("unknown key %q (line %d)", k, n))
				continue
			}
			vals[k] = strings.TrimSpace(v)
		}
		if err := sc.Err(); err != nil {
			problems = append(problems, fmt.Sprintf("config file %q missing or unreadable", path))
		}
	}
	for k := range defaults {
		if v := getenv(EnvName(k)); v != "" {
			vals[k] = v
		}
	}
	for _, k := range required {
		if v := getenv(EnvName(k)); v != "" {
			vals[k] = v
		}
		// REQ_DEPLOY_011: a container secret can be mounted as a file; the plain variable wins.
		if f := getenv(EnvName(k) + "_FILE"); f != "" && getenv(EnvName(k)) == "" {
			if b, err := os.ReadFile(f); err != nil {
				problems = append(problems, fmt.Sprintf("%s points at %q, which cannot be read", EnvName(k)+"_FILE", f))
			} else {
				vals[k] = strings.TrimRight(string(b), "\r\n")
			}
		}
		if vals[k] == "" {
			problems = append(problems, k+" is required and missing or empty")
		}
	}
	for k, d := range defaults {
		if vals[k] == "" {
			vals[k] = d
		}
	}

	c := &Config{
		DBPath: vals["db_path"], LogDir: vals["log_dir"], BackupDir: vals["backup_dir"], BackupTime: vals["backup_time"],
		BootstrapAdminUser: vals["bootstrap_admin_user"], BootstrapAdminPassword: vals["bootstrap_admin_password"],
		LogLevel: strings.ToUpper(vals["log_level"]),
	}
	num := func(key string, min, max int) int {
		n, err := strconv.Atoi(vals[key])
		if err != nil || n < min || n > max {
			problems = append(problems, fmt.Sprintf("%s must be a whole number from %d to %d", key, min, max))
		}
		return n
	}
	dir := filepath.Dir(abs(path))
	c.DBPath, c.LogDir, c.BackupDir = resolve(dir, c.DBPath), resolve(dir, c.LogDir), resolve(dir, c.BackupDir)
	c.DBPath = legacyDBFallback(c.DBPath)
	c.Port = num("port", 1, 65535)
	c.AuditRetentionDays = num("audit_retention_days", 0, 36500)
	c.BackupKeepDays = num("backup_keep_days", 1, 36500)
	c.SessionTTLDays = num("session_ttl_days", 1, 36500)
	switch c.LogLevel {
	case "DEBUG", "INFO", "WARN", "ERROR":
	default:
		problems = append(problems, "log_level must be DEBUG, INFO, WARN or ERROR")
	}
	switch strings.ToLower(vals["backup_enabled"]) {
	case "true":
		c.BackupEnabled = true
	case "false":
	default:
		problems = append(problems, "backup_enabled must be true or false")
	}
	switch strings.ToLower(vals["mcp_enabled"]) {
	case "true":
		c.MCPEnabled = true
	case "false":
	default:
		problems = append(problems, "mcp_enabled must be true or false")
	}
	switch strings.ToLower(vals["sample_data"]) {
	case "true":
		c.SampleData = true
	case "false":
	default:
		problems = append(problems, "sample_data must be true or false")
	}
	switch c.Environment = strings.ToLower(vals["environment"]); c.Environment {
	case "production", "development":
	default:
		problems = append(problems, "environment must be production or development")
	}
	switch c.CookieSecure = strings.ToLower(vals["cookie_secure"]); c.CookieSecure {
	case "auto", "true":
	default:
		problems = append(problems, "cookie_secure must be auto or true")
	}
	if !timeRe.MatchString(c.BackupTime) {
		problems = append(problems, "backup_time must be HH:MM (24-hour)")
	}
	if canon(c.BackupDir) == canon(filepath.Dir(c.DBPath)) {
		problems = append(problems, "backup_dir must not be the database's own directory")
	}

	if len(problems) > 0 {
		if noFile != "" {
			problems = append(problems, noFile)
		}
		sort.Strings(problems)
		msg := "invalid configuration: " + strings.Join(problems, "; ")
		slog.Debug("config: rejected", "problems", len(problems))
		return nil, errors.New(msg)
	}
	return c, nil
}

// The database file was called roadmap.db until 2026-10-17 (REQ_CFG_012). Where the configured file is the new
// name, is missing, and the old name sits beside it, the old file is used, so an upgrade never starts on an empty
// database. Nothing is renamed or copied here.
const (
	dbFileName       = "roadmap-database.db"
	legacyDBFileName = "roadmap.db"
)

func legacyDBFallback(dbPath string) string {
	if filepath.Base(dbPath) != dbFileName {
		return dbPath
	}
	legacy := filepath.Join(filepath.Dir(dbPath), legacyDBFileName)
	if _, err := os.Stat(dbPath); err == nil {
		return dbPath
	}
	if _, err := os.Stat(legacy); err != nil {
		return dbPath
	}
	slog.Warn("config: using the old database file name; rename it to finish the upgrade (stop the program first)",
		"using", legacy, "new_name", dbPath)
	return legacy
}

// LogSummary logs the effective settings (never the password). Call it once logging is set up.
func (c *Config) LogSummary(path string) {
	slog.Info("config: loaded", "path", path, "port", c.Port, "db_path", c.DBPath, "log_dir", c.LogDir,
		"log_level", c.LogLevel, "audit_retention_days", c.AuditRetentionDays, "backup_enabled", c.BackupEnabled,
		"backup_dir", c.BackupDir, "backup_time", c.BackupTime, "backup_keep_days", c.BackupKeepDays,
		"session_ttl_days", c.SessionTTLDays, "bootstrap_admin_user", c.BootstrapAdminUser,
		"environment", c.Environment, "sample_data", c.SampleData, "cookie_secure", c.CookieSecure, "mcp_enabled", c.MCPEnabled)
}

// PeekLogDir returns the log_dir a (possibly invalid) config would use, resolved against the config
// file's directory, so a config failure can still be logged where the operator looks. It returns ""
// when the file cannot be read. It never validates anything else.
func PeekLogDir(path string, getenv func(string) string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	dir := defaults["log_dir"]
	for n, line := range strings.Split(string(data), "\n") {
		if n == 0 {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		if k, v, ok := strings.Cut(strings.TrimSpace(line), ":"); ok && strings.ToLower(strings.TrimSpace(k)) == "log_dir" {
			if v = strings.TrimSpace(v); v != "" {
				dir = v
			}
		}
	}
	if v := getenv(EnvName("log_dir")); v != "" {
		dir = v
	}
	return resolve(filepath.Dir(abs(path)), dir)
}

// resolve makes p absolute; a relative p is taken relative to base.
func resolve(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}

func abs(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

// canon is a comparison key for a directory: absolute, symlinks resolved through the longest
// existing ancestor (the directory itself may not exist yet), and lower-cased on Windows.
func canon(p string) string {
	p = abs(p)
	rest := ""
	for cur := p; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			p = filepath.Join(r, rest)
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}
