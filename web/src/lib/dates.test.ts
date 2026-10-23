import { describe, expect, it } from 'vitest'
import { formatDate, formatDateRange } from './dates'
import { step } from '../testSteps'

describe('REQ_FE_112 date text', () => {
  it('REQ_FE_112 REQ_FE_024 a range in one year shows the year once with an inclusive day count; a range across years carries both years; a single day reads "1 day"; a milestone date reads like "Mar 12, 2026"', async () => {
    await step('a range in one year shows the year once with an inclusive day count', () => {
      expect(formatDateRange('2026-01-12', '2026-02-27')).toBe('Jan 12 (Mon) – Feb 27, 2026 (Fri) · 47 days')
    })

    await step('a range across years carries both years', () => {
      expect(formatDateRange('2025-12-12', '2026-02-27')).toBe('Dec 12, 2025 (Fri) – Feb 27, 2026 (Fri) · 78 days')
    })

    await step('a single day reads "1 day"', () => {
      expect(formatDateRange('2026-03-01', '2026-03-01')).toBe('Mar 1, 2026 (Sun) · 1 day')
    })

    await step('a milestone date reads like "Mar 12, 2026"', () => {
      expect(formatDate('2026-03-12')).toBe('Mar 12, 2026')
    })
  })
})
