// REQ_FE_127 on the REAL running app: a workstream the roadmap has nothing in is not drawn, a workstream holding only
// a copy stays drawn whether copies are on or off, and Manage workstreams still lists every workstream. Data comes
// from the real API via builders.ts.
import { expect, test } from '@playwright/test'
import { createDeliverable, createScene, createWorkstream, isoDay } from './builders'

test('REQ_FE_127 an empty workstream is not shown on the team roadmap; one holding only a copy stays with copies off; Manage workstreams lists all', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap } = await createScene(url, 0) // a blank roadmap has its own empty "General"
  const main = await createWorkstream(url, roadmap)
  const copyOnly = await createWorkstream(url, roadmap)
  const empty = await createWorkstream(url, roadmap)
  await createDeliverable(url, roadmap, [main.id, copyOnly.id], isoDay(2), isoDay(20))

  await page.goto(`/#/teams/${team.id}`)
  const bands = () => page.locator('.band').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ws))
  await expect(page.locator('.deliverable.dup')).toHaveCount(1)
  expect(await bands()).toEqual([main.name, copyOnly.name])
  await expect(page.locator('.ws-label .name')).toHaveText([main.name, copyOnly.name])

  const swCopies = page.locator('#sw-copies')
  await swCopies.click()
  await expect(swCopies).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.deliverable.dup')).toHaveCount(0)
  expect(await bands()).toEqual([main.name, copyOnly.name]) // switching copies off never removes a row
  await swCopies.click()
  await expect(swCopies).toHaveAttribute('aria-checked', 'true')

  await page.goto(`/#/teams/${team.id}/workstreams`)
  await expect(page.getByRole('heading', { name: 'Manage workstreams' })).toBeVisible()
  await expect(page.locator('[data-testid="ws-row"] .nm')).toHaveText(['General', main.name, copyOnly.name, empty.name])
})
