// Test-only (never imported by app code). REQ_TEST_024: the frozen "today" of the Vitest and browser
// layers, derived from the run's seed with the formula of Go's clockFromSeed, which Go applies to each test's own
// derived seed, so the layers' days differ (2020-01-01 + seed mod 2920 days, so a day
// between 2020 and 2027). Local noon, so a daylight-saving change can't move the calendar day.
export const TEST_TZ = 'Europe/Amsterdam'

export function testToday(seed: number | string): Date {
  const n = ((BigInt(seed) % 2920n) + 2920n) % 2920n
  const d = new Date(2020, 0, 1, 12, 0, 0, 0)
  d.setDate(d.getDate() + Number(n))
  return d
}

// The seed of this run: TEST_SEED, or 0 when a tool is run outside make/the configs (they always set it).
export function envSeed(): number {
  const n = Number(process.env.TEST_SEED)
  return process.env.TEST_SEED && Number.isInteger(n) ? n : 0
}
