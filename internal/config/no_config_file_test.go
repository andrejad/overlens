package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/config"
)

// REQ_DEPLOY_011: a missing config file is not an error when the OVERLENS_* variables carry the settings.
func Test_REQ_DEPLOY_011_missing_file_is_fine_with_environment_settings(t *testing.T) {
	t.Run("other problems still fail fast", func(t *testing.T) {
		absent := filepath.Join(t.TempDir(), "absent.conf")
		_, err := config.Load(absent, func(string) string { return "" })
		if err == nil || !strings.Contains(err.Error(), "missing or unreadable") || !strings.Contains(err.Error(), "bootstrap_admin_user") {
			t.Errorf("no file and no settings: %v", err)
		}
		env := map[string]string{"OVERLENS_BOOTSTRAP_ADMIN_USER": "boss", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "s3cret", "OVERLENS_PORT": "nope"}
		_, err = config.Load(absent, func(k string) string { return env[k] })
		if err == nil || !strings.Contains(err.Error(), "port must be") || !strings.Contains(err.Error(), "missing or unreadable") {
			t.Errorf("a bad value: %v", err)
		}
		delete(env, "OVERLENS_PORT")
		dir := t.TempDir() // a directory is not a config file
		if _, err = config.Load(dir, func(k string) string { return env[k] }); err == nil {
			t.Error("a directory as the config file must fail")
		}
		bad := filepath.Join(t.TempDir(), "overlens.conf")
		os.WriteFile(bad, []byte("nonsense\n"), 0o600)
		if _, err = config.Load(bad, func(k string) string { return env[k] }); err == nil {
			t.Error("a malformed file must still fail")
		}
	})

	env := map[string]string{"OVERLENS_BOOTSTRAP_ADMIN_USER": "boss", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "s3cret", "OVERLENS_PORT": "9001"}
	c, err := config.Load(filepath.Join(t.TempDir(), "absent.conf"), func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("a missing file with the settings in the environment: %v", err)
	}
	if c.Port != 9001 || c.BootstrapAdminUser != "boss" || c.LogLevel != "INFO" {
		t.Errorf("settings %+v", c)
	}

}
