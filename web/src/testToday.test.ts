import { describe, expect, it } from 'vitest'
import { envSeed, TEST_TZ, testToday } from './testToday'

describe('REQ_TEST_024 the calendar and timezone are fixed', () => {
  it('REQ_TEST_024 today is the day the seed gives and does not move, in Europe/Amsterdam', async () => {
    const want = testToday(envSeed())
    const now = new Date()
    expect([now.getFullYear(), now.getMonth(), now.getDate()]).toEqual([want.getFullYear(), want.getMonth(), want.getDate()])
    expect(want.getFullYear()).toBeGreaterThanOrEqual(2020)
    expect(want.getFullYear()).toBeLessThanOrEqual(2027)
    await new Promise((r) => setTimeout(r, 5))
    expect(new Date().getTime()).toBe(now.getTime()) // frozen, not just started there
    expect(process.env.TZ).toBe(TEST_TZ)
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(TEST_TZ)
    expect(new Date(2024, 6, 1).getTimezoneOffset()).toBe(-120) // summer time: it is not UTC
  })
})
