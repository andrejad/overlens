import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { envSeed, testToday } from './testToday'

// vitest.config.ts doesn't enable `test.globals`, so @testing-library/react's own auto-cleanup
// (which detects a global `afterEach`) never registers — wire it explicitly so every test starts
// from an empty document.
afterEach(cleanup)

// REQ_TEST_024: today is frozen at the day the run's seed gives. Without fake timers this mocks only Date
// (timers keep running). Set at load (module-level `new Date()` in test files) and again before every test, so
// a test that moves the clock or calls vi.useRealTimers() can't leak into the next one. A test that needs fake
// timers calls vi.useRealTimers() first, then vi.useFakeTimers() and sets its own time.
const today = testToday(envSeed())
vi.setSystemTime(today)
beforeEach(() => vi.setSystemTime(today))
