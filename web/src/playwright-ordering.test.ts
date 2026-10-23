import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../playwright.config'

// REQ_TEST_012 (hard rule): the no-overlap project runs first and blocks every other browser test if
// it fails. 01-no-overlap.spec.ts and 02-copies-off.spec.ts (REQ_FE_010/REQ_FE_017) carry the visual
// assertions; this checks the *ordering* itself — the Playwright project `dependencies` wiring that
// makes it structural, not conventional — so an edit to playwright.config.ts can't quietly drop it.
describe('REQ_TEST_012 core project ordering', () => {
  const projects = config.projects ?? []
  const byName = Object.fromEntries(projects.map((p) => [p.name, p]))

  it('REQ_TEST_012 core-no-overlap exists and runs first with no dependency of its own; core-copies-off depends on it; the dependency specs run only after both; every other browser test depends on both', () => {
    expect(byName['core-no-overlap'], 'core-no-overlap exists').toBeTruthy()
    expect(byName['core-no-overlap']!.dependencies ?? [], 'core-no-overlap has no dependency').toEqual([])

    expect(byName['core-copies-off'], 'core-copies-off exists').toBeTruthy()
    expect(byName['core-copies-off']!.dependencies, 'core-copies-off depends on core-no-overlap having passed first').toEqual(['core-no-overlap'])

    expect(byName['dependencies'], 'the dependencies project exists').toBeTruthy()
    expect(byName['dependencies']!.dependencies, 'dependencies runs only after core-copies-off').toEqual(['core-copies-off']) // which itself depends on core-no-overlap
    expect(String(byName['dependencies']!.testMatch)).toContain('03-dependencies')

    expect(byName['rest'], 'the rest project exists').toBeTruthy()
    expect(byName['rest']!.dependencies, 'rest depends on both core projects having passed').toEqual(['core-copies-off'])
    // "rest" must never itself match the core spec files — those only ever run as core-no-overlap/core-copies-off
    expect(String(byName['rest']!.testIgnore)).toContain('0[123]-')
  })

  it('REQ_TEST_012 every project except core-no-overlap depends, directly or through others, on core-copies-off, which depends on core-no-overlap', () => {
    const reachesCore = (name: string, seen = new Set<string>()): boolean => {
      if (name === 'core-copies-off') return true
      if (seen.has(name)) return false
      seen.add(name)
      return (byName[name]?.dependencies ?? []).some((d: string) => reachesCore(d, seen))
    }
    for (const p of projects) {
      if (p.name === 'core-no-overlap') continue
      expect(reachesCore(p.name!), `${p.name} must run only after the no-overlap test has passed`).toBe(true)
    }
  })

  // A spec that no project runs is silently never run; one that two projects run runs twice. Both would hide a failure.
  it('REQ_TEST_012 every spec file in e2e runs in exactly one project', () => {
    const matches = (m: unknown, file: string): boolean => (Array.isArray(m) ? m.some((x) => matches(x, file)) : m instanceof RegExp ? m.test(file) : false)
    const specs = readdirSync(join(__dirname, '..', 'e2e')).filter((f) => f.endsWith('.spec.ts'))
    expect(specs.length).toBeGreaterThan(0)
    for (const f of specs) {
      const owners = projects.filter((p) => (p.testMatch === undefined || matches(p.testMatch, f)) && !matches(p.testIgnore, f)).map((p) => p.name)
      expect(owners, `${f} must be in exactly one Playwright project`).toHaveLength(1)
    }
  })
})
