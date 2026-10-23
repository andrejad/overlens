// REQ_FE_128 / REQ_FE_132: the whole guided tour in a real browser, logged out and logged in. Each step must highlight a
// visible element, the steps must be exactly the expected ones in order, and the tour must never send a write request
// to the API. The tour is started with the Help button (REQ_FE_129); the shared setup marks it as seen so it never
// opens by itself in other specs.
import { expect, test, type Page } from '@playwright/test'
import { ADMIN_STATE, ANON_STATE, apiFetch, createDeliverable, createDependency, createMilestone, createTeam, createWorkstream, isoDay, teamRoadmap } from './builders'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const SHARED = [
  'The top bar', 'Company view', 'Team roadmaps', 'Zoom', 'Date range', 'Workstreams', 'Deliverables', 'Milestones', 'The side panel', 'Copies',
  'Dependency arrows', 'Depends on', 'Blocks', 'Trace dependencies', 'The trace', 'Milestones only', 'CSV download', // REQ_FE_138: the Milestones only step
]
const ANONYMOUS_TITLES = [...SHARED, 'Log in to edit']
const EDITOR_TITLES = [
  ...SHARED, 'Add a deliverable', 'Add a milestone', 'Add a workstream', 'Move and resize', 'Connector dots', 'The full edit window', 'Delete',
  'Your account', 'Users', 'Teams', 'Icons', 'Audit log',
]

// Builds a team with deliverables, a milestone and a dependency and moves it to the front of the team order, so the
// company view and the first team both have everything the tour points at. Returns what puts the order back.
async function seed(baseURL: string) {
  const team = await createTeam(baseURL)
  const roadmap = await teamRoadmap(baseURL, team)
  const ws = await createWorkstream(baseURL, roadmap)
  const a = await createDeliverable(baseURL, roadmap, [ws.id], isoDay(2), isoDay(12))
  const b = await createDeliverable(baseURL, roadmap, [ws.id], isoDay(20), isoDay(300)) // long enough to carry connector dots at the year zoom
  await createDependency(baseURL, a, b)
  await createMilestone(baseURL, roadmap, ws.id, isoDay(40))
  const ids = ((await (await apiFetch(baseURL, '/api/company/team-order')).json()).items as { id: number }[]).map((t) => t.id)
  const put = (order: number[]) =>
    apiFetch(baseURL, '/api/company/team-order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team_ids: order }) })
  await put([team.id, ...ids.filter((id) => id !== team.id)])
  return () => put(ids)
}

// Runs the tour to its end; returns the titles seen and the write requests sent.
async function walk(page: Page) {
  const writes: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`)
  })
  await page.goto('/#/teams')
  await page.getByTestId('help-tour').click()
  const titles: string[] = []
  for (let i = 0; i < 60; i++) {
    const title = page.locator('.driver-popover-title')
    await expect(title).toBeVisible()
    titles.push((await title.textContent()) ?? '')
    await expect(page.locator('.driver-active-element'), `the highlighted element of "${titles.at(-1)}"`).toBeVisible()
    const next = page.locator('.driver-popover-next-btn')
    const last = (await next.textContent()) === 'Done'
    await next.click()
    if (last) break
    await expect(page.locator('.driver-popover-title')).not.toHaveText(titles.at(-1)!)
  }
  await expect(page.locator('.driver-popover')).toHaveCount(0)
  expect(await page.evaluate(() => window.location.hash)).toBe('#/teams') // REQ_FE_134
  expect(await page.evaluate(() => localStorage.getItem('erm.tutorialSeen'))).toBe('true')
  return { titles, writes }
}

test.describe('anonymous', () => {
  test.use({ storageState: ANON_STATE })

  test('REQ_FE_128 REQ_FE_131 REQ_FE_132 the tour runs logged out with every step, ends on Log in and sends no write', async ({ page, baseURL }) => {
    const restore = await seed(baseURL!)
    try {
      const { titles, writes } = await walk(page)
      expect(titles).toEqual(ANONYMOUS_TITLES)
      expect(writes).toEqual([])
    } finally {
      await restore()
    }
  })

  test('REQ_FE_128 REQ_FE_134 the arrow keys go forward and back and Esc ends the tour on the start page, marked as seen', async ({ page }) => {
    await page.goto('/#/teams')
    await page.getByTestId('help-tour').click()
    const title = page.locator('.driver-popover-title')
    await expect(title).toHaveText('The top bar')
    await page.keyboard.press('ArrowRight')
    await expect(title).toHaveText('Company view')
    await page.keyboard.press('ArrowLeft')
    await expect(title).toHaveText('The top bar')
    await page.keyboard.press('Escape')
    await expect(page.locator('.driver-popover')).toHaveCount(0)
    expect(await page.evaluate(() => window.location.hash)).toBe('#/teams')
    expect(await page.evaluate(() => localStorage.getItem('erm.tutorialSeen'))).toBe('true')
  })
})

test.describe('logged in', () => {
  test.use({ storageState: ADMIN_STATE })

  test('REQ_FE_128 REQ_FE_131 REQ_FE_132 the tour runs logged in with the editing and admin steps and sends no write', async ({ page, baseURL }) => {
    const restore = await seed(baseURL!)
    try {
      const { titles, writes } = await walk(page)
      expect(titles).toEqual(EDITOR_TITLES)
      expect(writes).toEqual([])
    } finally {
      await restore()
    }
  })
})
