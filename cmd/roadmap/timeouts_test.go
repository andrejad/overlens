package main

import (
	"net/http"
	"testing"
	"time"
)

// REQ_OVR_013: the server limits how long it waits for a request's headers and body and for writing its
// answer; the write limit leaves room for the CSV download.
func Test_REQ_OVR_013_server_has_timeouts(t *testing.T) {
	s := newServer(http.NotFoundHandler())
	for name, d := range map[string]time.Duration{
		"ReadHeaderTimeout": s.ReadHeaderTimeout, "ReadTimeout": s.ReadTimeout, "WriteTimeout": s.WriteTimeout, "IdleTimeout": s.IdleTimeout,
	} {
		if d <= 0 {
			t.Errorf("%s is not set", name)
		}
	}
	if s.WriteTimeout < 60*time.Second {
		t.Errorf("WriteTimeout %v is too short for the CSV download", s.WriteTimeout)
	}
	if s.ReadHeaderTimeout > s.ReadTimeout {
		t.Errorf("ReadHeaderTimeout %v is longer than ReadTimeout %v", s.ReadHeaderTimeout, s.ReadTimeout)
	}
}
