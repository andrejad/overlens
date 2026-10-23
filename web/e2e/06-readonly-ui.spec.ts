// REQ_FE_083 / REQ_DEP_020: an anonymous visitor sees the roadmap read-only, with no edit controls.
//
// Green since slice 6c (AuthProvider hides edit controls for anonymous visitors). Runs in its own
// project, `readonly-ui`, with NO storageState (a fresh, logged-out browser context). Run it alone with: npx playwright test --grep REQ_FE_083 --no-deps
import { expect, test } from '@playwright/test'
import { createDeliverable, createDependency, teamRoadmap, createTeam, createWorkstream, isoDay } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

test('REQ_FE_083 REQ_DEP_020 an anonymous visitor sees the team roadmap with no edit controls', async ({ page, baseURL }) => {
  const team = await createTeam(baseURL!)
  const roadmap = await teamRoadmap(baseURL!, team)
  const ws = await createWorkstream(baseURL!, roadmap, { name: 'Alpha' })
  const a = await createDeliverable(baseURL!, roadmap, [ws.id], isoDay(2), isoDay(12), { name: 'Prereq work' })
  const b = await createDeliverable(baseURL!, roadmap, [ws.id], isoDay(20), isoDay(30), { name: 'Dependent work' })
  await createDependency(baseURL!, a, b)

  await page.goto(`/#/teams/${team.id}`)
  // the roadmap itself is readable: both bars are drawn
  await expect(page.locator('.deliverable:not(.dup)')).toHaveCount([a, b].length)

  const editControls = [
    page.getByRole('button', { name: /deliverable/i }),
    page.getByRole('button', { name: /milestone/i }),
    page.getByRole('button', { name: /workstream/i }),
    page.locator('.rz'), // resize zones
    page.locator('.cdot'), // connector dots
  ]
  for (const control of editControls) await expect(control).toHaveCount(0)

  // opening a deliverable (side panel) must not offer the prerequisite picker either
  await page.locator('.deliverable:not(.dup)').first().click()
  await expect(page.getByText('Prereq work').or(page.getByText('Dependent work')).first()).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Prerequisite candidates' })).toHaveCount(0)
  await expect(page.getByLabel('Search deliverables')).toHaveCount(0)
})
