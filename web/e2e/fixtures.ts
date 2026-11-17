// REQ_TEST_024: every spec imports `test` and `expect` from here, not from @playwright/test, so the browser's
// clock is frozen at the seed's day (builders.freezeClock) in the default context. A context a spec makes by hand
// calls freezeClock itself (checked by src/playwright-ordering.test.ts).
import { test as base } from '@playwright/test'
import { freezeClock } from './builders'

export const test = base.extend({
  context: async ({ context }, provide) => {
    await freezeClock(context)
    await provide(context)
  },
})

export { expect } from '@playwright/test'
