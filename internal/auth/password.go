// Package auth holds passwords, sessions, login rate limiting and the user table's rules
// (REQ_AUTH_001–018). The HTTP layer talks to it only through Service.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Params are the argon2id cost settings; they are written into every stored hash so the cost can be
// raised later without invalidating old hashes.
type Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultParams follows the OWASP minimum for argon2id.
var DefaultParams = Params{MemoryKiB: 19 * 1024, Time: 2, Threads: 1}

const (
	saltLen = 16
	keyLen  = 32
	// MinPassword and MaxPassword are the policy of REQ_AUTH_014, in characters.
	MinPassword = 8
	MaxPassword = 128
)

// ValidatePassword reports whether pw satisfies the 8–128 character policy.
func ValidatePassword(pw string) bool {
	n := utf8.RuneCountInString(pw)
	return n >= MinPassword && n <= MaxPassword
}

// HashPassword hashes pw with DefaultParams: $argon2id$v=19$m=..,t=..,p=..$salt$hash.
func HashPassword(pw string) (string, error) { return HashPasswordWith(pw, DefaultParams) }

// HashPasswordWith is HashPassword with explicit cost (tests use a cheap one).
func HashPasswordWith(pw string, p Params) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, p.Time, p.MemoryKiB, p.Threads, keyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.MemoryKiB, p.Time, p.Threads,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var errBadHash = errors.New("auth: malformed password hash")

// parseHash splits an encoded hash into its cost parameters, salt and key.
func parseHash(encoded string) (p Params, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return p, nil, nil, errBadHash
	}
	var v int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return p, nil, nil, errBadHash
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.MemoryKiB, &p.Time, &p.Threads); err != nil || p.Threads == 0 || p.Time == 0 {
		return p, nil, nil, errBadHash
	}
	b64 := base64.RawStdEncoding
	if salt, err = b64.DecodeString(parts[4]); err != nil {
		return p, nil, nil, errBadHash
	}
	if key, err = b64.DecodeString(parts[5]); err != nil || len(key) == 0 {
		return p, nil, nil, errBadHash
	}
	return p, salt, key, nil
}

// VerifyPassword compares pw to an encoded hash in constant time. A malformed hash is an error,
// never a match.
func VerifyPassword(pw, encoded string) (bool, error) {
	p, salt, want, err := parseHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pw), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// NeedsRehash reports whether encoded was made with different cost settings than p, so a
// successful login can transparently replace it. A malformed hash never "needs" one.
func NeedsRehash(encoded string, p Params) bool {
	got, _, _, err := parseHash(encoded)
	return err == nil && got != p
}
