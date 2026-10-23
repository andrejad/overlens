import { describe, expect, it } from 'vitest'
import { resolveApiBaseURL } from './base'
import { step } from '../testSteps'

describe('REQ_FE_087 API base URL resolution', () => {
  it('REQ_FE_087 an empty string (same-origin) is kept as-is, not replaced; an unset value falls back to the empty string; a real configured value is used unchanged', async () => {
    await step('an empty string (same-origin) is kept as-is, not replaced', () => {
      // this is exactly the case `??` and `||` disagree on: '' is falsy, so `||` would replace it
      expect(resolveApiBaseURL('')).toBe('')
    })

    await step('an unset value (undefined) falls back to the empty string', () => {
      expect(resolveApiBaseURL(undefined)).toBe('')
    })

    await step('a real configured value is used unchanged', () => {
      expect(resolveApiBaseURL('https://roadmaps.example.com')).toBe('https://roadmaps.example.com')
    })
  })
})
