package auth

// Test seams: compiled only into this package's tests.

func (s *Service) SetVerify(f func(pw, encoded string) (bool, error)) { s.verify = f }
func (s *Service) SetLimiterCap(n int)                                { s.lim.cap = n }
func (s *Service) LimiterSize() int                                   { return s.lim.size() }
func (s *Service) DummyHash() string                                  { return s.dummy }

const MaxVerifies = maxVerifies
