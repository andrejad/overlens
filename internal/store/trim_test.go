package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Test_REQ_DAT_028_trim_table runs the shared table (testdata/trim_cases.json, also read by the
// frontend's Vitest) through the server's TrimName and cleanName.
func Test_REQ_DAT_028_trim_table(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "trim_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct{ In, Out string } `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) < 10 {
		t.Fatalf("table too small: %d cases", len(table.Cases))
	}
	for _, c := range table.Cases {
		if got := TrimName(c.In); got != c.Out {
			t.Errorf("TrimName(%q) = %q, want %q", c.In, got, c.Out)
		}
		got, err := cleanName("name", c.In)
		if c.Out == "" {
			if err == nil {
				t.Errorf("cleanName(%q) should refuse an empty name", c.In)
			}
		} else if err != nil || got != c.Out {
			t.Errorf("cleanName(%q) = %q, %v, want %q", c.In, got, err, c.Out)
		}
		if foldName(c.In) != foldName(c.Out) {
			t.Errorf("foldName must trim like TrimName: %q vs %q", c.In, c.Out)
		}
	}
}
