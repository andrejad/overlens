import { describe, expect, it } from 'vitest'
import { ICON_KEYS, ICONS } from './icons'

// REQ_FE_080: "exactly the 20 fixed icons" — this is the frontend's half of that hard count; the
// backend's iconDefaults map (internal/store/icons.go) is the other half and must list the same 20
// keys (checked by a Go test, not here — the two are hand-kept in sync, same as every other
// frontend/backend shape mirror in this codebase).
describe('REQ_FE_080 the fixed icon set', () => {
  it('REQ_FE_080 has exactly 20 keys, each matching the API key shape and carrying a component and a default label', () => {
    expect(ICON_KEYS).toHaveLength(20)
    expect(new Set(ICON_KEYS).size).toBe(20) // no duplicate keys
    for (const key of ICON_KEYS) {
      expect(key).toMatch(/^[a-z0-9_-]{1,40}$/) // the same regex internal/store/deliverables.go enforces
      expect(ICONS[key].Icon).toBeTruthy()
      expect(ICONS[key].defaultLabel.length).toBeGreaterThan(0)
    }
  })
})
