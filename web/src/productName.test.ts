import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// REQ_OVR_014: the application is called Overlens, and the browser tab says so (Vitest runs from web/).
describe('REQ_OVR_014 product name', () => {
  it('REQ_OVR_014 the browser tab title is "Overlens"', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toBe('Overlens')
  })
})
