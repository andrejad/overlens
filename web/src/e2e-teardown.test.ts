// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import globalTeardown from '../e2e/global-teardown'

// REQ_TEST_007: the browser run's scratch folder is always removed when the run ends, and only that folder.
describe('REQ_TEST_007 the e2e global teardown removes its erm-test directory', () => {
  const saved = process.env.ERM_E2E_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.ERM_E2E_DIR
    else process.env.ERM_E2E_DIR = saved
  })

  it('REQ_TEST_007 removes the erm-test folder with everything in it, and refuses any other folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'erm-test-'))
    writeFileSync(join(dir, 'roadmap.db'), 'x')
    process.env.ERM_E2E_DIR = dir
    globalTeardown()
    expect(existsSync(dir)).toBe(false)

    // a folder that is not erm-test-* in the temp dir is never deleted
    const other = mkdtempSync(join(tmpdir(), 'not-ours-'))
    process.env.ERM_E2E_DIR = other
    expect(() => globalTeardown()).toThrow(/refusing to delete/)
    expect(existsSync(other)).toBe(true)
    process.env.ERM_E2E_DIR = join(other, 'erm-test-nested')
    expect(() => globalTeardown()).toThrow(/refusing to delete/)
  })
})

// REQ_TEST_020: the browser tests' server never creates the shipped sample company and does not inherit settings.
describe('REQ_TEST_020 the e2e server starts without sample data', () => {
  it('REQ_TEST_020 start-server.sh drops inherited OVERLENS_* variables, then sets sample data off', () => {
    const script = readFileSync(join(__dirname, '..', 'e2e', 'start-server.sh'), 'utf8')
    const unset = script.indexOf("grep '^OVERLENS_'")
    const sampleOff = script.indexOf('export OVERLENS_SAMPLE_DATA=false')
    expect(unset).toBeGreaterThan(-1)
    expect(sampleOff).toBeGreaterThan(unset) // exported after the inherited ones are gone
  })
})
