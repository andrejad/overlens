import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trimName } from './ui'

// The shared table also run by the Go side (testdata/trim_cases.json at the repository root).
const table = JSON.parse(readFileSync(resolve(__dirname, '../../../testdata/trim_cases.json'), 'utf8')) as { cases: { in: string; out: string }[] }

describe('REQ_DAT_028 trimName', () => {
  it('REQ_DAT_028 gives the shared table\'s answers for every case', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(8)
    for (const c of table.cases) expect(trimName(c.in), JSON.stringify(c.in)).toBe(c.out)
  })

  it('REQ_DAT_028 strips U+0085, U+200B and U+FEFF (which String.trim() does not all do), leaves characters in the middle alone and keeps astral characters at the ends', () => {
    expect(trimName('\u0085x​'), 'U+0085 and U+200B at the ends').toBe('x')
    expect('​x'.trim(), 'String.trim() alone does not strip U+200B').not.toBe('x')
    expect(trimName(' a​b c '), 'characters in the middle are left alone').toBe('a​b c')
    expect(trimName(' \u{1F600} '), 'astral characters at the ends are kept').toBe('\u{1F600}')
  })
})
