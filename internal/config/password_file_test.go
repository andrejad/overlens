package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/config"
)

// REQ_DEPLOY_011: the bootstrap password can come from a file named by OVERLENS_BOOTSTRAP_ADMIN_PASSWORD_FILE;
// the plain variable wins; an unreadable file is a config problem that does not echo the password.
func Test_REQ_DEPLOY_011_bootstrap_password_from_file(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(secret, []byte("from-the-file\n"), 0o600)
	conf := write(t, "bootstrap_admin_user: boss\n")
	c, err := config.Load(conf, func(k string) string {
		return map[string]string{"OVERLENS_BOOTSTRAP_ADMIN_PASSWORD_FILE": secret}[k]
	})
	if err != nil || c.BootstrapAdminPassword != "from-the-file" {
		t.Fatalf("%+v %v", c, err)
	}
	c, err = config.Load(conf, func(k string) string {
		return map[string]string{"OVERLENS_BOOTSTRAP_ADMIN_PASSWORD_FILE": secret, "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "plain"}[k]
	})
	if err != nil || c.BootstrapAdminPassword != "plain" {
		t.Fatalf("the plain variable should win: %+v %v", c, err)
	}
	_, err = config.Load(conf, func(k string) string {
		return map[string]string{"OVERLENS_BOOTSTRAP_ADMIN_PASSWORD_FILE": filepath.Join(t.TempDir(), "missing")}[k]
	})
	if err == nil || !strings.Contains(err.Error(), "_FILE") {
		t.Fatalf("a missing secret file must be a config problem: %v", err)
	}
}
