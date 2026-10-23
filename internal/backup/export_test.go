package backup

import (
	"context"
	"time"
)

// SetLast exposes setLast to the tests (the message cut is otherwise only reachable through errors).
func (s *Service) SetLast(ctx context.Context, at time.Time, result, msg string) {
	s.setLast(ctx, at, result, msg)
}
