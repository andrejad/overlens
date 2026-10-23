package config_test

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/config"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "roadmap.conf")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func noEnv(string) string { return "" }

const req = "bootstrap_admin_user: boss\nbootstrap_admin_password: s3cret\n"

func Test_REQ_CFG_003_defaults(t *testing.T) {
	t.Run("phase8 keys defaults and overrides", func(t *testing.T) {
		c, err := config.Load(write(t, req), noEnv)
		if err != nil {
			t.Fatal(err)
		}
		if c.Environment != "production" || !c.SampleData || c.CookieSecure != "auto" {
			t.Fatalf("defaults: %q %v %q", c.Environment, c.SampleData, c.CookieSecure)
		}
		c, err = config.Load(write(t, req+"environment: Development\nsample_data: false\ncookie_secure: TRUE\n"), noEnv)
		if err != nil || c.Environment != "development" || c.SampleData || c.CookieSecure != "true" {
			t.Fatalf("file values: %+v %v", c, err)
		}
		env := map[string]string{"ROADMAP_ENVIRONMENT": "production", "ROADMAP_SAMPLE_DATA": "true", "ROADMAP_COOKIE_SECURE": "auto"}
		c, err = config.Load(write(t, req+"environment: development\nsample_data: false\ncookie_secure: true\n"), func(k string) string { return env[k] })
		if err != nil || c.Environment != "production" || !c.SampleData || c.CookieSecure != "auto" {
			t.Fatalf("env overrides: %+v %v", c, err)
		}
		if config.EnvName("cookie_secure") != "ROADMAP_COOKIE_SECURE" {
			t.Error("env name")
		}
	})

	p := write(t, req)
	dir := filepath.Dir(p)
	c, err := config.Load(p, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8080 || c.DBPath != filepath.Join(dir, "data", "roadmap-database.db") || c.LogDir != filepath.Join(dir, "logs") || c.LogLevel != "INFO" ||
		c.AuditRetentionDays != 365 || !c.BackupEnabled || c.BackupDir != filepath.Join(dir, "backups") || c.BackupTime != "04:00" ||
		c.BackupKeepDays != 10 || c.SessionTTLDays != 365 || c.BootstrapAdminUser != "boss" {
		t.Fatalf("unexpected defaults: %+v", c)
	}

}

func Test_REQ_CFG_001_format_comments_and_colons(t *testing.T) {
	t.Run("bom and crlf", func(t *testing.T) {
		body := "\ufeffbootstrap_admin_user: boss\r\nbootstrap_admin_password: s3cret\r\nport: 9091\r\n"
		c, err := config.Load(write(t, body), noEnv)
		if err != nil {
			t.Fatal(err)
		}
		if c.BootstrapAdminUser != "boss" || c.BootstrapAdminPassword != "s3cret" || c.Port != 9091 {
			t.Fatalf("got %+v", c)
		}
	})

	body := "# comment\n\n  port :  9090  \nbackup_time: 13:45\n" + req + "# bootstrap_admin_user: nope\n"
	c, err := config.Load(write(t, body), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 9090 || c.BackupTime != "13:45" {
		t.Fatalf("got %+v", c)
	}

}

func Test_REQ_CFG_002_env_overrides(t *testing.T) {
	env := map[string]string{"ROADMAP_PORT": "9999", "ROADMAP_BOOTSTRAP_ADMIN_USER": "envadmin"}
	c, err := config.Load(write(t, req+"port: 1234\n"), func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 9999 || c.BootstrapAdminUser != "envadmin" {
		t.Fatalf("got %+v", c)
	}
}

func Test_REQ_CFG_005_REQ_CFG_006_every_problem_listed_at_once(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		_, err := config.Load(filepath.Join(t.TempDir(), "absent.conf"), noEnv)
		if err == nil || !strings.Contains(err.Error(), "missing or unreadable") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("phase8 keys are validated", func(t *testing.T) {
		for _, bad := range []string{"environment: staging", "sample_data: maybe", "cookie_secure: false", "cookie_secure: yes"} {
			_, err := config.Load(write(t, req+bad+"\n"), noEnv)
			key := strings.SplitN(bad, ":", 2)[0]
			if err == nil || !strings.Contains(err.Error(), key+" must be") {
				t.Errorf("%q: error %v", bad, err)
			}
		}
	})

	t.Run("required never default", func(t *testing.T) {
		_, err := config.Load(write(t, "bootstrap_admin_user: \nbootstrap_admin_password: x\n"), noEnv)
		if err == nil || !strings.Contains(err.Error(), "bootstrap_admin_user") {
			t.Fatalf("empty required key must fail, got %v", err)
		}
	})

	_, err := config.Load(write(t, "port: abc\nlog_level: LOUD\nnonsense\nbackup_enabled: maybe\n"), noEnv)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"bootstrap_admin_user", "bootstrap_admin_password", "port", "log_level", "line 3", "backup_enabled"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "\n") {
		t.Error("error must be a single line")
	}

}

func Test_REQ_CFG_005_backup_dir_not_db_dir(t *testing.T) {
	t.Run("backup dir symlink to db dir", func(t *testing.T) {
		p := write(t, req+"db_path: real/r.db\nbackup_dir: link\n")
		dir := filepath.Dir(p)
		os.MkdirAll(filepath.Join(dir, "real"), 0o755)
		if err := os.Symlink(filepath.Join(dir, "real"), filepath.Join(dir, "link")); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
		if _, err := config.Load(p, noEnv); err == nil || !strings.Contains(err.Error(), "backup_dir") {
			t.Fatalf("symlinked backup_dir must be rejected, got %v", err)
		}
	})

	_, err := config.Load(write(t, req+"db_path: ./x/r.db\nbackup_dir: ./x\n"), noEnv)
	if err == nil || !strings.Contains(err.Error(), "backup_dir") {
		t.Fatalf("got %v", err)
	}

}

func Test_REQ_CFG_010_password_not_in_error(t *testing.T) {
	_, err := config.Load(write(t, "bootstrap_admin_password: hunter2hunter2\nport: x\n"), noEnv)
	if err == nil || strings.Contains(err.Error(), "hunter2hunter2") {
		t.Fatalf("error must exist and not contain the password: %v", err)
	}
}

func Test_REQ_CFG_003_relative_paths_resolve_against_config_dir(t *testing.T) {
	p := write(t, req+"db_path: d/r.db\nlog_dir: /abs/logs\nbackup_dir: ../b\n")
	dir := filepath.Dir(p)
	c, err := config.Load(p, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if c.DBPath != filepath.Join(dir, "d", "r.db") || c.LogDir != filepath.FromSlash("/abs/logs") || c.BackupDir != filepath.Join(filepath.Dir(dir), "b") {
		t.Fatalf("got %+v", c)
	}
}

func Test_REQ_CFG_012_old_database_file_name_is_used_when_the_new_one_is_missing(t *testing.T) {
	touch := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	load := func(extra string, files ...string) (string, string) {
		t.Helper()
		p := write(t, req+extra)
		dir := filepath.Dir(p)
		for _, f := range files {
			touch(filepath.Join(dir, f))
		}
		c, err := config.Load(p, noEnv)
		if err != nil {
			t.Fatal(err)
		}
		return dir, c.DBPath
	}
	t.Run("an existing installation keeps its data", func(t *testing.T) {
		dir, got := load("", "data/roadmap.db")
		if want := filepath.Join(dir, "data", "roadmap.db"); got != want {
			t.Fatalf("got %s, want the old file %s", got, want)
		}
		if _, err := os.Stat(filepath.Join(dir, "data", "roadmap-database.db")); err == nil {
			t.Fatal("nothing may be created or renamed by loading the config")
		}
	})
	t.Run("the new file wins when both exist", func(t *testing.T) {
		dir, got := load("", "data/roadmap.db", "data/roadmap-database.db")
		if want := filepath.Join(dir, "data", "roadmap-database.db"); got != want {
			t.Fatalf("got %s, want %s", got, want)
		}
	})
	t.Run("a fresh installation uses the new name", func(t *testing.T) {
		dir, got := load("")
		if want := filepath.Join(dir, "data", "roadmap-database.db"); got != want {
			t.Fatalf("got %s, want %s", got, want)
		}
	})
	t.Run("another name is used as written", func(t *testing.T) {
		dir, got := load("db_path: ./data/mine.db\n", "data/roadmap.db")
		if want := filepath.Join(dir, "data", "mine.db"); got != want {
			t.Fatalf("got %s, want %s", got, want)
		}
	})
	t.Run("an explicit new name in another folder falls back only beside itself", func(t *testing.T) {
		dir, got := load("db_path: ./elsewhere/roadmap-database.db\n", "data/roadmap.db")
		if want := filepath.Join(dir, "elsewhere", "roadmap-database.db"); got != want {
			t.Fatalf("got %s, want %s", got, want)
		}
	})
}

// Test_REQ_CFG_013_mcp_enabled: off by default, true/false in the file (any case) or ROADMAP_MCP_ENABLED, the
// variable wins, anything else stops the start, and the start-up summary says whether it is on.
func Test_REQ_CFG_013_mcp_enabled(t *testing.T) {
	c, err := config.Load(write(t, req), noEnv)
	if err != nil || c.MCPEnabled {
		t.Fatalf("default: %+v %v", c, err)
	}
	c, err = config.Load(write(t, req+"mcp_enabled: TRUE\n"), noEnv)
	if err != nil || !c.MCPEnabled {
		t.Fatalf("file true: %+v %v", c, err)
	}
	env := map[string]string{"ROADMAP_MCP_ENABLED": "false"}
	c, err = config.Load(write(t, req+"mcp_enabled: true\n"), func(k string) string { return env[k] })
	if err != nil || c.MCPEnabled {
		t.Fatalf("env wins: %+v %v", c, err)
	}
	env["ROADMAP_MCP_ENABLED"] = "true"
	if c, err = config.Load(write(t, req), func(k string) string { return env[k] }); err != nil || !c.MCPEnabled {
		t.Fatalf("env true: %+v %v", c, err)
	}
	if _, err = config.Load(write(t, req+"mcp_enabled: yes\n"), noEnv); err == nil || !strings.Contains(err.Error(), "mcp_enabled") {
		t.Fatalf("bad value: %v", err)
	}
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(prev)
	c.LogSummary("x.conf")
	if !strings.Contains(buf.String(), "mcp_enabled=true") {
		t.Errorf("start-up line lacks mcp_enabled: %s", buf.String())
	}
}
